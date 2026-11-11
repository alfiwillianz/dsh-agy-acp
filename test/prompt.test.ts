import { describe, expect, test } from 'bun:test'
import { buildPrompt } from '../src/prompt.js'

const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] })
const assistant = (text: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text }] })

describe('buildPrompt', () => {
  test('a single user turn is sent verbatim', () => {
    expect(buildPrompt({ messages: [user('hello')] })).toBe('hello')
  })

  test('system text is wrapped in instructions', () => {
    const prompt = buildPrompt({ system: 'You are helpful.', messages: [user('hi')] })
    expect(prompt).toBe('<instructions>\nYou are helpful.\n</instructions>\n\nhi')
  })

  test('a leading system message is treated as instructions', () => {
    const prompt = buildPrompt({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
        user('hi'),
      ],
    })
    expect(prompt).toContain('<instructions>\nsystem prompt\n</instructions>')
    expect(prompt).toContain('hi')
  })

  test('multi-turn history is labelled and separated from the current request', () => {
    const prompt = buildPrompt({ messages: [user('first'), assistant('second'), user('third')] })
    expect(prompt).toContain('<conversation_so_far>')
    expect(prompt).toContain('User: first')
    expect(prompt).toContain('Assistant: second')
    expect(prompt).toContain('User: third')
  })

  test('tool calls and tool results are replayed as text', () => {
    const prompt = buildPrompt({
      messages: [
        user('read it'),
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 't1', name: 'read', arguments: '{"path":"a.txt"}' }],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
        },
      ],
    })
    expect(prompt).toContain('[tool call: read {"path":"a.txt"}]')
    expect(prompt).toContain('Tool: file contents')
  })

  test('a failed tool result is marked as an error', () => {
    const prompt = buildPrompt({
      messages: [
        user('run it'),
        {
          role: 'tool',
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
        },
      ],
    })
    expect(prompt).toContain('Tool: [error] boom')
  })

  test('images and files are omitted, reasoning is not replayed', () => {
    const prompt = buildPrompt({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', attachment: { name: 'shot.png' } },
            { type: 'file', attachment: { name: 'notes.txt' } },
          ],
        },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'private thoughts' }] },
      ],
    })
    expect(prompt).toContain('[image omitted: shot.png]')
    expect(prompt).toContain('[file: notes.txt]')
    expect(prompt).not.toContain('private thoughts')
  })

  test('native tool definitions add an agent-runtime note', () => {
    const prompt = buildPrompt({ messages: [user('hi')], tools: [{ name: 'bash' }] })
    expect(prompt).toContain('<agent_runtime>')
    expect(prompt).toContain("host's tool definitions are not forwarded")
  })

  test('empty messages produce an empty prompt', () => {
    expect(buildPrompt({ messages: [] })).toBe('')
  })
})
