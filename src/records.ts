import type { Session } from '@deepseek-ai/dsh-session'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Logger } from './log.js'

/* ----------------------------------------------------------------------------------------------------------------
 * Structured ACP lifecycle records.
 *
 * dsh's `StreamChunk` cannot represent provider-executed tools, plans, usage, or session metadata. Rather than
 * throwing that structure away, the plugin appends plugin-owned, ignorable `plugin:agy-acp/*` records to the dsh
 * session log. They never enter the model-visible surface, survive fork/resume, and are readable with
 * `pluginRecordOf()`. This is an extension of dsh's documented plugin-record mechanism, not a new core event.
 * -------------------------------------------------------------------------------------------------------------- */

export interface AcpSessionRecord {
  readonly acpSessionId: string
  readonly cwd: string
  readonly resumed: boolean
  readonly capabilities: {
    readonly load: boolean
    readonly resume: boolean
    readonly close: boolean
    readonly image: boolean
    readonly embeddedContext: boolean
  }
}

export interface AcpToolRecord {
  readonly acpSessionId: string
  readonly toolCallId: string
  readonly name?: string
  readonly title?: string
  readonly toolKind?: string
  readonly status?: string
  readonly locations?: readonly string[]
  readonly output?: string
  readonly contentKinds?: readonly string[]
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
}

export interface AcpUpdateRecord {
  readonly acpSessionId: string
  readonly update: unknown
}

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    /** One ACP session bound to this dsh session. */
    'plugin:agy-acp/session': AcpSessionRecord
    /** One structured ACP tool-call lifecycle event. */
    'plugin:agy-acp/tool': AcpToolRecord
    /** One structured ACP non-tool update (plan, notice, usage, mode, config, compaction). */
    'plugin:agy-acp/update': AcpUpdateRecord
  }
}

function jsonSafe(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      out[key] = jsonSafe(v, depth + 1)
    }
    return out
  }
  return undefined
}

function append(session: Session | undefined, log: Logger, type: string, data: unknown): void {
  if (session === undefined) return
  try {
    // `appendPluginRecord` validates JSON-serializability; the sanitizer keeps adapter-owned objects (which may
    // contain undefined or non-JSON values) from turning a diagnostic record into a failed append.
    appendPluginRecord(session, type as never, jsonSafe(data) as never)
  } catch (e) {
    log.debug('could not append ACP plugin record', { type, message: (e as Error)?.message })
  }
}

export function recordAcpSession(session: Session | undefined, log: Logger, data: AcpSessionRecord): void {
  append(session, log, 'plugin:agy-acp/session', data)
}

export function recordAcpTool(session: Session | undefined, log: Logger, data: AcpToolRecord): void {
  append(session, log, 'plugin:agy-acp/tool', data)
}

export function recordAcpUpdate(session: Session | undefined, log: Logger, data: AcpUpdateRecord): void {
  append(session, log, 'plugin:agy-acp/update', data)
}
