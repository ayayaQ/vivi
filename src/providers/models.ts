// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
import type { ReasoningEffort, ReasoningSelection } from './transport.js'

export type { ReasoningEffort, ReasoningSelection } from './transport.js'

/** A documented capability is not an assertion of account access or request success. */
export type Capability = 'supported' | 'unsupported' | 'unknown'
export type CapabilityProvider = 'openai' | 'openrouter'
export type ApiProtocol = 'responses' | 'chat-completions'
export type ReasoningRequirement = 'required' | 'optional' | 'unknown'

export interface CapabilityInput {
  apiVersion: 1
  provider: CapabilityProvider
  protocol: ApiProtocol
  /** One entry from a host-fetched catalog, or just { id } for a host-selected model. */
  model: unknown
}

export interface CapabilitySource {
  kind: 'official-model-documentation' | 'provider-catalog'
  /** Documentation of the static fact or interpretation, never a credential-bearing URL. */
  url: string
  /** Date the documentation was reviewed, not when the host fetched its catalog. */
  reviewedOn: string
}

export interface ModelCapabilities {
  apiVersion: 1
  provider: CapabilityProvider
  protocol: ApiProtocol
  /** Exact catalog ID. No trimming, aliases, prefixes, or case folding. */
  id: string
  /** Text conversation through this particular provider and protocol. */
  chat: Capability
  tools: Capability
  stream: Capability
  reasoning: {
    support: Capability
    /** Explicit disable can be supported independently of named effort selection. */
    disable: Capability
    /** Whether the metadata describes an effort selector; not whether reasoning exists. */
    effortSelection: Capability
    /** Known accepted choices only. Empty never means reasoning is off by default. */
    efforts: readonly ReasoningEffort[]
    /** Required means reasoning cannot be disabled, not that an override must be sent. */
    requirement: ReasoningRequirement
  }
  sources: readonly CapabilitySource[]
}

const REVIEWED_ON = '2026-10-05'
const EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const OPENROUTER_MODELS = 'https://openrouter.ai/docs/guides/overview/models'
const OPENROUTER_REASONING = 'https://openrouter.ai/docs/guides/best-practices/reasoning-tokens'

type Facts = Pick<ModelCapabilities, 'chat' | 'tools' | 'stream' | 'reasoning'>
interface DocumentedFacts {
  ids: readonly string[]
  protocols: readonly ApiProtocol[]
  facts: Facts
  url: string
}

// Deliberately bounded to the exact IDs verified in CAPABILITIES.md. This is not a
// copy of either host's catalog. Unreviewed IDs, fine-tunes, and versions stay unknown.
const DOCUMENTED_OPENAI: readonly DocumentedFacts[] = [
  {
    ids: ['gpt-5', 'gpt-5-2025-08-07'],
    protocols: ['responses', 'chat-completions'],
    facts: {
      chat: 'supported', tools: 'supported', stream: 'supported',
      reasoning: { support: 'supported', disable: 'unsupported', effortSelection: 'supported',
        efforts: ['minimal', 'low', 'medium', 'high'], requirement: 'required' }
    },
    url: 'https://developers.openai.com/api/docs/models/gpt-5'
  },
  {
    ids: ['gpt-5.1', 'gpt-5.1-2025-11-13'],
    protocols: ['responses', 'chat-completions'],
    facts: {
      chat: 'supported', tools: 'supported', stream: 'supported',
      reasoning: { support: 'supported', disable: 'supported', effortSelection: 'supported',
        efforts: ['none', 'low', 'medium', 'high'], requirement: 'optional' }
    },
    url: 'https://developers.openai.com/api/docs/models/gpt-5.1'
  },
  {
    ids: ['gpt-4.1', 'gpt-4.1-2025-04-14'],
    protocols: ['responses', 'chat-completions'],
    facts: {
      chat: 'supported', tools: 'supported', stream: 'supported',
      reasoning: { support: 'unsupported', disable: 'unsupported', effortSelection: 'unsupported',
        efforts: [], requirement: 'optional' }
    },
    url: 'https://developers.openai.com/api/docs/models/gpt-4.1'
  },
  {
    ids: ['gpt-5-pro', 'gpt-5-pro-2025-10-06'],
    protocols: ['responses'],
    facts: {
      chat: 'supported', tools: 'supported', stream: 'supported',
      reasoning: { support: 'supported', disable: 'unsupported', effortSelection: 'supported',
        efforts: ['high'], requirement: 'required' }
    },
    url: 'https://developers.openai.com/api/docs/models/gpt-5-pro'
  },
  {
    ids: ['o3-pro', 'o3-pro-2025-06-10'],
    protocols: ['responses'],
    facts: {
      chat: 'supported', tools: 'supported', stream: 'unsupported',
      reasoning: { support: 'supported', disable: 'unknown', effortSelection: 'unknown',
        efforts: [], requirement: 'unknown' }
    },
    url: 'https://developers.openai.com/api/docs/models/o3-pro'
  }
]
const EMBEDDING_URL = 'https://developers.openai.com/api/docs/models/text-embedding-3-small'

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Catalogs are JSON data. Never invoke an accessor while looking for metadata.
function field(value: unknown, key: string): unknown {
  if (!record(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined
  const result: string[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') return undefined
    result.push(descriptor.value)
  }
  return result
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[^\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,200}$/.test(value)
}

function source(kind: CapabilitySource['kind'], url: string): CapabilitySource {
  return { kind, url, reviewedOn: REVIEWED_ON }
}

function unknown(provider: CapabilityProvider, protocol: ApiProtocol, id: string): ModelCapabilities {
  return {
    apiVersion: 1, provider, protocol, id,
    chat: 'unknown', tools: 'unknown', stream: 'unknown',
    reasoning: { support: 'unknown', disable: 'unknown', effortSelection: 'unknown', efforts: [], requirement: 'unknown' },
    sources: []
  }
}

function unsupported(result: ModelCapabilities): void {
  result.chat = 'unsupported'
  result.tools = 'unsupported'
  result.stream = 'unsupported'
  result.reasoning = {
    support: 'unsupported', disable: 'unsupported', effortSelection: 'unsupported', efforts: [], requirement: 'optional'
  }
}

function openai(result: ModelCapabilities): void {
  if (result.id === 'text-embedding-3-small') {
    unsupported(result)
    result.sources = [source('official-model-documentation', EMBEDDING_URL)]
    return
  }
  const entry = DOCUMENTED_OPENAI.find((candidate) => candidate.ids.includes(result.id))
  if (!entry) return
  result.sources = [source('official-model-documentation', entry.url)]
  if (!entry.protocols.includes(result.protocol)) {
    unsupported(result)
    return
  }
  Object.assign(result, entry.facts)
  result.reasoning = { ...entry.facts.reasoning, efforts: [...entry.facts.reasoning.efforts] }
}

function openrouter(result: ModelCapabilities, model: unknown): void {
  // The reviewed model-catalog fields describe the Chat Completions gateway.
  // They do not prove support on OpenRouter's separate Responses endpoint.
  if (result.protocol !== 'chat-completions') return
  const parameters = stringList(field(model, 'supported_parameters'))
  const architecture = field(model, 'architecture')
  const input = stringList(field(architecture, 'input_modalities'))
  const output = stringList(field(architecture, 'output_modalities'))
  let catalogEvidence = false
  if (parameters) {
    result.tools = parameters.includes('tools') ? 'supported' : 'unsupported'
    catalogEvidence = true
  }
  if (input && !input.includes('text') || output && !output.includes('text')) {
    result.chat = 'unsupported'
    catalogEvidence = true
  } else if (input && output) {
    result.chat = 'supported'
    catalogEvidence = true
  }
  const reasoning = field(model, 'reasoning')
  if (record(reasoning)) {
    const supported = field(reasoning, 'supported_efforts')
    const supportedList = stringList(supported)
    const mandatory = field(reasoning, 'mandatory')
    const knownEfforts = supported === null || supportedList !== undefined
    const knownReasoning = knownEfforts || typeof mandatory === 'boolean' ||
      typeof field(reasoning, 'default_enabled') === 'boolean' ||
      EFFORTS.includes(field(reasoning, 'default_effort') as ReasoningEffort) ||
      field(reasoning, 'supports_max_tokens') === true
    if (knownReasoning || parameters &&
        (parameters.includes('reasoning') || parameters.includes('include_reasoning'))) {
      result.reasoning.support = 'supported'
    }
    result.reasoning.requirement = mandatory === true ? 'required' : mandatory === false ? 'optional' : 'unknown'
    if (mandatory === true) result.reasoning.disable = 'unsupported'
    else if (mandatory === false) result.reasoning.disable = 'supported'
    if (knownEfforts) {
      result.reasoning.effortSelection = 'supported'
      result.reasoning.efforts = supported === null ? [...EFFORTS] :
        EFFORTS.filter((effort) => supportedList!.includes(effort))
      if (mandatory === true) result.reasoning.efforts = result.reasoning.efforts.filter((effort) => effort !== 'none')
      else if (result.reasoning.efforts.includes('none')) {
        result.reasoning.requirement = 'optional'
        result.reasoning.disable = 'supported'
      }
    } else if (knownReasoning && !Object.hasOwn(reasoning, 'supported_efforts')) {
      // Reasoning can exist without an effort selector (e.g. token-budget models).
      result.reasoning.effortSelection = 'unsupported'
    }
    if (knownReasoning) result.sources = [source('provider-catalog', OPENROUTER_REASONING)]
  } else if (parameters) {
    if (parameters.includes('reasoning') || parameters.includes('include_reasoning')) {
      result.reasoning.support = 'supported'
    } else if (!Object.hasOwn(model as object, 'reasoning') &&
               result.id !== 'openrouter/auto' && result.id !== 'openrouter/free') {
      // Missing reasoning alone is ambiguous: dynamic routers also omit it.
      result.reasoning.support = 'unsupported'
      result.reasoning.disable = 'unsupported'
      result.reasoning.effortSelection = 'unsupported'
      result.reasoning.requirement = 'optional'
    }
  }
  if (catalogEvidence) result.sources = [source('provider-catalog', OPENROUTER_MODELS), ...result.sources]
  // supported_parameters is gateway metadata, not proof that every backing
  // endpoint honors it. Neither it nor modalities establish per-model streaming.
}

/** Pure per-entry normalization. Fetching, access, caching, filtering and policy remain host-owned. */
export function normalizeModelCapabilities(input: CapabilityInput): ModelCapabilities {
  if (!record(input) || field(input, 'apiVersion') !== 1) {
    throw new TypeError('Capability input requires API version 1')
  }
  const provider = field(input, 'provider')
  const protocol = field(input, 'protocol')
  const model = field(input, 'model')
  const id = field(model, 'id')
  if (provider !== 'openai' && provider !== 'openrouter') throw new TypeError('Unsupported capability provider')
  if (protocol !== 'responses' && protocol !== 'chat-completions') throw new TypeError('Unsupported API protocol')
  if (!identifier(id)) throw new TypeError('Model must contain a valid exact ID')
  const result = unknown(provider, protocol, id)
  if (provider === 'openai') openai(result)
  else openrouter(result, model)
  Object.freeze(result.reasoning.efforts)
  Object.freeze(result.reasoning)
  for (const item of result.sources) Object.freeze(item)
  Object.freeze(result.sources)
  return Object.freeze(result)
}

/** Check an override without selecting a default or rewriting a provider request. */
export function reasoningSelectionSupport(
  capabilities: ModelCapabilities,
  selection: ReasoningSelection
): Capability {
  if (!record(capabilities) || field(capabilities, 'apiVersion') !== 1) {
    throw new TypeError('Capabilities require API version 1')
  }
  if (!record(selection)) throw new TypeError('Reasoning selection must be a data object')
  const mode = field(selection, 'mode')
  // Default means omission. It makes no claim about what the model will do.
  if (mode === 'default') return 'supported'
  const effort = mode === 'disabled' ? 'none' : field(selection, 'effort')
  if ((mode !== 'disabled' && mode !== 'effort') || !EFFORTS.includes(effort as ReasoningEffort) ||
      mode === 'effort' && effort === 'none') {
    throw new TypeError('Unsupported reasoning selection')
  }
  const reasoning = field(capabilities, 'reasoning')
  if (!record(reasoning)) throw new TypeError('Invalid reasoning capabilities')
  if (mode === 'disabled') {
    if (field(reasoning, 'requirement') === 'required') return 'unsupported'
    const disable = field(reasoning, 'disable')
    if (disable === 'supported' || disable === 'unsupported' || disable === 'unknown') return disable
    throw new TypeError('Invalid reasoning capabilities')
  }
  const support = field(reasoning, 'support')
  if (support === 'unknown' || support === 'unsupported') return support
  const effortSelection = field(reasoning, 'effortSelection')
  if (effortSelection === 'unknown' || effortSelection === 'unsupported') return effortSelection
  const efforts = stringList(field(reasoning, 'efforts'))
  if (support !== 'supported' || effortSelection !== 'supported' || !efforts ||
      efforts.some((value) => !EFFORTS.includes(value as ReasoningEffort))) {
    throw new TypeError('Invalid reasoning capabilities')
  }
  return efforts.includes(effort as ReasoningEffort) ? 'supported' : 'unsupported'
}
