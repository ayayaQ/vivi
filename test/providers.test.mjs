// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { createOpenAIProvider, projectOpenAiHistory } from '../dist/providers/openai.js';
import { createOpenRouterProvider, projectOpenRouterHistory } from '../dist/providers/openrouter.js';

const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn);
const openAiModel = 'fixture-openai-model';
const routerModel = 'fixture/router-model';
const privateKey = 'private-provider-key-never-in-output';
const privateDetail = 'private-body-never-in-errors';
const definitions = [{
  name: 'read_bot_state',
  description: 'Read bot state',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
}];
const seed = [
  { kind: 'message', role: 'system', content: 'Inspect carefully' },
  { kind: 'message', role: 'user', content: 'Inspect state' },
];
const reasoning = {
  type: 'reasoning',
  id: 'reasoning_1',
  summary: [{ type: 'summary_text', text: 'Inspect state first' }],
  encrypted_content: 'opaque-private-reasoning',
  status: 'completed',
};
const functionCall = {
  type: 'function_call',
  id: 'item_1',
  call_id: 'call_1',
  name: 'read_bot_state',
  arguments: '{}',
  status: 'completed',
};
const assistantMessage = {
  type: 'message',
  id: 'message_1',
  role: 'assistant',
  status: 'completed',
  phase: 'commentary',
  content: [{ type: 'output_text', text: 'Inspecting now', annotations: [] }],
};
const canonicalCall = { id: 'call_1', name: 'read_bot_state', arguments: {} };
const result = {
  kind: 'tool_result', callId: 'call_1', name: 'read_bot_state', content: '{"value":1}',
};
const routerCall = {
  id: 'call_1', type: 'function', function: { name: 'read_bot_state', arguments: '{}' },
};
const routerNativeMessage = {
  role: 'assistant', content: 'Inspecting now', tool_calls: [routerCall],
  reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-router-reasoning' }],
};
const assistant = (turn) => ({ kind: 'assistant', ...turn });
const aiResponse = (output = [], extra = {}) => ({ status: 'completed', output, ...extra });
const routerResponse = (message = { role: 'assistant', content: 'Done' }, extra = {}, choice = {}) => ({
  choices: [{ message, finish_reason: message?.tool_calls?.length ? 'tool_calls' : 'stop', ...choice }],
  ...extra,
});
const jsonResponse = (value, init = {}) => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' }, ...init,
});

// Every provider receives an injected HTTP implementation. These tests cannot use live credentials
// or accidentally fall through to the network, including when a response queue is exhausted.
function harness(kind, responses = [], options = {}) {
  const requests = [];
  const pending = [...responses];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), init, body: JSON.parse(init.body) });
    assert.ok(pending.length, 'Unexpected provider HTTP request');
    const next = pending.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    return next instanceof Response ? next : jsonResponse(next);
  };
  const factory = kind === 'openai' ? createOpenAIProvider : createOpenRouterProvider;
  const model = kind === 'openai' ? openAiModel : routerModel;
  const provider = factory({ model, apiKey: privateKey, fetch, ...options });
  const run = (messages = seed, tools = definitions, signal = new AbortController().signal) =>
    provider.generate({ messages, tools }, signal);
  return { provider, requests, run, enqueue: (...next) => pending.push(...next) };
}

function canonicalOpenAi(content = 'Inspecting now') {
  return [
    { role: 'assistant', content },
    { type: 'function_call', call_id: 'call_1', name: 'read_bot_state', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: '{"value":1}' },
  ];
}

function canonicalRouter(content = 'Inspecting now') {
  return [
    { role: 'assistant', content, tool_calls: [routerCall] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"value":1}' },
  ];
}

test('OpenAI sends stateless Responses HTTP, schemas, reasoning, and normalized usage', async () => {
  const h = harness('openai', [aiResponse([functionCall], {
    usage: { input_tokens: 30, output_tokens: 12, total_tokens: 45 },
  })], { reasoning: { mode: 'effort', effort: 'low' }, supportedReasoningEfforts: ['low'] });
  const turn = await h.run();
  const { url, init, body } = h.requests[0];
  assert.equal(url, 'https://api.openai.com/v1/responses');
  assert.equal(init.method, 'POST');
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${privateKey}`);
  assert.equal(new Headers(init.headers).get('content-type'), 'application/json');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(body.model, openAiModel);
  assert.deepEqual(body.input, [
    { role: 'system', content: 'Inspect carefully' }, { role: 'user', content: 'Inspect state' },
  ]);
  assert.deepEqual(body.tools, [{ type: 'function', ...definitions[0], strict: false }]);
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.equal(body.stream ?? false, false);
  assert.deepEqual(turn.toolCalls, [canonicalCall]);
  assert.deepEqual(turn.usage, { inputTokens: 30, outputTokens: 12, totalTokens: 45 });
  assert.deepEqual(turn.providerState, { provider: `openai:${openAiModel}`, items: [functionCall] });
});

test('OpenRouter sends chat HTTP, attribution, retained reasoning, and normalized usage', async () => {
  const h = harness('openrouter', [routerResponse({ role: 'assistant', content: 'Done' }, {
    usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 },
  })], {
    reasoning: { mode: 'effort', effort: 'high' }, supportedReasoningEfforts: ['high'],
    attribution: { referer: 'https://example.test/vivi', title: 'Vivi HTTP contract tests' },
  });
  const turn = await h.run();
  const { url, init, body } = h.requests[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(init.method, 'POST');
  const headers = new Headers(init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${privateKey}`);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('http-referer'), 'https://example.test/vivi');
  assert.equal(headers.get('x-title'), 'Vivi HTTP contract tests');
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(body.model, routerModel);
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Inspect carefully' }, { role: 'user', content: 'Inspect state' },
  ]);
  assert.deepEqual(body.tools, [{ type: 'function', function: definitions[0] }]);
  assert.equal(body.tool_choice, 'auto');
  assert.deepEqual(body.reasoning, { effort: 'high', exclude: false });
  assert.equal(body.stream ?? false, false);
  assert.deepEqual(turn.usage, { inputTokens: 50, outputTokens: 8, totalTokens: 58 });
});

for (const kind of ['openai', 'openrouter']) {
  test(`${kind} uses the configured base URL without a duplicate separator`, async () => {
    const response = kind === 'openai' ? aiResponse() : routerResponse();
    const h = harness(kind, [response], { baseURL: 'https://provider.example.test/api/v1/' });
    await h.run();
    assert.equal(h.requests[0].url, `https://provider.example.test/api/v1/${kind === 'openai' ? 'responses' : 'chat/completions'}`);
  });

  test(`${kind} default reasoning omits overrides and disabled reasoning is explicit`, async () => {
    const response = kind === 'openai' ? aiResponse() : routerResponse();
    for (const reasoningSetting of [undefined, { mode: 'default' }]) {
      const h = harness(kind, [response], { reasoning: reasoningSetting });
      await h.run();
      assert.equal(Object.hasOwn(h.requests[0].body, 'reasoning'), false);
      if (kind === 'openrouter') {
        const headers = new Headers(h.requests[0].init.headers);
        assert.equal(headers.has('http-referer'), false);
        assert.equal(headers.has('x-title'), false);
      }
    }
    const h = harness(kind, [response], {
      reasoning: { mode: 'disabled' }, supportedReasoningEfforts: ['none'],
    });
    await h.run();
    assert.deepEqual(h.requests[0].body.reasoning,
      kind === 'openai' ? { effort: 'none' } : { enabled: false });
  });

  test(`${kind} resolves an async API key freshly for each request`, async () => {
    const response = kind === 'openai' ? aiResponse() : routerResponse();
    let calls = 0;
    const h = harness(kind, [response, response], { apiKey: async () => `fixture-key-${++calls}` });
    await h.run();
    await h.run();
    assert.equal(calls, 2);
    assert.equal(new Headers(h.requests[0].init.headers).get('authorization'), 'Bearer fixture-key-1');
    assert.equal(new Headers(h.requests[1].init.headers).get('authorization'), 'Bearer fixture-key-2');
  });

  test(`${kind} rejects unsupported reasoning selections before HTTP`, async () => {
    const forbidden = ['unknown', 'none'];
    for (const options of [
      { reasoning: { mode: 'effort', effort: 'high' } },
      { reasoning: { mode: 'effort', effort: 'high' }, supportedReasoningEfforts: ['low'] },
      { reasoning: { mode: 'disabled' } },
      { reasoning: { mode: 'disabled' }, supportedReasoningEfforts: ['low'] },
      ...forbidden.map((effort) => ({ reasoning: { mode: 'effort', effort }, supportedReasoningEfforts: [effort] })),
    ]) {
      await assert.rejects(async () => { await harness(kind, [], options).run(); }, /reasoning|effort|capabilit/i);
    }
  });

  test(`${kind} validates bounded integer timeouts before HTTP`, async () => {
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648, '100']) {
      await assert.rejects(async () => { await harness(kind, [], { timeoutMs }).run(); }, /timeout/i);
    }
  });

  test(`${kind} defaults absent usage to zero, derives totals, and keeps explicit zero`, async () => {
    const native = kind === 'openai'
      ? (counts) => aiResponse([], { usage: counts })
      : (counts) => routerResponse(undefined, { usage: counts });
    const fields = kind === 'openai' ? { input_tokens: 10, output_tokens: 4 } : { prompt_tokens: 10, completion_tokens: 4 };
    const h = harness(kind, [native(undefined), native(fields), native({ ...fields, total_tokens: 0 })]);
    assert.deepEqual((await h.run()).usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.deepEqual((await h.run()).usage, { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    assert.deepEqual((await h.run()).usage, { inputTokens: 10, outputTokens: 4, totalTokens: 0 });
  });

  test(`${kind} rejects invalid usage without leaking provider data`, async () => {
    const inputField = kind === 'openai' ? 'input_tokens' : 'prompt_tokens';
    const outputField = kind === 'openai' ? 'output_tokens' : 'completion_tokens';
    for (const counts of [[], privateDetail, { [inputField]: -1 }, { [inputField]: 1.5 }, { [inputField]: Number.MAX_SAFE_INTEGER + 1 }, { [inputField]: privateDetail }, { total_tokens: -1 }, { [inputField]: Number.MAX_SAFE_INTEGER, [outputField]: 1 }]) {
      const response = kind === 'openai' ? aiResponse([], { usage: counts }) : routerResponse(undefined, { usage: counts });
      const h = harness(kind, [response]);
      await assert.rejects(h.run(), (error) => {
        assert.match(error.message, /usage|token/i);
        assert.equal(error.message.includes(privateDetail), false);
        return true;
      });
    }
  });

  test(`${kind} sanitizes HTTP, network, resolver, and JSON errors`, async () => {
    for (const response of [
      new Response(`${privateKey} ${privateDetail}`, { status: 503 }),
      new Error(`${privateKey} ${privateDetail}`),
      new Response(`{"${privateDetail}":`, { headers: { 'Content-Type': 'application/json' } }),
    ]) {
      const h = harness(kind, [response]);
      await assert.rejects(h.run(), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(privateKey), false);
        assert.equal(error.message.includes(privateDetail), false);
        assert.equal(JSON.stringify(error).includes(privateKey), false);
        assert.equal(JSON.stringify(error).includes(privateDetail), false);
        if (response instanceof Response && response.status === 503) assert.match(error.message, /503/);
        return true;
      });
    }
    const h = harness(kind, [], { apiKey: async () => { throw new Error(`${privateKey} ${privateDetail}`); } });
    await assert.rejects(h.run(), (error) => {
      assert.equal(error.message.includes(privateKey), false);
      assert.equal(error.message.includes(privateDetail), false);
      assert.equal(JSON.stringify(error).includes(privateKey), false);
      assert.equal(JSON.stringify(error).includes(privateDetail), false);
      return true;
    });
    assert.equal(h.requests.length, 0);
    for (const apiKey of ['', '   ', async () => '', async () => null]) {
      await assert.rejects(async () => { await harness(kind, [], { apiKey }).run(); }, /key|credential/i);
    }
  });

  test(`${kind} bounds response bodies and function argument strings`, async () => {
    const hugeBody = new Response(' '.repeat(16_777_217));
    await assert.rejects(harness(kind, [hugeBody]).run(), /response exceeded the size limit/);
    const oversizedArguments = JSON.stringify({ value: 'a'.repeat(1_048_576) });
    const response = kind === 'openai'
      ? aiResponse([{ ...functionCall, arguments: oversizedArguments }])
      : routerResponse({ role: 'assistant', content: null, tool_calls: [
        { ...routerCall, function: { name: 'read_bot_state', arguments: oversizedArguments } },
      ] });
    await assert.rejects(harness(kind, [response]).run(), /tool arguments exceeded the size limit/);
  });
}

test('Both providers accept every supported enabled effort, including max', async () => {
  for (const kind of ['openai', 'openrouter']) {
    const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    for (const effort of efforts) {
      const h = harness(kind, [kind === 'openai' ? aiResponse() : routerResponse()], {
        reasoning: { mode: 'effort', effort }, supportedReasoningEfforts: [effort],
      });
      await h.run();
      assert.equal(h.requests[0].body.reasoning.effort, effort);
    }
  }
});

test('OpenAI derives canonical text and refusals from output, without convenience output_text', async () => {
  const h = harness('openai', [aiResponse([{
    ...assistantMessage,
    content: [
      { type: 'output_text', text: 'First. ', annotations: [] },
      { type: 'output_text', text: 'Second. ', annotations: [] },
      { type: 'refusal', refusal: 'Cannot do that.' },
    ],
  }])]);
  assert.equal((await h.run()).content, 'First. Second. Cannot do that.');
});

test('OpenAI replays persisted native reasoning, calls, and phase without duplicating text', async () => {
  const native = [reasoning, assistantMessage, functionCall];
  const h = harness('openai', [aiResponse(native, { output_text: 'Inspecting now' }), aiResponse()]);
  const turn = JSON.parse(JSON.stringify(await h.run()));
  await h.run([...seed, assistant(turn), result]);
  assert.deepEqual(h.requests[1].body.input, [
    { role: 'system', content: 'Inspect carefully' }, { role: 'user', content: 'Inspect state' },
    ...native, { type: 'function_call_output', call_id: 'call_1', output: '{"value":1}' },
  ]);
});

test('OpenAI synthesizes missing canonical text alongside native reasoning-only state', () => {
  assert.deepEqual(projectOpenAiHistory([{
    kind: 'assistant', content: 'Done', toolCalls: [],
    providerState: { provider: `openai:${openAiModel}`, items: [reasoning] },
  }], openAiModel), [reasoning, { role: 'assistant', content: 'Done' }]);
});

test('OpenAI incompatible provider/model or inconsistent native state falls back canonically', () => {
  const states = [
    { provider: 'openai:another-model', items: [reasoning, assistantMessage, functionCall] },
    { provider: `openrouter:${openAiModel}`, items: [reasoning, assistantMessage, functionCall] },
    ...[
      [{ type: 'unknown' }], [], [{ ...functionCall, call_id: 'wrong_call' }],
      [{ ...functionCall, name: 'wrong_tool' }], [{ ...functionCall, arguments: '{"changed":true}' }],
      [{ ...assistantMessage, content: [{ type: 'output_text', text: 'Different native text', annotations: [] }] }, functionCall],
    ].map((items) => ({ provider: `openai:${openAiModel}`, items })),
  ];
  for (const providerState of states) {
    assert.deepEqual(projectOpenAiHistory([{
      kind: 'assistant', content: 'Inspecting now', toolCalls: [canonicalCall], providerState,
    }, result], openAiModel), canonicalOpenAi());
  }
});

test('OpenAI rejects historical ID reuse and duplicate IDs without changing encrypted state', async () => {
  const source = [reasoning, functionCall];
  const original = structuredClone(source);
  const h = harness('openai', [aiResponse(source)]);
  await assert.rejects(h.run([assistant({ content: '', toolCalls: [canonicalCall] }), result]), /tool call ID was reused from history/);
  assert.deepEqual(source, original);
  await assert.rejects(harness('openai', [aiResponse([functionCall, functionCall])]).run(), /duplicate tool call ID/);
});

test('OpenAI leaves unadvertised tool names to core policy', async () => {
  const h = harness('openai', [aiResponse([{ ...functionCall, name: 'unadvertised_tool' }])]);
  assert.deepEqual((await h.run()).toolCalls, [{ ...canonicalCall, name: 'unadvertised_tool' }]);
});

test('OpenAI rejects malformed, unsupported, and incomplete native output safely', async () => {
  const omittedArguments = { ...functionCall };
  delete omittedArguments.arguments;
  const badItems = [
    null, { ...functionCall, call_id: '' }, { ...functionCall, call_id: 10 },
    { ...functionCall, call_id: 'invalid id' }, { ...functionCall, name: '' },
    omittedArguments, { ...functionCall, arguments: '' }, { ...functionCall, arguments: `{${privateDetail}` },
    ...['[]', 'null', '"text"', '{"value":1e999}'].map((argumentsValue) => ({ ...functionCall, arguments: argumentsValue })),
    { ...functionCall, status: 'incomplete' }, { type: 'unrecognized_output', api_key: privateKey },
    { ...reasoning, encrypted_content: {} }, { ...reasoning, summary: privateDetail },
    { ...assistantMessage, role: 'user' }, { ...assistantMessage, content: [{ type: 'output_image' }] },
  ];
  for (const item of badItems) {
    await assert.rejects(harness('openai', [aiResponse([item])]).run(), (error) => {
      assert.match(error.message, /Invalid OpenAI/i);
      assert.equal(error.message.includes(privateDetail), false);
      assert.equal(error.message.includes(privateKey), false);
      return true;
    });
  }
  for (const response of [
    null, {}, { output: [functionCall] }, { status: 'completed', output: null },
    ...['failed', 'incomplete', 'in_progress', 'cancelled'].map((status) => aiResponse([functionCall], { status })),
    aiResponse([functionCall], { incomplete_details: { reason: 'max_output_tokens' } }),
    aiResponse([functionCall], { error: { message: privateDetail } }),
  ]) {
    await assert.rejects(harness('openai', [response]).run(), /Invalid OpenAI|not completed/i);
  }
});

test('OpenAI stores sanitized assistant output only, excluding keys and response envelope', async () => {
  const h = harness('openai', [aiResponse([
    { ...reasoning, api_key: privateKey, summary: [{ ...reasoning.summary[0], secret: privateDetail }] },
    { ...assistantMessage, api_key: privateKey, content: [{ ...assistantMessage.content[0], secret: privateDetail }] },
    { ...functionCall, api_key: privateKey },
  ], { metadata: { api_key: privateKey }, id: 'response_secret', api_key: privateKey })]);
  const turn = await h.run();
  assert.deepEqual(turn.providerState.items, [reasoning, assistantMessage, functionCall]);
  const serialized = JSON.stringify(turn);
  for (const value of [privateKey, privateDetail, 'api_key', 'response_secret']) assert.equal(serialized.includes(value), false);
});

test('OpenRouter defaults omitted call arguments to an empty object and replays native JSON', async () => {
  const omittedCall = { id: 'call_1', type: 'function', function: { name: 'read_bot_state' } };
  const message = { ...routerNativeMessage, tool_calls: [omittedCall] };
  const h = harness('openrouter', [routerResponse(message), routerResponse()]);
  const turn = JSON.parse(JSON.stringify(await h.run()));
  assert.deepEqual(turn.toolCalls, [canonicalCall]);
  assert.deepEqual(turn.providerState, { provider: `openrouter:${routerModel}`, items: [routerNativeMessage] });
  await h.run([...seed, assistant(turn), result]);
  assert.deepEqual(h.requests[1].body.messages, [
    { role: 'system', content: 'Inspect carefully' }, { role: 'user', content: 'Inspect state' },
    routerNativeMessage, { role: 'tool', tool_call_id: 'call_1', content: '{"value":1}' },
  ]);
});

test('OpenRouter normalizes text arrays while retaining raw call JSON, reasoning, and native arrays', async () => {
  const nativeMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Inspecting ' }, { type: 'text', text: 'now', cache_control: { type: 'ephemeral' } }],
    tool_calls: [{ ...routerCall, function: { name: 'read_bot_state', arguments: '{ }' } }],
    reasoning_details: routerNativeMessage.reasoning_details,
  };
  const h = harness('openrouter', [routerResponse(nativeMessage), routerResponse()]);
  const turn = JSON.parse(JSON.stringify(await h.run()));
  assert.equal(turn.content, 'Inspecting now');
  assert.deepEqual(turn.toolCalls, [canonicalCall]);
  assert.deepEqual(turn.providerState.items, [nativeMessage]);
  await h.run([assistant(turn), result]);
  assert.deepEqual(h.requests[1].body.messages, [nativeMessage, { role: 'tool', tool_call_id: 'call_1', content: '{"value":1}' }]);
  assert.deepEqual(projectOpenAiHistory([assistant(turn), result], openAiModel), canonicalOpenAi());
});

test('OpenRouter supports completed text-only arrays and nullable native reasoning fields', async () => {
  for (const [content, expected] of [[[], ''], [[{ type: 'text', text: 'Done' }], 'Done']]) {
    const nativeMessage = { role: 'assistant', content };
    const turn = await harness('openrouter', [routerResponse(nativeMessage)]).run();
    assert.equal(turn.content, expected);
    assert.deepEqual(turn.toolCalls, []);
    assert.deepEqual(turn.providerState.items, [nativeMessage]);
  }
  const nativeMessage = {
    role: 'assistant', content: [{ type: 'text', text: 'Inspecting now' }], tool_calls: [routerCall],
    reasoning: null, reasoning_content: null, reasoning_details: null,
  };
  const turn = await harness('openrouter', [routerResponse(nativeMessage)]).run();
  assert.equal(turn.content, 'Inspecting now');
  assert.deepEqual(turn.providerState.items, [nativeMessage]);
  assert.deepEqual(projectOpenRouterHistory([assistant(turn), result], routerModel), [
    nativeMessage, { role: 'tool', tool_call_id: 'call_1', content: '{"value":1}' },
  ]);
});

test('OpenRouter appends refusal text to canonical content while preserving native refusal replay', async () => {
  for (const content of [null, 'First. ']) {
    const message = { role: 'assistant', content, refusal: 'Cannot do that.' };
    const h = harness('openrouter', [routerResponse(message), routerResponse()]);
    const turn = JSON.parse(JSON.stringify(await h.run()));
    assert.equal(turn.content, `${content ?? ''}Cannot do that.`);
    assert.deepEqual(turn.providerState.items, [message]);
    await h.run([assistant(turn)]);
    assert.deepEqual(h.requests[1].body.messages, [message]);
  }
  await assert.rejects(harness('openrouter', [routerResponse({ role: 'assistant', content: null, refusal: {} })]).run(), /invalid refusal/);
});

test('OpenRouter preserves summary, encrypted, and signed text reasoning details without reordering', async () => {
  const details = [
    { type: 'reasoning.summary', summary: 'Inspect state first', id: 'summary_1', format: 'openai-responses-v1', index: 0 },
    { type: 'reasoning.encrypted', data: 'opaque-native-reasoning', id: null, format: 'anthropic-claude-v1', index: 1 },
    { type: 'reasoning.text', text: 'Inspect state', signature: 'signed', id: 'text_1', format: 'anthropic-claude-v1', index: 2 },
  ];
  const message = { role: 'assistant', content: null, tool_calls: [routerCall], reasoning_details: details };
  const h = harness('openrouter', [routerResponse(message), routerResponse()]);
  const turn = JSON.parse(JSON.stringify(await h.run()));
  assert.deepEqual(turn.providerState.items, [message]);
  await h.run([assistant(turn), result]);
  assert.deepEqual(h.requests[1].body.messages, [message, { role: 'tool', tool_call_id: 'call_1', content: '{"value":1}' }]);
});

test('OpenRouter rejects malformed reasoning detail entries and payload fields', async () => {
  for (const detail of [
    null, 1, 'reasoning', [], {}, { type: 1 },
    { type: 'reasoning.encrypted', data: {} }, { type: 'reasoning.encrypted', data: 1 },
    { type: 'reasoning.summary', summary: {} }, { type: 'reasoning.summary', summary: null },
    { type: 'reasoning.encrypted', data: null }, { type: 'reasoning.text', text: [] },
    { type: 'reasoning.text', text: true }, { type: 'reasoning.text', format: 42 },
    { type: 'reasoning.text', format: {} }, { type: 'reasoning.text', signature: false },
    { type: 'reasoning.text', text: 'Valid text', signature: {} },
  ]) {
    const message = { role: 'assistant', content: 'Done', reasoning_details: [detail] };
    await assert.rejects(harness('openrouter', [routerResponse(message)]).run(), /invalid reasoning|reasoning detail/i);
  }
});

test('OpenRouter sanitizes native state while retaining same-provider/model reasoning', async () => {
  const h = harness('openrouter', [routerResponse({ ...routerNativeMessage, api_key: privateKey }, {
    metadata: { api_key: privateKey }, id: 'response_secret', api_key: privateKey,
  })]);
  const turn = await h.run();
  assert.deepEqual(turn.providerState, { provider: `openrouter:${routerModel}`, items: [routerNativeMessage] });
  const serialized = JSON.stringify(turn);
  for (const value of [privateKey, 'api_key', 'response_secret']) assert.equal(serialized.includes(value), false);
  assert.deepEqual(projectOpenRouterHistory([assistant(turn), result], routerModel), [
    routerNativeMessage, { role: 'tool', tool_call_id: 'call_1', content: '{"value":1}' },
  ]);
});

test('OpenRouter incompatible provider/model and inconsistent native state fall back canonically', () => {
  const states = [
    { provider: `openai:${routerModel}`, items: [reasoning, functionCall] },
    { provider: 'openrouter:another-model', items: [routerNativeMessage] },
    ...[
      [], [{ type: 'unknown' }], [{ ...routerNativeMessage, content: 'Different native text' }],
      [{ ...routerNativeMessage, tool_calls: [{ ...routerCall, id: 'wrong_call' }] }],
      [{ ...routerNativeMessage, tool_calls: [{ ...routerCall, function: { name: 'wrong_tool', arguments: '{}' } }] }],
      [{ ...routerNativeMessage, tool_calls: [{ ...routerCall, function: { name: 'read_bot_state', arguments: '{"changed":true}' } }] }],
    ].map((items) => ({ provider: `openrouter:${routerModel}`, items })),
  ];
  for (const providerState of states) {
    const projected = projectOpenRouterHistory([{
      kind: 'assistant', content: 'Inspecting now', toolCalls: [canonicalCall], providerState,
    }, result], routerModel);
    assert.deepEqual(projected, canonicalRouter());
    assert.equal(JSON.stringify(projected).includes('opaque'), false);
  }
});

test('OpenRouter renames plain historical ID collisions in canonical and native calls only', async () => {
  const history = [
    assistant({ content: '', toolCalls: [canonicalCall] }), result,
    assistant({ content: '', toolCalls: [{ ...canonicalCall, id: 'call_1__vivi_1' }] }),
    { ...result, callId: 'call_1__vivi_1' },
  ];
  const original = structuredClone(history);
  const rawArguments = '{  "nested": { "enabled": true } }';
  const nativeMessage = {
    role: 'assistant', content: null,
    tool_calls: [{ ...routerCall, function: { name: 'read_bot_state', arguments: rawArguments } }],
  };
  const source = structuredClone(nativeMessage);
  const turn = await harness('openrouter', [routerResponse(nativeMessage)]).run(history);
  assert.deepEqual(turn.toolCalls, [{
    id: 'call_1__vivi_2', name: 'read_bot_state', arguments: { nested: { enabled: true } },
  }]);
  const projected = projectOpenRouterHistory([
    ...history, assistant(turn), { ...result, callId: 'call_1__vivi_2' },
  ], routerModel);
  assert.deepEqual(projected.slice(-2), [
    { ...nativeMessage, tool_calls: [{ ...nativeMessage.tool_calls[0], id: 'call_1__vivi_2' }] },
    { role: 'tool', tool_call_id: 'call_1__vivi_2', content: '{"value":1}' },
  ]);
  assert.deepEqual(history, original);
  assert.deepEqual(nativeMessage, source);
});

test('OpenRouter rejects historical ID collisions when native reasoning is present', async () => {
  for (const nativeReasoning of [
    { reasoning: 'Native reasoning' }, { reasoning_content: 'Native reasoning' },
    { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }] },
    { reasoning_details: [{ type: 'reasoning.text', text: 'Native reasoning', signature: 'signed' }] },
  ]) {
    const message = { role: 'assistant', content: null, tool_calls: [routerCall], ...nativeReasoning };
    await assert.rejects(harness('openrouter', [routerResponse(message)]).run([
      assistant({ content: '', toolCalls: [canonicalCall] }), result,
    ]), /tool call ID was reused from history/);
  }
});

test('OpenRouter rejects malformed supplied call arguments and malformed assistant messages', async () => {
  const callWithArguments = (argumentsValue) => ({
    ...routerCall, function: { name: 'read_bot_state', arguments: argumentsValue },
  });
  const badMessages = [
    null, { role: 'tool', content: 'Done' }, { content: {} },
    { content: [{ type: 'text', text: 1 }] }, { content: [{ type: 'text' }] }, { content: [null] },
    { content: [{ type: 'unknown', text: privateDetail }] }, { tool_calls: {} },
    { tool_calls: [{ ...routerCall, type: 'custom' }] }, { tool_calls: [{ ...routerCall, id: '' }] },
    { tool_calls: [{ ...routerCall, id: 'invalid id' }] }, { tool_calls: [routerCall, routerCall] },
    ...['', `{${privateDetail}`, null, {}, '[]', 'null', '"text"', '{"value":1e999}'].map((args) => ({ tool_calls: [callWithArguments(args)] })),
    { reasoning_details: privateDetail },
  ];
  for (const message of badMessages) {
    await assert.rejects(harness('openrouter', [routerResponse(message)]).run(), (error) => {
      assert.match(error.message, /Invalid OpenRouter/i);
      assert.equal(error.message.includes(privateDetail), false);
      return true;
    });
  }
});

test('OpenRouter rejects missing choices and responses that did not complete', async () => {
  const responses = [null, {}, { choices: [] }, { choices: [null] }, { choices: [{}] },
    { choices: [{ message: { role: 'assistant', content: 'Done' } }] },
    ...['length', 'content_filter', 'max_tokens', 'error', 'unknown'].map((finish_reason) =>
      routerResponse({ role: 'assistant', content: '' }, {}, { finish_reason })),
    routerResponse({ role: 'assistant', content: '' }, {}, { error: { message: privateDetail } }),
    routerResponse({ role: 'assistant', content: '' }, { error: { message: privateDetail } }),
  ];
  for (const response of responses) {
    await assert.rejects(harness('openrouter', [response]).run(), (error) => {
      assert.match(error.message, /Invalid OpenRouter|no agent message|not completed/i);
      assert.equal(error.message.includes(privateDetail), false);
      return true;
    });
  }
});

for (const [kind, project, model] of [
  ['OpenAI', projectOpenAiHistory, openAiModel], ['OpenRouter', projectOpenRouterHistory, routerModel],
]) {
  test(`${kind} projection rejects orphaned, mismatched, and duplicate tool results`, () => {
    assert.throws(() => project([result], model), /unmatched tool result/);
    const history = [assistant({ content: '', toolCalls: [canonicalCall] })];
    assert.throws(() => project([...history, { ...result, name: 'different' }], model), /unmatched tool result/);
    assert.throws(() => project([...history, result, result], model), /unmatched tool result/);
  });
}

// OpenRouter's maintained primary schema permits nullish text/signature/format:
// https://raw.githubusercontent.com/OpenRouterTeam/ai-sdk-provider/main/src/schemas/reasoning-details.ts
test('OpenRouter preserves nullable and omitted reasoning text and format through native tool replay', async () => {
  const variants = [
    { type: 'reasoning.text', text: null, signature: 'signed', format: 'google-gemini-v1', index: 0 },
    { type: 'reasoning.text', text: 'Thinking', signature: null, format: null, index: 0 },
    { type: 'reasoning.text', signature: 'signed', format: null, index: 0 },
    { type: 'reasoning.text', index: 0 },
  ];
  for (const detail of variants) {
    const message = { role: 'assistant', content: 'Done', tool_calls: [routerCall], reasoning_details: [detail] };
    const original = structuredClone(message);
    const h = harness('openrouter', [routerResponse(message), routerResponse()]);
    const turn = JSON.parse(JSON.stringify(await h.run()));
    assert.equal(turn.content, 'Done');
    assert.deepEqual(turn.providerState.items, [message]);
    await h.run([...seed, assistant(turn), result]);
    assert.deepEqual(h.requests[1].body.messages.slice(-2), [message, { role: 'tool', tool_call_id: 'call_1', content: '{"value":1}' }]);
    assert.deepEqual(message, original);
  }
});
