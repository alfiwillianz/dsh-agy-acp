import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  ReasoningEffortId,
  ToolCallId,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import type { AcpAgentBackend, AgentSession, AgentUpdate } from './backend.js'
import { AcpAgentBackendImpl } from './acp-backend.js'
import type { AcpProcess, PermissionRequest, StopReason } from './acp-process.js'
import type { AgyConfig } from './config.js'
import { SessionContinuity, type ContinuityResult } from './continuity.js'
import { AgyError, errorCode } from './errors.js'
import { createAttachmentResolver } from './attachments.js'
import { planText, translateUpdate } from './events.js'
import { describeError } from './turn.js'
import type { Logger } from './log.js'
import {
  advertisedLevelsFor,
  configStepsForModel,
  knownLimits,
  modeStep,
  orderThinkingLevels,
  thoughtLevelStep,
  type ModelFamily,
} from './models.js'
import { chooseOutcome, describeToolCall, type AcpOutcome, type PermissionOptionLike } from './permission.js'
import { buildPrompt, type MessageLike } from './prompt.js'
import { recordAcpSession, recordAcpTool, recordAcpUpdate } from './records.js'
import { discoverGeminiModels, runTurn, type AcpFrame } from './turn.js'

/* ----------------------------------------------------------------------------------------------------------------
 * dsh LLM adapter backed by Google's official `agy acp` server.
 *
 *     dsh agent loop ── GenerateOptions ──▶ this adapter ── ACP turn over `agy acp` ──▶ StreamChunk
 *
 * Antigravity is an *agent*: it runs its own tool loop. dsh has no provider-executed tool concept, so its tool
 * activity is surfaced as compact text blocks (configurable) instead of tool-call chunks the loop would try to
 * execute. dsh's tool definitions are not forwarded; the prompt explains that to the agent.
 *
 * Main calls with a dsh session id use the persistent ACP session layer (`SessionContinuity`); auxiliary calls
 * (title generation, compaction) and calls without a session id use a fresh, ephemeral ACP session.
 * -------------------------------------------------------------------------------------------------------------- */

const PROVIDER_NAME = 'Antigravity (Gemini via ACP)'

interface OpenBlock {
  index: number
  type: 'text' | 'reasoning'
  text: string
}

function closeChunk(block: OpenBlock | undefined): StreamChunk | undefined {
  if (block === undefined) return undefined
  return {
    type: 'block-end',
    index: block.index,
    block:
      block.type === 'text'
        ? { type: 'text', text: block.text }
        : { type: 'reasoning', text: block.text },
  }
}

function finishAborted(message = 'Antigravity turn cancelled'): StreamChunk {
  return { type: 'finish', reason: { kind: 'aborted', failure: { message, code: 'ABORTED' } } }
}

function finishError(message: string, code: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

function mapStop(reason: StopReason, aborted: boolean): FinishReason {
  if (aborted || reason === 'cancelled') {
    return { kind: 'aborted', failure: { message: 'Antigravity turn cancelled', code: 'ABORTED' } }
  }
  if (reason === 'max_tokens') return { kind: 'max-tokens' }
  // `refusal` and `max_turn_requests` are legitimate final answers in dsh's vocabulary.
  return { kind: 'stop' }
}

/** Display names for thinking levels whose id is not self-explanatory (`xhigh` is Hydrogen's "Extra" level). */
const EFFORT_NAMES: Readonly<Record<string, string>> = { xhigh: 'Extra High' }

function effortName(level: string): string {
  if (level === '') return level
  return EFFORT_NAMES[level] ?? level.charAt(0).toUpperCase() + level.slice(1)
}

function truncate(text: string, max = 600): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function toolCallLine(frame: Extract<AcpFrame, { kind: 'tool_call' }>): string {
  return `\n[agy ${frame.name}] ${frame.title}\n`
}

function toolUpdateLine(
  frame: Extract<AcpFrame, { kind: 'tool_update' }>,
  knownTitle: string | undefined,
): string | undefined {
  if (frame.status !== 'completed' && frame.status !== 'failed') return undefined
  const title = frame.title ?? knownTitle ?? frame.id
  const output = frame.output ? `\n${truncate(frame.output)}` : ''
  return `\n[agy] ${title} — ${frame.status}${output}\n`
}

/** Minimal async queue bridging callback-based ACP turns into async generators. */
class Queue<T> implements AsyncIterable<T> {
  readonly #items: T[] = []
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = []
  #ended = false

  push(item: T): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value: item, done: false })
    else this.#items.push(item)
  }

  end(): void {
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.#ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

type PersistentEvent =
  | { readonly kind: 'update'; readonly update: AgentUpdate }
  | { readonly kind: 'done'; readonly result: ContinuityResult }
  | { readonly kind: 'failed'; readonly error: unknown }

interface PermissionRequestLike {
  readonly toolCall: PermissionRequest['toolCall']
  readonly options: readonly PermissionOptionLike[]
  /** Present on backend requests; the legacy `runTurn` path passes the signal separately. */
  readonly signal?: AbortSignal
}

export class AgyAcpAdapter extends LlmAdapter {
  #catalog: { at: number; models: ModelFamily[] } | undefined
  #inflight: Promise<ModelFamily[]> | undefined
  readonly #backend: AcpAgentBackend
  readonly #continuity: SessionContinuity
  /** Last configuration applied per ACP session, so steady-state turns do not re-send config requests. */
  readonly #configured = new Map<string, string>()
  readonly #recordedSessions = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly config: AgyConfig,
    private readonly proc: AcpProcess,
    private readonly log: Logger,
  ) {
    super()
    this.#backend = new AcpAgentBackendImpl(proc, log)
    this.#continuity = new SessionContinuity(this.#backend, config, log)
  }

  /** Close persistent ACP sessions and terminate the subprocess. Idempotent. */
  async dispose(): Promise<void> {
    await this.#continuity.dispose()
    await this.#backend.dispose()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.#catalogFor()
    const inputModalities = this.#inputModalities()
    return models.map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      inputModalities,
    }))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const models = await this.#catalogFor()
    const family = models.find((m) => m.id === model)
    const limits = knownLimits(model)
    const efforts = orderThinkingLevels(family?.levels ?? []).map((level) => ({
      id: ReasoningEffortId(level),
      name: effortName(level),
    }))
    return {
      provider,
      id: model,
      name: family?.name ?? model,
      inputModalities: this.#inputModalities(),
      ...(limits === undefined
        ? {}
        : { context: { contextWindow: limits.context }, defaultMaxTokens: limits.output }),
      ...(efforts.length === 0 ? {} : { reasoning: { efforts } }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const callerSignal = options.signal
    if (callerSignal?.aborted === true) {
      yield finishAborted()
      return
    }

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    callerSignal?.addEventListener('abort', onAbort, { once: true })
    try {
      const agent = this.#agent(options.sessionId)
      const cwd = this.#cwd(agent)
      const persistent =
        this.config.sessionContinuity && options.sessionId !== undefined && options.purpose === undefined
      if (persistent) yield* this.#runPersistent(options, cwd, controller.signal)
      else yield* this.#run(options, cwd, controller.signal)
    } finally {
      callerSignal?.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }

  /* ------------------------------------------------------------------------------------------------- discovery */

  #inputModalities(): ('text' | 'image')[] {
    const attachments = this.ctx.get('attachments', false)
    const image = this.config.imageInput && attachments !== undefined && this.proc.capabilities.prompt.image
    return image ? ['text', 'image'] : ['text']
  }

  async #catalogFor(): Promise<ModelFamily[]> {
    const now = Date.now()
    if (this.#catalog !== undefined && now - this.#catalog.at < this.config.modelsRefreshMs) {
      return this.#catalog.models
    }
    if (this.#inflight !== undefined) return this.#inflight

    const run = (async (): Promise<ModelFamily[]> => {
      try {
        const models = await discoverGeminiModels(this.config, process.cwd(), this.proc)
        this.#catalog = { at: Date.now(), models }
        if (models.length === 0) {
          this.log.warn('Antigravity ACP server reported no Gemini models')
        } else {
          this.log.debug('discovered models', { count: models.length })
        }
        return models
      } catch (e) {
        this.log.error(describeError(e))
        // Cache the failure briefly so a picker refresh does not spawn a subprocess per keystroke.
        this.#catalog = { at: Date.now(), models: [] }
        return []
      } finally {
        this.#inflight = undefined
      }
    })()
    this.#inflight = run
    return run
  }

  /* --------------------------------------------------------------------------------------------- ephemeral turn */

  async *#run(options: GenerateOptions, cwd: string, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const frames = new Queue<AcpFrame>()
    const prompt = buildPrompt(options)
    const turn = runTurn(
      {
        config: this.config,
        model: options.model,
        prompt,
        thoughtLevel: options.reasoningEffort,
        cwd,
        onPermission: (request, permissionSignal) => this.#askApproval(options, request, permissionSignal),
      },
      signal,
      (frame) => frames.push(frame),
      this.proc,
    )
    void turn.catch(() => {}).finally(() => frames.end())

    let open: OpenBlock | undefined
    let nextIndex = 0
    const toolTitles = new Map<string, string>()

    for await (const frame of frames) {
      switch (frame.kind) {
        case 'text': {
          if (open?.type !== 'text') {
            const closed = closeChunk(open)
            if (closed) yield closed
            open = { index: nextIndex++, type: 'text', text: '' }
            yield { type: 'block-start', index: open.index, blockType: 'text' }
          }
          open.text += frame.text
          yield { type: 'text-delta', index: open.index, text: frame.text }
          break
        }
        case 'thought': {
          if (open?.type !== 'reasoning') {
            const closed = closeChunk(open)
            if (closed) yield closed
            open = { index: nextIndex++, type: 'reasoning', text: '' }
            yield { type: 'block-start', index: open.index, blockType: 'reasoning' }
          }
          open.text += frame.text
          yield { type: 'reasoning-delta', index: open.index, text: frame.text }
          break
        }
        case 'tool_call': {
          if (this.config.toolActivity === 'hidden') break
          toolTitles.set(frame.id, frame.title)
          if (open?.type !== 'text') {
            const closed = closeChunk(open)
            if (closed) yield closed
            open = { index: nextIndex++, type: 'text', text: '' }
            yield { type: 'block-start', index: open.index, blockType: 'text' }
          }
          const line = toolCallLine(frame)
          open.text += line
          yield { type: 'text-delta', index: open.index, text: line }
          break
        }
        case 'tool_update': {
          if (this.config.toolActivity === 'hidden') break
          const line = toolUpdateLine(frame, toolTitles.get(frame.id))
          if (line === undefined) break
          if (open?.type !== 'text') {
            const closed = closeChunk(open)
            if (closed) yield closed
            open = { index: nextIndex++, type: 'text', text: '' }
            yield { type: 'block-start', index: open.index, blockType: 'text' }
          }
          open.text += line
          yield { type: 'text-delta', index: open.index, text: line }
          break
        }
        case 'stop': {
          const closed = closeChunk(open)
          if (closed) yield closed
          open = undefined
          yield { type: 'finish', reason: mapStop(frame.reason, signal.aborted) }
          return
        }
        case 'error': {
          const closed = closeChunk(open)
          if (closed) yield closed
          open = undefined
          yield finishError(frame.message, frame.code)
          return
        }
      }
    }

    // `runTurn` always emits one terminal frame; reaching here means the queue ended unexpectedly.
    const closed = closeChunk(open)
    if (closed) yield closed
    yield finishError('Antigravity turn ended without a terminal frame', 'PROTOCOL')
  }

  /* --------------------------------------------------------------------------------------------- persistent turn */

  async *#runPersistent(options: GenerateOptions, cwd: string, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const events = new Queue<PersistentEvent>()
    const toolTitles = new Map<string, string>()
    const dshSession = this.#session(options.sessionId)
    let assistantText = ''
    let acpSessionId = ''

    const run = this.#continuity
      .run({
        dshSessionId: String(options.sessionId),
        cwd,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        system: options.system,
        messages: options.messages as unknown as MessageLike[],
        tools: options.tools,
        signal,
        onUpdate: (update) => {
          this.#rememberTool(update, toolTitles)
          assistantText += this.#textContribution(update, toolTitles)
          this.#recordUpdate(dshSession, acpSessionId, update)
          events.push({ kind: 'update', update })
        },
        onPermission: (request) => this.#askOutcome(options, request, signal),
        assistantText: () => assistantText,
        configureSession: async (session, resumed) => {
          acpSessionId = session.id
          await this.#configureSession(options, session, resumed)
          this.#recordSession(dshSession, session, cwd, resumed)
        },
        attachments: createAttachmentResolver(this.ctx, this.config.imageInput),
      })
      .then(
        (result) => events.push({ kind: 'done', result }),
        (error) => events.push({ kind: 'failed', error }),
      )
      .finally(() => events.end())
    void run

    let open: OpenBlock | undefined
    let nextIndex = 0

    for await (const event of events) {
      if (event.kind === 'update') {
        const update = event.update
        this.#rememberTool(update, toolTitles)
        if (update.kind === 'reasoning') {
          if (open?.type !== 'reasoning') {
            const closed = closeChunk(open)
            if (closed) yield closed
            open = { index: nextIndex++, type: 'reasoning', text: '' }
            yield { type: 'block-start', index: open.index, blockType: 'reasoning' }
          }
          open.text += update.text
          yield { type: 'reasoning-delta', index: open.index, text: update.text }
          continue
        }
        const text = this.#textContribution(update, toolTitles)
        if (text !== '') {
          if (open?.type !== 'text') {
            const closed = closeChunk(open)
            if (closed) yield closed
            open = { index: nextIndex++, type: 'text', text: '' }
            yield { type: 'block-start', index: open.index, blockType: 'text' }
          }
          open.text += text
          yield { type: 'text-delta', index: open.index, text }
        }
        if (update.kind === 'image' && this.ctx.get('attachments', false) !== undefined) {
          const block = await this.#saveImage(update)
          if (block !== undefined) {
            const closed = closeChunk(open)
            if (closed) yield closed
            open = undefined
            yield { type: 'block-start', index: nextIndex, blockType: 'image' }
            yield { type: 'block-end', index: nextIndex, block }
            nextIndex++
          } else {
            // The store exists but refused the image. Keep an explicit placeholder; the continuity fingerprint
            // intentionally does not include it, so the next turn replays rather than silently losing the image.
            const closed = closeChunk(open)
            if (closed) yield closed
            open = { index: nextIndex++, type: 'text', text: '' }
            yield { type: 'block-start', index: open.index, blockType: 'text' }
            const placeholder = '\n[agy image omitted: could not store it]\n'
            open.text += placeholder
            yield { type: 'text-delta', index: open.index, text: placeholder }
          }
        }
        continue
      }

      const closed = closeChunk(open)
      if (closed) yield closed
      open = undefined

      if (event.kind === 'done') {
        yield { type: 'finish', reason: mapStop(event.result.stopReason as StopReason, signal.aborted) }
        return
      }
      yield finishError(describeError(event.error), errorCode(event.error))
      return
    }

    const closed = closeChunk(open)
    if (closed) yield closed
    yield finishError('Antigravity turn ended without a terminal event', 'PROTOCOL')
  }

  #rememberTool(update: AgentUpdate, toolTitles: Map<string, string>): void {
    if (update.kind === 'tool-call') toolTitles.set(update.id, update.title)
    else if (update.kind === 'tool-update' && update.title !== undefined) toolTitles.set(update.id, update.title)
  }

  /** The exact text contribution of one update. Kept pure so the stream and the continuity fingerprint agree. */
  #textContribution(update: AgentUpdate, toolTitles: Map<string, string>): string {
    switch (update.kind) {
      case 'text':
        return update.text
      case 'reasoning':
      case 'user-text':
        return ''
      case 'image':
        // Assistant images are preserved as image blocks when the attachment store is composed. Without it the
        // image cannot be made durable, so say so explicitly instead of dropping it silently.
        return this.ctx.get('attachments', false) === undefined
          ? '\n[agy image omitted: no attachment store is composed]\n'
          : ''
      case 'tool-call':
        if (this.config.toolActivity === 'hidden') return ''
        return `\n[agy ${update.name}] ${update.title}\n`
      case 'tool-update': {
        if (this.config.toolActivity === 'hidden') return ''
        if (update.status !== 'completed' && update.status !== 'failed') return ''
        const title = update.title ?? toolTitles.get(update.id) ?? update.id
        const output = update.output ? `\n${truncate(update.output)}` : ''
        return `\n[agy] ${title} — ${update.status}${output}\n`
      }
      case 'plan':
        if (this.config.toolActivity === 'hidden') return ''
        return `\n[agy plan]\n${planText(update)}\n`
      case 'notice':
        return `\n[agy ${update.severity}] ${update.title}${update.description ? `: ${update.description}` : ''}\n`
      default:
        return ''
    }
  }

  async #saveImage(update: Extract<AgentUpdate, { kind: 'image' }>): Promise<{ type: 'image'; attachment: unknown } | undefined> {
    const store = this.ctx.get('attachments', false) as
      | {
          saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
        }
      | undefined
    if (store === undefined) return undefined
    try {
      const attachment = await store.saveImage({
        data: Buffer.from(update.data, 'base64'),
        mediaType: update.mimeType,
      })
      return { type: 'image', attachment }
    } catch (e) {
      this.log.debug('could not store an ACP image output', { message: (e as Error)?.message })
      return undefined
    }
  }

  #recordSession(session: Session | undefined, agentSession: AgentSession, cwd: string, resumed: boolean): void {
    if (!this.config.structuredEvents || session === undefined) return
    if (this.#recordedSessions.has(agentSession.id)) return
    this.#recordedSessions.add(agentSession.id)
    const caps = agentSession.capabilities
    recordAcpSession(session, this.log, {
      acpSessionId: agentSession.id,
      cwd,
      resumed,
      capabilities: {
        load: caps.session.load,
        resume: caps.session.resume,
        close: caps.session.close,
        image: caps.prompt.image,
        embeddedContext: caps.prompt.embeddedContext,
      },
    })
  }

  #recordUpdate(session: Session | undefined, acpSessionId: string, update: AgentUpdate): void {
    if (!this.config.structuredEvents || session === undefined || acpSessionId === '') return
    if (update.kind === 'tool-call') {
      recordAcpTool(session, this.log, {
        acpSessionId,
        toolCallId: update.id,
        ...(update.name === undefined ? {} : { name: update.name }),
        ...(update.title === undefined ? {} : { title: update.title }),
        ...(update.toolKind === undefined ? {} : { toolKind: update.toolKind }),
        ...(update.status === undefined ? {} : { status: update.status }),
        ...(update.locations === undefined ? {} : { locations: update.locations }),
        ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
      })
      return
    }
    if (update.kind === 'tool-update') {
      recordAcpTool(session, this.log, {
        acpSessionId,
        toolCallId: update.id,
        ...(update.name === undefined ? {} : { name: update.name }),
        ...(update.title === undefined ? {} : { title: update.title }),
        ...(update.status === undefined ? {} : { status: update.status }),
        ...(update.output === undefined ? {} : { output: update.output }),
        ...(update.contentKinds === undefined ? {} : { contentKinds: update.contentKinds }),
        ...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput }),
      })
      return
    }
    if (update.kind === 'plan' || update.kind === 'notice' || update.kind === 'usage' || update.kind === 'mode' || update.kind === 'config' || update.kind === 'session-info' || update.kind === 'compaction' || update.kind === 'unknown') {
      recordAcpUpdate(session, this.log, { acpSessionId, update })
    }
  }

  async #configureSession(options: GenerateOptions, session: AgentSession, resumed: boolean): Promise<void> {
    const desired = JSON.stringify([options.model, options.reasoningEffort ?? '', this.config.sessionMode])
    // A resumed session may have been configured by an earlier process (or by another client). Never trust the
    // in-memory cache for it: re-apply the model, effort, and restrictive mode before the first prompt.
    if (!resumed && this.#configured.get(session.id) === desired) return
    const response = session.info
    const configOptions = response.configOptions
    // A resumed session may not return its configuration. The restrictive mode is a security boundary, so it must
    // still be enforced: use the standard `session/set_mode` method and fail closed if the agent cannot confirm it.
    if (resumed && configOptions === undefined) {
      if (this.config.sessionMode === 'plan') {
        if (session.setMode === undefined) {
          throw new AgyError(
            'cannot enforce the restrictive "plan" session mode on a resumed ACP session: the agent returned no ' +
              'configuration and does not expose session/set_mode. Refusing to continue.',
          )
        }
        try {
          await session.setMode('plan')
        } catch (e) {
          throw new AgyError(
            `cannot enforce the restrictive "plan" session mode on a resumed ACP session (${(e as Error)?.message ?? String(e)}). ` +
              'Refusing to continue.',
          )
        }
      }
      this.#configured.set(session.id, desired)
      return
    }

    const levels = advertisedLevelsFor(response, options.model)
    const steps = configStepsForModel(options.model, configOptions, levels)
    const current = (response.models as { currentModelId?: unknown } | undefined)?.currentModelId
    if (steps.length === 0 && current !== options.model) {
      throw new AgyError(
        `Antigravity does not offer a way to select model "${options.model}" in this session. Refresh the model list and try again.`,
      )
    }
    for (const step of steps) await session.setConfigOption(step.configId, step.value)

    // Reasoning effort (dsh) => the server's thinking level. Unset keeps the server's own default.
    if (options.reasoningEffort) {
      const level = thoughtLevelStep(options.reasoningEffort, configOptions, levels)
      await session.setConfigOption(level.configId, level.value)
    }

    // Restrictive session mode (default: plan). Throws, hence fails the turn, if it cannot be enforced.
    const mode = modeStep(this.config.sessionMode, configOptions)
    if (mode) await session.setConfigOption(mode.configId, mode.value)
    this.#configured.set(session.id, desired)
  }

  /* ------------------------------------------------------------------------------------------------ permissions */

  async #askOutcome(
    options: GenerateOptions,
    request: PermissionRequestLike,
    signal: AbortSignal,
  ): Promise<AcpOutcome> {
    // `reject` must not prompt the user at all: the answer is known without asking.
    if (this.config.permissionMode === 'reject') return chooseOutcome('reject', false, request.options)
    // Prefer the request-scoped signal: it is aborted when this specific prompt settles or is cancelled, so a
    // decision can never be applied to a later turn.
    const requestSignal = request.signal ?? signal
    const approved = await this.#askApproval(options, request, requestSignal)
    if (signal.aborted || requestSignal.aborted) return { outcome: 'cancelled' }
    return chooseOutcome(this.config.permissionMode, approved, request.options)
  }

  async #askApproval(
    options: GenerateOptions,
    request: PermissionRequestLike,
    signal: AbortSignal,
  ): Promise<boolean> {
    const agent = this.#agent(options.sessionId)
    const approval = this.ctx.get('approval', false) as ApprovalService | undefined
    if (agent === undefined || approval === undefined) {
      // Cannot attribute the request to a live agent or no approval seam is composed: fail closed.
      return false
    }
    const description = describeToolCall(request.toolCall)
    this.log.debug('asking dsh approval', {
      toolName: description.toolName,
      reason: description.reason,
      session: String(options.sessionId ?? ''),
    })
    try {
      const callId = request.toolCall.toolCallId
      const outcome = await approval.request({
        agent,
        toolName: description.toolName,
        reason: description.reason,
        ...(callId === undefined ? {} : { callId: ToolCallId(callId) }),
        signal,
      })
      this.log.debug('dsh approval outcome', { outcome })
      return outcome === 'allowed-once'
    } catch (e) {
      this.log.debug('dsh approval failed; denying', { message: (e as Error)?.message })
      return false
    }
  }

  #agent(sessionId: GenerateOptions['sessionId']): Agent | undefined {
    if (sessionId === undefined) return undefined
    const agents = this.ctx.get('agents', false) as AgentRegistry | undefined
    return agents?.get(sessionId as unknown as SessionId)
  }

  #session(sessionId: GenerateOptions['sessionId']): Session | undefined {
    return this.#agent(sessionId)?.session
  }

  #cwd(agent: Agent | undefined): string {
    if (agent === undefined) return process.cwd()
    const workingDirectory = this.ctx.get('workingDirectory', false) as WorkingDirectoryService | undefined
    try {
      return workingDirectory?.get(agent.session) ?? process.cwd()
    } catch {
      return process.cwd()
    }
  }
}
