import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type { AcpCapabilities } from './backend.js'
import { EMPTY_CAPABILITIES } from './backend.js'
import type { AgyConfig } from './config.js'
import {
  AgyError,
  AuthRequiredError,
  CancelledError,
  CliMissingError,
  ProcessExitedError,
  ProtocolError,
  RequestTimeoutError,
  StartupTimeoutError,
  UnsupportedAcpError,
} from './errors.js'
import { redact, type Logger } from './log.js'
import type { AcpOutcome, PermissionOptionLike } from './permission.js'

/* ----------------------------------------------------------------------------------------------------------------
 * Thin, SDK-backed ACP client around ONE `agy acp` subprocess.
 *
 *  - All framing/JSON-RPC is done by `@agentclientprotocol/sdk` (`ndJsonStream`); stdout is the protocol channel
 *    and is never written to by us. stderr is drained separately and only ever goes to the logger.
 *  - We advertise NO client capabilities (no fs, no terminal): Antigravity runs its own tools, and everything that
 *    needs consent arrives as `session/request_permission`, which we hand to the caller's resolver.
 *  - We never call `authenticate`; the CLI owns login. If it says auth is required, we fail with instructions.
 * -------------------------------------------------------------------------------------------------------------- */

export type SessionUpdate = acp.SessionNotification['update']

export interface PermissionRequest {
  readonly sessionId: string
  readonly toolCall: {
    readonly toolCallId?: string
    readonly kind?: string | null
    readonly title?: string | null
    readonly name?: string | null
    readonly locations?: ReadonlyArray<{ path?: string }> | null
    readonly rawInput?: unknown
  }
  readonly options: readonly PermissionOptionLike[]
}

export interface SessionHandlers {
  onUpdate(update: SessionUpdate): void
  /** Must resolve to an ACP outcome. Rejections are treated as `cancelled`. Receives an abort signal for cancellation. */
  onPermission(request: PermissionRequest, signal: AbortSignal): Promise<AcpOutcome>
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

const CLIENT_INFO = { name: 'dsh-agy-acp', version: '0.2.0' } as const
const CANCEL_GRACE_MS = 5_000
const KILL_GRACE_MS = 2_000
const AUTH_REQUIRED_CODE = -32000

/**
 * Client capabilities we advertise. Deliberately minimal:
 *  - no `fs` and no `terminal`: the agent runs its own tools and asks us for permission instead;
 *  - `session.notices` and `session.compaction` so a newer agent may send those structured updates;
 *  - boolean config options so a newer agent may advertise them.
 * Advertising a capability is a promise to handle the corresponding requests/notifications; we handle the
 * session-scoped ones and reject unknown agent->client requests explicitly.
 */
const CLIENT_CAPABILITIES = {
  session: { notices: {}, compaction: {}, configOptions: { boolean: {} } },
} as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** Normalize the agent's `initialize` capabilities. Anything not explicitly `true`/present is unsupported. */
export function normalizeCapabilities(initializeResult: Record<string, unknown>): AcpCapabilities {
  const caps = asRecord(initializeResult.agentCapabilities) ?? {}
  const prompt = asRecord(caps.promptCapabilities) ?? {}
  const session = asRecord(caps.sessionCapabilities) ?? {}
  const mcp = asRecord(caps.mcpCapabilities) ?? {}
  return {
    protocolVersion: typeof initializeResult.protocolVersion === 'number' ? initializeResult.protocolVersion : 0,
    prompt: {
      image: prompt.image === true,
      audio: prompt.audio === true,
      embeddedContext: prompt.embeddedContext === true,
    },
    session: {
      load: caps.loadSession === true,
      resume: session.resume != null,
      close: session.close != null,
      list: session.list != null,
      delete: session.delete != null,
    },
    mcp: { http: mcp.http === true, sse: mcp.sse === true },
    raw: caps,
  }
}

/** Children we spawned and have not seen exit, so a hard process exit can't orphan them. */
const liveChildren = new Set<ChildProcess>()
let exitHookInstalled = false
function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const child of liveChildren) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  })
}

interface Connection {
  readonly child: ChildProcess
  conn: acp.ClientConnection
  /** Rejects (never resolves) when the process dies or stdio closes. */
  readonly died: Promise<never>
  exited: boolean
  /** Set when we are deliberately terminating the child. */
  stopping?: boolean
  readonly stderr: { tail: string }
  initializeResult: Record<string, unknown>
}

/**
 * One in-flight prompt. Permission waits belong to the prompt, not the session, so a persistent session can be
 * reused after a cancelled turn without inheriting an already-aborted permission signal.
 */
interface ActivePrompt {
  readonly permissionAbort: AbortController
  /** Set once the caller (or a timeout) asked to cancel; used to map the JSON-RPC abort error to `cancelled`. */
  cancelled: boolean
  /** Releases the prompt wait after the cancel grace period when the agent ignores `session/cancel`. */
  cancel: () => void
}

interface SessionEntry {
  handlers: SessionHandlers
  activity: () => void
  pauseActivity: () => () => void
  /** Present only while a prompt is active; stale permission requests are rejected. */
  activePrompt?: ActivePrompt | undefined
}

export class AcpProcess {
  readonly #config: AgyConfig
  readonly #log: Logger
  #connection: Connection | undefined
  #starting: Promise<Connection> | undefined
  readonly #sessions = new Map<string, SessionEntry>()
  #disposed = false
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #generation = 0
  /** Last negotiated capabilities, retained across idle stops so model metadata stays accurate. */
  #capabilities: AcpCapabilities = EMPTY_CAPABILITIES

  constructor(config: AgyConfig, log: Logger) {
    this.#config = config
    this.#log = log
  }

  get disposed(): boolean {
    return this.#disposed
  }
  get activeSessions(): number {
    return this.#sessions.size
  }
  get running(): boolean {
    return this.#connection !== undefined && !this.#connection.exited
  }

  /**
   * Capabilities advertised by the current ACP server. Before the first successful `initialize` every optional
   * feature is negative, which is the safe default for capability-gated operations (`session/load`, images, …).
   */
  get capabilities(): AcpCapabilities {
    const init = this.#connection?.initializeResult
    return init === undefined ? this.#capabilities : normalizeCapabilities(init)
  }

  /* ----------------------------------------------------------------------------------------------- lifecycle */

  /** Start (or restart after a crash/idle stop) the subprocess and complete ACP initialization. */
  async ensureStarted(): Promise<void> {
    await this.#ensure()
  }

  async #ensure(): Promise<Connection> {
    if (this.#disposed) throw new AgyError('The Antigravity ACP client has been disposed.')
    this.#clearIdle()
    if (this.#connection && !this.#connection.exited) return this.#connection
    if (this.#starting) return this.#starting
    const starting = this.#start().finally(() => {
      if (this.#starting === starting) this.#starting = undefined
    })
    this.#starting = starting
    return starting
  }

  async #start(): Promise<Connection> {
    const { command, args, startupTimeoutMs } = this.#config
    const generation = ++this.#generation
    this.#log.debug('spawning', { command, args })
    installExitHook()

    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    liveChildren.add(child)

    const stderr = { tail: '' }
    let spawnFailure: unknown
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let rejectDied: (e: unknown) => void = () => {}
    const died = new Promise<never>((_, reject) => {
      rejectDied = reject
    })
    died.catch(() => {}) // never an unhandled rejection; consumers race against it explicitly

    const state: Connection = {
      child,
      conn: undefined as unknown as acp.ClientConnection,
      died,
      exited: false,
      stderr,
      initializeResult: {},
    }

    const markDead = (detail: string) => {
      if (state.exited) return
      state.exited = true
      liveChildren.delete(child)
      const err = new ProcessExitedError(detail, stderr.tail.trim())
      // Only unexpected terminations are warnings; our own stop/dispose is routine.
      if (this.#disposed || state.stopping) this.#log.debug('process terminated', { detail })
      else this.#log.warn('process terminated', { detail })
      rejectDied(err)
      // Release anything waiting on the user for this dead process, and tell sessions it is over.
      for (const entry of this.#sessions.values()) entry.activePrompt?.permissionAbort.abort(err)
      // The dead process owns no live ACP sessions. Clearing them lets a later `session/load` / `session/resume`
      // attempt reuse the same id on the restarted process instead of being rejected as "already active".
      this.#sessions.clear()
      // If the connection died but the child is still alive, do not orphan it. Intentional stop/dispose paths set
      // `stopping`/`disposed` and handle termination themselves.
      if (!this.#disposed && state.stopping !== true) {
        try {
          child.kill('SIGTERM')
        } catch {
          /* already gone */
        }
      }
      if (this.#generation === generation && this.#connection === state) this.#connection = undefined
    }

    // stderr is drained continuously (a full pipe would deadlock the child) and kept strictly separate from stdout.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      const safe = redact(chunk)
      stderr.tail = (stderr.tail + safe).slice(-4096)
      if (this.#log.enabled) for (const line of safe.split(/\r?\n/)) if (line.trim()) this.#log.debug('agy stderr: ' + line)
    })
    child.stdin.on('error', () => {
      /* EPIPE after the child died is reported through 'exit' */
    })
    let settleChild: () => void = () => {}
    const childSettled = new Promise<void>((resolve) => {
      settleChild = resolve
    })
    child.on('error', (err) => {
      spawnFailure = err
      markDead(`spawn error: ${(err as NodeJS.ErrnoException).code ?? err.message}`)
      settleChild()
    })
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal }
      markDead(`exit code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}`)
      settleChild()
    })

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )

    const app = acp
      .client({ name: 'dsh-agy-acp' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.#handlePermission(ctx.params, ctx.signal))
      // Diagnostics only: record any agent->client request this client does not implement (the SDK still answers
      // it with JSON-RPC "method not found"; we never improvise a result).
      .onRequest('*', (ctx) => {
        this.#log.warn('agent sent an unsupported request', { method: ctx.method })
        throw new acp.RequestError(-32601, `Method not found: ${ctx.method}`)
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const entry = this.#sessions.get(ctx.params.sessionId)
        if (!entry) return
        entry.activity()
        this.#log.debug('session/update', { type: (ctx.params.update as { sessionUpdate?: string }).sessionUpdate })
        try {
          entry.handlers.onUpdate(ctx.params.update)
        } catch (e) {
          this.#log.warn('session update handler threw', { message: (e as Error).message })
        }
      })

    state.conn = app.connect(stream)
    void state.conn.closed.then(
      () => markDead('connection closed'),
      (e) => markDead(`connection error: ${(e as Error)?.message ?? String(e)}`),
    )

    const kill = () => void this.#kill(state)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StartupTimeoutError(startupTimeoutMs)), startupTimeoutMs)
    })
    timeout.catch(() => {})

    try {
      const init = (await Promise.race([
        state.conn.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          // No fs / terminal capabilities: Antigravity uses its own tools and asks us for permission instead.
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: CLIENT_INFO,
        }),
        died,
        timeout,
      ])) as unknown as Record<string, unknown>

      if (!init || typeof init !== 'object' || typeof init.protocolVersion !== 'number') {
        throw new UnsupportedAcpError('malformed initialize response', stderr.tail.trim())
      }
      if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw new UnsupportedAcpError(
          `server speaks ACP v${String(init.protocolVersion)}, client supports v${acp.PROTOCOL_VERSION}`,
        )
      }
      state.initializeResult = init
      this.#capabilities = normalizeCapabilities(init)
      this.#connection = state
      this.#log.debug('initialized', { agentInfo: (init as { agentInfo?: unknown }).agentInfo })
      return state
    } catch (e) {
      // The SDK's stream error (e.g. "operation was aborted") routinely beats the child's own 'error'/'exit' event
      // by a tick. Give the real cause a moment to arrive so ENOENT / early exit are reported as such.
      let cause = e
      if (!(e instanceof AgyError) || e instanceof ProcessExitedError) {
        // The child's own 'error' (spawn failure) / 'exit' event is the authoritative cause; wait for it briefly.
        await Promise.race([childSettled, new Promise<void>((r) => setTimeout(r, 500))])
        const settled = await Promise.race([
          died.catch((x: unknown) => x),
          new Promise<undefined>((r) => setTimeout(r, 50, undefined)),
        ])
        if (settled instanceof ProcessExitedError) cause = settled
      }
      kill()
      throw this.#classifyStartupFailure(cause, { spawnFailure, exitInfo, stderr: stderr.tail.trim() })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  #classifyStartupFailure(
    e: unknown,
    ctx: { spawnFailure: unknown; exitInfo: { code: number | null } | undefined; stderr: string },
  ): Error {
    if (e instanceof StartupTimeoutError || e instanceof UnsupportedAcpError) return e
    const sf = ctx.spawnFailure as NodeJS.ErrnoException | undefined
    if (sf && (sf.code === 'ENOENT' || sf.code === 'EACCES' || sf.code === 'ENOTDIR')) {
      return new CliMissingError(this.#config.command, sf)
    }
    if (sf) return new UnsupportedAcpError(`failed to spawn: ${sf.message}`)
    if (e instanceof ProcessExitedError) {
      return new UnsupportedAcpError(
        `process exited during initialization${ctx.exitInfo ? ` with code ${ctx.exitInfo.code ?? 'null'}` : ''}`,
        ctx.stderr,
      )
    }
    if (e instanceof AgyError) return e
    const code = (e as { code?: number })?.code
    // JSON-RPC "method not found" for `initialize` => not an ACP server.
    if (code === -32601) return new UnsupportedAcpError('initialize is not implemented', ctx.stderr)
    return new UnsupportedAcpError(`initialize failed: ${(e as Error)?.message ?? String(e)}`, ctx.stderr)
  }

  async #kill(state: Connection): Promise<void> {
    state.stopping = true
    try {
      state.conn?.close()
    } catch {
      /* ignore */
    }
    try {
      state.child.stdin?.end()
    } catch {
      /* ignore */
    }
    if (state.exited) return
    const exited = new Promise<void>((resolve) => state.child.once('exit', () => resolve()))
    try {
      state.child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    let force: ReturnType<typeof setTimeout> | undefined
    const forced = new Promise<void>((resolve) => {
      force = setTimeout(() => {
        try {
          state.child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve()
      }, KILL_GRACE_MS)
    })
    await Promise.race([exited, forced])
    if (force) clearTimeout(force)
  }

  /** Stop the subprocess but keep this object usable (it restarts on next use). */
  async stop(): Promise<void> {
    this.#clearIdle()
    const conn = this.#connection
    this.#connection = undefined
    // A stopped process owns no live ACP sessions. Release waiters and forget the entries so the next use starts
    // from a clean slate (the continuity layer will recreate or resume its sessions).
    for (const entry of this.#sessions.values()) entry.activePrompt?.permissionAbort.abort(new CancelledError())
    this.#sessions.clear()
    if (conn) await this.#kill(conn)
  }

  /** Permanently shut down: cancel sessions, terminate the subprocess, release everything. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#clearIdle()
    for (const [id, entry] of this.#sessions) {
      entry.activePrompt?.permissionAbort.abort(new CancelledError())
      void this.#connection?.conn.agent
        .notify(acp.methods.agent.session.cancel, { sessionId: id })
        .catch(() => {})
    }
    this.#sessions.clear()
    const pending = this.#starting
    const conn = this.#connection
    this.#connection = undefined
    if (pending) await pending.then((c) => this.#kill(c), () => {})
    if (conn) await this.#kill(conn)
  }

  #clearIdle() {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
  }

  #maybeScheduleIdle() {
    const ms = this.#config.idleTimeoutMs
    if (ms <= 0 || this.#sessions.size > 0 || this.#disposed || !this.running || this.#idleTimer) return
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined
      if (this.#sessions.size === 0) {
        this.#log.debug('idle timeout; stopping subprocess')
        void this.stop()
      }
    }, ms)
    this.#idleTimer.unref?.()
  }

  /* ------------------------------------------------------------------------------------------- permissions */

  async #handlePermission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const entry = this.#sessions.get(params.sessionId)
    this.#log.debug('session/request_permission received', {
      acpSession: params.sessionId,
      kind: (params.toolCall as { kind?: unknown }).kind,
      optionKinds: (params.options as Array<{ kind: string }>).map((o) => o.kind),
      knownSession: entry !== undefined,
    })
    // Fail closed: an unknown session, no active prompt, or no resolver never auto-approves. A request that
    // arrives after its prompt settled is stale; answering it could authorize work the user never saw.
    if (!entry) return { outcome: { outcome: 'cancelled' } }
    const prompt = entry.activePrompt
    if (prompt === undefined || prompt.cancelled) {
      this.#log.debug('rejecting a stale permission request', { acpSession: params.sessionId })
      return { outcome: { outcome: 'cancelled' } }
    }
    const resume = entry.pauseActivity() // waiting on a human must not trip the inactivity timeout
    const merged = new AbortController()
    const abort = () => merged.abort()
    signal.addEventListener('abort', abort, { once: true })
    prompt.permissionAbort.signal.addEventListener('abort', abort, { once: true })
    try {
      const outcome = await entry.handlers.onPermission(
        {
          sessionId: params.sessionId,
          toolCall: params.toolCall as PermissionRequest['toolCall'],
          options: params.options as unknown as PermissionOptionLike[],
        },
        merged.signal,
      )
      // The prompt may have ended (or been replaced) while the user was deciding. Never apply a decision to a
      // different turn than the one that asked.
      if (merged.signal.aborted || prompt.cancelled || entry.activePrompt !== prompt) {
        return { outcome: { outcome: 'cancelled' } }
      }
      return { outcome } as acp.RequestPermissionResponse
    } catch (e) {
      this.#log.warn('permission resolver failed; cancelling', { message: (e as Error)?.message })
      return { outcome: { outcome: 'cancelled' } }
    } finally {
      signal.removeEventListener('abort', abort)
      prompt.permissionAbort.signal.removeEventListener('abort', abort)
      resume()
    }
  }

  /* ----------------------------------------------------------------------------------------------- sessions */

  async openSession(cwd: string, handlers: SessionHandlers): Promise<AcpSession> {
    const state = await this.#ensure()
    const res = (await this.#request(state, 'session/new', () =>
      state.conn.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }),
    )) as { sessionId?: unknown } & Record<string, unknown>

    if (!res || typeof res !== 'object' || typeof res.sessionId !== 'string' || res.sessionId === '') {
      throw new ProtocolError('session/new returned a malformed response (missing sessionId)')
    }
    const sessionId = res.sessionId
    const { entry, probe } = this.#registerSession(handlers)
    this.#sessions.set(sessionId, entry)
    this.#clearIdle()
    return new AcpSession(this, state, sessionId, res, entry, probe, false)
  }

  /**
   * Restore a persisted ACP session with `session/load` (the agent replays prior updates through the handlers).
   * Only available when the agent advertised the top-level `loadSession` capability.
   */
  async loadSession(cwd: string, sessionId: string, handlers: SessionHandlers): Promise<AcpSession> {
    const state = await this.#ensure()
    if (!this.capabilities.session.load) {
      throw new UnsupportedAcpError('the agent does not advertise the `loadSession` capability')
    }
    return this.#restoreSession(state, cwd, sessionId, handlers, 'session/load', () =>
      state.conn.agent.request(acp.methods.agent.session.load, {
        cwd,
        mcpServers: [],
        sessionId,
      } as never),
    )
  }

  /**
   * Restore a persisted ACP session with `session/resume` (no history replay). Only available when the agent
   * advertised `sessionCapabilities.resume`.
   */
  async resumeSession(cwd: string, sessionId: string, handlers: SessionHandlers): Promise<AcpSession> {
    const state = await this.#ensure()
    if (!this.capabilities.session.resume) {
      throw new UnsupportedAcpError('the agent does not advertise the `session/resume` capability')
    }
    return this.#restoreSession(state, cwd, sessionId, handlers, 'session/resume', () =>
      state.conn.agent.request(acp.methods.agent.session.resume, {
        cwd,
        mcpServers: [],
        sessionId,
      } as never),
    )
  }

  async #restoreSession(
    state: Connection,
    cwd: string,
    sessionId: string,
    handlers: SessionHandlers,
    what: string,
    run: () => Promise<unknown>,
  ): Promise<AcpSession> {
    if (sessionId === '') throw new ProtocolError(`${what} requires a non-empty session id`)
    if (this.#sessions.has(sessionId)) {
      throw new ProtocolError(`ACP session "${sessionId}" is already active in this process`)
    }
    const { entry, probe } = this.#registerSession(handlers)
    // Register before the request: `session/load` replays prior updates as notifications, and they must reach
    // this session's handlers rather than being dropped as an unknown session.
    this.#sessions.set(sessionId, entry)
    this.#clearIdle()
    try {
      const res = (await this.#request(state, what, run)) as Record<string, unknown> | undefined
      return new AcpSession(this, state, sessionId, res ?? {}, entry, probe, true)
    } catch (e) {
      this.#sessions.delete(sessionId)
      entry.activePrompt?.permissionAbort.abort(new CancelledError())
      this.#maybeScheduleIdle()
      throw e
    }
  }

  #registerSession(handlers: SessionHandlers): {
    entry: SessionEntry
    probe: () => { lastActivity: number; paused: number }
  } {
    let lastActivity = Date.now()
    let paused = 0
    const entry: SessionEntry = {
      handlers,
      activity: () => {
        lastActivity = Date.now()
      },
      pauseActivity: () => {
        paused++
        return () => {
          paused--
          lastActivity = Date.now()
        }
      },
    }
    return { entry, probe: () => ({ lastActivity, paused }) }
  }

  /** @internal */
  async _request<T>(state: Connection, what: string, run: () => Promise<T>): Promise<T> {
    return this.#request(state, what, run)
  }

  async #request<T>(state: Connection, what: string, run: () => Promise<T>): Promise<T> {
    const ms = this.#config.requestTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RequestTimeoutError(what, ms)), ms)
    })
    timeout.catch(() => {})
    try {
      return await Promise.race([run(), state.died, timeout])
    } catch (e) {
      throw await this.#mapRpcError(e, state)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** @internal */
  _mapRpcError(e: unknown, state: Connection): Promise<Error> {
    return this.#mapRpcError(e, state)
  }

  async #mapRpcError(e: unknown, state: Connection): Promise<Error> {
    if (e instanceof AgyError) return e
    const err = e as { code?: number; message?: string; data?: unknown }
    // The SDK reports a dropped pipe ("ACP connection closed") a moment before the child's 'exit' event is seen.
    // Normalise both to ProcessExitedError (with stderr context) so callers see one stable failure mode.
    if (/connection closed|stream (closed|ended)|EPIPE|broken pipe/i.test(err?.message ?? '') || state.exited) {
      const settled = await Promise.race([
        state.died.catch((x: unknown) => x),
        new Promise<undefined>((resolve) => setTimeout(resolve, 500, undefined)),
      ])
      return settled instanceof ProcessExitedError
        ? settled
        : new ProcessExitedError('connection closed', state.stderr.tail.trim())
    }
    if (
      err?.code === AUTH_REQUIRED_CODE ||
      /auth(entication)? required|not (logged|signed) in|please log ?in/i.test(err?.message ?? '')
    ) {
      return new AuthRequiredError()
    }
    return new ProtocolError(`ACP error${err?.code !== undefined ? ` ${err.code}` : ''}: ${err?.message ?? String(e)}`)
  }

  /** @internal */
  _releaseSession(sessionId: string) {
    this.#sessions.delete(sessionId)
    this.#maybeScheduleIdle()
  }
  /** @internal */
  get _config() {
    return this.#config
  }
  /** @internal */
  get _log() {
    return this.#log
  }
}

export class AcpSession {
  #closed = false
  #activePrompt: ActivePrompt | undefined

  constructor(
    private readonly proc: AcpProcess,
    private readonly state: Connection,
    readonly sessionId: string,
    /** The raw `session/new`, `session/load`, or `session/resume` response. */
    readonly response: Record<string, unknown>,
    private readonly entry: SessionEntry,
    private readonly activityProbe: () => { lastActivity: number; paused: number },
    /** True when the session was restored rather than freshly created. */
    readonly resumed: boolean = false,
  ) {}

  get closed(): boolean {
    return this.#closed
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    await this.proc._request(this.state, 'session/set_config_option', () =>
      this.state.conn.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.sessionId,
        configId,
        value,
      } as never),
    )
  }

  /** Apply one standard `session/set_mode` value (used when a resumed session returns no config options). */
  async setMode(modeId: string): Promise<void> {
    await this.proc._request(this.state, 'session/set_mode', () =>
      this.state.conn.agent.request(acp.methods.agent.session.setMode, {
        sessionId: this.sessionId,
        modeId,
      } as never),
    )
  }

  /**
   * Run one prompt turn. Resolves with the stop reason (`cancelled` when `signal` aborts).
   * Streaming updates and permission requests are delivered through the handlers given to the opener.
   *
   * `content` accepts a plain string for backwards compatibility, or the full ACP content-block array (text,
   * images, resources) when the caller has negotiated the corresponding capability.
   */
  async prompt(content: string | readonly acp.ContentBlock[], signal?: AbortSignal): Promise<StopReason> {
    if (this.#closed) throw new ProtocolError('cannot prompt a closed ACP session')
    if (this.#activePrompt !== undefined) {
      throw new ProtocolError('another prompt is already active on this ACP session')
    }
    const { conn } = this.state
    const idleMs = this.proc._config.requestTimeoutMs
    let timedOut = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setInterval> | undefined

    let rejectEarly: (e: unknown) => void = () => {}
    const early = new Promise<never>((_, reject) => {
      rejectEarly = reject
    })
    early.catch(() => {})

    const promptState: ActivePrompt = {
      permissionAbort: new AbortController(),
      cancelled: false,
      cancel: () => {},
    }
    const cancel = () => {
      if (promptState.cancelled) return
      promptState.cancelled = true
      promptState.permissionAbort.abort(new CancelledError()) // release any pending approval immediately
      void conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => {})
      // A well-behaved agent answers the prompt with stopReason "cancelled". If it does not, stop waiting.
      graceTimer = setTimeout(() => rejectEarly(new CancelledError()), CANCEL_GRACE_MS)
    }
    promptState.cancel = cancel
    this.#activePrompt = promptState
    this.entry.activePrompt = promptState

    const onAbort = () => cancel()
    if (signal?.aborted) {
      cancel()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }

    // Inactivity watchdog: any update/permission activity resets it; time spent waiting on a human is excluded.
    idleTimer = setInterval(
      () => {
        const { lastActivity, paused } = this.activityProbe()
        if (paused === 0 && !promptState.cancelled && Date.now() - lastActivity > idleMs) {
          timedOut = true
          cancel()
          clearTimeout(graceTimer)
          graceTimer = setTimeout(() => rejectEarly(new RequestTimeoutError('session/prompt', idleMs)), 1_000)
        }
      },
      Math.max(50, Math.min(1_000, Math.floor(idleMs / 4))),
    )
    this.entry.activity()

    // An already-aborted caller must not send a prompt at all; `cancel()` above already notified the agent and
    // armed the grace timer, so release our state and return without waiting for a turn that was never requested.
    if (signal?.aborted === true) {
      clearInterval(idleTimer)
      clearTimeout(graceTimer)
      signal.removeEventListener('abort', onAbort)
      promptState.permissionAbort.abort(new CancelledError())
      if (this.#activePrompt === promptState) this.#activePrompt = undefined
      if (this.entry.activePrompt === promptState) this.entry.activePrompt = undefined
      return 'cancelled'
    }

    const prompt = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : [...content]
    try {
      const response = (await Promise.race([
        conn.agent.request(acp.methods.agent.session.prompt, {
          sessionId: this.sessionId,
          prompt,
        }),
        this.state.died,
        early,
      ])) as { stopReason?: unknown }
      if (typeof response?.stopReason !== 'string') {
        throw new ProtocolError('session/prompt returned a malformed response (missing stopReason)')
      }
      if (timedOut) throw new RequestTimeoutError('session/prompt', idleMs)
      return response.stopReason as StopReason
    } catch (e) {
      if (promptState.cancelled && !timedOut && (e instanceof CancelledError || (e as { code?: number })?.code === -32800)) {
        return 'cancelled'
      }
      throw await this.proc._mapRpcError(e, this.state)
    } finally {
      signal?.removeEventListener('abort', onAbort)
      clearInterval(idleTimer)
      clearTimeout(graceTimer)
      // Release any permission waiter and detach the prompt so a late request is rejected as stale.
      promptState.permissionAbort.abort(new CancelledError())
      if (this.#activePrompt === promptState) this.#activePrompt = undefined
      if (this.entry.activePrompt === promptState) this.entry.activePrompt = undefined
    }
  }

  /**
   * Ask the agent to cancel the active prompt without closing the session. The prompt's own abort path performs
   * the same work; this is for callers that hold a session handle rather than the prompt's signal.
   */
  cancel(): void {
    this.#activePrompt?.cancel()
  }

  /** Release the ACP session on the agent (best effort) and stop routing its updates. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    // Ask the agent to stop any active work before releasing the session (ACP `session/close` also requires this,
    // and agents that do not implement close still get the cancel notification).
    this.#activePrompt?.cancel()
    this.#activePrompt?.permissionAbort.abort(new CancelledError())
    this.#activePrompt = undefined
    this.entry.activePrompt = undefined
    this.proc._releaseSession(this.sessionId)
    if (this.state.exited) return
    try {
      if (this.proc.capabilities.session.close) {
        await Promise.race([
          this.state.conn.agent.request(acp.methods.agent.session.close, { sessionId: this.sessionId }),
          this.state.died,
          new Promise((resolve) => setTimeout(resolve, 2_000).unref?.()),
        ])
      }
    } catch {
      /* best effort */
    }
  }
}
