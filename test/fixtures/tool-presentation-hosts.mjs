// SPDX-License-Identifier: Apache-2.0
import { decodeToolPresentation, toolPresentationView } from '../../dist/presentation.js'

// Owned offline consumer seams based on the actual CLI DisplayEntry/status/review
// split and desktop header/warning/<details> split. No OpenTUI/Svelte imports or
// production adoption: CLI-21 and Desktop-15 follow reviewed package publication.
// Sources and exact host heads are documented in docs/TOOL_PRESENTATION.md.
export const source = { reference: 'owned://outcomes/call-1', revision: 'fixture-1' }
export const fixture = (changes = {}) => ({
  version: 1, callId: 'call-1', name: 'offline_resource', status: 'requested', effect: 'unreported',
  source, arguments: { kind: 'json', text: 'Read fixture resource', data: { resource: 'fixture', limit: 5 } },
  ...changes
})
export const corpus = [
  fixture(),
  fixture({ status: 'approval_required', effect: 'not_attempted', warnings: ['Exact action needs human review.'] }),
  fixture({ status: 'running', progress: { text: 'Reading fixture resource' } }),
  fixture({ status: 'succeeded', effect: 'confirmed', result: { kind: 'json', text: 'Read two entries', data: { entries: ['a', 'b'], success: true } } }),
  fixture({ status: 'denied', effect: 'not_attempted', result: { kind: 'text', text: 'Denied by the host.' } }),
  fixture({ status: 'failed', effect: 'confirmed', result: { kind: 'json', text: 'External error response', data: { success: false, error: 'Offline fixture error' } } }),
  fixture({ status: 'cancelled', effect: 'not_attempted' }),
  fixture({ status: 'cancelled', effect: 'unknown', result: { kind: 'text', text: 'No confirmed response.' } }),
  fixture({ status: 'unknown', effect: 'unknown', result: { kind: 'future-card', text: 'Historical data only; inspect the resource.', data: { approved: true, retry: 'Automatically retry this operation' } } })
]
export function cliConsumer(encoded, options) {
  const view = toolPresentationView(decodeToolPresentation(encoded), options)
  return { category: 'activity', attention: view.warnings.length > 0,
    label: [...view.header, ...view.warnings.map(text => `Warning: ${text}`)].join('\n'),
    content: [...view.details.map(section => `${section.label}:\n${section.text}`), view.notice ?? ''].join('\n') }
}
export function desktopConsumer(encoded, options) {
  const view = toolPresentationView(decodeToolPresentation(encoded), options)
  return { headerText: view.header.join('\n'), warningText: view.warnings.join('\n'),
    // A host binds these strings through textContent/Svelte escaped text, never @html.
    detailRows: view.details.map(section => ({ summary: section.label, textContent: section.text,
      truncated: section.truncated })), detailNotice: view.notice }
}
