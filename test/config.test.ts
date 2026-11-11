import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.js'
import { ConfigError } from '../src/errors.js'

describe('resolveConfig', () => {
  test('defaults are safe and complete', () => {
    const config = resolveConfig(undefined)
    expect(config.command).toBe('agy')
    expect(config.args).toEqual(['acp'])
    expect(config.permissionMode).toBe('allow-once')
    expect(config.sessionMode).toBe('plan')
    expect(config.toolActivity).toBe('text')
    expect(config.logFile).toBeUndefined()
  })

  test('trims the executable and normalizes an empty log file', () => {
    const config = resolveConfig({ ...DEFAULT_CONFIG, command: '  agy  ', logFile: '   ' })
    expect(config.command).toBe('agy')
    expect(config.logFile).toBeUndefined()
  })

  test('rejects flags that bypass permissions or redirect the CLI', () => {
    for (const flag of [
      '--dangerously-skip-permissions',
      '--cloud_code_endpoint',
      '--override_user_agent_name',
      '--gemini-dir',
      '--app_data_dir',
      '--cli_dir_name',
      '--login',
    ]) {
      expect(() => resolveConfig({ ...DEFAULT_CONFIG, args: ['acp', flag] })).toThrow(ConfigError)
      expect(() => resolveConfig({ ...DEFAULT_CONFIG, args: ['acp', `${flag}=x`] })).toThrow(ConfigError)
    }
  })

  test('allows safe ACP flags', () => {
    expect(resolveConfig({ ...DEFAULT_CONFIG, args: ['acp', '--sandbox'] }).args).toEqual(['acp', '--sandbox'])
  })

  test('rejects an empty command', () => {
    expect(() => resolveConfig({ ...DEFAULT_CONFIG, command: '   ' })).toThrow(ConfigError)
  })

  test('rejects invalid enums', () => {
    expect(() => resolveConfig({ ...DEFAULT_CONFIG, permissionMode: 'allow' as never })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...DEFAULT_CONFIG, sessionMode: 'accept-edits' as never })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...DEFAULT_CONFIG, toolActivity: 'loud' as never })).toThrow(ConfigError)
  })

  test('rejects out-of-range numbers', () => {
    expect(() => resolveConfig({ ...DEFAULT_CONFIG, startupTimeoutMs: 0 })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...DEFAULT_CONFIG, requestTimeoutMs: -1 })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...DEFAULT_CONFIG, idleTimeoutMs: -1 })).toThrow(ConfigError)
    expect(() => resolveConfig({ ...DEFAULT_CONFIG, modelsRefreshMs: -1 })).toThrow(ConfigError)
  })
})
