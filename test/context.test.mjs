// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { compactContext, prepareContext, measureContext, estimateContext, validateContextCheckpoint, runAgent, validateHistory } from '../dist/index.js'

const user = (content) => ({ kind: 'message', role: 'user', content })
const system = (content) => ({ kind: 'message', role: 'system', content })
const assistant = (content) => ({ kind: 'assistant', content, toolCalls: [] })
const textResult = (content = 'concise historical facts') => ({ content, toolCalls: [] })
const messages = () => [system('current instructions'), ...Array.from({ length: 10 }, (_, i) =>
  [user(`old request ${i} ${'a'.repeat(200)}`), assistant(`old response ${i} ${'b'.repeat(200)}`)]).flat(), user('current exact request')]
const provider = (generate = async () => textResult()) => ({ generate, estimateContext: estimateContext })
const input = (extra = {}) => ({ provider: provider(), messages: messages(), tools: [], context: { sourceId: 'session-a', keepRecentMessages: 3 }, ...extra })

function toolGroup(id, content = 'actual successful side effect') {
  return [{ kind: 'assistant', content: '', toolCalls: [{ id, name: 'write', arguments: { value: id } }], providerState: { provider: 'native:model', items: ['opaque reasoning'] } },
    { kind: 'tool_result', callId: id, name: 'write', content }]
}

test('measurement includes full prefix schemas native state and CJK; occupancy is not billing usage', () => {
  const basic = measureContext(input())
  const complete = measureContext(input({ tools: [{ name: 'tool', description: '文'.repeat(100), parameters: { type: 'object', properties: { field: { type: 'string', description: 'schema'.repeat(100) } } } }],
    messages: [...messages(), ...toolGroup('a')], context: { sourceId: 's', prefixMessages: [system('fresh'), user('memory'.repeat(100))] } }))
  assert(complete.usage.inputTokens > basic.usage.inputTokens)
  assert.equal(complete.usage.estimated, true)
  assert.equal(complete.usage.contextWindow, undefined)
  assert.equal(complete.usage.utilization, undefined)
  assert.equal(complete.maxOutputTokens, 4096)
  assert(estimateContext({ messages: [user('界'.repeat(100))], tools: [] }).inputTokens > estimateContext({ messages: [user('a'.repeat(100))], tools: [] }).inputTokens)
})

test('small models scale output reserve; endpoint cap remains separate and provenance survives', () => {
  const result = measureContext(input({ context: { sourceId: 's', limits: { contextWindow: 100, maxInputTokens: 50, maxOutputTokens: 8,
    source: { kind: 'provider-catalog', freshness: 'stale', fetchedAt: '2026-10-15T00:00:00Z' } } } }))
  assert.equal(result.usage.outputReserveTokens, 8)
  assert.equal(result.usage.availableInputTokens, 50)
  assert.equal(result.usage.contextWindow, 100)
  assert.equal(result.usage.limitSource.freshness, 'stale')
})

test('manual compaction preserves canonical input, current instructions, recent whole groups and exact latest user', async () => {
  const raw = [...messages().slice(0, -1), user('exact current goal'), ...toolGroup('a'), ...toolGroup('b'), ...toolGroup('c')]
  const original = structuredClone(raw)
  let summaryRequest
  let saved
  const result = await compactContext(input({ messages: raw, provider: provider(async (request, _signal, options) => {
    summaryRequest = request
    assert.equal(options.maxOutputTokens, 2048)
    assert.deepEqual(request.tools, [])
    assert(Object.isFrozen(request.messages))
    return textResult()
  }), context: { sourceId: 's', keepRecentMessages: 3, prefixMessages: [user('fresh memory')], onCheckpoint: async (checkpoint) => { saved = checkpoint } } }))
  assert.deepEqual(raw, original)
  validateHistory(result.messages)
  assert.deepEqual(result.messages.at(-4), raw.at(-4))
  assert.deepEqual(result.messages.at(-1), raw.at(-1))
  assert(result.messages.some((message) => message.content === 'exact current goal'))
  assert(result.messages.some((message) => message.content === 'current instructions'))
  assert.equal(result.messages[0].content, 'fresh memory')
  assert.equal(result.messages[2].role, 'user')
  assert.match(result.messages[2].content, /untrusted data/)
  assert.equal(saved.source.id, 's')
  assert.equal(result.checkpoint.source.revision, saved.source.revision)
  assert(!summaryRequest.messages[1].content.includes('opaque reasoning'))
  assert(!summaryRequest.messages[1].content.includes('fresh memory'))
})

test('bound checkpoint resumes safely; source identity/revision mismatch rejects stale summary', async () => {
  const first = await compactContext(input())
  validateContextCheckpoint(first.checkpoint)
  const resumed = measureContext(input({ context: { sourceId: 'session-a', checkpoint: first.checkpoint,
    prefixMessages: [system('changed instructions'), user('changed memory')] } }))
  assert(resumed.checkpoint)
  assert.equal(resumed.messages[0].content, 'changed instructions')
  const edited = messages(); edited[1].content = 'edited'
  const mismatch = measureContext(input({ messages: edited, context: { sourceId: 'session-a', checkpoint: first.checkpoint } }))
  assert.equal(mismatch.checkpoint, undefined)
  assert(!mismatch.messages.some((message) => message.content.includes('untrusted data')))
  assert.equal(measureContext(input({ context: { sourceId: 'other', checkpoint: first.checkpoint } })).checkpoint, undefined)
})

test('repeated compaction summarizes previous summary plus new portable delta, bound to full raw prefix', async () => {
  const first = await compactContext(input())
  const raw = [...messages(), ...Array.from({ length: 6 }, (_, i) => [user(`new ${i} ${'x'.repeat(200)}`), assistant('y'.repeat(200))]).flat(), user('latest')]
  let summarySource
  const next = await compactContext(input({ messages: raw, provider: provider(async (request) => { summarySource = JSON.parse(request.messages[1].content); return textResult('new summary') }),
    context: { sourceId: 'session-a', checkpoint: first.checkpoint, keepRecentMessages: 3 } }))
  assert.equal(summarySource.previousSummary, first.checkpoint.summary)
  assert(!summarySource.conversation.some((message) => message.content?.startsWith('old request 0 ')))
  assert(next.checkpoint.source.messageCount > first.checkpoint.source.messageCount)
  assert(measureContext(input({ messages: raw, context: { sourceId: 'session-a', checkpoint: next.checkpoint } })).checkpoint)
})

test('host projection removes stale skill content in provider view and summary source without rewriting raw evidence', async () => {
  const raw = [...messages().slice(0, 4), ...toolGroup('skill', 'SECRET_STALE_SKILL_INSTRUCTION'), ...messages().slice(4)]
  const projectMessages = (messages) => messages.map((message) => message.kind === 'tool_result' && message.callId === 'skill'
    ? { ...message, content: 'Reload skill for current guidance' } : message)
  let source
  await compactContext(input({ messages: raw, provider: provider(async (request) => { source = request.messages[1].content; return textResult() }), context: { sourceId: 's', projectMessages } }))
  assert(!source.includes('SECRET_STALE_SKILL_INSTRUCTION'))
  assert(source.includes('Reload skill'))
  assert(raw.some((message) => message.content === 'SECRET_STALE_SKILL_INSTRUCTION'))
  assert.throws(() => measureContext(input({ context: { sourceId: 's', projectMessages: () => [] } })), /Invalid context/)
})

test('unknown limits only measure automatically; known threshold compacts once and disabled never generates', async () => {
  let calls = 0
  const source = input({ provider: provider(async () => { calls++; return textResult() }) })
  assert.equal((await prepareContext(source)).checkpoint, undefined)
  assert.equal(calls, 0)
  const before = measureContext(source).usage.inputTokens
  const known = { ...source, context: { ...source.context, limits: { contextWindow: before + 150, maxOutputTokens: 100 }, threshold: 0.8 } }
  assert((await prepareContext(known)).checkpoint)
  assert.equal(calls, 1)
  await assert.rejects(() => prepareContext({ ...known, context: { ...known.context, autoCompact: false, limits: { contextWindow: 50 } } }), /exceed/)
  assert.equal(calls, 1)
})

test('failure/no shrink/invalid summary/checkpoint save failure never replace the prior view', async () => {
  for (const generate of [async () => { throw new Error('sensitive provider data') }, async () => textResult('x'.repeat(10000)),
    async () => ({ content: 'summary', toolCalls: [{ id: 'unexpected', name: 'write', arguments: {} }] })]) {
    let saves = 0
    await assert.rejects(() => compactContext(input({ provider: provider(generate), context: { sourceId: 's', onCheckpoint: () => { saves++ } } })))
    assert.equal(saves, 0)
  }
  await assert.rejects(() => compactContext(input({ context: { sourceId: 's', onCheckpoint: () => { throw new Error('disk') } } })), /could not be saved/)
})

test('cancelled uncooperative summary is quarantined and never saves checkpoint or completes', async () => {
  const controller = new AbortController()
  let finish
  let saves = 0
  const events = []
  const promise = compactContext(input({ signal: controller.signal,
    provider: provider(() => new Promise((resolve) => { finish = resolve })),
    onEvent: (event) => events.push(event.type), context: { sourceId: 's', onCheckpoint: () => { saves++ } } }))
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(promise)
  finish(textResult())
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(saves, 0)
  assert(!events.includes('compaction_completed'))
})

test('cannot fit protects current prefix, schemas and complete tool groups with actionable error', async () => {
  let calls = 0
  const result = await runAgent({ ...input({ messages: [user('large'.repeat(1000)), ...toolGroup('a')] }),
    provider: provider(async () => { calls++; return textResult() }),
    context: { sourceId: 's', limits: { contextWindow: 100 }, prefixMessages: [system('instruction'.repeat(100))] }, executeTool: async () => { throw Error('must not run') } })
  assert.equal(result.error.code, 'context_cannot_fit')
  assert.equal(calls, 0)
  assert.match(result.error.message, /Reduce|larger-context/)
})

test('runAgent compacts at request boundary and leaves accepted canonical raw history unchanged', async () => {
  const raw = messages()
  const before = measureContext(input()).usage.inputTokens
  let summaries = 0
  let dispatches = 0
  const result = await runAgent({ messages: raw, tools: [], context: { sourceId: 's', limits: { contextWindow: before + 150, maxOutputTokens: 100 } },
    provider: provider(async ({ messages, tools }) => {
      if (messages[0].content.startsWith('Summarize')) { summaries++; assert.deepEqual(tools, []); return textResult() }
      dispatches++; assert(messages.some((message) => message.content.includes('Historical conversation summary'))); return textResult('final')
    }), executeTool: async () => { throw Error('must not run') } })
  assert.equal(result.status, 'completed')
  assert.equal(summaries, 1)
  assert.equal(dispatches, 1)
  assert.deepEqual(result.history.slice(0, -1), raw)
  assert(result.checkpoint)
  assert.equal(result.usage.totalTokens, 0)
  assert.equal(result.contextUsage.estimated, true)
})

test('classified overflow gets one smaller generation retry and never replays completed side effects', async () => {
  let mainCalls = 0
  let summaries = 0
  let executions = 0
  const requests = []
  const events = []
  const result = await runAgent({ messages: messages(), tools: [{ name: 'write', description: 'write', parameters: {} }],
    context: { sourceId: 's', keepRecentMessages: 3 }, onEvent: (event) => events.push(event),
    provider: provider(async (request) => {
      if (request.messages[0].content.startsWith('Summarize')) { summaries++; return textResult() }
      requests.push(request)
      mainCalls++
      if (mainCalls === 1) return { content: '', toolCalls: [{ id: 'new', name: 'write', arguments: {} }] }
      if (mainCalls === 2) throw Object.assign(new Error('sanitized overflow'), { code: 'context_overflow' })
      return textResult('finished')
    }), executeTool: async () => { executions++; return { content: 'actual complete' } } })
  assert.equal(result.status, 'completed')
  assert.equal(executions, 1)
  assert.equal(summaries, 1)
  assert.equal(mainCalls, 3)
  assert(requests[2].messages.length < requests[1].messages.length)
  assert.equal(result.history.filter((message) => message.kind === 'tool_result' && message.callId === 'new').length, 1)
  assert(events.some((event) => event.type === 'compaction_started' && event.reason === 'overflow'))
})

test('second overflow stops, arbitrary error message never triggers retry', async () => {
  for (const classified of [false, true]) {
    let main = 0
    let summaries = 0
    const result = await runAgent({ messages: messages(), tools: [], context: { sourceId: 's' }, executeTool: async () => ({ content: '' }),
      provider: provider(async ({ messages }) => {
        if (messages[0].content.startsWith('Summarize')) { summaries++; return textResult() }
        main++
        throw Object.assign(new Error('context window exceeded'), classified ? { code: 'context_overflow' } : {})
      }) })
    assert.equal(result.status, 'error')
    assert.equal(main, classified ? 2 : 1)
    assert.equal(summaries, classified ? 1 : 0)
    assert.equal(result.error.code, classified ? 'context_cannot_fit' : 'provider_error')
  }
})

test('model switch remeasures bound checkpoint with new full projection and capacities', async () => {
  const compacted = await compactContext(input())
  const first = measureContext(input({ context: { sourceId: 'session-a', checkpoint: compacted.checkpoint, limits: { contextWindow: 4000 } } }))
  const second = measureContext(input({ provider: { ...provider(), estimateContext: (request) => ({ inputTokens: estimateContext(request).inputTokens * 2, estimated: true }) },
    context: { sourceId: 'session-a', checkpoint: compacted.checkpoint, limits: { contextWindow: 8000 }, prefixMessages: [system('new model instructions')] } }))
  assert(second.checkpoint)
  assert(second.usage.inputTokens > first.usage.inputTokens)
  assert.equal(second.usage.contextWindow, 8000)
})

test('summary usage is separately reported even when shrink or durable checkpoint fails; missing usage stays unknown', async () => {
  for (const failure of ['not_smaller', 'checkpoint']) {
    const events = []
    const source = input({ onEvent: (event) => events.push(event), provider: provider(async () => ({
      content: failure === 'not_smaller' ? 'z'.repeat(10000) : 'concise summary', toolCalls: [], usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 }
    })), context: { sourceId: 's', ...(failure === 'checkpoint' ? { onCheckpoint: () => { throw Error('disk') } } : {}) } })
    await assert.rejects(() => compactContext(source))
    assert.deepEqual(events.find((event) => event.type === 'compaction_usage').usage, { inputTokens: 50, outputTokens: 5, totalTokens: 55 })
    assert(!events.some((event) => event.type === 'compaction_completed'))
  }
  const events = []
  await compactContext(input({ onEvent: (event) => events.push(event) }))
  assert.equal(events.find((event) => event.type === 'compaction_usage').usage, undefined)
})

test('observer failure stops lifecycle callbacks before normal provider dispatch', async () => {
  const events = []
  let calls = 0
  const before = measureContext(input()).usage.inputTokens
  const result = await runAgent({ messages: messages(), tools: [], context: { sourceId: 's', limits: { contextWindow: before + 150, maxOutputTokens: 100 } },
    provider: provider(async () => { calls++; return textResult() }), executeTool: async () => ({ content: '' }),
    onEvent: (event) => { events.push(event.type); if (event.type === 'compaction_usage') throw Error('observer failed') } })
  assert.equal(result.error.code, 'event_error')
  assert.equal(calls, 1)
  assert.deepEqual(events, ['compaction_started', 'compaction_usage'])
})

test('crash before checkpoint save leaves raw transcript sufficient for safe fresh resume', async () => {
  const raw = messages()
  await assert.rejects(() => compactContext(input({ messages: raw, context: { sourceId: 's', onCheckpoint: () => { throw Error('crash') } } })))
  const resumed = measureContext(input({ messages: raw, context: { sourceId: 's' } }))
  assert.equal(resumed.checkpoint, undefined)
  assert.deepEqual(resumed.messages, raw)
  const compacted = await compactContext(input({ messages: raw, context: { sourceId: 's' } }))
  const crashRecovered = measureContext(input({ messages: structuredClone(raw), context: { sourceId: 's', checkpoint: JSON.parse(JSON.stringify(compacted.checkpoint)) } }))
  assert.equal(crashRecovered.checkpoint.source.revision, compacted.checkpoint.source.revision)
})

test('invalid checkpoint structures and incomplete tool-pair bindings never dispatch summaries', async () => {
  const source = input()
  const valid = (await compactContext(source)).checkpoint
  for (const checkpoint of [{ ...valid, version: 2 }, { ...valid, source: { ...valid.source, messageCount: -1 } }, { ...valid, summary: '' }]) {
    assert.throws(() => validateContextCheckpoint(checkpoint))
    await assert.rejects(() => prepareContext({ ...source, context: { ...source.context, checkpoint } }), /Invalid context/)
  }
})

test('changed source projection invalidates checkpoint even when raw history is identical', async () => {
  const raw = [...messages().slice(0, 4), ...toolGroup('skill', 'OLD_SKILL_CONTENT'), ...messages().slice(4)]
  const first = await compactContext(input({ messages: raw, context: { sourceId: 's' } }))
  const fresh = (messages) => messages.map((message) => message.kind === 'tool_result' && message.callId === 'skill'
    ? { ...message, content: 'Reload current skill guidance' } : message)
  const remeasured = measureContext(input({ messages: raw, context: { sourceId: 's', checkpoint: first.checkpoint, projectMessages: fresh } }))
  assert.equal(remeasured.checkpoint, undefined)
  assert(!remeasured.messages.some((message) => message.content.includes('Historical conversation summary')))
  assert(remeasured.messages.some((message) => message.content === 'Reload current skill guidance'))
  const next = await compactContext(input({ messages: raw, context: { sourceId: 's', checkpoint: first.checkpoint, projectMessages: fresh } }))
  assert.equal(next.checkpoint.source.revision, first.checkpoint.source.revision)
  assert.notEqual(next.checkpoint.source.projectionRevision, first.checkpoint.source.projectionRevision)
})

test('canonical settlements retain raw history and exclude derived summary/occupancy metadata', async () => {
  const { createRunSettlement, decodeAgentRecord } = await import('../dist/events.js')
  const raw = messages()
  const result = await runAgent({ messages: raw, tools: [], provider: provider(async (_request, _signal, options) =>
    textResult(options.purpose === 'context-summary' ? 'derived summary only' : 'final answer')),
    context: { sourceId: 's' }, executeTool: async () => ({ content: '' }) })
  const compacted = await compactContext(input({ messages: raw, context: { sourceId: 's' } }))
  result.checkpoint = compacted.checkpoint
  const entries = result.history.map((message, index) => ({ id: `message-${index}`, source: { reference: 'canonical/session', revision: '1' }, message }))
  const record = createRunSettlement({ envelope: { version: 1, sessionId: 's', eventId: 'terminal', sequence: 1, previousEventId: null, source: { reference: 'canonical/session' } },
    runId: 'run', inputHistoryLength: raw.length, result, history: entries, outcomes: [], sessionUsage: result.usage })
  assert.equal(record.settlement.checkpoint, undefined)
  assert.equal(record.settlement.contextUsage, undefined)
  assert(!JSON.stringify(record).includes('concise historical facts'))
  assert.deepEqual(record.snapshot.history.map((entry) => entry.message), result.history)
  for (const code of ['context_error', 'context_cannot_fit']) {
    const errorRecord = structuredClone(record)
    errorRecord.settlement.status = 'error'
    errorRecord.settlement.error = { code, message: 'actionable' }
    assert.equal(decodeAgentRecord(errorRecord).settlement.error.code, code)
  }
})

test('current projected system instructions survive compaction and checkpoint resume', async () => {
  const projectMessages = (messages) => messages.map((message) => message.kind === 'message' && message.role === 'system'
    ? { ...message, content: 'current projected instructions' } : message)
  const source = input({ context: { sourceId: 's', projectMessages } })
  assert.equal(measureContext(source).messages[0].content, 'current projected instructions')
  const compacted = await compactContext(source)
  assert.equal(compacted.messages[0].content, 'current projected instructions')
  assert.equal(measureContext({ ...source, context: { ...source.context, checkpoint: compacted.checkpoint } }).messages[0].content, 'current projected instructions')
})

test('compaction captures raw source, projection, route methods and settings once before awaiting work', async () => {
  const raw = messages()
  const originalRaw = structuredClone(raw)
  let changed = false
  let finish
  let projections = 0
  const context = { sourceId: 'captured', prefixMessages: [system('captured prefix')], projectMessages(messages) {
    projections++
    return messages.map((message) => message.kind === 'message' && message.role === 'system'
      ? { ...message, content: changed ? 'changed projection' : 'captured projection' } : message)
  } }
  const source = input({ messages: raw, context, provider: provider(() => new Promise((resolve) => { finish = resolve })) })
  const pending = compactContext(source)
  await new Promise((resolve) => setImmediate(resolve))
  raw[1].content = 'changed raw source'
  context.sourceId = 'changed identity'
  context.prefixMessages[0].content = 'changed prefix'
  changed = true
  finish(textResult('captured facts'))
  const result = await pending
  assert.equal(projections, 1)
  assert.equal(result.checkpoint.source.id, 'captured')
  assert.equal(result.messages[0].content, 'captured prefix')
  assert.equal(result.messages[1].content, 'captured projection')
  const restored = measureContext(input({ messages: originalRaw, context: { sourceId: 'captured', checkpoint: result.checkpoint,
    projectMessages: (messages) => messages.map((message) => message.kind === 'message' && message.role === 'system' ? { ...message, content: 'captured projection' } : message) } }))
  assert(restored.checkpoint)
  assert.equal(measureContext(input({ messages: raw, context: { sourceId: 'captured', checkpoint: result.checkpoint } })).checkpoint, undefined)
})

test('built-in OpenRouter reserves all canonical IDs hidden by compaction without replaying old effects', async () => {
  const { createOpenRouterProvider } = await import('../dist/providers/openrouter.js')
  const raw = [user('old'), ...toolGroup('call_1'), ...toolGroup('call_1__vivi_1'), ...messages().slice(1)]
  const compacted = await compactContext(input({ messages: raw, context: { sourceId: 's', keepRecentMessages: 2 } }))
  let calls = 0
  let executions = 0
  const nativeRequests = []
  const builtin = createOpenRouterProvider({ model: 'fixture', apiKey: 'offline-only', fetch: async (_url, init) => {
    nativeRequests.push(JSON.parse(init.body))
    calls++
    return new Response(JSON.stringify({ choices: [{ finish_reason: calls === 1 ? 'tool_calls' : 'stop', message: calls === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write', arguments: '{}' } }] }
      : { role: 'assistant', content: 'done' } }] }))
  } })
  const result = await runAgent({ messages: raw, tools: [{ name: 'write', description: '', parameters: {} }], provider: builtin,
    context: { sourceId: 's', checkpoint: compacted.checkpoint, autoCompact: false }, executeTool: async (call) => {
      executions++
      assert.equal(call.id, 'call_1__vivi_2')
      return { content: 'new actual result' }
    } })
  assert.equal(result.status, 'completed')
  assert.equal(executions, 1)
  assert.equal(calls, 2)
  assert.deepEqual(result.history.slice(0, raw.length), raw)
  assert.equal(nativeRequests.some((request) => Object.hasOwn(request, 'reservedToolCallIds')), false)
  assert(nativeRequests[1].messages.some((message) => message.tool_call_id === 'call_1__vivi_2'))
})

test('repeated manual compaction without new eligible history is a no-op retaining checkpoint', async () => {
  let calls = 0
  const first = await compactContext(input({ provider: provider(async () => { calls++; return textResult() }) }))
  const events = []
  const again = await compactContext(input({ provider: provider(async () => { calls++; throw Error('must not dispatch') }),
    context: { sourceId: 'session-a', checkpoint: first.checkpoint, keepRecentMessages: 3 }, onEvent: (event) => events.push(event.type) }))
  assert.equal(calls, 1)
  assert.equal(again.canCompact, false)
  assert.deepEqual(again.checkpoint, first.checkpoint)
  assert.deepEqual(events, ['context_usage'])
})

test('irreducible retained floor fails before paying for a futile summary', async () => {
  let calls = 0
  const source = input({ messages: [...Array.from({ length: 11 }, (_, index) => user(`short history ${index}`))],
    provider: provider(async () => { calls++; return textResult() }),
    context: { sourceId: 's', prefixMessages: [system('instruction '.repeat(400))], limits: { contextWindow: 1000, maxOutputTokens: 100 }, keepRecentMessages: 2 } })
  await assert.rejects(() => compactContext(source), /summarizing older history cannot help/)
  assert.equal(calls, 0)
})

test('content-only projection permits structurally equivalent object key ordering', () => {
  const source = input({ messages: [{ content: 'old', kind: 'message', role: 'user' }], context: { sourceId: 's',
    projectMessages: (messages) => messages.map((message) => ({ kind: message.kind, role: message.role, content: 'new' })) } })
  assert.equal(measureContext(source).messages[0].content, 'new')
})

test('provider output recommendation is reserved consistently and fails before dispatch when input cannot fit', async () => {
  let requests = 0
  const p = { defaultOutputTokens: 65536, estimateContext: (_input, options) => {
    assert.equal(options.maxOutputTokens, 65536)
    return { inputTokens: 40000, estimated: true }
  }, async generate() { requests++; return textResult() } }
  const request = { provider: p, messages: [user('latest')], tools: [], context: { sourceId: 's', limits: { contextWindow: 100000 } } }
  const measured = measureContext(request)
  assert.equal(measured.maxOutputTokens, 65536)
  assert.equal(measured.usage.availableInputTokens, 34464)
  await assert.rejects(prepareContext(request), { code: 'cannot_fit' })
  assert.equal(requests, 0)
  for (const invalid of [0, -1, NaN, Infinity, '65536']) {
    assert.throws(() => measureContext({ ...request, provider: { ...p, defaultOutputTokens: invalid } }), { code: 'invalid_context' })
  }
})

test('provider-aware compaction reserves reasoning tokens while ordinary providers retain concise summary budget', async () => {
  for (const recommended of [undefined, 65536]) {
    const calls = []
    const p = { ...provider(async (_input, _signal, options) => { calls.push(options); return textResult() }),
      ...(recommended ? { defaultOutputTokens: recommended } : {}) }
    await compactContext(input({ provider: p }))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].purpose, 'context-summary')
    assert.equal(calls[0].maxOutputTokens, recommended ?? 2048)
  }
})
