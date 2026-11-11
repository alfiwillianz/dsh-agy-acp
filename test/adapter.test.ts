import { afterEach, describe, expect, test } from 'bun:test'
import type { Context } from '@deepseek-ai/cordis'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { AcpProcess } from '../src/acp-process.js'
import { AgyAcpAdapter } from '../src/adapter.js'
import type { AgyConfig } from '../src/config.js'
import { silentLogger } from '../src/log.js'
import { mockConfig } from './helpers.js'

interface FakeServices {
  agents?: { get(id: string): unknown }
  approval?: { request(req: unknown): Promise<string> }
  workingDirectory?: { get(session: unknown): string }
}

function fakeCtx(services: FakeServices = {}): Context {
  return {
    get: (name: string) => (services as Record<string, unknown>)[name],
  } as unknown as Context
}

const procs: AcpProcess[] = []

function makeAdapter(scenario = '', overrides: Partial<AgyConfig> = {}, services: FakeServices = {}) {
  const config = mockConfig(scenario, overrides)
  const proc = new AcpProcess(config, silentLogger)
  procs.push(proc)
  const adapter = new AgyAcpAdapter(fakeCtx(services), config, proc, silentLogger)
  return { adapter, proc, config }
}

afterEach(async () => {
  await Promise.all(procs.splice(0).map((p) => p.dispose()))
})

function opts(overrides: Record<string, unknown> = {}): GenerateOptions {
  return {
    provider: 'antigravity',
    model: 'gemini-4-argon',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }],
    ...overrides,
  } as unknown as GenerateOptions
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<{
  chunks: StreamChunk[]
  text: string
  reasoning: string
  finish: FinishReason | undefined
}> {
  const chunks: StreamChunk[] = []
  let text = ''
  let reasoning = ''
  let finish: FinishReason | undefined
  for await (const chunk of stream) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  return { chunks, text, reasoning, finish }
}

function assertProtocol(chunks: readonly StreamChunk[]): void {
  const open = new Set<number>()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') open.add(chunk.index)
    else if (chunk.type === 'block-end') {
      expect(open.has(chunk.index)).toBe(true)
      open.delete(chunk.index)
    } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      expect(open.has(chunk.index)).toBe(true)
    }
  }
  expect(open.size).toBe(0)
  expect(chunks.filter((c) => c.type === 'finish')).toHaveLength(1)
  expect(chunks.at(-1)?.type).toBe('finish')
}

describe('model catalog', () => {
  test('lists only the Gemini families the server reports, with their thinking levels', async () => {
    const { adapter } = makeAdapter()
    const models = await adapter.listModels('antigravity')
    expect(models.map((m) => m.id)).toEqual(['gemini-4-argon', 'gemini-3.8-flash'])
    expect(models.every((m) => m.provider === 'antigravity')).toBe(true)
    expect(models.every((m) => m.inputModalities?.join() === 'text')).toBe(true)
  })

  test('resolves context, output cap and reasoning efforts', async () => {
    const { adapter } = makeAdapter()
    const info = await adapter.resolveModel('antigravity', 'gemini-4-argon')
    expect(info.id).toBe('gemini-4-argon')
    expect(info.name).toBe('Gemini 4 Argon')
    expect(info.context).toEqual({ contextWindow: 1_048_576 })
    expect(info.defaultMaxTokens).toBe(65_536)
    expect(info.reasoning?.efforts.map((e) => e.id)).toEqual(['medium', 'high'])
  })

  test('a missing CLI yields an empty catalog instead of throwing', async () => {
    const { adapter } = makeAdapter('', { command: '/nonexistent/definitely-not-agy' })
    expect(await adapter.listModels('antigravity')).toEqual([])
  })

  test('an unauthenticated CLI yields an empty catalog', async () => {
    const { adapter } = makeAdapter('auth-required')
    expect(await adapter.listModels('antigravity')).toEqual([])
  })
})

describe('streaming', () => {
  test('streams text, reasoning and tool activity, then a stop finish', async () => {
    const { adapter } = makeAdapter()
    const { chunks, text, reasoning, finish } = await collect(adapter.stream(opts()))
    expect(text).toContain('Hello, world!')
    expect(text).toContain('[agy read] Read package.json')
    expect(text).toContain('[agy] Read package.json — completed')
    expect(reasoning).toContain('thinking about it')
    expect(finish).toEqual({ kind: 'stop' })
    assertProtocol(chunks)
  })

  test('tool activity can be hidden', async () => {
    const { adapter } = makeAdapter('', { toolActivity: 'hidden' })
    const { text } = await collect(adapter.stream(opts()))
    expect(text).toContain('Hello, world!')
    expect(text).not.toContain('[agy')
  })

  test('selects the requested model and thinking level through session config options', async () => {
    const { adapter } = makeAdapter()
    const { text } = await collect(
      adapter.stream(opts({ model: 'gemini-3.8-flash', reasoningEffort: 'low' })),
    )
    expect(text).toContain('[model:gemini-3.8-flash+low]')
  })

  test('the restrictive plan mode is applied by default', async () => {
    const { adapter } = makeAdapter()
    const { text } = await collect(adapter.stream(opts()))
    expect(text).toContain('[mode:plan]')
  })

  test('fails the turn when plan mode is not offered', async () => {
    const { adapter } = makeAdapter('no-mode')
    const { finish } = await collect(adapter.stream(opts()))
    expect(finish?.kind).toBe('error')
    if (finish?.kind === 'error') expect(finish.failure.message).toContain('does not offer a "plan" session mode')
  })

  test('sessionMode default works without a mode option', async () => {
    const { adapter } = makeAdapter('no-mode', { sessionMode: 'default' })
    const { text, finish } = await collect(adapter.stream(opts()))
    expect(text).toContain('Hello, world!')
    expect(finish).toEqual({ kind: 'stop' })
  })

  test('an already-aborted signal finishes aborted without spawning', async () => {
    const { adapter, proc } = makeAdapter()
    const ac = new AbortController()
    ac.abort()
    const { finish } = await collect(adapter.stream(opts({ signal: ac.signal })))
    expect(finish?.kind).toBe('aborted')
    expect(proc.running).toBe(false)
  })

  test('aborting mid-turn cancels the ACP turn and finishes aborted', async () => {
    const { adapter } = makeAdapter('hang')
    const ac = new AbortController()
    const run = collect(adapter.stream(opts({ signal: ac.signal })))
    await Bun.sleep(150)
    ac.abort()
    const { finish } = await run
    expect(finish?.kind).toBe('aborted')
  })

  test('a missing CLI becomes a MISSING_CLI error finish', async () => {
    const { adapter } = makeAdapter('', { command: '/nonexistent/definitely-not-agy' })
    const { finish } = await collect(adapter.stream(opts()))
    expect(finish?.kind).toBe('error')
    if (finish?.kind === 'error') {
      expect(finish.failure.code).toBe('MISSING_CLI')
      expect(finish.failure.message).toContain('not found')
    }
  })

  test('an unauthenticated CLI becomes an AUTH error finish', async () => {
    const { adapter } = makeAdapter('auth-required')
    const { finish } = await collect(adapter.stream(opts()))
    expect(finish?.kind).toBe('error')
    if (finish?.kind === 'error') expect(finish.failure.code).toBe('AUTH')
  })

  test('native tool definitions are explained to the agent', async () => {
    const { adapter } = makeAdapter()
    const { text } = await collect(adapter.stream(opts({ tools: [{ name: 'bash' }] })))
    expect(text).toContain('[echo:<agent_runtime>')
  })

  test('system prompts and history are replayed as text', async () => {
    const { adapter } = makeAdapter()
    const { text } = await collect(
      adapter.stream(
        opts({
          system: 'SYS',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'first' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
            { role: 'user', content: [{ type: 'text', text: 'third' }] },
          ],
        }),
      ),
    )
    expect(text).toContain('[echo:<instructions>')
  })
})

describe('permissions', () => {
  const services = (outcome: string): FakeServices => ({
    agents: { get: () => ({ id: 's', session: { id: 's' } }) },
    approval: { request: async () => outcome },
    workingDirectory: { get: () => process.cwd() },
  })

  test('an approval selects allow_once and the agent proceeds', async () => {
    const requests: Array<{ toolName: string; reason: string }> = []
    const { adapter } = makeAdapter('permission', {}, {
      ...services('allowed-once'),
      approval: {
        request: async (req) => {
          requests.push(req as { toolName: string; reason: string })
          return 'allowed-once'
        },
      },
    })
    const { text } = await collect(adapter.stream(opts({ sessionId: 's' })))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.toolName).toBe('edit')
    expect(requests[0]!.reason).toContain('/tmp/notes.txt')
    expect(text).toContain('permission:allow')
  })

  test('a rejection selects reject_once and the tool call fails', async () => {
    const { adapter } = makeAdapter('permission', {}, services('rejected'))
    const { text } = await collect(adapter.stream(opts({ sessionId: 's' })))
    expect(text).toContain('permission:reject')
  })

  test('no approval seam fails closed', async () => {
    const { adapter } = makeAdapter('permission')
    const { text } = await collect(adapter.stream(opts({ sessionId: 's' })))
    expect(text).toContain('permission:reject')
  })

  test('no live agent fails closed', async () => {
    const { adapter } = makeAdapter('permission', {}, { approval: { request: async () => 'allowed-once' } })
    const { text } = await collect(adapter.stream(opts({ sessionId: 'missing' })))
    expect(text).toContain('permission:reject')
  })

  test('a throwing approval fails closed', async () => {
    const { adapter } = makeAdapter('permission', {}, {
      ...services('allowed-once'),
      approval: {
        request: async () => {
          throw new Error('boom')
        },
      },
    })
    const { text } = await collect(adapter.stream(opts({ sessionId: 's' })))
    expect(text).toContain('permission:reject')
  })
})
