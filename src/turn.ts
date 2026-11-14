import type { AcpProcess, PermissionRequest, SessionUpdate, StopReason } from './acp-process.js'
import type { AgyConfig } from './config.js'
import { AgyError, errorCode } from './errors.js'
import {
  advertisedLevelsFor,
  configStepsForModel,
  extractGeminiFamilies,
  modeStep,
  thoughtLevelStep,
  type ModelFamily,
} from './models.js'
import { chooseOutcome } from './permission.js'

/** Provider-neutral frames produced by one Antigravity prompt turn. The adapter turns them into `StreamChunk`s. */
export type AcpFrame =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thought'; readonly text: string }
  | {
      readonly kind: 'tool_call'
      readonly id: string
      readonly name: string
      readonly title: string
      readonly status?: string | undefined
      readonly input?: unknown
    }
  | {
      readonly kind: 'tool_update'
      readonly id: string
      readonly status?: string | undefined
      readonly title?: string | undefined
      readonly output?: string | undefined
    }
  | { readonly kind: 'stop'; readonly reason: StopReason }
  | { readonly kind: 'error'; readonly message: string; readonly code: string }

export interface TurnInput {
  readonly config: AgyConfig
  /** Model id exactly as advertised by this adapter (the family id). */
  readonly model: string
  readonly prompt: string
  /** Optional thinking level chosen through dsh's reasoning-effort selector. */
  readonly thoughtLevel?: string | undefined
  readonly cwd: string
  /**
   * Ask dsh whether the action is allowed. Must resolve `true` only for an explicit one-shot approval; any
   * rejection or error is a denial. Receives an abort signal for cancellation.
   */
  readonly onPermission: (request: PermissionRequest, signal: AbortSignal) => Promise<boolean>
}

function textOf(content: unknown): string | undefined {
  const c = content as { type?: string; text?: string } | null | undefined
  return c && c.type === 'text' && typeof c.text === 'string' ? c.text : undefined
}

function toolOutput(update: { content?: unknown; rawOutput?: unknown }): string | undefined {
  const parts: string[] = []
  if (Array.isArray(update.content)) {
    for (const item of update.content as Array<{ type?: string; content?: unknown; path?: string }>) {
      if (item?.type === 'content') {
        const t = textOf(item.content)
        if (t) parts.push(t)
      } else if (item?.type === 'diff' && item.path) parts.push(`diff: ${item.path}`)
      else if (item?.type === 'terminal') parts.push('[terminal output]')
    }
  }
  if (parts.length === 0 && update.rawOutput !== undefined && update.rawOutput !== null) {
    parts.push(typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput))
  }
  return parts.length ? parts.join('\n') : undefined
}

export function frameFromUpdate(update: SessionUpdate): AcpFrame | undefined {
  const u = update as Record<string, any>
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = textOf(u.content)
      return text ? { kind: 'text', text } : undefined
    }
    case 'agent_thought_chunk': {
      const text = textOf(u.content)
      return text ? { kind: 'thought', text } : undefined
    }
    case 'tool_call':
      return {
        kind: 'tool_call',
        id: String(u.toolCallId),
        name: String(u.name ?? u.kind ?? 'tool'),
        title: String(u.title ?? u.name ?? u.kind ?? 'tool'),
        status: u.status ?? undefined,
        input: u.rawInput ?? { title: u.title, locations: u.locations },
      }
    case 'tool_call_update':
      return {
        kind: 'tool_update',
        id: String(u.toolCallId),
        status: u.status ?? undefined,
        title: u.title ?? undefined,
        output: toolOutput(u),
      }
    default:
      return undefined // plans, mode changes, usage, notices, … are not part of the model transcript
  }
}

/** The text shown to the user for a failure. Our typed errors already carry actionable messages. */
export function describeError(e: unknown): string {
  if (e instanceof AgyError) return e.message
  return `Antigravity request failed: ${(e as Error)?.message ?? String(e)}`
}

/**
 * Run one prompt turn on a fresh ACP session, emitting frames as they arrive. Always finishes by emitting exactly
 * one terminal frame (`stop` or `error`), then releases the session. Aborting `signal` cancels the turn.
 */
export async function runTurn(
  input: TurnInput,
  signal: AbortSignal,
  emit: (frame: AcpFrame) => void,
  proc: AcpProcess,
): Promise<void> {
  const { config } = input
  let session: Awaited<ReturnType<AcpProcess['openSession']>> | undefined
  try {
    session = await proc.openSession(input.cwd, {
      onUpdate: (update) => {
        const frame = frameFromUpdate(update)
        if (frame) emit(frame)
      },
      // dsh's approval seam decides. Anything short of an explicit approval is a denial.
      onPermission: async (request, permissionSignal) => {
        let approved = false
        try {
          approved = await input.onPermission(request, permissionSignal)
        } catch {
          approved = false
        }
        if (permissionSignal.aborted) return { outcome: 'cancelled' }
        return chooseOutcome(config.permissionMode, approved, request.options)
      },
    })

    // Select the requested model through the server's own config options. Never silently fall back to another model.
    const levels = advertisedLevelsFor(session.response, input.model)
    const steps = configStepsForModel(input.model, session.response.configOptions, levels)
    const current = (session.response.models as { currentModelId?: unknown } | undefined)?.currentModelId
    if (steps.length === 0 && current !== input.model) {
      throw new AgyError(
        `Antigravity does not offer a way to select model "${input.model}" in this session. Refresh the model list and try again.`,
      )
    }
    for (const step of steps) await session.setConfigOption(step.configId, step.value)

    // Reasoning effort (dsh) => the server's thinking level. Unset keeps the server's own default.
    if (input.thoughtLevel) {
      const level = thoughtLevelStep(input.thoughtLevel, session.response.configOptions, levels)
      await session.setConfigOption(level.configId, level.value)
    }

    // Restrictive session mode (default: plan). Throws, hence fails the turn, if it cannot be enforced.
    const mode = modeStep(config.sessionMode, session.response.configOptions)
    if (mode) await session.setConfigOption(mode.configId, mode.value)

    const stop = await session.prompt(input.prompt, signal)
    emit({ kind: 'stop', reason: stop })
  } catch (e) {
    emit({ kind: 'error', message: describeError(e), code: errorCode(e) })
  } finally {
    await session?.close().catch(() => {})
  }
}

/**
 * Ask the official server which models it reports. Only Gemini models are returned (this integration does not
 * expose other vendors' models even if the server lists them). Throws typed errors (missing CLI, auth, …).
 */
export async function discoverGeminiModels(
  config: AgyConfig,
  cwd: string,
  proc: AcpProcess,
): Promise<ModelFamily[]> {
  const session = await proc.openSession(cwd, {
    onUpdate: () => {},
    onPermission: async () => ({ outcome: 'cancelled' }),
  })
  try {
    return extractGeminiFamilies(session.response)
  } finally {
    await session.close().catch(() => {})
  }
}
