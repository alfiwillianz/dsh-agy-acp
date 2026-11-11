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
interface ImageBlockLike {
  readonly type: 'image'
  readonly attachment?: { readonly name?: string }
}
interface FileBlockLike {
  readonly type: 'file'
  readonly attachment?: { readonly name?: string }
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

interface MessageLike {
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
