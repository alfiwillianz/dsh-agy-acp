import { createHash } from 'node:crypto'
import type {
  AcpAgentBackend,
  AgentPermissionRequest,
  AgentSession,
  AgentSessionHandlers,
  AgentStopReason,
  AgentUpdate,
} from './backend.js'
import type { AgyConfig } from './config.js'
import { CancelledError, ProcessExitedError, ProtocolError } from './errors.js'
import type { Logger } from './log.js'
import type { AcpOutcome } from './permission.js'
import {
  buildDeltaBlocks,
  buildPromptBlocks,
  NO_ATTACHMENTS,
  systemText,
  type MessageLike,
  type PromptAttachmentResolver,
} from './prompt.js'

/* ----------------------------------------------------------------------------------------------------------------
 * ACP session continuity.
 *
 * dsh re-sends the whole conversation on every model call; ACP sessions are stateful. This layer keeps one ACP
 * session per dsh session, sends only the new tail, and falls back to a fresh session + full replay whenever the
 * two histories diverge (compaction, fork, retry, crash, model switch, …). It never assumes `session/load` or
 * `session/resume` exists: those are capability-gated and a failure falls back to replay.
 * -------------------------------------------------------------------------------------------------------------- */

interface TurnHandlers {
  readonly onUpdate: (update: AgentUpdate) => void
  readonly onPermission: (request: AgentPermissionRequest) => Promise<AcpOutcome>
}

interface SessionState {
  readonly key: string
  readonly dshSessionId?: string
  cwd: string
  model: string
  reasoningEffort?: string
  systemHash: string
  toolsHash: string
  session?: AgentSession | undefined
  /** Last known ACP session id, kept across process crashes for a capability-gated resume attempt. */
  acpSessionId?: string | undefined
  /** Fingerprints of the non-system messages the ACP session has context for. */
  sent: string[]
  /** Text the adapter streamed for the last turn, used to verify the assistant message dsh appended. */
  assistantText: string
  lastUsed: number
  /** A failed turn whose session state is no longer trustworthy. */
  poisoned: boolean
  /** Handlers for the turn currently prompting; stale permission requests see `undefined`. */
  current?: TurnHandlers | undefined
}

export interface ContinuityRunOptions {
  /** dsh session id. Omitted for auxiliary calls, which always use an ephemeral session. */
  readonly dshSessionId?: string | undefined
  readonly cwd: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
  readonly system?: string | undefined
  readonly messages: readonly MessageLike[]
  readonly tools?: readonly unknown[] | undefined
  readonly signal?: AbortSignal | undefined
  readonly onUpdate: (update: AgentUpdate) => void
  readonly onPermission: (request: AgentPermissionRequest) => Promise<AcpOutcome>
  /** The text the adapter actually streamed; read after the prompt settles. */
  readonly assistantText: () => string
  /** Apply model/effort/mode configuration to the session. Called on every turn; the adapter may no-op. */
  readonly configureSession: (session: AgentSession, resumed: boolean) => Promise<void>
  readonly attachments?: PromptAttachmentResolver | undefined
}

export interface ContinuityResult {
  readonly stopReason: AgentStopReason
  readonly reused: boolean
  readonly resumed: boolean
  readonly acpSessionId: string
  readonly warnings: readonly string[]
}

export interface ContinuityStats {
  readonly sessions: number
  readonly created: number
  readonly resumed: number
  readonly reused: number
  readonly replayed: number
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function blockFingerprint(block: MessageLike['content'][number]): string {
  switch (block.type) {
    case 'text':
      return `t:${(block as { text?: unknown }).text ?? ''}`
    case 'reasoning':
      // Provider-private: dsh may rewrite or drop it without changing what the ACP session saw.
      return 'r'
    case 'image': {
      const attachment = (block as { attachment?: { attachmentId?: string; name?: string } }).attachment
      return `i:${attachment?.attachmentId ?? attachment?.name ?? ''}`
    }
    case 'file': {
      const attachment = (block as { attachment?: { attachmentId?: string; name?: string } }).attachment
      return `f:${attachment?.attachmentId ?? attachment?.name ?? ''}`
    }
    case 'tool-call': {
      const call = block as { id?: string; name?: string; arguments?: string }
      return `c:${call.id ?? ''}:${call.name ?? ''}:${call.arguments ?? ''}`
    }
    case 'tool-addition':
      return `a:${(block as { toolName?: string }).toolName ?? ''}`
    case 'tool-removal':
      return `r:${(block as { toolName?: string }).toolName ?? ''}`
    default:
      return `?:${block.type}`
  }
}

function fingerprintMessage(message: MessageLike): string {
  return `${message.role}\u0000${message.content.map(blockFingerprint).join('\u0001')}`
}

function messageText(message: MessageLike): string {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('')
}

function matchPrefix(sent: readonly string[], messages: readonly MessageLike[]): number | undefined {
  if (sent.length > messages.length) return undefined
  for (let i = 0; i < sent.length; i++) {
    if (sent[i] !== fingerprintMessage(messages[i]!)) return undefined
  }
  return sent.length
}

function isTransportFailure(error: unknown): boolean {
  return error instanceof ProcessExitedError
}

function isUnknownSessionFailure(error: unknown): boolean {
  const message = (error as { message?: string })?.message ?? ''
  return /unknown session|session (not found|does not exist|expired)|no such session/i.test(message)
}

/** Serialize turns per dsh session without letting one rejected turn wedge the next. */
class Mutex {
  #tail: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release: () => void = () => {}
    this.#tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

export class SessionContinuity {
  readonly #backend: AcpAgentBackend
  readonly #config: AgyConfig
  readonly #log: Logger
  readonly #states = new Map<string, SessionState>()
  readonly #locks = new Map<string, Mutex>()
  #idleTimer: ReturnType<typeof setInterval> | undefined
  #disposed = false
  #created = 0
  #resumed = 0
  #reused = 0
  #replayed = 0

  constructor(backend: AcpAgentBackend, config: AgyConfig, log: Logger) {
    this.#backend = backend
    this.#config = config
    this.#log = log
    if (config.sessionContinuity) this.#startIdleTimer()
  }

  get stats(): ContinuityStats {
    return {
      sessions: this.#states.size,
      created: this.#created,
      resumed: this.#resumed,
      reused: this.#reused,
      replayed: this.#replayed,
    }
  }

  get sessionCount(): number {
    return this.#states.size
  }

  /**
   * Run one turn. Uses a persistent ACP session when `sessionContinuity` is enabled and a dsh session id is
   * present; otherwise creates an ephemeral session and closes it afterwards.
   */
  async run(options: ContinuityRunOptions): Promise<ContinuityResult> {
    if (this.#disposed) throw new ProtocolError('the ACP continuity layer has been disposed')
    if (options.signal?.aborted === true) throw new CancelledError()
    if (!this.#config.sessionContinuity || options.dshSessionId === undefined) {
      return this.#runEphemeral(options)
    }
    const key = options.dshSessionId
    const mutex = this.#locks.get(key) ?? new Mutex()
    this.#locks.set(key, mutex)
    return mutex.run(() => this.#runPersistent(key, options))
  }

  /** Close every persistent session. Safe to call repeatedly. */
  async closeAll(): Promise<void> {
    const sessions = [...this.#states.values()].flatMap((s) => (s.session === undefined ? [] : [s.session]))
    this.#states.clear()
    await Promise.all(sessions.map((s) => s.close().catch(() => {})))
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#idleTimer !== undefined) clearInterval(this.#idleTimer)
    this.#idleTimer = undefined
    await this.closeAll()
  }

  /* ------------------------------------------------------------------------------------------------- ephemeral */

  async #runEphemeral(options: ContinuityRunOptions): Promise<ContinuityResult> {
    let session: AgentSession | undefined
    try {
      session = await this.#backend.createSession({
        cwd: options.cwd,
        handlers: this.#handlers(options),
      })
      await options.configureSession(session, false)
      const prompt = await buildPromptBlocks(
        { system: options.system, messages: options.messages, tools: options.tools },
        session.capabilities.prompt,
        options.attachments ?? NO_ATTACHMENTS,
      )
      this.#warn(prompt.warnings)
      const stopReason = await session.prompt(prompt.blocks, options.signal)
      return {
        stopReason,
        reused: false,
        resumed: false,
        acpSessionId: session.id,
        warnings: prompt.warnings,
      }
    } finally {
      await session?.close().catch(() => {})
    }
  }

  /* ------------------------------------------------------------------------------------------------- persistent */

  async #runPersistent(key: string, options: ContinuityRunOptions): Promise<ContinuityResult> {
    const state = this.#states.get(key) ?? this.#newState(key, options)
    this.#states.set(key, state)
    state.current = { onUpdate: options.onUpdate, onPermission: options.onPermission }
    state.lastUsed = Date.now()

    const messages = options.messages.filter((m) => m.role !== 'system')
    const fingerprints = messages.map(fingerprintMessage)
    const instructions = systemText({ system: options.system, messages: options.messages })
    const systemHash = hash(instructions)
    const toolsHash = hash(JSON.stringify(options.tools ?? []))
    const systemChanged = state.systemHash !== '' && state.systemHash !== systemHash
    const toolsChanged = state.toolsHash !== '' && state.toolsHash !== toolsHash

    let startIndex = 0
    let reused = false
    let resumed = false

    try {
      // 1) Reuse a live session when its history is a prefix of this request.
      if (state.session !== undefined && !state.session.closed && !state.poisoned && state.cwd === options.cwd) {
        const match = matchPrefix(state.sent, messages)
        const next = match === undefined ? undefined : this.#deltaStart(match, messages, state.assistantText)
        if (next !== undefined && next < messages.length) {
          startIndex = next
          reused = true
        } else {
          this.#log.debug('ACP session history diverged; replaying', {
            acpSession: state.session.id,
            sent: state.sent.length,
            messages: messages.length,
          })
        }
      }

      // 2) Try a capability-gated resume after a process crash / idle stop.
      if (state.session?.closed === true) state.session = undefined
      if (!reused && state.session === undefined && state.acpSessionId !== undefined && this.#config.resumeSessions) {
        try {
          const session = await this.#backend.resumeSession({
            cwd: options.cwd,
            sessionId: state.acpSessionId,
            handlers: this.#handlers(options, state),
          })
          if (session.capabilities.session.load || session.capabilities.session.resume) {
            const match = matchPrefix(state.sent, messages)
            const next = match === undefined ? undefined : this.#deltaStart(match, messages, state.assistantText)
            if (next !== undefined && next < messages.length) {
              state.session = session
              state.cwd = options.cwd
              state.poisoned = false
              startIndex = next
              resumed = true
              reused = true
              this.#resumed++
              this.#log.debug('resumed ACP session after reconnect', { acpSession: session.id })
            } else {
              await session.close().catch(() => {})
            }
          } else {
            await session.close().catch(() => {})
          }
        } catch (e) {
          this.#log.debug('ACP session resume failed; replaying', { message: (e as Error)?.message })
          this.#replayed++
        }
      }

      // 3) Otherwise create a fresh session and replay the whole conversation.
      if (!reused) {
        await state.session?.close().catch(() => {})
        const session = await this.#backend.createSession({
          cwd: options.cwd,
          handlers: this.#handlers(options, state),
        })
        state.session = session
        state.acpSessionId = session.id
        state.cwd = options.cwd
        state.sent = []
        state.assistantText = ''
        state.poisoned = false
        startIndex = 0
        this.#created++
      }

      const session = state.session
      if (session === undefined) throw new ProtocolError('no ACP session is available for this turn')

      await options.configureSession(session, resumed)
      const prompt =
        startIndex === 0
          ? await buildPromptBlocks(
              { system: options.system, messages: options.messages, tools: options.tools },
              session.capabilities.prompt,
              options.attachments ?? NO_ATTACHMENTS,
            )
          : await buildDeltaBlocks(
              { system: options.system, messages: options.messages, tools: options.tools },
              startIndex,
              session.capabilities.prompt,
              options.attachments ?? NO_ATTACHMENTS,
              { systemChanged, toolsChanged },
            )
      this.#warn(prompt.warnings)

      if (prompt.blocks.length === 0) {
        // Nothing new to say (for example a retry with an unchanged history). Replay from scratch rather than
        // sending an empty prompt, which some agents reject.
        await session.close().catch(() => {})
        state.session = undefined
        state.sent = []
        state.assistantText = ''
        const fresh = await this.#backend.createSession({
          cwd: options.cwd,
          handlers: this.#handlers(options, state),
        })
        state.session = fresh
        state.acpSessionId = fresh.id
        this.#created++
        await options.configureSession(fresh, false)
        const full = await buildPromptBlocks(
          { system: options.system, messages: options.messages, tools: options.tools },
          fresh.capabilities.prompt,
          options.attachments ?? NO_ATTACHMENTS,
        )
        this.#warn(full.warnings)
        const stopReason = await fresh.prompt(full.blocks, options.signal)
        this.#commit(state, fingerprints, options, systemHash, toolsHash)
        return {
          stopReason,
          reused: false,
          resumed: false,
          acpSessionId: fresh.id,
          warnings: full.warnings,
        }
      }

      const stopReason = await session.prompt(prompt.blocks, options.signal)
      this.#commit(state, fingerprints, options, systemHash, toolsHash)
      if (reused) this.#reused++
      return {
        stopReason,
        reused,
        resumed,
        acpSessionId: session.id,
        warnings: prompt.warnings,
      }
    } catch (e) {
      state.assistantText = options.assistantText()
      if (isTransportFailure(e) || isUnknownSessionFailure(e)) {
        // Keep the ACP session id and history so the next turn can attempt a capability-gated resume.
        state.session = undefined
        this.#replayed++
      } else if (e instanceof CancelledError) {
        // The agent ignored `session/cancel`; its state is no longer trustworthy.
        state.poisoned = true
        state.session = undefined
      } else {
        state.poisoned = true
      }
      throw e
    } finally {
      state.current = undefined
      state.lastUsed = Date.now()
      this.#evict()
    }
  }

  /**
   * Decide where the new tail starts. `match` is the number of non-system messages the ACP session already has.
   * dsh appends the assistant message after a successful turn; verify it matches what we streamed before treating
   * it as part of the shared history. A missing assistant message (cancelled turn) is tolerated.
   */
  #deltaStart(match: number, messages: readonly MessageLike[], assistantText: string): number | undefined {
    if (match >= messages.length) return undefined
    const next = messages[match]!
    if (next.role !== 'assistant') return match
    if (messageText(next) === assistantText) return match + 1
    return undefined
  }

  #commit(
    state: SessionState,
    fingerprints: readonly string[],
    options: ContinuityRunOptions,
    systemHash: string,
    toolsHash: string,
  ): void {
    state.sent = [...fingerprints]
    state.assistantText = options.assistantText()
    state.systemHash = systemHash
    state.toolsHash = toolsHash
    state.model = options.model
    state.reasoningEffort = options.reasoningEffort
    state.cwd = options.cwd
    state.poisoned = false
    state.lastUsed = Date.now()
  }

  #newState(key: string, options: ContinuityRunOptions): SessionState {
    return {
      key,
      dshSessionId: options.dshSessionId,
      cwd: options.cwd,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      systemHash: '',
      toolsHash: '',
      sent: [],
      assistantText: '',
      lastUsed: Date.now(),
      poisoned: false,
    }
  }

  #handlers(options: ContinuityRunOptions, state?: SessionState): AgentSessionHandlers {
    const turn: TurnHandlers = { onUpdate: options.onUpdate, onPermission: options.onPermission }
    if (state === undefined) {
      return {
        onUpdate: (update) => turn.onUpdate(update),
        onPermission: (request) => turn.onPermission(request),
      }
    }
    return {
      onUpdate: (update) => {
        try {
          state.current?.onUpdate(update)
        } catch (e) {
          this.#log.warn('session update handler threw', { message: (e as Error)?.message })
        }
      },
      onPermission: async (request) => {
        const current = state.current
        if (current === undefined) return { outcome: 'cancelled' }
        return current.onPermission(request)
      },
    }
  }

  #warn(warnings: readonly string[]): void {
    if (!this.#config.warnOnUnsupportedContent) return
    for (const warning of warnings) this.#log.warn(warning)
  }

  #evict(): void {
    const max = this.#config.maxSessions
    if (max <= 0 || this.#states.size <= max) return
    const candidates = [...this.#states.entries()]
      .filter(([, state]) => state.current === undefined)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [key, state] of candidates) {
      if (this.#states.size <= max) break
      this.#states.delete(key)
      this.#log.debug('evicting idle ACP session', { acpSession: state.acpSessionId })
      void state.session?.close().catch(() => {})
    }
  }

  #startIdleTimer(): void {
    const ms = this.#config.sessionIdleTimeoutMs
    if (ms <= 0) return
    const interval = Math.max(1_000, Math.min(60_000, Math.floor(ms / 4)))
    this.#idleTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, state] of [...this.#states]) {
        if (state.current !== undefined) continue
        if (now - state.lastUsed < ms) continue
        this.#states.delete(key)
        this.#log.debug('closing idle ACP session', { acpSession: state.acpSessionId })
        void state.session?.close().catch(() => {})
      }
    }, interval)
    this.#idleTimer.unref?.()
  }
}
