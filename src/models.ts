/**
 * Model discovery helpers. Model IDs are never invented: everything here is derived from what the ACP server
 * reports in its `session/new` response (`models.availableModels` and `configOptions`).
 */

export interface DiscoveredModel {
  readonly id: string
  readonly name: string
}

interface AvailableModel {
  modelId?: unknown
  name?: unknown
}

interface ConfigOptionLike {
  id?: unknown
  category?: unknown
  type?: unknown
  options?: unknown
}

/** Only Gemini models are exposed by this integration, even if the server also lists other vendors' models. */
export function isGeminiModelId(id: string): boolean {
  return /^gemini[-_.]/i.test(id)
}

export function extractGeminiModels(newSessionResponse: unknown): DiscoveredModel[] {
  const available = (newSessionResponse as { models?: { availableModels?: unknown } } | null)?.models?.availableModels
  if (!Array.isArray(available)) return []
  const seen = new Set<string>()
  const out: DiscoveredModel[] = []
  for (const entry of available as AvailableModel[]) {
    if (typeof entry?.modelId !== 'string' || !isGeminiModelId(entry.modelId)) continue
    if (seen.has(entry.modelId)) continue
    seen.add(entry.modelId)
    out.push({ id: entry.modelId, name: typeof entry.name === 'string' && entry.name ? entry.name : entry.modelId })
  }
  return out
}

/**
 * Token limits per model family. `agy acp` reports none, so these come from Google's published model docs
 * (ai.google.dev/gemini-api/docs/models/gemini-4-argon; ai.google.dev/gemini-api/docs/whats-new-gemini-3.8):
 * 1,048,576 context window, 65,536 default max output, for both families. They are Gemini *API* figures;
 * Antigravity plan tiers may enforce lower caps. Families not listed return undefined (dsh's default applies).
 */
const FAMILY_LIMITS: ReadonlyArray<readonly [prefix: string, limits: { context: number; output: number }]> = [
  ['gemini-4-argon', { context: 1_048_576, output: 65_536 }],
  ['gemini-3.8-flash', { context: 1_048_576, output: 65_536 }],
]

export function knownLimits(modelId: string): { context: number; output: number } | undefined {
  return FAMILY_LIMITS.find(([prefix]) => modelId === prefix || modelId.startsWith(prefix + '-'))?.[1]
}

export interface ModelFamily {
  /** Family id as the server's `model` config option knows it (e.g. `gemini-4-argon`), or a standalone model id. */
  readonly id: string
  readonly name: string
  /** Thinking levels the server reports for this family (e.g. low/medium/high); empty if it has none. */
  readonly levels: readonly string[]
}

/**
 * Collapse the server's per-level model ids (`gemini-4-argon-low|medium|high`) into one entry per family with its
 * levels, using the server's own `model` / `thought_level` config options to decompose. Anything that does not
 * decompose is kept as a standalone model so nothing the server reports is lost or invented.
 */
export function extractGeminiFamilies(newSessionResponse: unknown): ModelFamily[] {
  const configOptions = (newSessionResponse as { configOptions?: unknown } | null)?.configOptions
  const families = new Map<string, { name: string; levels: string[] }>()
  for (const m of extractGeminiModels(newSessionResponse)) {
    const steps = configStepsForModel(m.id, configOptions)
    const family = steps[0]?.value
    const level = steps[1]?.value
    if (!family) {
      families.set(m.id, { name: m.name, levels: [] })
      continue
    }
    const entry = families.get(family) ?? {
      name: m.name.replace(/\s*\([^)]*\)\s*$/, '').trim() || family,
      levels: [],
    }
    if (level && !entry.levels.includes(level)) entry.levels.push(level)
    families.set(family, entry)
  }
  return [...families].map(([id, v]) => ({ id, name: v.name, levels: v.levels }))
}

/** Config step selecting a thinking level, validated against the server's `thought_level` option. */
export function thoughtLevelStep(level: string, configOptions: unknown): ConfigStep {
  const opts = Array.isArray(configOptions) ? (configOptions as ConfigOptionLike[]) : []
  const opt = opts.find((o) => o?.category === 'thought_level' || o?.id === 'thought_level')
  if (!opt || typeof opt.id !== 'string' || !selectValues(opt).includes(level)) {
    throw new Error(`Antigravity does not offer thinking level "${level}" for this session.`)
  }
  return { configId: opt.id, value: level }
}

export interface ConfigStep {
  readonly configId: string
  readonly value: string
}

/** Canonical least-to-greatest order for the thinking levels Antigravity reports. */
const LEVEL_ORDER: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2 }

/**
 * Order thinking levels from least to greatest, as dsh's reasoning-effort contract requires. Unknown levels keep
 * a deterministic alphabetical order after the known ones instead of being dropped.
 */
export function orderThinkingLevels(levels: readonly string[]): string[] {
  return [...levels].sort((a, b) => {
    const rank = (LEVEL_ORDER[a] ?? 99) - (LEVEL_ORDER[b] ?? 99)
    return rank !== 0 ? rank : a.localeCompare(b)
  })
}

function selectValues(option: ConfigOptionLike | undefined): string[] {
  if (!option || option.type !== 'select' || !Array.isArray(option.options)) return []
  const values: string[] = []
  for (const o of option.options as Array<{ value?: unknown; options?: unknown }>) {
    if (typeof o?.value === 'string') values.push(o.value)
    // grouped options
    if (Array.isArray(o?.options)) {
      for (const g of o.options as Array<{ value?: unknown }>) if (typeof g?.value === 'string') values.push(g.value)
    }
  }
  return values
}

/**
 * Config step that puts the session into the requested Antigravity mode.
 * `default` => no step (the server's native mode). `plan` => must be offered by the server's `mode` option;
 * if it is not, this throws so the caller fails closed rather than silently running in a less restrictive mode.
 */
export function modeStep(sessionMode: 'plan' | 'default', configOptions: unknown): ConfigStep | undefined {
  if (sessionMode === 'default') return undefined
  const opts = Array.isArray(configOptions) ? (configOptions as ConfigOptionLike[]) : []
  const modeOpt = opts.find((o) => o?.category === 'mode' || o?.id === 'mode')
  if (!modeOpt || typeof modeOpt.id !== 'string' || !selectValues(modeOpt).includes(sessionMode)) {
    throw new Error(
      `Antigravity does not offer a "${sessionMode}" session mode, so the restrictive sessionMode cannot be enforced. ` +
        `Refusing to continue. (Set sessionMode to "default" only if you accept that Antigravity may write files without asking.)`,
    )
  }
  return { configId: modeOpt.id, value: sessionMode }
}

/**
 * Translate a reported model id (e.g. `gemini-3.8-flash-high`) into the stable `session/set_config_option`
 * calls the server understands: a `model` option (family) plus, when the id carries a suffix, the
 * `thought_level` option. If the server's `model` option lists the id verbatim, a single step is used.
 * Returns `[]` when the session response has no model option (the session's default model is then used).
 */
export function configStepsForModel(modelId: string, configOptions: unknown): ConfigStep[] {
  if (!Array.isArray(configOptions)) return []
  const opts = configOptions as ConfigOptionLike[]
  const modelOpt = opts.find((o) => o?.category === 'model' || o?.id === 'model')
  const levelOpt = opts.find((o) => o?.category === 'thought_level' || o?.id === 'thought_level')
  if (!modelOpt || typeof modelOpt.id !== 'string') return []

  const families = selectValues(modelOpt)
  if (families.includes(modelId)) return [{ configId: modelOpt.id, value: modelId }]

  // Longest family that prefixes the id wins (so `a-b` beats `a`).
  const family = families.filter((f) => modelId.startsWith(f + '-')).sort((a, b) => b.length - a.length)[0]
  if (family) {
    const level = modelId.slice(family.length + 1)
    const steps: ConfigStep[] = [{ configId: modelOpt.id, value: family }]
    if (levelOpt && typeof levelOpt.id === 'string' && selectValues(levelOpt).includes(level)) {
      steps.push({ configId: levelOpt.id, value: level })
    }
    return steps
  }
  return []
}
