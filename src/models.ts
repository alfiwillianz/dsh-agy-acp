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
 * (ai.google.dev/gemini-api/docs/models/gemini-4-argon; ai.google.dev/gemini-api/docs/models/gemini-4-hydrogen;
 * ai.google.dev/gemini-api/docs/whats-new-gemini-3.8): 1,048,576 context window, 65,536 default max output.
 * Gemini 4 Hydrogen has a unified 1,048,576-token window covering input *and* output, with 65,536 as the default
 * per-request output cap. These are Gemini *API* figures; Antigravity plan tiers may enforce lower caps. Families
 * not listed return undefined (dsh's default applies) — notably Orchestrator, a fixed two-model configuration
 * (planner + Hydrogen) for which Google publishes no separate limits.
 */
const FAMILY_LIMITS: ReadonlyArray<readonly [prefix: string, limits: { context: number; output: number }]> = [
  ['gemini-4-argon', { context: 1_048_576, output: 65_536 }],
  ['gemini-4-hydrogen', { context: 1_048_576, output: 65_536 }],
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
 * levels, using the server's own `model` config option to find the family and the id suffix to find the level.
 * The level comes from the advertised id itself because the `thought_level` select can lag behind: Gemini 4 Hydrogen
 * advertises `gemini-4-hydrogen-xhigh` while that select still lists only low/medium/high. Anything that does not
 * decompose is kept as a standalone model so nothing the server reports is lost or invented.
 */
export function extractGeminiFamilies(newSessionResponse: unknown): ModelFamily[] {
  const configOptions = (newSessionResponse as { configOptions?: unknown } | null)?.configOptions
  const familyNames = new Map(selectEntries(findOption(configOptions, 'model')).map((e) => [e.value, e.name]))
  const families = new Map<string, { name: string; levels: string[] }>()
  for (const m of extractGeminiModels(newSessionResponse)) {
    const decomposed = decomposeModelId(m.id, configOptions)
    if (decomposed === undefined) {
      families.set(m.id, { name: m.name, levels: [] })
      continue
    }
    const entry = families.get(decomposed.family) ?? {
      name:
        familyNames.get(decomposed.family) ??
        (m.name.replace(/\s*\([^)]*\)\s*$/, '').trim() || decomposed.family),
      levels: [],
    }
    if (decomposed.level !== undefined && decomposed.level !== '' && !entry.levels.includes(decomposed.level)) {
      entry.levels.push(decomposed.level)
    }
    families.set(decomposed.family, entry)
  }
  return [...families].map(([id, v]) => ({ id, name: v.name, levels: v.levels }))
}

/**
 * Thinking levels the server advertises for a model id (a family id or a `<family>-<level>` id), derived from
 * `models.availableModels`. Used to accept levels such as `xhigh` that the `thought_level` select omits.
 */
export function advertisedLevelsFor(newSessionResponse: unknown, modelId: string): string[] {
  const families = extractGeminiFamilies(newSessionResponse)
  const exact = families.find((f) => f.id === modelId)
  if (exact !== undefined) return [...exact.levels]
  const prefixed = families
    .filter((f) => modelId.startsWith(f.id + '-'))
    .sort((a, b) => b.id.length - a.id.length)[0]
  return prefixed === undefined ? [] : [...prefixed.levels]
}

/** Config step selecting a thinking level, validated against the server's `thought_level` option and its catalog. */
export function thoughtLevelStep(
  level: string,
  configOptions: unknown,
  advertisedLevels: readonly string[] = [],
): ConfigStep {
  const opt = findOption(configOptions, 'thought_level')
  if (
    !opt ||
    typeof opt.id !== 'string' ||
    !(selectValues(opt).includes(level) || advertisedLevels.includes(level))
  ) {
    throw new Error(`Antigravity does not offer thinking level "${level}" for this session.`)
  }
  return { configId: opt.id, value: level }
}

export interface ConfigStep {
  readonly configId: string
  readonly value: string
}

/** Canonical least-to-greatest order for the thinking levels Antigravity reports (`xhigh` is Hydrogen's "Extra"). */
const LEVEL_ORDER: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2, xhigh: 3 }

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

interface SelectEntry {
  readonly value: string
  readonly name?: string
}

function selectEntries(option: ConfigOptionLike | undefined): SelectEntry[] {
  if (!option || option.type !== 'select' || !Array.isArray(option.options)) return []
  const out: SelectEntry[] = []
  for (const o of option.options as Array<{ value?: unknown; name?: unknown; options?: unknown }>) {
    if (typeof o?.value === 'string') out.push({ value: o.value, ...(typeof o.name === 'string' && o.name ? { name: o.name } : {}) })
    // grouped options
    if (Array.isArray(o?.options)) {
      for (const g of o.options as Array<{ value?: unknown; name?: unknown }>) {
        if (typeof g?.value === 'string') out.push({ value: g.value, ...(typeof g.name === 'string' && g.name ? { name: g.name } : {}) })
      }
    }
  }
  return out
}

function selectValues(option: ConfigOptionLike | undefined): string[] {
  return selectEntries(option).map((e) => e.value)
}

function findOption(configOptions: unknown, kind: 'model' | 'thought_level' | 'mode'): ConfigOptionLike | undefined {
  const opts = Array.isArray(configOptions) ? (configOptions as ConfigOptionLike[]) : []
  return opts.find((o) => o?.category === kind || o?.id === kind)
}

interface DecomposedModelId {
  /** Family id as the server's `model` config option knows it. */
  readonly family: string
  /** Thinking level carried by the id suffix, when the server advertises one. */
  readonly level?: string
}

/**
 * Split a reported model id into the server's `model` option value plus its thinking-level suffix. Returns
 * undefined when the session response has no `model` option or the id matches no advertised family.
 */
function decomposeModelId(modelId: string, configOptions: unknown): DecomposedModelId | undefined {
  const modelOpt = findOption(configOptions, 'model')
  if (!modelOpt) return undefined
  const families = selectValues(modelOpt)
  if (families.includes(modelId)) return { family: modelId }
  // Longest family that prefixes the id wins (so `a-b` beats `a`).
  const family = families.filter((f) => modelId.startsWith(f + '-')).sort((a, b) => b.length - a.length)[0]
  if (family === undefined) return undefined
  return { family, level: modelId.slice(family.length + 1) }
}

/**
 * Config step that puts the session into the requested Antigravity mode.
 * `default` => no step (the server's native mode). `plan` => must be offered by the server's `mode` option;
 * if it is not, this throws so the caller fails closed rather than silently running in a less restrictive mode.
 */
export function modeStep(sessionMode: 'plan' | 'default', configOptions: unknown): ConfigStep | undefined {
  if (sessionMode === 'default') return undefined
  const modeOpt = findOption(configOptions, 'mode')
  if (!modeOpt || typeof modeOpt.id !== 'string' || !selectValues(modeOpt).includes(sessionMode)) {
    throw new Error(
      `Antigravity does not offer a "${sessionMode}" session mode, so the restrictive sessionMode cannot be enforced. ` +
        `Refusing to continue. (Set sessionMode to "default" only if you accept that Antigravity may write files without asking.)`,
    )
  }
  return { configId: modeOpt.id, value: sessionMode }
}

/**
 * Translate a reported model id (e.g. `gemini-4-hydrogen-xhigh`) into the stable `session/set_config_option`
 * calls the server understands: a `model` option (family) plus, when the id carries a suffix, the
 * `thought_level` option. A level is applied when the server's `thought_level` select lists it or when the catalog
 * advertises it for this family (`advertisedLevels`, see `advertisedLevelsFor`). If the server's `model` option
 * lists the id verbatim, a single step is used. Returns `[]` when the session response has no model option (the
 * session's default model is then used).
 */
export function configStepsForModel(
  modelId: string,
  configOptions: unknown,
  advertisedLevels: readonly string[] = [],
): ConfigStep[] {
  const modelOpt = findOption(configOptions, 'model')
  if (!modelOpt || typeof modelOpt.id !== 'string') return []
  const decomposed = decomposeModelId(modelId, configOptions)
  if (decomposed === undefined) return []

  const steps: ConfigStep[] = [{ configId: modelOpt.id, value: decomposed.family }]
  const level = decomposed.level
  if (level === undefined || level === '') return steps
  const levelOpt = findOption(configOptions, 'thought_level')
  if (!levelOpt || typeof levelOpt.id !== 'string') return steps
  if (selectValues(levelOpt).includes(level) || advertisedLevels.includes(level)) {
    steps.push({ configId: levelOpt.id, value: level })
  }
  return steps
}
