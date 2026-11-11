import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, type AgyConfig } from '../src/config.js'
import { AcpProcess, type PermissionRequest, type SessionHandlers, type SessionUpdate } from '../src/acp-process.js'
import type { AcpOutcome } from '../src/permission.js'
import { silentLogger } from '../src/log.js'

export const MOCK_AGENT = fileURLToPath(new URL('./mock-agent.ts', import.meta.url))

/** Config that launches the mock ACP server via Bun with the given scenario flags. */
export function mockConfig(scenario = '', overrides: Partial<AgyConfig> = {}): AgyConfig {
  process.env.MOCK_SCENARIO = scenario
  return {
    ...DEFAULT_CONFIG,
    command: process.execPath,
    args: [MOCK_AGENT],
    startupTimeoutMs: 8_000,
    requestTimeoutMs: 8_000,
    idleTimeoutMs: 0,
    ...overrides,
  }
}

export interface Collected {
  updates: SessionUpdate[]
  permissions: PermissionRequest[]
  text(): string
}

export function collector(
  onPermission?: (r: PermissionRequest, s: AbortSignal) => Promise<AcpOutcome>,
): { handlers: SessionHandlers; got: Collected } {
  const updates: SessionUpdate[] = []
  const permissions: PermissionRequest[] = []
  return {
    handlers: {
      onUpdate: (u) => void updates.push(u),
      onPermission: async (r, s) => {
        permissions.push(r)
        return onPermission ? onPermission(r, s) : { outcome: 'cancelled' }
      },
    },
    got: {
      updates,
      permissions,
      text: () =>
        updates
          .filter((u) => u.sessionUpdate === 'agent_message_chunk')
          .map((u) => (u as { content: { text?: string } }).content.text ?? '')
          .join(''),
    },
  }
}

export function newProc(scenario = '', overrides: Partial<AgyConfig> = {}): AcpProcess {
  return new AcpProcess(mockConfig(scenario, overrides), silentLogger)
}
