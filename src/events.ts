import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'
import type { AgentUpdate } from './backend.js'

/* ----------------------------------------------------------------------------------------------------------------
 * ACP session/update -> backend-neutral AgentUpdate.
 *
 * The ACP schema is intentionally wider than DSH's `StreamChunk` vocabulary. This module keeps the structure
 * (tool lifecycle, plans, notices, usage, compaction) and only flattens content that DSH genuinely cannot
 * represent. The adapter decides how much of it becomes visible text; the continuity layer records the rest.
 * -------------------------------------------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function textOf(content: unknown): string | undefined {
  const c = asRecord(content)
  return c && c.type === 'text' && typeof c.text === 'string' ? c.text : undefined
}

function resourceText(content: unknown): string | undefined {
  const c = asRecord(content)
  if (!c) return undefined
  if (c.type === 'resource_link') {
    const name = typeof c.name === 'string' ? c.name : 'resource'
    const uri = typeof c.uri === 'string' ? c.uri : ''
    return `[resource: ${name}${uri ? ` (${uri})` : ''}]`
  }
  if (c.type === 'resource') {
    const resource = asRecord(c.resource)
    if (resource && typeof resource.text === 'string') return resource.text
    const uri = typeof resource?.uri === 'string' ? resource.uri : ''
    return `[embedded resource${uri ? `: ${uri}` : ''}]`
  }
  return undefined
}

/** Human-readable text for a tool-call update's content collection. */
export function toolOutputText(update: { content?: unknown; rawOutput?: unknown }): string | undefined {
  const parts: string[] = []
  if (Array.isArray(update.content)) {
    for (const item of update.content as unknown[]) {
      const c = asRecord(item)
      if (!c) continue
      if (c.type === 'content') {
        const content = asRecord(c.content)
        const text = textOf(content)
        if (text !== undefined) parts.push(text)
        else if (content?.type === 'image') parts.push('[image]')
        else {
          const resource = resourceText(content)
          if (resource) parts.push(resource)
        }
      } else if (c.type === 'diff' && typeof c.path === 'string') {
        parts.push(`diff: ${c.path}`)
      } else if (c.type === 'terminal') {
        const terminalId = typeof c.terminalId === 'string' ? c.terminalId : ''
        parts.push(`[terminal${terminalId ? ` ${terminalId}` : ''}]`)
      }
    }
  }
  if (parts.length === 0 && update.rawOutput !== undefined && update.rawOutput !== null) {
    parts.push(typeof update.rawOutput === 'string' ? update.rawOutput : safeJson(update.rawOutput))
  }
  return parts.length ? parts.join('\n') : undefined
}

function contentKinds(update: { content?: unknown }): string[] | undefined {
  if (!Array.isArray(update.content)) return undefined
  const kinds = new Set<string>()
  for (const item of update.content as unknown[]) {
    const c = asRecord(item)
    if (!c) continue
    if (c.type === 'content') {
      const content = asRecord(c.content)
      if (typeof content?.type === 'string') kinds.add(content.type)
    } else if (typeof c.type === 'string') {
      kinds.add(c.type)
    }
  }
  return kinds.size ? [...kinds] : undefined
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return '[unserializable]'
  }
}

function imageUpdate(content: Record<string, unknown>, messageId: string | undefined): AgentUpdate | undefined {
  if (typeof content.data !== 'string' || typeof content.mimeType !== 'string') return undefined
  return {
    kind: 'image',
    data: content.data,
    mimeType: content.mimeType,
    ...(typeof content.uri === 'string' ? { uri: content.uri } : {}),
    ...(messageId === undefined ? {} : { messageId }),
  }
}

/**
 * Translate one ACP `SessionUpdate`.
 *
 * Returns `undefined` only for updates that carry no information at all (for example an unrecognized chunk with
 * no text). Unknown update types are preserved as `{ kind: 'unknown' }` instead of being dropped, so a newer ACP
 * agent cannot silently lose information.
 */
export function translateUpdate(update: SessionUpdate): AgentUpdate | undefined {
  const u = update as unknown as Record<string, unknown>
  const type = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : 'unknown'
  const messageId = typeof u.messageId === 'string' ? u.messageId : undefined
  const content = asRecord(u.content)

  switch (type) {
    case 'agent_message_chunk': {
      const text = textOf(content)
      if (text !== undefined) return { kind: 'text', text, ...(messageId === undefined ? {} : { messageId }) }
      if (content?.type === 'image') return imageUpdate(content, messageId)
      const resource = resourceText(content)
      return resource === undefined ? undefined : { kind: 'text', text: resource, ...(messageId === undefined ? {} : { messageId }) }
    }
    case 'agent_thought_chunk': {
      const text = textOf(content)
      return text === undefined ? undefined : { kind: 'reasoning', text, ...(messageId === undefined ? {} : { messageId }) }
    }
    case 'user_message_chunk': {
      const text = textOf(content)
      return text === undefined ? undefined : { kind: 'user-text', text, ...(messageId === undefined ? {} : { messageId }) }
    }
    case 'tool_call': {
      const id = typeof u.toolCallId === 'string' ? u.toolCallId : ''
      if (id === '') return undefined
      const title = typeof u.title === 'string' ? u.title : 'tool'
      const name = typeof u.name === 'string' ? u.name : typeof u.kind === 'string' ? u.kind : 'tool'
      const locations = Array.isArray(u.locations)
        ? (u.locations as unknown[])
            .map((l) => asRecord(l)?.path)
            .filter((p): p is string => typeof p === 'string' && p !== '')
        : undefined
      return {
        kind: 'tool-call',
        id,
        name,
        title,
        ...(typeof u.kind === 'string' ? { toolKind: u.kind } : {}),
        ...(typeof u.status === 'string' ? { status: u.status } : {}),
        ...(locations && locations.length ? { locations } : {}),
        ...(u.rawInput === undefined ? {} : { rawInput: u.rawInput }),
      }
    }
    case 'tool_call_update': {
      const id = typeof u.toolCallId === 'string' ? u.toolCallId : ''
      if (id === '') return undefined
      const output = toolOutputText({ content: u.content, rawOutput: u.rawOutput })
      const kinds = contentKinds({ content: u.content })
      return {
        kind: 'tool-update',
        id,
        ...(typeof u.name === 'string' ? { name: u.name } : {}),
        ...(typeof u.title === 'string' ? { title: u.title } : {}),
        ...(typeof u.status === 'string' ? { status: u.status } : {}),
        ...(output === undefined ? {} : { output }),
        ...(kinds === undefined ? {} : { contentKinds: kinds }),
        ...(u.rawOutput === undefined ? {} : { rawOutput: u.rawOutput }),
      }
    }
    case 'plan': {
      const entries = Array.isArray(u.entries)
        ? (u.entries as unknown[]).flatMap((entry) => {
            const e = asRecord(entry)
            if (!e || typeof e.content !== 'string') return []
            return [
              {
                content: e.content,
                ...(typeof e.priority === 'string' ? { priority: e.priority } : {}),
                ...(typeof e.status === 'string' ? { status: e.status } : {}),
              },
            ]
          })
        : []
      return { kind: 'plan', entries }
    }
    case 'current_mode_update':
      return typeof u.currentModeId === 'string' ? { kind: 'mode', currentModeId: u.currentModeId } : undefined
    case 'config_option_update':
      return { kind: 'config', configOptions: Array.isArray(u.configOptions) ? u.configOptions : [] }
    case 'usage_update': {
      const used = typeof u.used === 'number' ? u.used : 0
      const size = typeof u.size === 'number' ? u.size : 0
      return { kind: 'usage', used, size, ...(u.cost === undefined ? {} : { cost: u.cost }) }
    }
    case 'notice': {
      const title = typeof u.title === 'string' ? u.title : ''
      if (title === '') return undefined
      return {
        kind: 'notice',
        severity: typeof u.severity === 'string' ? u.severity : 'info',
        title,
        ...(typeof u.description === 'string' ? { description: u.description } : {}),
      }
    }
    case 'session_info_update':
      return {
        kind: 'session-info',
        ...(typeof u.title === 'string' ? { title: u.title } : {}),
        ...(typeof u.updatedAt === 'string' ? { updatedAt: u.updatedAt } : {}),
      }
    case 'compaction_update': {
      const compactionId = typeof u.compactionId === 'string' ? u.compactionId : ''
      if (compactionId === '') return undefined
      return {
        kind: 'compaction',
        compactionId,
        status: typeof u.status === 'string' ? u.status : 'unknown',
        ...(Array.isArray(u.summary) ? { summary: u.summary as ContentBlock[] } : {}),
        ...(typeof u.error === 'string' ? { error: u.error } : {}),
      }
    }
    default:
      return { kind: 'unknown', type, raw: update }
  }
}

/** A compact one-line rendering of a plan, used when the adapter chooses to surface plans as text. */
export function planText(update: Extract<AgentUpdate, { kind: 'plan' }>): string {
  return update.entries
    .map((e) => `- [${e.status ?? 'pending'}] ${e.content}${e.priority ? ` (${e.priority})` : ''}`)
    .join('\n')
}
