// SPDX-License-Identifier: Apache-2.0
import { decodeToolPresentation, renderToolPresentationText } from '../dist/presentation.js'

// These are host-verified display facts, not instructions or permission to call a tool.
const presentation = decodeToolPresentation(JSON.stringify({
  version: 1, callId: 'offline-call', name: 'read_resource', status: 'unknown', effect: 'unknown',
  source: { reference: 'owned://outcomes/offline-call', revision: 'fixture-1' },
  arguments: { kind: 'json', text: 'Read the approved resource', data: { resource: 'fixture' } },
  result: { kind: 'future-card', text: 'No confirmed response is available.' }
}))
console.log(renderToolPresentationText(presentation, { collapsed: true }))
