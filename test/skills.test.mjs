// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test as nodeTest } from 'node:test'
import { runAgent } from '../dist/index.js'
import { createToolRegistry } from '../dist/extensions.js'
import {
  SKILL_LIMITS, validateSkillName, validateSkillResourcePath, skillRevision,
  parseSkillDocument, createSkillCatalog, formatSkillCatalogContext, createSkillsExtension,
  skillCreatorSource
} from '../dist/extensions/skills.js'

const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn)
const context = (controller = new AbortController()) => ({ signal: controller.signal })
const call = (name, arguments_ = {}) => ({ id: 'skill-call', name, arguments: arguments_ })
const document = (name = 'sample', description = 'Use for a sample task', body = 'Follow these sample instructions.') =>
  `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`
const frontmatter = (header, body = 'Instructions.') => `---\n${header}\n---\n${body}\n`
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const frozenTree = (value) => {
  if (value === null || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) frozenTree(child)
}
const parsedResult = (result) => JSON.parse(result.content)
const errorCode = (result) => {
  assert.equal(result.isError, true)
  return parsedResult(result).error.code
}
const registryFor = (sources = [{ content: document() }], overrides = {}) => {
  const catalog = createSkillCatalog(sources)
  const host = { catalog, authorizeRead() { return true }, ...overrides }
  const extension = createSkillsExtension(host)
  return { catalog, host, extension, registry: createToolRegistry([extension]) }
}
const request = (catalog, name = 'sample', path = 'SKILL.md') => ({
  name, path, expectedRevision: catalog.document(name).revision
})
const exactSizeDocument = (name, bytes) => {
  const prefix = document(name, 'Sample', '')
  assert.ok(Buffer.byteLength(prefix) <= bytes)
  return prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix))
}

test('decoded YAML metadata rejects escaped controls and lone surrogates before host display', () => {
  for (const escaped of ['\\u0000', '\\u001b', '\\ud800']) {
    assert.throws(() => parseSkillDocument(frontmatter(`name: escaped\ndescription: "${escaped}"`)))
    for (const field of ['license', 'compatibility', 'allowed-tools']) {
      assert.throws(() => parseSkillDocument(frontmatter(`name: escaped\ndescription: Valid\n${field}: "${escaped}"`)))
    }
    assert.throws(() => parseSkillDocument(frontmatter(`name: escaped\ndescription: Valid\nmetadata:\n  note: "${escaped}"`)))
    assert.throws(() => parseSkillDocument(frontmatter(`name: escaped\ndescription: Valid\nmetadata:\n  "${escaped}": note`)))
  }
  assert.equal(parseSkillDocument(frontmatter('name: escaped\ndescription: "Line one\\nLine two"')).metadata.description,
    'Line one\nLine two')
})

// Synthetic format-parity fixtures. No public skill content is copied or executed.
test('standard YAML quoting, comments, multiline text and optional fields interoperate', () => {
  const source = frontmatter(`name: yaml-parity # A YAML comment
description: >-
  Review YAML documents
  when the task needs format parity.
license: 'Example license: see LICENSE.txt'
compatibility: |-
  Requires a host text reader.
  No scripts are loaded.
metadata:
  author: example-org
  version: "1.0"
  quoted: 'It''s a string'
allowed-tools: 'Bash(git:*) Read'
`, '# Instructions\nRead [the reference](references/guide.md) only when needed.')
  const parsed = parseSkillDocument(source, 'yaml-parity')
  assert.deepEqual(parsed.metadata, {
    name: 'yaml-parity', description: 'Review YAML documents when the task needs format parity.',
    license: 'Example license: see LICENSE.txt',
    compatibility: 'Requires a host text reader.\nNo scripts are loaded.',
    metadata: { author: 'example-org', version: '1.0', quoted: "It's a string" },
    allowedTools: 'Bash(git:*) Read'
  })
  assert.equal(parsed.content, source)
  assert.equal(parsed.body, '# Instructions\nRead [the reference](references/guide.md) only when needed.\n')
  assert.deepEqual(parsed.warnings, [])
  frozenTree(parsed)
})

test('flow mappings, escaped YAML strings, literal blocks, BOM and CRLF preserve exact text', () => {
  const plain = frontmatter('name: quoting\ndescription: "Quoted \\"text\\" and \\u03bb"\nmetadata: {version: "2.0", note: "colon: hash # text"}', 'Text\n---\nBody delimiter stays in the body.')
  const parsed = parseSkillDocument(plain)
  assert.equal(parsed.metadata.description, 'Quoted "text" and λ')
  assert.equal(parsed.metadata.metadata.note, 'colon: hash # text')
  const literal = parseSkillDocument(frontmatter('name: literal\ndescription: |\n  First line\n  Second line'))
  assert.equal(literal.metadata.description, 'First line\nSecond line\n')
  const crlf = '\uFEFF' + plain.replaceAll('\n', '\r\n')
  assert.equal(parseSkillDocument(crlf).content, crlf)
  assert.equal(parseSkillDocument(crlf).body, 'Text\r\n---\r\nBody delimiter stays in the body.\r\n')
  assert.notEqual(skillRevision(crlf), skillRevision(plain))
})

test('Unicode lowercase names follow reference-spec NFKC normalization and directory matching', () => {
  for (const name of ['abc-123', 'résumé', '中文-１２', 'δοκιμή', '𐐨-test', 'e\u0301', 'a'.repeat(64)]) {
    assert.doesNotThrow(() => validateSkillName(name))
    assert.equal(parseSkillDocument(document(name), name).metadata.name, name.normalize('NFKC'))
  }
  assert.equal(parseSkillDocument(document('ｓａｍｐｌｅ'), 'sample').metadata.name, 'sample')
  assert.equal(parseSkillDocument(document('sample'), 'ｓａｍｐｌｅ').metadata.name, 'sample')
  // The reference validator strips surrounding name whitespace before NFKC validation.
  assert.equal(parseSkillDocument(document('  sample  '), 'sample').metadata.name, 'sample')
  for (const name of [null, 1, '', 'UPPER', 'Hello', '-name', 'name-', 'two--hyphens',
    'name_here', 'some name', '../name', 'a/b', 'a'.repeat(65), '😀', 'K']) {
    assert.throws(() => validateSkillName(name), undefined, String(name))
  }
  assert.throws(() => parseSkillDocument(document('sample'), 'different'), /directory/)
})

test('revisions hash exact UTF-8 source including comments, metadata, body and line endings', () => {
  const source = document('sample', 'Sample λ', 'Instructions 😀')
  const revision = createHash('sha256').update(source, 'utf8').digest('hex')
  assert.equal(skillRevision(source), revision)
  assert.equal(parseSkillDocument(source).revision, revision)
  for (const changed of [source + '\n', source.replace('name:', '# comment\nname:'),
    source.replace('Sample λ', 'Sample μ'), source.replace('😀', '😃'), source.replaceAll('\n', '\r\n')]) {
    assert.notEqual(skillRevision(changed), revision)
  }
})

test('unknown frontmatter warns without losing exact raw source or silently granting capabilities', () => {
  const source = frontmatter('name: future\ndescription: Future metadata\nfuture-version: 3\nexecution: {command: "do not execute"}\nallowed-tools: "shell network"')
  const parsed = parseSkillDocument(source)
  assert.deepEqual(parsed.warnings, [
    'Unsupported frontmatter field ignored: "future-version"',
    'Unsupported frontmatter field ignored: "execution"'
  ])
  assert.equal(parsed.content, source)
  assert.equal(parsed.metadata.allowedTools, 'shell network')
  assert.equal(Object.hasOwn(parsed.metadata, 'execution'), false)
})

test('invalid required metadata, optional field types and string mapping bounds are rejected', () => {
  const valid = 'name: sample\ndescription: Sample'
  const invalid = [
    '', 'description: Missing name', 'name: sample', 'name: 123\ndescription: Sample',
    'name: sample\ndescription: 123', 'name: sample\ndescription: null',
    'name: sample\ndescription: "   "', `name: sample\ndescription: ${'x'.repeat(1025)}`,
    `${valid}\nlicense: 3`, `${valid}\nlicense: ""`, `${valid}\nlicense: ${'x'.repeat(2049)}`,
    `${valid}\ncompatibility: false`, `${valid}\ncompatibility: " "`, `${valid}\ncompatibility: ${'x'.repeat(501)}`,
    `${valid}\nallowed-tools: [Read]`, `${valid}\nallowed-tools: null`, `${valid}\nallowed-tools: ${'x'.repeat(2049)}`,
    `${valid}\nmetadata: null`, `${valid}\nmetadata: []`, `${valid}\nmetadata: text`,
    `${valid}\nmetadata: {version: 1}`, `${valid}\nmetadata: {nested: {key: value}}`,
    `${valid}\nmetadata: {"": value}`, `${valid}\nmetadata: {${'k'.repeat(129)}: value}`,
    `${valid}\nmetadata: {key: "${'x'.repeat(1025)}"}`,
    `${valid}\nmetadata:\n${Array.from({ length: 33 }, (_, i) => `  key${i}: value`).join('\n')}`
  ]
  for (const header of invalid) assert.throws(() => parseSkillDocument(frontmatter(header)), undefined, header.slice(0, 120))
  assert.doesNotThrow(() => parseSkillDocument(document('sample', '😀'.repeat(1024))))
  assert.doesNotThrow(() => parseSkillDocument(frontmatter(`${valid}\ncompatibility: ${'x'.repeat(500)}\nmetadata: {empty: ""}`)))
  for (const value of [null, 5, 'Instructions only', '---\nname: sample\ndescription: Sample\n',
    frontmatter(valid, ''), frontmatter(valid, ' \t\n ')]) {
    assert.throws(() => parseSkillDocument(value))
  }
})

test('bounded YAML rejects duplicate keys, aliases, anchors, tags, merge keys and excessive depth/count', () => {
  const prefix = 'name: sample\ndescription: Sample'
  for (const header of [
    'name: sample\nname: duplicate\ndescription: Sample',
    `${prefix}\nunknown: &value text`, `${prefix}\nunknown: *missing`,
    `${prefix}\nunknown: &value [text]\nother: *value`,
    `${prefix}\nunknown: !!str tagged`, `${prefix}\nunknown: !custom tagged`,
    `${prefix}\nunknown: &defaults {key: text}\nother: {<<: *defaults}`,
    `${prefix}\nunknown: {a: {b: {c: {d: value}}}}`,
    `${prefix}\nunknown: [${Array.from({ length: 257 }, () => 'value').join(',')}]`,
    '- name: sample\n- description: Sample', '? [a, b]\n: complex key', 'name: [unterminated'
  ]) assert.throws(() => parseSkillDocument(frontmatter(header)), undefined, header.slice(0, 150))
})

test('document and frontmatter limits count bytes and reject controls or malformed Unicode', () => {
  const exact = exactSizeDocument('maximum', SKILL_LIMITS.maximumDocumentBytes)
  assert.equal(Buffer.byteLength(exact), SKILL_LIMITS.maximumDocumentBytes)
  assert.doesNotThrow(() => parseSkillDocument(exact))
  assert.throws(() => parseSkillDocument(exact + 'x'), /byte limit/)
  const base = 'name: sample\ndescription: Sample\n# '
  const header = base + 'x'.repeat(SKILL_LIMITS.maximumFrontmatterBytes - Buffer.byteLength(base))
  assert.doesNotThrow(() => parseSkillDocument(frontmatter(header)))
  assert.throws(() => parseSkillDocument(frontmatter(header + 'x')), /frontmatter.*byte limit/)
  for (const bad of ['\u0000', '\u0007', '\u000b', '\u007f', '\ud800', '\udfff']) {
    assert.throws(() => parseSkillDocument(document('sample', 'Sample', `Body${bad}`)))
    assert.throws(() => skillRevision(`Source${bad}`))
  }
  assert.doesNotThrow(() => parseSkillDocument(document('sample', 'Sample', 'Tabs\tand lines\r\nare fine')))
  assert.throws(() => parseSkillDocument(document('bytes', 'Sample', '😀'.repeat(16_384))), /byte limit/)
})

test('resource paths allow bounded portable relative files and reject traversal/device/absolute forms', () => {
  for (const path of ['SKILL.md', 'references/guide.md', 'scripts/extract.py', 'assets/template.json',
    'références/指南.md', 'a/b/c/d/e/f/g/h', 'x'.repeat(240)]) {
    assert.doesNotThrow(() => validateSkillResourcePath(path), path)
  }
  for (const path of [null, 1, '', '/', '/etc/passwd', '../SKILL.md', 'references/../secret',
    '.', './SKILL.md', 'a//b', 'a/', '\\server\\share', 'C:\\skills\\SKILL.md', 'C:/skills/SKILL.md',
    'references\\guide.md', '//server/share', '\\?\\C:\\skills', '\\.\\NUL',
    'CON', 'con.txt', 'references/PRN.md', 'AUX', 'nul', 'COM1', 'com9.log', 'LPT1.txt', 'lpt9',
    'COM¹', 'com².txt', 'COM³.log', 'LPT¹', 'lpt².md', 'LPT³.txt',
    'trailing.', 'trailing ', 'a/<bad>', 'a/quote"', 'a/pipe|', 'a/wild*', 'a/query?',
    'a/colon:', 'a/\u0000', 'a/\n', 'a/\u007f', 'a/\ud800', 'a/\udfff', 'a/b/c/d/e/f/g/h/i', 'x'.repeat(241)]) {
    assert.throws(() => validateSkillResourcePath(path), undefined, String(path))
  }
})

test('catalog rejects duplicate normalized names and invalid source contracts', () => {
  assert.throws(() => createSkillCatalog([{ content: document() }, { content: document() }]), /Duplicate/)
  assert.throws(() => createSkillCatalog([{ content: document('sample') }, { content: document('ｓａｍｐｌｅ') }]), /Duplicate/)
  for (const sources of [null, {}, [null], [{ content: 3 }], [{ content: document(), readOnly: 'yes' }],
    [{ content: document(), readResource: true }]]) assert.throws(() => createSkillCatalog(sources))
  assert.deepEqual(createSkillCatalog([]).skills, [])
})

test('skill count, total document bytes and catalog summary bytes have exact boundaries', () => {
  const hundred = Array.from({ length: SKILL_LIMITS.maximumSkills }, (_, i) => ({ content: document(`skill-${i}`, 'x') }))
  assert.equal(createSkillCatalog(hundred).skills.length, SKILL_LIMITS.maximumSkills)
  assert.throws(() => createSkillCatalog([...hundred, { content: document('extra') }]), /Too many/)
  const full = Array.from({ length: 32 }, (_, i) => ({ content: exactSizeDocument(`total-${i}`, SKILL_LIMITS.maximumDocumentBytes) }))
  assert.equal(full.reduce((sum, source) => sum + Buffer.byteLength(source.content), 0), SKILL_LIMITS.maximumTotalDocumentBytes)
  assert.equal(createSkillCatalog(full).skills.length, 32)
  assert.throws(() => createSkillCatalog([...full, { content: document('extra') }]), /catalog byte limit/)
  const lengths = hundred.map(() => 1)
  let remaining = SKILL_LIMITS.maximumCatalogBytes - Buffer.byteLength(JSON.stringify(createSkillCatalog(hundred).skills))
  for (let i = 0; remaining > 0; i++) {
    const addition = Math.min(1023, remaining)
    lengths[i] += addition
    remaining -= addition
  }
  const bounded = lengths.map((length, i) => ({ content: document(`skill-${i}`, 'x'.repeat(length)) }))
  assert.equal(Buffer.byteLength(JSON.stringify(createSkillCatalog(bounded).skills)), SKILL_LIMITS.maximumCatalogBytes)
  const last = lengths.findIndex((length) => length < 1024)
  bounded[last] = { content: document(`skill-${last}`, 'x'.repeat(lengths[last] + 1)) }
  assert.throws(() => createSkillCatalog(bounded), /summaries.*byte limit/)
})

test('catalog owns a deeply immutable document snapshot and captures resource methods', async () => {
  const original = document()
  const source = { content: original, readOnly: true, readResource(received) {
    assert.equal(this, source)
    assert.equal(received.path, 'references/guide.md')
    frozenTree(received)
    return 'Original reader'
  } }
  const sources = [source]
  const catalog = createSkillCatalog(sources)
  frozenTree(catalog.skills)
  frozenTree(catalog.document('sample'))
  assert.equal(Object.isFrozen(catalog), true)
  assert.throws(() => { catalog.skills[0].description = 'changed' }, TypeError)
  assert.throws(() => { catalog.document('sample').metadata.name = 'changed' }, TypeError)
  source.content = document('changed')
  source.readOnly = false
  source.readResource = () => { throw new Error('Replaced reader ran') }
  sources.length = 0
  assert.equal(catalog.document('sample').content, original)
  assert.equal(catalog.skills[0].readOnly, true)
  assert.equal(catalog.document('changed'), undefined)
  assert.equal(await catalog.read(request(catalog, 'sample'), context()), original)
  assert.equal(await catalog.read(request(catalog, 'sample', 'references/guide.md'), context()), 'Original reader')
})

test('resources are lazy, revision-bound inert text; SKILL.md never calls a resource reader', async () => {
  let reads = 0
  const script = 'globalThis.__skill_should_never_execute = true;\nthrow new Error("Do not execute")'
  const catalog = createSkillCatalog([{ content: document(), readResource(received, { signal }) {
    reads++
    assert.equal(signal.aborted, false)
    assert.equal(received.expectedRevision, catalog.skills[0].revision)
    return script
  } }])
  assert.equal(reads, 0)
  assert.equal(await catalog.read(request(catalog), context()), document())
  assert.equal(reads, 0)
  assert.equal(await catalog.read(request(catalog, 'sample', 'scripts/example.js'), context()), script)
  assert.equal(reads, 1)
  assert.equal(globalThis.__skill_should_never_execute, undefined)
  await assert.rejects(catalog.read({ ...request(catalog), expectedRevision: '0'.repeat(64) }, context()), /stale/)
  await assert.rejects(catalog.read({ ...request(catalog), name: 'missing' }, context()), /unavailable/)
  await assert.rejects(catalog.read({ ...request(catalog), path: '../secret' }, context()), /relative path/)
  assert.equal(reads, 1)
  const noResources = createSkillCatalog([{ content: document() }])
  await assert.rejects(noResources.read(request(noResources, 'sample', 'references/guide.md'), context()), /does not provide resources/)
})

test('resource result bounds, host failures and aborts do not produce late accepted content', async () => {
  const controller = new AbortController(), started = deferred(), finish = deferred()
  const catalog = createSkillCatalog([{ content: document(), async readResource(_request, { signal }) {
    assert.equal(signal, controller.signal)
    started.resolve()
    return finish.promise
  } }])
  const reading = catalog.read(request(catalog, 'sample', 'references/guide.md'), context(controller))
  await started.promise
  controller.abort(new Error('Stopped while reading'))
  finish.resolve('Late text')
  await assert.rejects(reading, /Stopped while reading/)
  let dispatches = 0
  const aborted = createSkillCatalog([{ content: document(), readResource() { dispatches++; return 'text' } }])
  await assert.rejects(aborted.read(request(aborted, 'sample', 'guide.md'), context(controller)), /Stopped/)
  assert.equal(dispatches, 0)
  for (const value of [3, '\u0000', '\ud800', 'x'.repeat(SKILL_LIMITS.maximumResourceBytes + 1), '😀'.repeat(16_385)]) {
    const invalid = createSkillCatalog([{ content: document(), readResource() { return value } }])
    await assert.rejects(invalid.read(request(invalid, 'sample', 'guide.md'), context()))
  }
  const exact = createSkillCatalog([{ content: document(), readResource() { return 'x'.repeat(SKILL_LIMITS.maximumResourceBytes) } }])
  assert.equal((await exact.read(request(exact, 'sample', 'guide.md'), context())).length, SKILL_LIMITS.maximumResourceBytes)
  const failure = new Error('Host containment or disk revision check failed')
  const stale = createSkillCatalog([{ content: document(), readResource() { throw failure } }])
  await assert.rejects(stale.read(request(stale, 'sample', 'guide.md'), context()), (error) => error === failure)
})

test('catalog context discloses names/descriptions only and never promotes skill tool grants', () => {
  const body = 'PRIVATE FULL INSTRUCTIONS'
  const source = frontmatter('name: sample\ndescription: Pick sample tasks\nallowed-tools: "shell network"', body)
  const catalog = createSkillCatalog([{ content: source }])
  const formatted = formatSkillCatalogContext(catalog)
  assert.match(formatted, /instruction-only.*untrusted.*no permissions or tool grants/i)
  assert.match(formatted, /read_skill/)
  assert.equal(formatted.includes(body), false)
  assert.equal(formatted.includes('shell network'), false)
  assert.equal(formatted.includes(catalog.skills[0].revision), false)
  assert.deepEqual(JSON.parse(formatted.slice(formatted.indexOf('\n') + 1)), [{ name: 'sample', description: 'Pick sample tasks' }])
})

test('bundled creator is optional, read-only and exactly matches its portable SKILL.md', async () => {
  const portable = readFileSync(new URL('../skills/skill-creator/SKILL.md', import.meta.url), 'utf8')
  assert.equal(skillCreatorSource.content, portable)
  assert.equal(skillCreatorSource.readOnly, true)
  assert.equal(Object.isFrozen(skillCreatorSource), true)
  const parsed = parseSkillDocument(portable, 'skill-creator')
  assert.equal(parsed.metadata.license, 'Apache-2.0')
  assert.match(parsed.body, /Show the exact final SKILL\.md/)
  assert.match(parsed.body, /Ask for approval before persisting/)
  assert.match(parsed.body, /Do not write scripts/)
  assert.equal(createSkillCatalog([]).document('skill-creator'), undefined)
  let reviews = 0, writes = 0
  const { registry, catalog } = registryFor([skillCreatorSource], { save: {
    authorize() { reviews++; return true }, commit() { writes++ }
  } })
  assert.equal(parsedResult(await registry.executeTool(call('read_skill', request(catalog, 'skill-creator')), context())).content, portable)
  const result = await registry.executeTool(call('save_skill', {
    name: 'skill-creator', content: document('skill-creator'), expectedRevision: parsed.revision
  }), context())
  assert.equal(errorCode(result), 'tool_error')
  assert.equal(reviews, 0)
  assert.equal(writes, 0)
})

test('normalized tool names resolve one canonical document and preserve exact saved bytes', async () => {
  let authorizedRead, reviewed, committed
  const raw = document('  ｎｅｗ  ', 'New normalized skill')
  const { registry, catalog } = registryFor([{ content: document('sample') }], {
    authorizeRead(received) { authorizedRead = received; return true },
    save: { authorize(proposal) { reviewed = proposal; return true }, commit(proposal) { committed = proposal } }
  })
  assert.equal(catalog.document(' ｓａｍｐｌｅ ').metadata.name, 'sample')
  assert.equal(await catalog.read({ ...request(catalog), name: ' ｓａｍｐｌｅ ' }, context()), document())
  const read = parsedResult(await registry.executeTool(call('read_skill', { ...request(catalog), name: ' ｓａｍｐｌｅ ' }), context()))
  assert.equal(read.name, 'sample')
  assert.equal(authorizedRead.name, 'sample')
  const saved = parsedResult(await registry.executeTool(call('save_skill', { name: ' ｎｅｗ ', content: raw, expectedRevision: null }), context()))
  assert.equal(saved.name, 'new')
  assert.equal(reviewed, committed)
  assert.equal(committed.name, 'new')
  assert.equal(committed.after.metadata.name, 'new')
  assert.equal(committed.after.content, raw)
  assert.equal(saved.revision, skillRevision(raw))
})

test('read-only extension has only list/read tools and rejects missing host authorization', async () => {
  const { registry, catalog } = registryFor()
  assert.deepEqual(registry.tools.map((tool) => tool.name), ['list_skills', 'read_skill'])
  assert.equal(registry.has('save_skill'), false)
  assert.deepEqual(parsedResult(await registry.executeTool(call('list_skills'), context())), { skills: catalog.skills, limits: SKILL_LIMITS })
  assert.equal(errorCode(await registry.executeTool(call('save_skill', { name: 'new', content: document('new'), expectedRevision: null }), context())), 'unavailable_tool')
  assert.throws(() => createSkillsExtension({ catalog }), TypeError)
  for (const tool of registry.tools) {
    assert.equal(tool.parameters.additionalProperties, false)
    assert.deepEqual(tool.parameters.required, Object.keys(tool.parameters.properties))
  }
})

test('read policy is mandatory for every document/resource read and only exact true approves', async () => {
  for (const decision of [false, undefined, null, 1, 'yes', {}]) {
    let approvals = 0, reads = 0
    const { registry, catalog } = registryFor([{ content: document(), readResource() { reads++; return 'Reference' } }], {
      authorizeRead(received, receivedContext) {
        approvals++
        frozenTree(received)
        assert.equal(receivedContext.signal.aborted, false)
        return decision
      }
    })
    for (const path of ['SKILL.md', 'references/guide.md']) {
      const result = await registry.executeTool(call('read_skill', request(catalog, 'sample', path)), context())
      assert.equal(result.isError, true)
      assert.equal(parsedResult(result).success, false)
      assert.match(parsedResult(result).error, /declined/)
    }
    assert.equal(approvals, 2)
    assert.equal(reads, 0)
  }
  let approvals = 0
  const { registry, catalog } = registryFor(undefined, { authorizeRead() { approvals++; return true } })
  const result = parsedResult(await registry.executeTool(call('read_skill', request(catalog)), context()))
  assert.equal(result.content, document())
  assert.match(result.guidance, /untrusted.*No new authority/)
  await registry.executeTool(call('read_skill', request(catalog)), context())
  assert.equal(approvals, 2, 'approval is not cached by the core')
})

test('invalid tool arguments and stale reads fail before authorization or resource dispatch', async () => {
  let approvals = 0, reads = 0
  const { registry, catalog } = registryFor([{ content: document(), readResource() { reads++; return '' } }], {
    authorizeRead() { approvals++; return true }
  })
  const valid = request(catalog)
  for (const args of [{}, { ...valid, unexpected: true }, { ...valid, name: '../sample' },
    { ...valid, path: '/absolute' }, { ...valid, path: 'CON.txt' }, { ...valid, expectedRevision: null },
    { ...valid, expectedRevision: 'A'.repeat(64) }, { ...valid, expectedRevision: 'short' }]) {
    assert.equal(errorCode(await registry.executeTool(call('read_skill', args), context())), 'invalid_arguments')
  }
  assert.equal(errorCode(await registry.executeTool(call('list_skills', { unexpected: true }), context())), 'invalid_arguments')
  for (const args of [{ ...valid, expectedRevision: '0'.repeat(64) }, { ...valid, name: 'missing' }]) {
    assert.equal(errorCode(await registry.executeTool(call('read_skill', args), context())), 'tool_error')
  }
  assert.equal(approvals, 0)
  assert.equal(reads, 0)
})

test('cancellation before/during read authorization prevents later resource dispatch', async () => {
  const controller = new AbortController(), started = deferred(), finish = deferred()
  let approvals = 0, reads = 0
  const { registry, catalog } = registryFor([{ content: document(), readResource() { reads++; return 'Reference' } }], {
    async authorizeRead(_request, { signal }) {
      approvals++
      assert.equal(signal, controller.signal)
      started.resolve()
      return finish.promise
    }
  })
  const reading = registry.executeTool(call('read_skill', request(catalog, 'sample', 'guide.md')), context(controller))
  await started.promise
  controller.abort(new Error('Cancelled review'))
  finish.resolve(true)
  await assert.rejects(reading, /Cancelled review/)
  await assert.rejects(registry.executeTool(call('read_skill', request(catalog)), context(controller)), /Cancelled review/)
  assert.equal(approvals, 1)
  assert.equal(reads, 0)
})

test('read approval and dispatch share one immutable request despite caller mutations', async () => {
  const started = deferred(), finish = deferred()
  let reviewed, dispatched
  const { registry, catalog } = registryFor([{ content: document(), readResource(received) {
    dispatched = received
    return 'Approved reference'
  } }], {
    async authorizeRead(received) {
      reviewed = received
      frozenTree(received)
      started.resolve()
      return finish.promise
    }
  })
  const input = call('read_skill', request(catalog, 'sample', 'references/approved.md'))
  const reading = registry.executeTool(input, context())
  await started.promise
  assert.throws(() => { reviewed.path = 'references/unapproved.md' }, TypeError)
  input.arguments.name = 'other'
  input.arguments.path = 'references/unapproved.md'
  input.arguments.expectedRevision = '0'.repeat(64)
  finish.resolve(true)
  const result = parsedResult(await reading)
  assert.deepEqual(dispatched, reviewed)
  assert.equal(result.name, 'sample')
  assert.equal(result.path, 'references/approved.md')
  assert.equal(result.content, 'Approved reference')
})

test('extension captures catalog, authorization and persistence methods at turn creation', async () => {
  const base = createSkillCatalog([{ content: document() }])
  const mutableCatalog = { skills: structuredClone(base.skills), document: base.document.bind(base), read: base.read.bind(base) }
  let approvals = 0, writes = 0
  const save = {
    authorize() { assert.equal(this, save); approvals++; return true },
    commit() { assert.equal(this, save); writes++ }
  }
  const host = { catalog: mutableCatalog, save, authorizeRead() { assert.equal(this, host); approvals++; return true } }
  const registry = createToolRegistry([createSkillsExtension(host)])
  mutableCatalog.skills[0].name = 'replacement'
  mutableCatalog.skills.length = 0
  mutableCatalog.document = () => { throw new Error('Replaced document method') }
  mutableCatalog.read = () => { throw new Error('Replaced reader') }
  host.authorizeRead = () => { throw new Error('Replaced policy') }
  host.catalog = createSkillCatalog([])
  save.authorize = () => { throw new Error('Replaced approval') }
  save.commit = () => { throw new Error('Replaced commit') }
  host.save = undefined
  assert.equal(parsedResult(await registry.executeTool(call('list_skills'), context())).skills[0].name, 'sample')
  assert.equal(parsedResult(await registry.executeTool(call('read_skill', request(base)), context())).content, document())
  assert.equal(parsedResult(await registry.executeTool(call('save_skill', { name: 'new', content: document('new'), expectedRevision: null }), context())).saved, true)
  assert.equal(approvals, 2)
  assert.equal(writes, 1)
})

test('save reviews and commits the same exact deeply frozen proposal and raw YAML', async () => {
  const existing = document()
  const after = frontmatter('name: sample\ndescription: Updated\nmetadata: {author: user}\nfuture-field: preserved', 'Revised instructions.')
  let reviewed, committed
  const started = deferred(), finish = deferred()
  const { registry, catalog } = registryFor([{ content: existing }], { save: {
    async authorize(proposal) { reviewed = proposal; frozenTree(proposal); started.resolve(); return finish.promise },
    commit(proposal) { committed = proposal; frozenTree(proposal) }
  } })
  const input = call('save_skill', { name: 'sample', content: after, expectedRevision: catalog.skills[0].revision })
  const saving = registry.executeTool(input, context())
  await started.promise
  assert.equal(reviewed.before.content, existing)
  assert.equal(reviewed.after.content, after)
  assert.equal(reviewed.after.warnings.length, 1)
  assert.throws(() => { reviewed.after.metadata.metadata.author = 'tampered' }, TypeError)
  assert.throws(() => { reviewed.after.content = document() }, TypeError)
  input.arguments.content = document('sample', 'Tampered')
  finish.resolve(true)
  const result = parsedResult(await saving)
  assert.equal(committed, reviewed)
  assert.equal(committed.after.content, after)
  assert.deepEqual(result, { saved: true, name: 'sample', revision: skillRevision(after), available: 'next_turn' })
  assert.equal(catalog.document('sample').content, existing)
})

test('save supports creation and update while changes activate only in a fresh host turn', async () => {
  const store = new Map([['sample', document()]])
  const proposals = []
  const save = {
    authorize(proposal) { proposals.push(proposal); return true },
    commit(proposal) {
      const current = store.get(proposal.name)
      assert.equal(current === undefined ? null : skillRevision(current), proposal.expectedRevision)
      store.set(proposal.name, proposal.after.content)
    }
  }
  const first = registryFor([...store.values()].map((content) => ({ content })), { save })
  const added = document('new-skill', 'New skill', 'New instructions')
  const edited = document('sample', 'Updated sample', 'Updated instructions')
  assert.equal(parsedResult(await first.registry.executeTool(call('save_skill', { name: 'new-skill', content: added, expectedRevision: null }), context())).saved, true)
  assert.equal(proposals[0].before, null)
  assert.equal(proposals[0].expectedRevision, null)
  await first.registry.executeTool(call('save_skill', { name: 'sample', content: edited, expectedRevision: first.catalog.skills[0].revision }), context())
  assert.equal(proposals[1].before.content, document())
  assert.equal(first.catalog.document('new-skill'), undefined)
  assert.equal(first.catalog.document('sample').content, document())
  assert.deepEqual(parsedResult(await first.registry.executeTool(call('list_skills'), context())).skills.map((skill) => skill.name), ['sample'])
  assert.equal(errorCode(await first.registry.executeTool(call('read_skill', { name: 'new-skill', path: 'SKILL.md', expectedRevision: skillRevision(added) }), context())), 'tool_error')
  const next = registryFor([...store.values()].map((content) => ({ content })), { save })
  assert.equal(next.catalog.document('sample').content, edited)
  assert.equal(next.catalog.document('new-skill').content, added)
  assert.equal(parsedResult(await next.registry.executeTool(call('read_skill', request(next.catalog, 'new-skill')), context())).content, added)
})

test('built-ins, stale create/update revisions and malformed saves never reach review or commit', async () => {
  let approvals = 0, commits = 0
  const save = { authorize() { approvals++; return true }, commit() { commits++ } }
  const { registry, catalog } = registryFor([{ content: document() }, { content: document('built-in'), readOnly: true }], { save })
  const revision = catalog.document('sample').revision
  for (const args of [
    { name: 'sample', content: document(), expectedRevision: null },
    { name: 'sample', content: document(), expectedRevision: '0'.repeat(64) },
    { name: 'new', content: document('new'), expectedRevision: revision },
    { name: 'built-in', content: document('built-in'), expectedRevision: catalog.document('built-in').revision },
    { name: 'built-in', content: document('built-in'), expectedRevision: null }
  ]) assert.equal(errorCode(await registry.executeTool(call('save_skill', args), context())), 'tool_error')
  for (const args of [{}, { name: 'new', content: document('other'), expectedRevision: null },
    { name: 'new', content: 'no frontmatter', expectedRevision: null },
    { name: 'new', content: document('new'), expectedRevision: 'short' },
    { name: 'new', content: document('new'), expectedRevision: null, extra: true }]) {
    assert.equal(errorCode(await registry.executeTool(call('save_skill', args), context())), 'invalid_arguments')
  }
  assert.equal(approvals, 0)
  assert.equal(commits, 0)
})

test('save requires exact true authorization; denial or review failure leaves persistence untouched', async () => {
  for (const decision of [false, undefined, null, 1, 'yes', {}]) {
    let commits = 0
    const { registry } = registryFor([], { save: { authorize() { return decision }, commit() { commits++ } } })
    const result = await registry.executeTool(call('save_skill', { name: 'new', content: document('new'), expectedRevision: null }), context())
    assert.equal(result.isError, true)
    assert.equal(parsedResult(result).success, false)
    assert.equal(commits, 0)
  }
  let commits = 0
  const { registry } = registryFor([], { save: {
    authorize() { throw new Error('Review unavailable') }, commit() { commits++ }
  } })
  assert.equal(errorCode(await registry.executeTool(call('save_skill', { name: 'new', content: document('new'), expectedRevision: null }), context())), 'tool_error')
  assert.equal(commits, 0)
})

test('host atomically rechecks current disk revision after review and rejected commits do not activate', async () => {
  let persisted = document()
  const externallyChanged = document('sample', 'Changed elsewhere')
  let commits = 0
  const { registry, catalog } = registryFor([{ content: persisted }], { save: {
    authorize() { persisted = externallyChanged; return true },
    commit(proposal) {
      commits++
      if (skillRevision(persisted) !== proposal.expectedRevision) throw new Error('Disk revision changed after review')
      persisted = proposal.after.content
    }
  } })
  const result = await registry.executeTool(call('save_skill', { name: 'sample', content: document('sample', 'Proposed'), expectedRevision: catalog.skills[0].revision }), context())
  assert.equal(errorCode(result), 'tool_error')
  assert.match(parsedResult(result).error.message, /Disk revision changed/)
  assert.equal(commits, 1)
  assert.equal(persisted, externallyChanged)
  assert.equal(catalog.document('sample').content, document())
})

test('cancellation before save review or between approval and commit prevents persistence', async () => {
  const controller = new AbortController(), started = deferred(), finish = deferred()
  let approvals = 0, commits = 0
  const { registry } = registryFor([], { save: {
    async authorize(_proposal, { signal }) { approvals++; assert.equal(signal, controller.signal); started.resolve(); return finish.promise },
    commit() { commits++ }
  } })
  const input = call('save_skill', { name: 'new', content: document('new'), expectedRevision: null })
  const saving = registry.executeTool(input, context(controller))
  await started.promise
  controller.abort(new Error('Cancelled approval'))
  finish.resolve(true)
  await assert.rejects(saving, /Cancelled approval/)
  await assert.rejects(registry.executeTool(input, context(controller)), /Cancelled approval/)
  assert.equal(approvals, 1)
  assert.equal(commits, 0)
})

test('host commit honors cancellation before its durable write and core does not activate failed saves', async () => {
  const controller = new AbortController(), started = deferred(), finish = deferred()
  let writes = 0
  const { registry, catalog } = registryFor([], { save: {
    authorize() { return true },
    async commit(_proposal, { signal }) {
      assert.equal(signal, controller.signal)
      started.resolve()
      await finish.promise
      signal.throwIfAborted()
      writes++
    }
  } })
  const saving = registry.executeTool(call('save_skill', { name: 'new', content: document('new'), expectedRevision: null }), context(controller))
  await started.promise
  controller.abort(new Error('Stopped before durable write'))
  finish.resolve()
  await assert.rejects(saving, /Stopped before durable write/)
  assert.equal(writes, 0)
  assert.equal(catalog.document('new'), undefined)
})

test('save extension reports committed success despite post-commit abort and preserves turn snapshot', async () => {
  const controller = new AbortController()
  let persisted
  const { extension, catalog } = registryFor([], { save: {
    authorize() { return true },
    commit(proposal, { signal }) {
      assert.equal(signal, controller.signal)
      persisted = proposal.after.content
      controller.abort(new Error('Stopped after committed rename'))
    }
  } })
  const tool = extension.tools.find((tool) => tool.definition.name === 'save_skill')
  const input = call('save_skill', { name: 'new', content: document('new'), expectedRevision: null })
  tool.validateArguments(input.arguments)
  const result = parsedResult(await tool.execute(input, context(controller)))
  assert.equal(result.saved, true)
  assert.equal(result.available, 'next_turn')
  assert.equal(persisted, document('new'))
  assert.equal(catalog.document('new'), undefined)
})

test('registry cancellation after a durable save never implies host rollback', async () => {
  const controller = new AbortController()
  let persisted
  const { registry, catalog } = registryFor([], { save: {
    authorize() { return true }, commit(proposal) { persisted = proposal.after.content; controller.abort() }
  } })
  await assert.rejects(registry.executeTool(call('save_skill', { name: 'new', content: document('new'), expectedRevision: null }), context(controller)), { name: 'AbortError' })
  assert.equal(persisted, document('new'))
  assert.equal(catalog.document('new'), undefined)
  assert.equal(createSkillCatalog([{ content: persisted }]).document('new').content, persisted)
})

test('fake provider progressively loads only needed skills/resources without persistence or activation', async () => {
  const needed = document('yaml-help', 'Use when reviewing YAML', 'YAML ONLY INSTRUCTIONS. See references/guide.md.')
  const unrelated = document('image-help', 'Use for images', 'UNRELATED FULL IMAGE INSTRUCTIONS')
  const resourceReads = [], authorized = []
  let writes = 0
  const { registry, catalog } = registryFor([
    { content: needed, readResource(received) { resourceReads.push(received); return 'YAML REFERENCE TEXT' } },
    { content: unrelated, readResource() { throw new Error('Unrelated resource was loaded') } }
  ], {
    authorizeRead(received) { authorized.push(received); return true },
    save: { authorize() { throw new Error('Persistence review should not run') }, commit() { writes++ } }
  })
  const catalogContext = formatSkillCatalogContext(catalog)
  const queries = []
  const result = await runAgent({
    provider: { async generate(query) {
      queries.push(query)
      assert.deepEqual(query.tools.map((tool) => tool.name), ['list_skills', 'read_skill', 'save_skill'])
      if (queries.length === 1) {
        assert.equal(query.messages[0].role, 'user')
        assert.equal(query.messages[0].content.includes('YAML ONLY INSTRUCTIONS'), false)
        assert.equal(query.messages[0].content.includes('UNRELATED FULL IMAGE INSTRUCTIONS'), false)
        return { content: '', toolCalls: [{ ...call('list_skills'), id: 'list-needed-skills' }] }
      }
      if (queries.length === 2) {
        const listed = parsedResult(query.messages.at(-1)).skills
        const chosen = listed.find((skill) => skill.name === 'yaml-help')
        return { content: '', toolCalls: [{ ...call('read_skill', { name: chosen.name, path: 'SKILL.md', expectedRevision: chosen.revision }), id: 'read-needed-skill' }] }
      }
      if (queries.length === 3) {
        assert.equal(parsedResult(query.messages.at(-1)).content, needed)
        return { content: '', toolCalls: [{ ...call('read_skill', request(catalog, 'yaml-help', 'references/guide.md')), id: 'read-needed-reference' }] }
      }
      assert.equal(parsedResult(query.messages.at(-1)).content, 'YAML REFERENCE TEXT')
      assert.equal(JSON.stringify(query.messages).includes('UNRELATED FULL IMAGE INSTRUCTIONS'), false)
      return { content: 'Reviewed the YAML using the relevant instructions.', toolCalls: [] }
    } },
    messages: [{ kind: 'message', role: 'user', content: catalogContext }, { kind: 'message', role: 'user', content: 'Review this YAML' }],
    tools: registry.tools, executeTool: registry.executeTool
  })
  assert.equal(result.status, 'completed', JSON.stringify(result.error))
  assert.equal(result.rounds, 4)
  assert.deepEqual(authorized.map(({ name, path }) => ({ name, path })), [
    { name: 'yaml-help', path: 'SKILL.md' }, { name: 'yaml-help', path: 'references/guide.md' }
  ])
  assert.equal(resourceReads.length, 1)
  assert.equal(writes, 0)
  assert.deepEqual(catalog.skills.map((skill) => skill.name), ['yaml-help', 'image-help'])
})
