import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  ReasoningEffortId,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { WorkingDirectoryService } from '@deepseek-ai/dsh-working-directory'
import type { AcpProcess, PermissionRequest, StopReason } from './acp-process.js'
import type { AgyConfig } from './config.js'
import { describeError } from './turn.js'
import type { Logger } from './log.js'
import { knownLimits, orderThinkingLevels, type ModelFamily } from './models.js'
import { describeToolCall } from './permission.js'
import { buildPrompt } from './prompt.js'
import { discoverGeminiModels, runTurn, type AcpFrame } from './turn.js'

/* ----------------------------------------------------------------------------------------------------------------
 * dsh LLM adapter backed by Google's official `agy acp` server.
 *
 *     dsh agent loop ── GenerateOptions ──▶ this adapter ── ACP turn over `agy acp` ──▶ StreamChunk
 *
 * Antigravity is an *agent*: it runs its own tool loop. dsh has no provider-executed tool concept, so its tool
 * activity is surfaced as compact text blocks (configurable) instead of tool-call chunks the loop would try to
 * execute. dsh's tool definitions are not forwarded; the prompt explains that to the agent.
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

function effortName(level: string): string {
  if (level === '') return level
  return level.charAt(0).toUpperCase() + level.slice(1)
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

/** Minimal async queue bridging the callback-based ACP turn into an async generator. */
class FrameQueue implements AsyncIterable<AcpFrame> {
  readonly #items: AcpFrame[] = []
  readonly #waiters: Array<(result: IteratorResult<AcpFrame>) => void> = []
  #ended = false

  push(frame: AcpFrame): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value: frame, done: false })
    else this.#items.push(frame)
  }

  end(): void {
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<AcpFrame> {
    return {
      next: () => {
        const item = this.#items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.#ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise<IteratorResult<AcpFrame>>((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

export class AgyAcpAdapter extends LlmAdapter {
  #catalog: { at: number; models: ModelFamily[] } | undefined
  #inflight: Promise<ModelFamily[]> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly config: AgyConfig,
    private readonly proc: AcpProcess,
    private readonly log: Logger,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.#catalogFor()
    return models.map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      inputModalities: ['text'] as const,
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
      inputModalities: ['text'],
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
      yield* this.#run(options, cwd, controller.signal)
    } finally {
      callerSignal?.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }

  /* ------------------------------------------------------------------------------------------------- discovery */

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

  /* ----------------------------------------------------------------------------------------------------- turn */

  async *#run(options: GenerateOptions, cwd: string, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const frames = new FrameQueue()
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

  /* ------------------------------------------------------------------------------------------------ permissions */

  async #askApproval(
    options: GenerateOptions,
    request: PermissionRequest,
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
      const outcome = await approval.request({
        agent,
        toolName: description.toolName,
        reason: description.reason,
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
