import { AcpProcess } from '../lib/types/acp-process.js'
import { AgyAcpAdapter } from '../lib/types/adapter.js'
import { resolveConfig } from '../lib/types/config.js'
import { createLogger } from '../lib/types/log.js'

const config = resolveConfig({ debug: true, startupTimeoutMs: 20000, requestTimeoutMs: 30000 })
const log = createLogger({ debug: true })
const proc = new AcpProcess(config, log)
const adapter = new AgyAcpAdapter({ get: () => undefined }, config, proc, log)
try {
  const models = await adapter.listModels('antigravity')
  console.log('MODELS', JSON.stringify(models, null, 2))
  for (const m of models) {
    const info = await adapter.resolveModel('antigravity', m.id)
    console.log('INFO', m.id, JSON.stringify(info))
  }
} catch (e) {
  console.error('FAILED', e)
} finally {
  await proc.dispose()
}
