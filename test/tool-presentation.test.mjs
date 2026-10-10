// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { decodeToolPresentation, toolPresentationView, renderToolPresentationText, TOOL_PRESENTATION_LIMITS } from '../dist/presentation.js'
import { fixture } from './fixtures/tool-presentation-hosts.mjs'

const decode = changes => decodeToolPresentation(JSON.stringify(fixture(changes)))
test('decoded data and views are detached deeply frozen snapshots', () => {
  const data = fixture(), encoded = JSON.stringify(data), snapshot = decodeToolPresentation(encoded)
  data.arguments.data.resource = 'changed'
  assert.equal(snapshot.arguments.data.resource, 'fixture')
  for (const value of [snapshot, snapshot.source, snapshot.arguments, snapshot.arguments.data,
    toolPresentationView(snapshot), toolPresentationView(snapshot).header]) assert.ok(Object.isFrozen(value))
  assert.throws(() => { snapshot.status = 'succeeded' }, TypeError)
  assert.throws(() => toolPresentationView(JSON.parse(encoded)), /Decode/)
  assert.equal(renderToolPresentationText(snapshot), renderToolPresentationText(snapshot))
  assert.equal(renderToolPresentationText(decodeToolPresentation(JSON.stringify(snapshot))), renderToolPresentationText(snapshot))
})
test('safe text escapes terminal and bidi controls, keeps markup and URLs inert', () => {
  const snapshot = decode({ name: '\u001b[31mtool\u202e', source: { reference: 'https://example.invalid/<script>\nnext', revision: '\u2066revision' },
    result: { kind: 'future-html', text: '<img src="https://example.invalid" onerror="run()">\u001b]52;secret\u0007\n😀\ud800' } })
  const rendered = renderToolPresentationText(snapshot)
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(rendered), false)
  assert.match(rendered, /\\u001b/)
  assert.match(rendered, /\\u202e/)
  assert.ok(rendered.includes('<img src="https://example.invalid" onerror="run()">'))
  assert.ok(rendered.includes('😀\\ud800'))
  assert.match(rendered, /unsupported presentation kind "future-html"/)
})
test('all twelve Unicode Bidi_Control characters are visible escapes in every text surface', () => {
  const points = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
    0x2066, 0x2067, 0x2068, 0x2069]
  const marks = String.fromCodePoint(...points)
  const snapshot = decode({ name: marks, callId: marks, source: { reference: marks, revision: marks },
    progress: { text: marks }, warnings: [marks], arguments: { kind: 'text', text: marks },
    result: { kind: 'future-card', text: marks } })
  const view = toolPresentationView(snapshot)
  for (const surface of [...view.header, ...view.warnings, ...view.details.map(section => section.text)]) {
    for (const point of points) assert.equal(surface.includes(String.fromCodePoint(point)), false)
  }
  for (const surface of [view.header[0], view.header[3], view.header[4], view.warnings[1],
    ...view.details.map(section => section.text)]) {
    for (const point of points) assert.ok(surface.includes(`\\u${point.toString(16).padStart(4, '0')}`))
  }
})
test('UTF-8 detail budget is shared and never splits emoji or hides source/warnings', () => {
  const snapshot = decode({ arguments: { kind: 'text', text: '😀😀' },
    status: 'approval_required', effect: 'unknown', result: { kind: 'text', text: '😀result' } })
  const view = toolPresentationView(snapshot, { detailBytes: 7 })
  assert.equal(view.details[0].text, '😀')
  assert.equal(view.details[1].text, '')
  assert.ok(view.details.every(section => section.truncated))
  assert.match(view.notice, /truncated/)
  assert.match(renderToolPresentationText(snapshot, { detailBytes: 0 }), /Approval required/)
  assert.match(renderToolPresentationText(snapshot, { detailBytes: 0 }), /Source:/)
  for (const detailBytes of [-1, 1.5, NaN, Infinity, TOOL_PRESENTATION_LIMITS.detailBytes + 1])
    assert.throws(() => toolPresentationView(snapshot, { detailBytes }))
})
test('structured results render canonically and unknown kinds use only text fallback', () => {
  const a = decode({ result: { kind: 'json', text: 'summary', data: { z: [{ b: 2, a: 1 }], a: null } } })
  const b = decode({ result: { kind: 'json', text: 'summary', data: { a: null, z: [{ a: 1, b: 2 }] } } })
  assert.equal(renderToolPresentationText(a), renderToolPresentationText(b))
  const fallback = decode({ result: { kind: 'interactive-action', text: 'Plain fallback', data: { execute: 'never run' } } })
  assert.equal(toolPresentationView(fallback).details[1].text, 'Plain fallback')
  assert.equal(renderToolPresentationText(fallback).includes('never run'), false)
})
test('wire, arguments, result, depth, nodes, metadata and warning limits reject oversized data', () => {
  assert.throws(() => decodeToolPresentation(' '.repeat(TOOL_PRESENTATION_LIMITS.wireBytes + 1)))
  assert.throws(() => decode({ arguments: { kind: 'text', text: 'a'.repeat(TOOL_PRESENTATION_LIMITS.argumentBytes) } }))
  assert.throws(() => decode({ result: { kind: 'text', text: '😀'.repeat(TOOL_PRESENTATION_LIMITS.resultBytes / 4) } }))
  assert.throws(() => decode({ source: { reference: 'x'.repeat(1025) } }))
  assert.throws(() => decode({ progress: { text: 'x'.repeat(2049) } }))
  assert.throws(() => decode({ warnings: Array(9).fill('warning') }))
  assert.throws(() => decode({ warnings: ['x'.repeat(513)] }))
  assert.throws(() => decode({ result: { kind: 'json', text: '', data: Array(4096).fill(null) } }))
  let deep = null
  for (let i = 0; i < 17; i++) deep = [deep]
  assert.throws(() => decode({ result: { kind: 'json', text: '', data: deep } }))
})
test('malformed snapshots and object inputs are rejected without result-driven status inference', () => {
  for (const changes of [{ version: 2 }, { status: 'approved' }, { effect: 'none' }, { name: '' },
    { callId: 1 }, { source: {} }, { source: { reference: 'x', execute: true } },
    { arguments: { kind: 'json', text: '' } }, { arguments: { kind: 'text', text: '', data: {} } },
    { progress: null }, { result: null }, { warnings: 'bad' }, { execute: true }]) assert.throws(() => decode(changes))
  assert.throws(() => decodeToolPresentation('{'))
  assert.throws(() => decodeToolPresentation(JSON.stringify(fixture()).replace('"limit":5', '"limit":1e309')))
  let called = false
  assert.throws(() => decodeToolPresentation({ toJSON() { called = true; return fixture() } }))
  assert.equal(called, false)
})
test('presentation subpath has no runtime imports, host framework or executable markup', async () => {
  const source = await readFile(new URL('../dist/presentation.js', import.meta.url), 'utf8')
  assert.equal(/\bimport\b|\brequire\s*\(|node:|@opentui|svelte|react/.test(source), false)
  assert.equal(/innerHTML|eval\(|new Function|fetch\(/.test(source), false)
})
