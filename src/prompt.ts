import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { AcpPromptCapabilities } from './backend.js'

/**
 * Flatten a dsh model request into the text of one ACP prompt.
 *
 * ACP sessions are stateful agents with their own context, while dsh re-sends the whole conversation on every
 * model call. We therefore open a fresh ACP session per model call and replay the transcript as text.
 * Structural subsets are used instead of `@deepseek-ai/dsh-llm` runtime values so this stays pure and
 * independently testable.
 */

interface TextBlockLike {
  readonly type: 'text'
  readonly text: string
}
interface ReasoningBlockLike {
  readonly type: 'reasoning'
  readonly text: string
}
export interface ImageAttachmentLike {
  readonly attachmentId?: string
  readonly mediaType?: string
  readonly bytes?: number
  readonly width?: number
  readonly height?: number
  readonly name?: string
}
export interface FileAttachmentLike {
  readonly attachmentId?: string
  readonly name?: string
  readonly bytes?: number
}
interface ImageBlockLike {
  readonly type: 'image'
  readonly attachment?: ImageAttachmentLike
}
interface FileBlockLike {
  readonly type: 'file'
  readonly attachment?: FileAttachmentLike
}
interface ToolCallBlockLike {
  readonly type: 'tool-call'
  readonly name: string
  readonly arguments: string
}
interface ToolChangeBlockLike {
  readonly type: 'tool-addition' | 'tool-removal'
  readonly toolName: string
}
type BlockLike =
  | TextBlockLike
  | ReasoningBlockLike
  | ImageBlockLike
  | FileBlockLike
  | ToolCallBlockLike
  | ToolChangeBlockLike
  | { readonly type: string }

export interface MessageLike {
  readonly role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  readonly content: ReadonlyArray<BlockLike>
  readonly isError?: boolean
}

export interface PromptInput {
  readonly system?: string | undefined
  readonly messages: ReadonlyArray<MessageLike>
  /** Present when the host offered native tool definitions; Antigravity uses its own tools instead. */
  readonly tools?: ReadonlyArray<unknown> | undefined
}

const MAX_TOOL_OUTPUT_CHARS = 8_000

function renderValue(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
  return text.length > MAX_TOOL_OUTPUT_CHARS ? text.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n…[truncated]' : text
}

function renderBlock(block: BlockLike): string {
  switch (block.type) {
    case 'text':
      return (block as TextBlockLike).text
    case 'reasoning':
      // Provider-private; not replayed to the next provider.
      return ''
    case 'image': {
      const name = (block as ImageBlockLike).attachment?.name
      return name ? `[image omitted: ${name}]` : '[image omitted]'
    }
    case 'file': {
      const name = (block as FileBlockLike).attachment?.name
      return name ? `[file: ${name}]` : '[file omitted]'
    }
    case 'tool-call': {
      const call = block as ToolCallBlockLike
      return `[tool call: ${call.name} ${renderValue(call.arguments)}]`
    }
    case 'tool-addition':
      return `[tool added: ${(block as ToolChangeBlockLike).toolName}]`
    case 'tool-removal':
      return `[tool removed: ${(block as ToolChangeBlockLike).toolName}]`
    default:
      return ''
  }
}

function renderContent(parts: ReadonlyArray<BlockLike>): string {
  const out: string[] = []
  for (const part of parts) {
    const text = renderBlock(part)
    if (text) out.push(text)
  }
  return out.join('\n')
}

const ROLE_LABEL: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool',
  system: 'System',
  developer: 'Developer',
}

/**
 * Build the single text prompt sent to `session/prompt`.
 *
 * The transcript is replayed as text because the ACP session is fresh for every dsh model call. A single
 * user turn is sent verbatim; multi-turn conversations are wrapped in `<conversation_so_far>` so the agent
 * can tell history from the current request.
 */
export function buildPrompt(input: PromptInput): string {
  const systemParts: string[] = []
  if (input.system && input.system.trim() !== '') systemParts.push(input.system)
  for (const message of input.messages) {
    if (message.role === 'system') {
      const text = renderContent(message.content)
      if (text.trim() !== '') systemParts.push(text)
    }
  }

  const turns = input.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role,
      text: m.role === 'tool' && m.isError === true ? `[error] ${renderContent(m.content)}` : renderContent(m.content),
    }))
    .filter((t) => t.text.trim() !== '')

  const sections: string[] = []
  if (systemParts.length > 0) sections.push(`<instructions>\n${systemParts.join('\n\n')}\n</instructions>`)

  // dsh's loop offers native tool definitions; Antigravity runs its own tools, so explain the mismatch rather
  // than silently ignoring the host's tool instructions.
  if (input.tools !== undefined && input.tools.length > 0) {
    sections.push(
      '<agent_runtime>\nYou are Antigravity running through its own ACP agent loop. The host\'s tool definitions ' +
        'are not forwarded to you; use your own tools to complete the task.\n</agent_runtime>',
    )
  }

  const onlyOneUser = turns.length === 1 && turns[0]!.role === 'user'
  if (onlyOneUser) {
    sections.push(turns[0]!.text)
  } else if (turns.length > 0) {
    const label = (role: string) => ROLE_LABEL[role] ?? 'System'
    const history = turns
      .slice(0, -1)
      .map((t) => `${label(t.role)}: ${t.text}`)
      .join('\n\n')
    const last = turns[turns.length - 1]!
    if (history) sections.push(`<conversation_so_far>\n${history}\n</conversation_so_far>`)
    sections.push(`${label(last.role)}: ${last.text}`)
  }
  return sections.join('\n\n')
}

/* ----------------------------------------------------------------------------------------------------------------
 * Structured ACP prompt blocks.
 *
 * `buildPrompt` above is the legacy text-only path. The functions below preserve images and files when the agent
 * advertises the matching prompt capability, and emit an explicit warning instead of silently dropping anything.
 * -------------------------------------------------------------------------------------------------------------- */

/** Resolves durable dsh attachment references into ACP wire content. */
export interface PromptAttachmentResolver {
  image(ref: ImageAttachmentLike): Promise<{ data: string; mimeType: string } | undefined>
  file(ref: FileAttachmentLike): Promise<
    | {
        readonly uri: string
        readonly name: string
        readonly size?: number
        readonly text?: string
        readonly mimeType?: string
      }
    | undefined
  >
}

/** Resolver used when no attachment capability is composed; every attachment becomes a visible placeholder. */
export const NO_ATTACHMENTS: PromptAttachmentResolver = {
  image: async () => undefined,
  file: async () => undefined,
}

export interface PromptBlocksResult {
  readonly blocks: ContentBlock[]
  readonly warnings: string[]
}

export interface BuildPromptBlocksInput extends PromptInput {
  /** Include attachments found in replayed history, not just the current message. Default: false. */
  readonly includeHistoryAttachments?: boolean
}

/** The effective instructions text: the explicit `system` plus every system-role message. */
export function systemText(input: PromptInput): string {
  const parts: string[] = []
  if (input.system && input.system.trim() !== '') parts.push(input.system)
  for (const message of input.messages) {
    if (message.role !== 'system') continue
    const text = renderContent(message.content)
    if (text.trim() !== '') parts.push(text)
  }
  return parts.join('\n\n')
}

function agentRuntimeNote(): string {
  return (
    '<agent_runtime>\nYou are an autonomous ACP agent running your own execution loop. The host\'s tool ' +
    'definitions are not forwarded to you; use your own tools to complete the task.\n</agent_runtime>'
  )
}

function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? 'System'
}

function placeholderFor(block: BlockLike, capabilities: AcpPromptCapabilities): string {
  switch (block.type) {
    case 'image': {
      const name = (block as ImageBlockLike).attachment?.name
      return capabilities.image ? (name ? `[image: ${name}]` : '[image]') : name ? `[image omitted: ${name}]` : '[image omitted]'
    }
    case 'file': {
      const name = (block as FileBlockLike).attachment?.name
      return name ? `[file: ${name}]` : '[file omitted]'
    }
    case 'audio':
      return '[audio omitted: ACP audio prompts are not supported by dsh]'
    default:
      return `[unsupported content: ${block.type}]`
  }
}

async function renderAttachmentBlock(
  block: ImageBlockLike | FileBlockLike,
  capabilities: AcpPromptCapabilities,
  resolver: PromptAttachmentResolver,
  warnings: string[],
): Promise<ContentBlock[]> {
  if (block.type === 'image') {
    const name = block.attachment?.name
    if (!capabilities.image) {
      warnings.push(`image${name ? ` "${name}"` : ''} omitted: the ACP agent does not advertise image prompts`)
      return [{ type: 'text', text: placeholderFor(block, capabilities) }]
    }
    const resolved = block.attachment === undefined ? undefined : await resolver.image(block.attachment)
    if (resolved === undefined) {
      warnings.push(
        `image${name ? ` "${name}"` : ''} omitted: no attachment store is composed to read its bytes`,
      )
      return [{ type: 'text', text: placeholderFor(block, capabilities) }]
    }
    return [{ type: 'image', data: resolved.data, mimeType: resolved.mimeType }]
  }

  const name = block.attachment?.name
  const resolved = block.attachment === undefined ? undefined : await resolver.file(block.attachment)
  if (resolved === undefined) {
    warnings.push(`file${name ? ` "${name}"` : ''} omitted: no attachment store is composed to read it`)
    return [{ type: 'text', text: placeholderFor(block, capabilities) }]
  }
  if (resolved.text !== undefined && capabilities.embeddedContext) {
    return [
      {
        type: 'resource',
        resource: {
          uri: resolved.uri,
          text: resolved.text,
          ...(resolved.mimeType === undefined ? {} : { mimeType: resolved.mimeType }),
        },
      },
    ]
  }
  return [
    {
      type: 'resource_link',
      uri: resolved.uri,
      name: resolved.name,
      ...(resolved.size === undefined ? {} : { size: resolved.size }),
      ...(resolved.mimeType === undefined ? {} : { mimeType: resolved.mimeType }),
    },
  ]
}

async function renderMessageBlocks(
  message: MessageLike,
  label: string | undefined,
  capabilities: AcpPromptCapabilities,
  resolver: PromptAttachmentResolver,
  includeAttachments: boolean,
  warnings: string[],
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []
  if (label !== undefined) blocks.push({ type: 'text', text: `${label}:` })
  let firstText = true
  const pushText = (text: string) => {
    if (text === '') return
    if (firstText && label !== undefined) {
      // Fold the label into the first text block instead of leaving a separate one-line block.
      blocks.pop()
      blocks.push({ type: 'text', text: `${label}: ${text}` })
    } else {
      blocks.push({ type: 'text', text })
    }
    firstText = false
  }

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        pushText((block as TextBlockLike).text)
        break
      case 'reasoning':
        // Provider-private; not replayed to the next provider.
        break
      case 'image':
      case 'file': {
        if (includeAttachments) {
          const rendered = await renderAttachmentBlock(block as ImageBlockLike | FileBlockLike, capabilities, resolver, warnings)
          if (firstText && label !== undefined) {
            blocks.pop()
            blocks.push({ type: 'text', text: `${label}:` })
            firstText = false
          }
          blocks.push(...rendered)
        } else {
          pushText(placeholderFor(block, capabilities))
        }
        break
      }
      case 'tool-call': {
        const call = block as ToolCallBlockLike
        pushText(`[tool call: ${call.name} ${renderValue(call.arguments)}]`)
        break
      }
      case 'tool-addition':
        pushText(`[tool added: ${(block as ToolChangeBlockLike).toolName}]`)
        break
      case 'tool-removal':
        pushText(`[tool removed: ${(block as ToolChangeBlockLike).toolName}]`)
        break
      default:
        warnings.push(`unsupported content block "${block.type}" was rendered as text`)
        pushText(`[unsupported content: ${block.type}]`)
    }
  }
  if (message.role === 'tool' && message.isError === true) {
    // The error marker belongs before the result text, which is already pushed; prepend a compact note instead.
    blocks.unshift({ type: 'text', text: '[error]' })
  }
  if (blocks.length === 0) return []
  return blocks
}

function historyText(messages: readonly MessageLike[]): string {
  return messages
    .map((m) => {
      const text = renderContent(m.content)
      if (text.trim() === '') return ''
      return `${roleLabel(m.role)}: ${m.role === 'tool' && m.isError === true ? `[error] ${text}` : text}`
    })
    .filter((s) => s !== '')
    .join('\n\n')
}

function dedupe(warnings: readonly string[]): string[] {
  return [...new Set(warnings)]
}

/**
 * Build the complete content-block prompt for a fresh ACP session.
 *
 * The transcript is replayed in `<conversation_so_far>` because the ACP session has no prior context. Images and
 * files in the current user message are preserved as ACP content blocks when the agent advertises the matching
 * capability; everything unsupported becomes an explicit placeholder plus a warning.
 */
export async function buildPromptBlocks(
  input: BuildPromptBlocksInput,
  capabilities: AcpPromptCapabilities,
  resolver: PromptAttachmentResolver = NO_ATTACHMENTS,
): Promise<PromptBlocksResult> {
  const warnings: string[] = []
  const blocks: ContentBlock[] = []
  const instructions = systemText(input)
  if (instructions !== '') blocks.push({ type: 'text', text: `<instructions>\n${instructions}\n</instructions>` })
  if (input.tools !== undefined && input.tools.length > 0) blocks.push({ type: 'text', text: agentRuntimeNote() })

  const turns = input.messages.filter((m) => m.role !== 'system')
  if (turns.length === 1 && turns[0]!.role === 'user') {
    blocks.push(
      ...(await renderMessageBlocks(
        turns[0]!,
        undefined,
        capabilities,
        resolver,
        true,
        warnings,
      )),
    )
  } else if (turns.length > 0) {
    const history = turns.slice(0, -1)
    if (input.includeHistoryAttachments === true) {
      for (const message of history) {
        blocks.push(
          ...(await renderMessageBlocks(message, roleLabel(message.role), capabilities, resolver, true, warnings)),
        )
      }
    } else {
      const text = historyText(history)
      if (text !== '') blocks.push({ type: 'text', text: `<conversation_so_far>\n${text}\n</conversation_so_far>` })
    }
    const last = turns[turns.length - 1]!
    blocks.push(
      ...(await renderMessageBlocks(
        last,
        roleLabel(last.role),
        capabilities,
        resolver,
        last.role === 'user',
        warnings,
      )),
    )
  }
  return { blocks, warnings: dedupe(warnings) }
}

/**
 * Build the prompt for an existing ACP session that already holds `startIndex` non-system messages.
 *
 * Only the new tail is sent. A changed system prompt is delivered as an explicit `<system_update>` block instead
 * of recreating the session, so the agent keeps its native execution context across ordinary turns.
 */
export async function buildDeltaBlocks(
  input: BuildPromptBlocksInput,
  startIndex: number,
  capabilities: AcpPromptCapabilities,
  resolver: PromptAttachmentResolver = NO_ATTACHMENTS,
  options: { readonly systemChanged?: boolean; readonly toolsChanged?: boolean } = {},
): Promise<PromptBlocksResult> {
  const warnings: string[] = []
  const blocks: ContentBlock[] = []
  const instructions = systemText(input)
  if (options.systemChanged === true && instructions !== '') {
    blocks.push({ type: 'text', text: `<system_update>\n${instructions}\n</system_update>` })
  }
  if (options.toolsChanged === true) blocks.push({ type: 'text', text: agentRuntimeNote() })

  const turns = input.messages.filter((m) => m.role !== 'system')
  const delta = turns.slice(Math.max(0, startIndex))
  if (delta.length === 1 && delta[0]!.role === 'user') {
    blocks.push(
      ...(await renderMessageBlocks(delta[0]!, undefined, capabilities, resolver, true, warnings)),
    )
  } else if (delta.length > 0) {
    const history = delta.slice(0, -1)
    if (input.includeHistoryAttachments === true) {
      for (const message of history) {
        blocks.push(
          ...(await renderMessageBlocks(message, roleLabel(message.role), capabilities, resolver, true, warnings)),
        )
      }
    } else {
      const text = historyText(history)
      if (text !== '') blocks.push({ type: 'text', text: `<conversation_so_far>\n${text}\n</conversation_so_far>` })
    }
    const last = delta[delta.length - 1]!
    blocks.push(
      ...(await renderMessageBlocks(
        last,
        roleLabel(last.role),
        capabilities,
        resolver,
        last.role === 'user',
        warnings,
      )),
    )
  }
  return { blocks, warnings: dedupe(warnings) }
}
