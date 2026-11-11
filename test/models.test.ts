import { describe, expect, test } from 'bun:test'
import {
  configStepsForModel,
  extractGeminiFamilies,
  extractGeminiModels,
  isGeminiModelId,
  knownLimits,
  modeStep,
  orderThinkingLevels,
  thoughtLevelStep,
} from '../src/models.js'

const CONFIG_OPTIONS = [
  {
    id: 'mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'accept-edits', name: 'Accept edits' },
      { value: 'plan', name: 'Plan' },
    ],
  },
  {
    id: 'model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-4-argon',
    options: [
      { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
      { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
      { value: 'claude-sonnet-5-5', name: 'Claude' },
    ],
  },
  {
    id: 'thought_level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
]

const SESSION_RESPONSE = {
  models: {
    availableModels: [
      { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
      { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
      { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
      { modelId: 'claude-sonnet-5-5-medium', name: 'Claude Sonnet 5.5 (Medium)' },
      { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    ],
  },
  configOptions: CONFIG_OPTIONS,
}

describe('model id filtering', () => {
  test('only Gemini ids are accepted', () => {
    expect(isGeminiModelId('gemini-4-argon')).toBe(true)
    expect(isGeminiModelId('gemini_3.8_flash')).toBe(true)
    expect(isGeminiModelId('claude-sonnet-5-5')).toBe(false)
    expect(isGeminiModelId('gpt-oss-120b')).toBe(false)
  })

  test('extractGeminiModels filters other vendors and deduplicates', () => {
    const models = extractGeminiModels({
      models: {
        availableModels: [
          { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
          { modelId: 'gemini-4-argon-medium', name: 'duplicate' },
          { modelId: 'claude-sonnet-5-5-medium', name: 'Claude' },
          { modelId: 'gemini-3.8-flash-low' },
        ],
      },
    })
    expect(models.map((m) => m.id)).toEqual(['gemini-4-argon-medium', 'gemini-3.8-flash-low'])
    expect(models[1]!.name).toBe('gemini-3.8-flash-low')
  })

  test('a malformed or missing models list yields nothing', () => {
    expect(extractGeminiModels(undefined)).toEqual([])
    expect(extractGeminiModels({ models: {} })).toEqual([])
    expect(extractGeminiModels({ models: { availableModels: 'nope' } })).toEqual([])
  })
})

describe('family discovery', () => {
  test('collapses per-level ids into one family with its levels', () => {
    const families = extractGeminiFamilies(SESSION_RESPONSE)
    expect(families).toEqual([
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', levels: ['medium', 'high'] },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', levels: ['low'] },
    ])
  })

  test('keeps a model that cannot be decomposed as a standalone entry', () => {
    const families = extractGeminiFamilies({
      models: { availableModels: [{ modelId: 'gemini-unknown', name: 'Gemini Unknown' }] },
      configOptions: CONFIG_OPTIONS,
    })
    expect(families).toEqual([{ id: 'gemini-unknown', name: 'Gemini Unknown', levels: [] }])
  })

  test('without config options every model is standalone', () => {
    const families = extractGeminiFamilies({
      models: { availableModels: [{ modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' }] },
    })
    expect(families).toEqual([{ id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)', levels: [] }])
  })
})

describe('config steps', () => {
  test('decomposes a family+level model id', () => {
    expect(configStepsForModel('gemini-4-argon-high', CONFIG_OPTIONS)).toEqual([
      { configId: 'model', value: 'gemini-4-argon' },
      { configId: 'thought_level', value: 'high' },
    ])
  })

  test('selects an exact model id verbatim when the server lists it', () => {
    expect(configStepsForModel('gemini-3.8-flash', CONFIG_OPTIONS)).toEqual([
      { configId: 'model', value: 'gemini-3.8-flash' },
    ])
  })

  test('returns no steps without a model option', () => {
    expect(configStepsForModel('gemini-4-argon', [])).toEqual([])
    expect(configStepsForModel('gemini-4-argon', undefined)).toEqual([])
  })

  test('thoughtLevelStep validates against the server option', () => {
    expect(thoughtLevelStep('low', CONFIG_OPTIONS)).toEqual({ configId: 'thought_level', value: 'low' })
    expect(() => thoughtLevelStep('ultra', CONFIG_OPTIONS)).toThrow(/does not offer thinking level/)
    expect(() => thoughtLevelStep('low', [])).toThrow(/does not offer thinking level/)
  })

  test('modeStep enforces plan and skips default', () => {
    expect(modeStep('default', CONFIG_OPTIONS)).toBeUndefined()
    expect(modeStep('plan', CONFIG_OPTIONS)).toEqual({ configId: 'mode', value: 'plan' })
    expect(() => modeStep('plan', [])).toThrow(/does not offer a "plan" session mode/)
  })

  test('knownLimits only answers for published families', () => {
    expect(knownLimits('gemini-4-argon')).toEqual({ context: 1_048_576, output: 65_536 })
    expect(knownLimits('gemini-3.8-flash-low')).toEqual({ context: 1_048_576, output: 65_536 })
    expect(knownLimits('gemini-unknown')).toBeUndefined()
  })

  test('thinking levels are ordered least to greatest', () => {
    expect(orderThinkingLevels(['high', 'low', 'medium'])).toEqual(['low', 'medium', 'high'])
    expect(orderThinkingLevels(['high', 'ultra', 'low'])).toEqual(['low', 'high', 'ultra'])
    expect(orderThinkingLevels([])).toEqual([])
  })
})
