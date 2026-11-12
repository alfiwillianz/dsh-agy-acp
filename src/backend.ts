import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { AcpOutcome, PermissionOptionLike } from './permission.js'

/**
 * Provider-neutral view of one ACP agent's capabilities.
 *
 * Everything here is derived from the `initialize` response. Absent fields are treated as *unsupported*: the
 * integration must never assume an optional ACP feature exists (in particular `session/load` and
 * `session/resume`). This is the discovery half of the "do not assume all ACP servers are identical" rule.
 */
export interface AcpPromptCapabilities {
  /** The agent accepts `image` prompt blocks. */
  readonly image: boolean
  /** The agent accepts `audio` prompt blocks. */
  readonly audio: boolean
  /** The agent accepts embedded `resource` blocks (not just `resource_link`). */
  readonly embeddedContext: boolean
}

export interface AcpSessionCapabilities {
  /** `session/load` is available (the top-level `loadSession` capability). */
  readonly load: boolean
  /** `session/resume` is available. */
  readonly resume: boolean
  /** `session/close` is available. */
  readonly close: boolean
  /** `session/list` is available. */
  readonly list: boolean
  /** `session/delete` is available. */
  readonly delete: boolean
}

export interface AcpCapabilities {
  /** ACP protocol version negotiated during `initialize`. */
  readonly protocolVersion: number
  readonly prompt: AcpPromptCapabilities
  readonly session: AcpSessionCapabilities
  readonly mcp: { readonly http: boolean; readonly sse: boolean }
  /** The raw `agentCapabilities` object, kept for diagnostics and `_meta` extensions. */
  readonly raw: Readonly<Record<string, unknown>>
}

/** The ACP stop reason, widened because agents may add their own values. */
export type AgentStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | (string & {})

/**
 * One structured ACP session update, translated out of the wire schema.
 *
 * The adapter maps these to DSH's `StreamChunk` vocabulary; the continuity layer records them. Keeping a
 * backend-neutral shape here means a future DSH `AgentBackend` can consume the same events without importing the
 * ACP SDK.
 */
export type AgentUpdate =
  | { readonly kind: 'text'; readonly text: string; readonly messageId?: string }
  | { readonly kind: 'reasoning'; readonly text: string; readonly messageId?: string }
  | { readonly kind: 'user-text'; readonly text: string; readonly messageId?: string }
  | {
      readonly kind: 'image'
      readonly data: string
      readonly mimeType: string
      readonly uri?: string
      readonly messageId?: string
    }
  | {
      readonly kind: 'tool-call'
      readonly id: string
      readonly name: string
      readonly title: string
      readonly toolKind?: string
      readonly status?: string
      readonly locations?: readonly string[]
      readonly rawInput?: unknown
    }
  | {
      readonly kind: 'tool-update'
      readonly id: string
      readonly name?: string
      readonly title?: string
      readonly status?: string
      readonly output?: string
      readonly contentKinds?: readonly string[]
      readonly rawOutput?: unknown
    }
  | {
      readonly kind: 'plan'
      readonly entries: readonly {
        readonly content: string
        readonly priority?: string
        readonly status?: string
      }[]
    }
  | { readonly kind: 'mode'; readonly currentModeId: string }
  | { readonly kind: 'config'; readonly configOptions: readonly unknown[] }
  | { readonly kind: 'usage'; readonly used: number; readonly size: number; readonly cost?: unknown }
  | {
      readonly kind: 'notice'
      readonly severity: string
      readonly title: string
      readonly description?: string
    }
  | { readonly kind: 'session-info'; readonly title?: string; readonly updatedAt?: string }
  | {
      readonly kind: 'compaction'
      readonly compactionId: string
      readonly status: string
      readonly summary?: readonly ContentBlock[]
      readonly error?: string
    }
  | { readonly kind: 'unknown'; readonly type: string; readonly raw: unknown }

/** One ACP permission request, already correlated with the prompt that caused it. */
export interface AgentPermissionRequest {
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
  /** Aborted when the turn is cancelled, the session closes, or the process dies. */
  readonly signal: AbortSignal
}

export interface AgentSessionHandlers {
  /** Called for every structured update in wire order. Exceptions are logged and contained. */
  onUpdate(update: AgentUpdate): void
  /** Must resolve to an ACP outcome. Rejections are treated as `cancelled` (fail closed). */
  onPermission(request: AgentPermissionRequest): Promise<AcpOutcome>
}

/** One live ACP session owned by the backend. */
export interface AgentSession {
  /** Agent-assigned ACP session id. */
  readonly id: string
  /** Working directory the session was created/loaded with. */
  readonly cwd: string
  /** Raw `session/new`, `session/load`, or `session/resume` response (may be `{}` for load/resume). */
  readonly info: Readonly<Record<string, unknown>>
  /** True when this session was restored rather than freshly created. */
  readonly resumed: boolean
  /** True after `close()` (or after the owning process died). */
  readonly closed: boolean
  /** Capabilities of the process that owns this session. */
  readonly capabilities: AcpCapabilities
  /** Run one prompt turn. Resolves with the ACP stop reason. */
  prompt(content: readonly ContentBlock[], signal?: AbortSignal): Promise<AgentStopReason>
  /** Ask the agent to cancel the active prompt without closing the session. */
  cancel(): void
  /** Release the session. Idempotent. */
  close(): Promise<void>
  /** Apply one `session/set_config_option` value. */
  setConfigOption(configId: string, value: string): Promise<void>
  /** Apply one `session/set_mode` value, when the agent supports the standard mode method. */
  setMode?(modeId: string): Promise<void>
}

/**
 * The ACP execution backend.
 *
 * This is deliberately *not* a DSH core interface yet: DSH 0.2.2-rc.1 has no agent-backend seam. It is the
 * plugin-local boundary that a future upstream `AgentBackend` can be implemented against. See ARCHITECTURE.md.
 */
export interface AcpAgentBackend {
  /** Capabilities of the current ACP process; all-false before the first successful `initialize`. */
  readonly capabilities: AcpCapabilities
  /** Whether the owning ACP process is currently alive. A stopped process invalidates every session. */
  readonly running: boolean
  createSession(input: { cwd: string; handlers: AgentSessionHandlers }): Promise<AgentSession>
  /**
   * Restore an existing ACP session. Prefers `session/load`, then `session/resume`. Throws
   * `UnsupportedAcpError` when the agent advertises neither.
   */
  resumeSession(input: {
    cwd: string
    sessionId: string
    handlers: AgentSessionHandlers
  }): Promise<AgentSession>
  dispose(): Promise<void>
}

/** Capabilities reported before `initialize`; everything optional is negative. */
export const EMPTY_CAPABILITIES: AcpCapabilities = {
  protocolVersion: 0,
  prompt: { image: false, audio: false, embeddedContext: false },
  session: { load: false, resume: false, close: false, list: false, delete: false },
  mcp: { http: false, sse: false },
  raw: {},
}
