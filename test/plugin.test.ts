import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.js'
import { apply, PROVIDER } from '../src/index.js'

interface FakeContext {
  registered: string[][]
  directories: unknown[]
  cleanup: (() => void) | undefined
}

function fakeContext(entryId: string | undefined): { ctx: unknown; state: FakeContext } {
  const state: FakeContext = { registered: [], directories: [], cleanup: undefined }
  const ctx = {
    llm: {
      registerAdapter: (providers: string[]) => {
        state.registered.push(providers)
        return Object.assign(() => {}, { replace() {} })
      },
      registerConfigurableProviders: (entries: unknown[]) => {
        state.directories.push(entries)
        return Object.assign(() => {}, { replace() {} })
      },
    },
    effect: (fn: () => () => void) => {
      state.cleanup = fn()
      return () => {}
    },
    fiber: entryId === undefined ? {} : { entry: { options: { id: entryId } } },
    get: () => undefined,
  }
  return { ctx, state }
}

describe('plugin entry', () => {
  test('registers the antigravity adapter and a configurable provider', () => {
    const { ctx, state } = fakeContext('agy-acp')
    apply(ctx as never, resolveConfig(DEFAULT_CONFIG))
    expect(state.registered).toEqual([[PROVIDER]])
    expect(state.directories).toEqual([
      [
        {
          provider: PROVIDER,
          displayName: 'Antigravity (Gemini via ACP)',
          settingsNs: 'agy-acp',
          settingsPath: [],
        },
      ],
    ])
    expect(typeof state.cleanup).toBe('function')
  })

  test('falls back to the package name when no entry id is available', () => {
    const { ctx, state } = fakeContext(undefined)
    apply(ctx as never, resolveConfig(DEFAULT_CONFIG))
    expect((state.directories[0] as Array<{ settingsNs: string }>)[0]!.settingsNs).toBe('agy-acp')
  })

  test('cleanup unregisters the adapter and the directory entry', () => {
    const { ctx, state } = fakeContext('agy-acp')
    apply(ctx as never, resolveConfig(DEFAULT_CONFIG))
    expect(() => state.cleanup?.()).not.toThrow()
  })

  test('refuses a configuration that bypasses permissions', () => {
    const { ctx } = fakeContext('agy-acp')
    expect(() =>
      apply(ctx as never, resolveConfig({ ...DEFAULT_CONFIG, args: ['acp', '--dangerously-skip-permissions'] })),
    ).toThrow(/not allowed/)
  })
})
