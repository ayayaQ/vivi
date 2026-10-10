// SPDX-License-Identifier: Apache-2.0
/** UI-neutral, display-only snapshots. Hosts supply facts and retain all authority. */
export type PresentationJson = null | boolean | number | string | readonly PresentationJson[] |
  { readonly [key: string]: PresentationJson }
export type ToolPresentationStatus = 'requested' | 'approval_required' | 'running' |
  'succeeded' | 'denied' | 'failed' | 'cancelled' | 'unknown'
export type ToolPresentationEffect = 'not_attempted' | 'confirmed' | 'unknown' | 'unreported'

export interface ToolPresentationContent {
  /** Known kinds are text and json. Every other kind uses text as its plain-text fallback. */
  readonly kind: string
  readonly text: string
  readonly data?: PresentationJson
}
export interface ToolPresentation {
  readonly version: 1
  readonly callId: string
  readonly name: string
  readonly status: ToolPresentationStatus
  /** Exact host evidence; a generic result or cancellation does not establish external effects. */
  readonly effect: ToolPresentationEffect
  readonly source: { readonly reference: string; readonly revision?: string }
  readonly arguments: ToolPresentationContent
  readonly progress?: { readonly text: string }
  readonly result?: ToolPresentationContent
  /** Host-authored warning text, never approval callbacks or executable capabilities. */
  readonly warnings?: readonly string[]
}
export interface ToolPresentationOptions {
  readonly collapsed?: boolean
  /** Combined UTF-8 budget for detail text only. Safety/provenance never share this budget. */
  readonly detailBytes?: number
}
export interface ToolPresentationView {
  /** Always-visible plain text: identity, status, effect, source and optional progress. */
  readonly header: readonly string[]
  /** Always-visible plain text, outside any host collapse/truncation container. */
  readonly warnings: readonly string[]
  readonly details: readonly {
    readonly label: 'Arguments' | 'Result'
    readonly text: string
    readonly truncated: boolean
    readonly kind: 'text' | 'json' | 'fallback'
  }[]
  readonly notice?: string
}

export const TOOL_PRESENTATION_LIMITS = Object.freeze({ wireBytes: 128 * 1024,
  argumentBytes: 16 * 1024, resultBytes: 64 * 1024, detailBytes: 64 * 1024,
  nodes: 4096, depth: 16, warnings: 8 })
const encoder = new TextEncoder()
const admitted = new WeakSet<object>()
const statuses: readonly string[] = ['requested', 'approval_required', 'running', 'succeeded',
  'denied', 'failed', 'cancelled', 'unknown']
const effects: readonly string[] = ['not_attempted', 'confirmed', 'unknown', 'unreported']
const fail = (): never => { throw new Error('Invalid or oversized tool presentation') }
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail()
}
function text(value: unknown, bytes: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || !empty && value.length === 0 || value.length > bytes ||
    encoder.encode(value).length > bytes) fail()
}
function boundedJson(value: unknown): void {
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > TOOL_PRESENTATION_LIMITS.nodes || depth > TOOL_PRESENTATION_LIMITS.depth) fail()
    if (typeof item === 'number' && !Number.isFinite(item)) fail()
    if (item !== null && typeof item === 'object') {
      for (const child of Object.values(item)) visit(child, depth + 1)
    }
  }
  visit(value, 0)
}
function content(value: unknown, bytes: number): void {
  fields(value, ['kind', 'text'], ['data'])
  text(value.kind, 128)
  text(value.text, bytes, true)
  if (value.kind === 'text' && Object.hasOwn(value, 'data') ||
    value.kind === 'json' && !Object.hasOwn(value, 'data') ||
    encoder.encode(JSON.stringify(value)).length > bytes) fail()
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Decode bounded host-prepared JSON, never arbitrary objects/getters/toJSON callbacks.
 * Hosts screen the complete data for privacy before serializing it. Persisted/IPC data
 * must be decoded again; it contains no consent, action handles or execution authority.
 */
export function decodeToolPresentation(encoded: string): ToolPresentation {
  text(encoded, TOOL_PRESENTATION_LIMITS.wireBytes)
  let value: unknown
  try { value = JSON.parse(encoded) } catch { return fail() }
  boundedJson(value)
  fields(value, ['version', 'callId', 'name', 'status', 'effect', 'source', 'arguments'],
    ['progress', 'result', 'warnings'])
  if (value.version !== 1 || !statuses.includes(value.status as string) ||
    !effects.includes(value.effect as string)) fail()
  text(value.callId, 256); text(value.name, 256)
  fields(value.source, ['reference'], ['revision'])
  text(value.source.reference, 1024)
  if (Object.hasOwn(value.source, 'revision')) text(value.source.revision, 256)
  content(value.arguments, TOOL_PRESENTATION_LIMITS.argumentBytes)
  if (Object.hasOwn(value, 'result')) content(value.result, TOOL_PRESENTATION_LIMITS.resultBytes)
  if (Object.hasOwn(value, 'progress')) {
    fields(value.progress, ['text']); text(value.progress.text, 2048)
  }
  if (Object.hasOwn(value, 'warnings')) {
    if (!Array.isArray(value.warnings) || value.warnings.length > TOOL_PRESENTATION_LIMITS.warnings) fail()
    for (const warning of value.warnings as unknown[]) text(warning, 512)
  }
  const snapshot = freeze(value) as unknown as ToolPresentation
  admitted.add(snapshot)
  return snapshot
}

/** Escape terminal controls and bidi controls; this is text, never HTML/Markdown/links. */
function plain(value: string, singleLine = false): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]|[\ud800-\udfff]/gu, unit => {
    if (!singleLine && (unit === '\n' || unit === '\t')) return unit
    return `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}
function clipped(value: string, bytes: number): { text: string; truncated: boolean; bytes: number } {
  let used = 0, end = 0
  for (const unit of value) {
    const size = encoder.encode(unit).length
    if (used + size > bytes) break
    used += size; end += unit.length
  }
  return { text: value.slice(0, end), truncated: end < value.length, bytes: used }
}
function json(value: PresentationJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => json(item)).join(',')}]`
  const record = value as { readonly [key: string]: PresentationJson }
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${json(record[key]!)}`).join(',')}}`
}
const quoted = (value: string): string => plain(JSON.stringify(value), true)

/** Pure display conversion. Only this module's frozen decoded snapshots are accepted. */
export function toolPresentationView(snapshot: ToolPresentation,
  options: ToolPresentationOptions = {}): ToolPresentationView {
  if (!admitted.has(snapshot)) throw new Error('Decode the tool presentation before rendering')
  const collapsed = options.collapsed ?? false
  let budget = options.detailBytes ?? TOOL_PRESENTATION_LIMITS.detailBytes
  if (typeof collapsed !== 'boolean' || !Number.isSafeInteger(budget) || budget < 0 ||
    budget > TOOL_PRESENTATION_LIMITS.detailBytes) fail()
  const header = [`Tool ${quoted(snapshot.name)} (call ${quoted(snapshot.callId)})`,
    `Status: ${snapshot.status}`, `Effect: ${snapshot.effect}`,
    `Source: ${quoted(snapshot.source.reference)}${snapshot.source.revision === undefined ? '' :
      `; revision ${quoted(snapshot.source.revision)}`}`]
  if (snapshot.progress) header.push(`Progress: ${plain(snapshot.progress.text, true)}`)
  const warnings: string[] = []
  if (snapshot.status === 'approval_required') warnings.push('Approval required. This display grants no permission to execute.')
  if (snapshot.status === 'denied') warnings.push('Tool request denied. This display grants no permission to execute.')
  if (snapshot.status === 'failed') warnings.push('Tool failed. Failure does not establish that no effects occurred.')
  if (snapshot.status === 'unknown') warnings.push('Tool outcome is unknown. Inspect the resource before retrying.')
  if (snapshot.effect === 'unknown') warnings.push('External effects are unknown. Do not retry automatically; cancellation cannot undo effects.')
  if (snapshot.effect === 'unreported') warnings.push('External effects are unreported. Do not infer that no effects occurred.')
  for (const warning of snapshot.warnings ?? []) warnings.push(plain(warning, true))
  const sections: readonly (readonly ['Arguments' | 'Result', ToolPresentationContent])[] =
    [['Arguments', snapshot.arguments], ...(snapshot.result ? [['Result', snapshot.result] as const] : [])]
  const details: { label: 'Arguments' | 'Result'; text: string; truncated: boolean; kind: 'text' | 'json' | 'fallback' }[] = []
  for (const [label, section] of sections) {
    const kind = section.kind === 'text' || section.kind === 'json' ? section.kind : 'fallback'
    if (kind === 'fallback') warnings.push(`${label}: unsupported presentation kind ${quoted(section.kind)}; using plain-text fallback.`)
    if (collapsed) continue
    const display = clipped(plain(kind === 'json' ? json(section.data!) :
      kind === 'fallback' && !section.text ? 'No plain-text details available.' : section.text), budget)
    budget -= display.bytes
    details.push({ label, text: display.text, truncated: display.truncated, kind })
  }
  const truncated = details.some(section => section.truncated)
  return freeze({ header, warnings, details, ...(collapsed ? { notice: 'Details collapsed.' } :
    truncated ? { notice: 'Detail display truncated. Status, warnings and source remain visible.' } : {}) })
}

/** Deterministic safe text fallback for terminals/logs. Never truncate this whole return value. */
export function renderToolPresentationText(snapshot: ToolPresentation,
  options: ToolPresentationOptions = {}): string {
  const view = toolPresentationView(snapshot, options)
  return [...view.header, ...view.warnings.map(warning => `Warning: ${warning}`),
    ...view.details.map(section => `${section.label}:\n${section.text}`), ...(view.notice ? [view.notice] : [])].join('\n')
}
