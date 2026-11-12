import { describe, expect, test } from 'bun:test'
import type { AcpPromptCapabilities } from '../src/backend.js'
import {
  buildDeltaBlocks,
  buildPromptBlocks,
  NO_ATTACHMENTS,
  type MessageLike,
  type PromptAttachmentResolver,
} from '../src/prompt.js'

const caps = (overrides: Partial<AcpPromptCapabilities> = {}): AcpPromptCapabilities => ({
  image: false,
  audio: false,
  embeddedContext: false,
  ...overrides,
})

const user = (content: MessageLike['content']): MessageLike => ({ role: 'user', content })
const text = (value: string): MessageLike['content'][number] => ({ type: 'text', text: value })

describe('buildPromptBlocks', () => {
  test('a single user turn is sent as text', async () => {
    const { blocks, warnings } = await buildPromptBlocks({ messages: [user([text('hello')])] }, caps())
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }])
    expect(warnings).toEqual([])
  })

  test('system text and the agent-runtime note precede the request', async () => {
    const { blocks } = await buildPromptBlocks(
      { system: 'You are helpful.', messages: [user([text('hi')])], tools: [{ name: 'bash' }] },
      caps(),
    )
    expect(blocks[0]).toEqual({ type: 'text', text: '<instructions>\nYou are helpful.\n</instructions>' })
    expect(blocks[1]).toMatchObject({ type: 'text', text: expect.stringContaining('<agent_runtime>') })
    expect(blocks[2]).toEqual({ type: 'text', text: 'hi' })
  })

  test('images are preserved when the agent advertises image prompts', async () => {
    const resolver: PromptAttachmentResolver = {
      image: async () => ({ data: 'AAAA', mimeType: 'image/png' }),
      file: async () => undefined,
    }
    const { blocks, warnings } = await buildPromptBlocks(
      {
        messages: [user([text('look'), { type: 'image', attachment: { attachmentId: 'img-1', name: 'shot.png' } }])],
      },
      caps({ image: true }),
      resolver,
    )
    expect(blocks).toContainEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
    expect(warnings).toEqual([])
  })

  test('unsupported images become an explicit placeholder and warning', async () => {
    const { blocks, warnings } = await buildPromptBlocks(
      {
        messages: [user([text('look'), { type: 'image', attachment: { attachmentId: 'img-1', name: 'shot.png' } }])],
      },
      caps({ image: false }),
    )
    expect(blocks).toContainEqual({ type: 'text', text: '[image omitted: shot.png]' })
    expect(warnings[0]).toContain('does not advertise image prompts')
  })

  test('a file with a host path becomes a resource_link', async () => {
    const resolver: PromptAttachmentResolver = {
      image: async () => undefined,
      file: async () => ({ uri: 'file:///tmp/a.txt', name: 'a.txt', size: 10 }),
    }
    const { blocks } = await buildPromptBlocks(
      { messages: [user([{ type: 'file', attachment: { attachmentId: 'file-1', name: 'a.txt', bytes: 10 } }])] },
      caps(),
      resolver,
    )
    expect(blocks).toContainEqual({ type: 'resource_link', uri: 'file:///tmp/a.txt', name: 'a.txt', size: 10 })
  })

  test('a text file is embedded when the agent supports embedded context', async () => {
    const resolver: PromptAttachmentResolver = {
      image: async () => undefined,
      file: async () => ({ uri: 'attachment://file-1', name: 'a.txt', text: 'body', mimeType: 'text/plain' }),
    }
    const { blocks } = await buildPromptBlocks(
      { messages: [user([{ type: 'file', attachment: { attachmentId: 'file-1', name: 'a.txt' } }])] },
      caps({ embeddedContext: true }),
      resolver,
    )
    expect(blocks).toContainEqual({
      type: 'resource',
      resource: { uri: 'attachment://file-1', text: 'body', mimeType: 'text/plain' },
    })
  })

  test('a missing attachment store produces a warning, not a silent drop', async () => {
    const { blocks, warnings } = await buildPromptBlocks(
      { messages: [user([{ type: 'file', attachment: { attachmentId: 'file-1', name: 'a.txt' } }])] },
      caps(),
      NO_ATTACHMENTS,
    )
    expect(blocks).toContainEqual({ type: 'text', text: '[file: a.txt]' })
    expect(warnings[0]).toContain('no attachment store')
  })

  test('history attachments can be preserved on request', async () => {
    const resolver: PromptAttachmentResolver = {
      image: async () => ({ data: 'AAAA', mimeType: 'image/png' }),
      file: async () => undefined,
    }
    const messages: MessageLike[] = [
      user([text('look'), { type: 'image', attachment: { attachmentId: 'img-1' } }]),
      { role: 'assistant', content: [text('ok')] },
      user([text('next')]),
    ]
    const { blocks } = await buildPromptBlocks(
      { messages, includeHistoryAttachments: true },
      caps({ image: true }),
      resolver,
    )
    expect(blocks.some((b) => b.type === 'image')).toBe(true)
  })

  test('unknown content blocks are reported', async () => {
    const { blocks, warnings } = await buildPromptBlocks(
      { messages: [user([{ type: 'future-block' } as never])] },
      caps(),
    )
    expect(blocks).toContainEqual({ type: 'text', text: '[unsupported content: future-block]' })
    expect(warnings[0]).toContain('unsupported content block')
  })
})

describe('buildDeltaBlocks', () => {
  test('only the new tail is sent', async () => {
    const messages: MessageLike[] = [
      user([text('one')]),
      { role: 'assistant', content: [text('echo:one')] },
      user([text('two')]),
    ]
    const { blocks } = await buildDeltaBlocks({ messages }, 2, caps())
    expect(blocks).toEqual([{ type: 'text', text: 'two' }])
  })

  test('a changed system prompt is delivered as a system update', async () => {
    const messages: MessageLike[] = [user([text('one')]), user([text('two')])]
    const { blocks } = await buildDeltaBlocks({ system: 'new rules', messages }, 1, caps(), NO_ATTACHMENTS, {
      systemChanged: true,
    })
    expect(blocks[0]).toEqual({ type: 'text', text: '<system_update>\nnew rules\n</system_update>' })
    expect(blocks[1]).toEqual({ type: 'text', text: 'two' })
  })

  test('multiple delta messages are labelled as history', async () => {
    const messages: MessageLike[] = [
      user([text('one')]),
      { role: 'assistant', content: [text('echo:one')] },
      user([text('two')]),
      { role: 'tool', content: [text('result')] },
    ]
    const { blocks } = await buildDeltaBlocks({ messages }, 2, caps())
    expect(blocks[0]!.type).toBe('text')
    expect((blocks[0] as { text: string }).text).toContain('<conversation_so_far>')
    expect((blocks[0] as { text: string }).text).toContain('User: two')
    expect(blocks[1]).toEqual({ type: 'text', text: 'Tool: result' })
  })
})
