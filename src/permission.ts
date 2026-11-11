import type { PermissionMode } from './config.js'

/** Structural subsets of the ACP schema types, so this module stays pure and trivially testable. */
export interface PermissionOptionLike {
  readonly optionId: string
  readonly name?: string
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | (string & {})
}

export type AcpOutcome = { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }

/**
 * Map dsh's decision onto an ACP permission outcome.
 *
 * Restrictive by construction:
 *  - A denial never selects an `allow_*` option.
 *  - Approval selects `allow_once` unless the operator explicitly opted into `allow-always`.
 *  - If the agent only offers `allow_always`, an `allow-once` policy does NOT escalate: the request is rejected.
 *  - `permissionMode: "reject"` rejects everything, even dsh-approved requests.
 */
export function chooseOutcome(
  mode: PermissionMode,
  approved: boolean,
  options: readonly PermissionOptionLike[],
): AcpOutcome {
  const find = (kind: string) => options.find((o) => o.kind === kind)
  const reject = (): AcpOutcome => {
    const opt = find('reject_once')
    return opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' }
  }
  if (!approved || mode === 'reject') return reject()
  if (mode === 'allow-always') {
    const opt = find('allow_always') ?? find('allow_once')
    return opt ? { outcome: 'selected', optionId: opt.optionId } : reject()
  }
  const once = find('allow_once')
  return once ? { outcome: 'selected', optionId: once.optionId } : reject()
}

interface ToolCallLike {
  readonly toolCallId?: string
  readonly kind?: string | null
  readonly title?: string | null
  readonly locations?: ReadonlyArray<{ path?: string }> | null
  readonly rawInput?: unknown
}

/** One dsh approval request derived from an ACP tool call. */
export interface ApprovalDescription {
  /** dsh tool name shown in the approval prompt and audit log. */
  readonly toolName: string
  /** Human-readable explanation of what Antigravity wants to do. */
  readonly reason: string
}

/**
 * Describe an ACP tool call in dsh's approval vocabulary.
 *
 * dsh approvals are one-shot decisions about one tool name plus a reason (there is no resource-pattern
 * vocabulary), so the command/paths are folded into the reason. Denials always fail closed.
 */
export function describeToolCall(toolCall: ToolCallLike): ApprovalDescription {
  const kind = toolCall.kind ?? 'other'
  const paths = (toolCall.locations ?? [])
    .map((l) => l.path)
    .filter((p): p is string => typeof p === 'string' && p !== '')
  const raw = toolCall.rawInput as Record<string, unknown> | null | undefined
  const rawCommand = typeof raw?.command === 'string' ? raw.command : undefined
  const rawUrl = typeof raw?.url === 'string' ? raw.url : undefined
  const title = toolCall.title ?? 'Antigravity tool call'

  switch (kind) {
    case 'read':
      return {
        toolName: 'read',
        reason: `Antigravity wants to read ${paths.length ? paths.join(', ') : title}`,
      }
    case 'edit':
    case 'delete':
    case 'move':
      return {
        toolName: 'edit',
        reason: `Antigravity wants to ${kind} ${paths.length ? paths.join(', ') : title}`,
      }
    case 'execute':
      return {
        toolName: 'bash',
        reason: `Antigravity wants to run: ${rawCommand ?? title}`,
      }
    case 'fetch':
      return {
        toolName: 'web_fetch',
        reason: `Antigravity wants to fetch: ${rawUrl ?? title}`,
      }
    case 'search':
      return {
        toolName: 'grep',
        reason: `Antigravity wants to search: ${title}`,
      }
    default:
      return {
        toolName: 'agy_' + String(kind).replace(/[^a-zA-Z0-9_]/g, '_'),
        reason: paths.length ? `${title} (${paths.join(', ')})` : title,
      }
  }
}
