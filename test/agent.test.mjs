// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { runAgent } from '../dist/index.js';

const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn);
const user = (content = 'Hello') => ({ kind: 'message', role: 'user', content });
const call = (id = 'call-1', name = 'lookup', args = { query: 'hello' }) => ({ id, name, arguments: args });
const answer = (content = 'Done', toolCalls = [], extras = {}) => ({ content, toolCalls, ...extras });
const tool = (name = 'lookup') => ({
  name,
  description: `Run ${name}`,
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
});
const usage = (inputTokens, outputTokens, totalTokens = inputTokens + outputTokens) => ({ inputTokens, outputTokens, totalTokens });
const emptyUsage = usage(0, 0);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const never = () => new Promise(() => {});
const within = async (promise, milliseconds = 750) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation did not settle within ${milliseconds} ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const options = (extras = {}) => ({
  provider: { generate: async () => answer() },
  messages: [user()],
  tools: [tool()],
  executeTool: async () => ({ content: 'Found it' }),
  ...extras,
});
const assertError = (result, code) => {
  assert.equal(result.status, 'error');
  assert.equal(result.error?.code, code);
  assert.equal(typeof result.error?.message, 'string');
  assert.ok(result.error.message.length > 0);
};
const assertFailure = (message, code, id) => {
  assert.equal(message.kind, 'tool_result');
  assert.equal(message.isError, true);
  if (id !== undefined) assert.equal(message.callId, id);
  assert.equal(JSON.parse(message.content).error.code, code);
};
const assertFrozenTree = (value) => {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozenTree(child);
};

test('completes one text-only round and emits assistant before round completion', async () => {
  const events = [];
  let executeCount = 0;
  const result = await runAgent(options({
    provider: { generate: async () => answer('Hello back', [], { usage: usage(3, 4) }) },
    executeTool: async () => { executeCount++; return { content: 'unused' }; },
    onEvent: async (event) => { events.push(event); },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'Hello back');
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.usage, usage(3, 4));
  assert.deepEqual(result.history, [user(), { kind: 'assistant', content: 'Hello back', toolCalls: [] }]);
  assert.equal(executeCount, 0);
  assert.deepEqual(events.map((event) => event.type), ['assistant', 'round_completed']);
  assert.deepEqual(events[0].message, result.history[1]);
  assert.deepEqual(events[1].usage, usage(3, 4));
});

test('replays provider state and tool results, accumulates usage, and executes tools sequentially', async () => {
  const firstCall = call('a', 'lookup', { query: 'first' });
  const secondCall = call('b', 'lookup', { query: 'second' });
  const state = { provider: 'fake', items: [{ opaque: ['state', 1, true, null] }] };
  const queries = [];
  const order = [];
  let active = 0;
  const outputs = [
    answer('Looking', [firstCall, secondCall], { usage: usage(5, 2), providerState: state }),
    answer('Finished', [], { usage: usage(11, 3) }),
  ];
  const result = await runAgent(options({
    provider: {
      generate: async (query) => { queries.push(query); order.push(`generate:${queries.length}`); return outputs.shift(); },
    },
    executeTool: async (requested) => {
      active++;
      assert.equal(active, 1, 'tools must not overlap');
      order.push(`execute:${requested.id}`);
      await tick();
      active--;
      return { content: `result:${requested.id}` };
    },
    onEvent: async (event) => {
      const id = event.call?.id ?? event.message?.callId ?? '';
      order.push(`${event.type}${id ? `:${id}` : ''}`);
      await tick();
    },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'Finished');
  assert.equal(result.rounds, 2);
  assert.deepEqual(result.usage, usage(16, 5));
  assert.deepEqual(order, [
    'generate:1', 'assistant', 'tool_started:a', 'execute:a', 'tool_completed:a',
    'tool_started:b', 'execute:b', 'tool_completed:b', 'round_completed',
    'generate:2', 'assistant', 'round_completed',
  ]);
  assert.deepEqual(queries[1].messages, result.history.slice(0, -1));
  assert.deepEqual(queries[1].messages[1].providerState, state);
  assert.deepEqual(queries[0].messages, [user()], 'earlier snapshots stay unchanged');
  assert.deepEqual(queries[0].tools, [tool()]);
  assert.deepEqual(result.history.map((message) => message.kind), [
    'message', 'assistant', 'tool_result', 'tool_result', 'assistant',
  ]);
});

test('accepts a complete prior transcript and sends it intact to the provider', async () => {
  const messages = [
    { kind: 'message', role: 'system', content: 'Be helpful' },
    user('Earlier'),
    { kind: 'assistant', ...answer('Using a tool', [call('old')]), providerState: { provider: 'fake', items: ['old-state'] } },
    { kind: 'tool_result', callId: 'old', name: 'lookup', content: 'old result', isError: false },
    { kind: 'assistant', ...answer('Earlier answer') },
    user('Continue'),
  ];
  let received;
  const result = await runAgent(options({ messages, provider: { generate: async ({ messages: snapshot }) => { received = snapshot; return answer('Continued'); } } }));
  assert.equal(result.status, 'completed');
  assert.deepEqual(received, messages);
  assert.deepEqual(result.history.slice(0, -1), messages);
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.usage, emptyUsage);
});

test('does not dispatch unadvertised tools and provides a model-visible unavailable_tool result', async () => {
  let dispatched = 0;
  let requests = 0;
  const result = await runAgent(options({
    provider: { generate: async ({ messages }) => {
      requests++;
      if (requests === 1) return answer('', [call('unknown', 'not-advertised')]);
      assertFailure(messages.at(-1), 'unavailable_tool', 'unknown');
      return answer('Recovered');
    } },
    executeTool: async () => { dispatched++; return { content: 'must not run' }; },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(dispatched, 0);
  assert.equal(requests, 2);
  assertFailure(result.history[2], 'unavailable_tool', 'unknown');
  assert.equal(result.history[2].name, 'not-advertised');
});

test('converts host exceptions into tool_error and continues the remaining tools and next round', async () => {
  let rounds = 0;
  const executed = [];
  const result = await runAgent(options({
    provider: { generate: async ({ messages }) => {
      if (++rounds === 1) return answer('Work', [call('bad'), call('good')]);
      assertFailure(messages[2], 'tool_error', 'bad');
      assert.equal(messages[3].content, 'success');
      return answer('Recovered');
    } },
    executeTool: async (requested) => {
      executed.push(requested.id);
      if (requested.id === 'bad') throw new Error('host broke');
      return { content: 'success' };
    },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.rounds, 2);
  assert.deepEqual(executed, ['bad', 'good']);
  assertFailure(result.history[2], 'tool_error', 'bad');
});

test('preserves an explicitly returned tool error as a tool result', async () => {
  let rounds = 0;
  const result = await runAgent(options({
    provider: { generate: async () => ++rounds === 1 ? answer('', [call()]) : answer('Handled') },
    executeTool: async () => ({ content: 'No match', isError: true }),
  }));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.history[2], { kind: 'tool_result', callId: 'call-1', name: 'lookup', content: 'No match', isError: true });
});

test('turns malformed host results into tool_error instead of corrupting history', async () => {
  for (const returned of [undefined, null, false, {}, { content: 7 }, { content: 'x', isError: 'yes' }]) {
    let rounds = 0;
    const result = await runAgent(options({
      provider: { generate: async () => ++rounds === 1 ? answer('', [call()]) : answer('Recovered') },
      executeTool: async () => returned,
    }));
    assert.equal(result.status, 'completed');
    assertFailure(result.history[2], 'tool_error');
  }
});

test('reports provider failure before any accepted round without modifying history', async () => {
  const events = [];
  const result = await runAgent(options({
    provider: { generate: async () => { throw new Error('offline'); } },
    onEvent: (event) => { events.push(event); },
  }));
  assertError(result, 'provider_error');
  assert.deepEqual(result.history, [user()]);
  assert.equal(result.rounds, 0);
  assert.deepEqual(result.usage, emptyUsage);
  assert.deepEqual(events, []);
});

test('preserves accepted history and usage when a later provider round fails', async () => {
  let rounds = 0;
  const result = await runAgent(options({
    provider: { generate: async () => {
      if (++rounds === 1) return answer('Working', [call()], { usage: usage(6, 2) });
      throw new Error('later failure');
    } },
  }));
  assertError(result, 'provider_error');
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.usage, usage(6, 2));
  assert.deepEqual(result.history.map((message) => message.kind), ['message', 'assistant', 'tool_result']);
  assert.equal(result.history[2].content, 'Found it');
});

test('rejects malformed provider outputs atomically without dispatching tools or events', async () => {
  const cyclic = {}; cyclic.self = cyclic;
  const malformed = [
    undefined, null, false, '', {}, [],
    { content: 3, toolCalls: [] },
    { content: 'x' },
    { content: 'x', toolCalls: {} },
    answer('x', [null]),
    answer('x', [{ name: 'lookup', arguments: {} }]),
    answer('x', [call('', 'lookup')]),
    answer('x', [call('a', '')]),
    answer('x', [call('a', 'lookup', [])]),
    answer('x', [call('a', 'lookup', null)]),
    answer('x', [call('a', 'lookup', { illegal: undefined })]),
    answer('x', [call('a', 'lookup', { illegal: Number.NaN })]),
    answer('x', [call('a', 'lookup', { illegal: () => {} })]),
    answer('x', [call('a', 'lookup', { illegal: 1n })]),
    answer('x', [call('a', 'lookup', cyclic)]),
    answer('x', [call('a'), call('a')]),
    answer('x', [call('valid'), call('broken', 'lookup', { invalid: undefined })]),
    answer('x', [], { providerState: { provider: 'fake', items: [undefined] } }),
    answer('x', [], { providerState: { provider: 'fake', items: 'wrong' } }),
  ];
  for (const output of malformed) {
    let dispatches = 0;
    const events = [];
    const result = await runAgent(options({
      provider: { generate: async () => output },
      executeTool: async () => { dispatches++; return { content: 'unused' }; },
      onEvent: (event) => { events.push(event); },
    }));
    assertError(result, 'invalid_provider_output');
    assert.equal(result.rounds, 0);
    assert.deepEqual(result.history, [user()]);
    assert.deepEqual(result.usage, emptyUsage);
    assert.equal(dispatches, 0);
    assert.deepEqual(events, []);
  }
});

test('rejects a provider call ID already present in complete prior history', async () => {
  const messages = [user(), { kind: 'assistant', ...answer('', [call('reused')]) },
    { kind: 'tool_result', callId: 'reused', name: 'lookup', content: 'done' }, user('Again')];
  let dispatches = 0;
  const result = await runAgent(options({
    messages,
    provider: { generate: async () => answer('', [call('reused')]) },
    executeTool: async () => { dispatches++; return { content: 'unused' }; },
  }));
  assertError(result, 'invalid_provider_output');
  assert.equal(result.rounds, 0);
  assert.deepEqual(result.history, messages);
  assert.equal(dispatches, 0);
});

test('preserves earlier accepted rounds when a later provider response is malformed', async () => {
  let rounds = 0;
  const result = await runAgent(options({
    provider: { generate: async () => ++rounds === 1 ? answer('First', [call('a')], { usage: usage(2, 1) }) : answer('Bad', [call('b'), call('b')]) },
  }));
  assertError(result, 'invalid_provider_output');
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.usage, usage(2, 1));
  assert.equal(result.history.length, 3);
  assert.equal(result.history[1].content, 'First');
});

test('finishes a final answer at maxRounds and closes a tool round before max_rounds', async () => {
  const final = await runAgent(options({ maxRounds: 1 }));
  assert.equal(final.status, 'completed');
  assert.equal(final.rounds, 1);
  let generations = 0;
  const events = [];
  const limited = await runAgent(options({
    maxRounds: 1,
    provider: { generate: async () => { generations++; return answer('Still working', [call()]); } },
    onEvent: (event) => { events.push(event.type); },
  }));
  assertError(limited, 'max_rounds');
  assert.equal(generations, 1);
  assert.equal(limited.rounds, 1);
  assert.equal(limited.history[2].content, 'Found it');
  assert.deepEqual(events, ['assistant', 'tool_started', 'tool_completed', 'round_completed']);
});

test('uses a default limit of 25 accepted provider rounds', async () => {
  let generations = 0;
  const result = await runAgent(options({
    provider: { generate: async () => answer('', [call(`c-${++generations}`)]) },
  }));
  assertError(result, 'max_rounds');
  assert.equal(result.rounds, 25);
  assert.equal(generations, 25);
  assert.equal(result.history.length, 51);
});

test('deep-copies caller history and tools and freezes every callback snapshot', async () => {
  const messages = [user('Immutable')];
  const tools = [tool()];
  const originals = structuredClone({ messages, tools });
  let rounds = 0;
  let firstQuery;
  let frozenCall;
  const result = await runAgent(options({
    messages, tools,
    provider: { generate: async (query) => {
      assertFrozenTree(query.messages);
      assertFrozenTree(query.tools);
      assert.notEqual(query.messages, messages);
      assert.notEqual(query.tools, tools);
      assert.notEqual(query.messages[0], messages[0]);
      assert.notEqual(query.tools[0].parameters, tools[0].parameters);
      assert.throws(() => { query.messages[0].content = 'changed'; }, TypeError);
      assert.throws(() => { query.tools[0].parameters.properties.query.type = 'number'; }, TypeError);
      if (++rounds === 1) { firstQuery = query; return answer('', [call('immutable', 'lookup', { nested: { array: [1, { ok: true }] } })]); }
      return answer('Safe');
    } },
    executeTool: async (requested) => {
      frozenCall = requested;
      assertFrozenTree(requested);
      assert.throws(() => { requested.arguments.nested.array.push(2); }, TypeError);
      return { content: 'safe' };
    },
    onEvent: async (event) => {
      assertFrozenTree(event);
      if (event.message) assert.throws(() => { event.message.content = 'changed'; }, TypeError);
      if (event.call) assert.throws(() => { event.call.name = 'changed'; }, TypeError);
    },
  }));
  assert.equal(result.status, 'completed');
  assert.deepEqual({ messages, tools }, originals);
  assert.equal(Object.isFrozen(messages), false);
  assert.equal(Object.isFrozen(tools), false);
  assert.deepEqual(firstQuery.messages, originals.messages);
  assert.equal(frozenCall.name, 'lookup');
});

test('snapshots inputs before pending work so later caller mutations cannot change the run', async () => {
  const entered = deferred();
  const release = deferred();
  const messages = [user('Original')];
  const tools = [tool()];
  let query;
  const pending = runAgent(options({
    messages, tools,
    provider: { generate: async (received) => { query = received; entered.resolve(); await release.promise; return answer('Done'); } },
  }));
  await entered.promise;
  messages[0].content = 'External mutation';
  messages.push(user('Added'));
  tools[0].parameters.properties.query.type = 'number';
  tools.length = 0;
  release.resolve();
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.deepEqual(query.messages, [user('Original')]);
  assert.deepEqual(query.tools, [tool()]);
  assert.deepEqual(result.history[0], user('Original'));
});

test('does not retain mutable aliases from provider outputs', async () => {
  const output = answer('Done', [], { providerState: { provider: 'fake', items: [{ value: [1] }] } });
  const result = await runAgent(options({ provider: { generate: async () => output } }));
  output.content = 'Changed';
  output.providerState.items[0].value.push(2);
  assert.equal(result.content, 'Done');
  assert.equal(result.history[1].content, 'Done');
  assert.deepEqual(result.history[1].providerState.items, [{ value: [1] }]);
});

test('returns cancelled for an already-aborted signal without calling any callback', async () => {
  const controller = new AbortController();
  controller.abort();
  let touched = 0;
  const result = await runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => { touched++; return answer(); } },
    executeTool: async () => { touched++; return { content: 'unused' }; },
    onEvent: () => { touched++; },
  }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.rounds, 0);
  assert.deepEqual(result.history, [user()]);
  assert.equal(touched, 0);
});

test('cancels promptly while a provider hangs and safely absorbs its late rejection', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const late = deferred();
  let providerSignal;
  const events = [];
  const pending = runAgent(options({
    signal: controller.signal,
    provider: { generate: async (_, signal) => { providerSignal = signal; entered.resolve(); return late.promise; } },
    onEvent: (event) => { events.push(event); },
  }));
  await entered.promise;
  controller.abort();
  const result = await within(pending);
  assert.equal(result.status, 'cancelled');
  assert.equal(providerSignal.aborted, true);
  assert.deepEqual(result.history, [user()]);
  assert.equal(result.rounds, 0);
  late.reject(new Error('late provider rejection'));
  await tick();
  assert.deepEqual(events, []);
});

test('ignores a late provider success after cancellation', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const late = deferred();
  let dispatches = 0;
  const events = [];
  const pending = runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => { entered.resolve(); return late.promise; } },
    executeTool: async () => { dispatches++; return { content: 'unused' }; },
    onEvent: (event) => { events.push(event); },
  }));
  await entered.promise;
  controller.abort();
  const result = await within(pending);
  late.resolve(answer('Too late', [call()]));
  await tick();
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.history, [user()]);
  assert.equal(dispatches, 0);
  assert.deepEqual(events, []);
});

test('abort takes precedence over a provider result before it can be committed', async () => {
  const controller = new AbortController();
  const events = [];
  const result = await runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => { controller.abort(); return answer('Too late', [call()]); } },
    onEvent: (event) => { events.push(event); },
  }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.rounds, 0);
  assert.deepEqual(result.history, [user()]);
  assert.deepEqual(events, []);
});

test('cancels pending host approval promptly and closes every accepted call without new events', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const late = deferred();
  const dispatches = [];
  const events = [];
  let hostSignal;
  const pending = runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => answer('Working', [call('a'), call('b'), call('c')]) },
    executeTool: async (requested, { signal }) => { dispatches.push(requested.id); hostSignal = signal; entered.resolve(); return late.promise; },
    onEvent: (event) => { events.push(event.type); },
  }));
  await entered.promise;
  controller.abort();
  const result = await within(pending);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.rounds, 1);
  assert.equal(hostSignal.aborted, true);
  assert.deepEqual(dispatches, ['a']);
  assert.deepEqual(events, ['assistant', 'tool_started']);
  assert.equal(result.history[1].kind, 'assistant');
  assert.equal(result.history.length, 5);
  for (const [index, id] of ['a', 'b', 'c'].entries()) assertFailure(result.history[index + 2], 'cancelled', id);
  late.reject(new Error('late host rejection'));
  await tick();
  assert.deepEqual(dispatches, ['a']);
  assert.deepEqual(events, ['assistant', 'tool_started']);
});

test('preserves completed calls and cancels only the remaining accepted calls', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const dispatches = [];
  const pending = runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => answer('', [call('a'), call('b'), call('c')]) },
    executeTool: async (requested) => {
      dispatches.push(requested.id);
      if (requested.id === 'a') return { content: 'A succeeded' };
      entered.resolve();
      return never();
    },
  }));
  await entered.promise;
  controller.abort();
  const result = await within(pending);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.history[2].content, 'A succeeded');
  assertFailure(result.history[3], 'cancelled', 'b');
  assertFailure(result.history[4], 'cancelled', 'c');
  assert.deepEqual(dispatches, ['a', 'b']);
});

test('abort takes precedence over a host result before it can be committed', async () => {
  const controller = new AbortController();
  const events = [];
  const result = await runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => answer('', [call('a'), call('b')]) },
    executeTool: async () => { controller.abort(); return { content: 'too late' }; },
    onEvent: (event) => { events.push(event.type); },
  }));
  assert.equal(result.status, 'cancelled');
  assertFailure(result.history[2], 'cancelled', 'a');
  assertFailure(result.history[3], 'cancelled', 'b');
  assert.deepEqual(events, ['assistant', 'tool_started']);
});

test('cancels promptly while the assistant event hook hangs, with the accepted assistant preserved', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const late = deferred();
  let dispatches = 0;
  const events = [];
  const pending = runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => answer('Accepted', [call('a'), call('b')], { usage: usage(4, 2) }) },
    executeTool: async () => { dispatches++; return { content: 'unused' }; },
    onEvent: async (event) => { events.push(event.type); entered.resolve(); return late.promise; },
  }));
  await entered.promise;
  controller.abort();
  const result = await within(pending);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.history[1].content, 'Accepted');
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.usage, usage(4, 2));
  assertFailure(result.history[2], 'cancelled', 'a');
  assertFailure(result.history[3], 'cancelled', 'b');
  assert.equal(dispatches, 0);
  assert.deepEqual(events, ['assistant']);
  late.reject(new Error('late event rejection'));
  await tick();
  assert.deepEqual(events, ['assistant']);
});

test('cancels while tool_started hook hangs without starting the host', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const events = [];
  let dispatches = 0;
  const pending = runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => answer('', [call()]) },
    executeTool: async () => { dispatches++; return { content: 'unused' }; },
    onEvent: async (event) => {
      events.push(event.type);
      if (event.type === 'tool_started') { entered.resolve(); return never(); }
    },
  }));
  await entered.promise;
  controller.abort();
  const result = await within(pending);
  assert.equal(result.status, 'cancelled');
  assertFailure(result.history[2], 'cancelled');
  assert.equal(dispatches, 0);
  assert.deepEqual(events, ['assistant', 'tool_started']);
});

test('cancels while tool_completed hook hangs, retaining the committed tool result', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const events = [];
  const dispatches = [];
  const pending = runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => answer('', [call('a'), call('b')]) },
    executeTool: async (requested) => { dispatches.push(requested.id); return { content: 'A succeeded' }; },
    onEvent: async (event) => {
      events.push(event.type);
      if (event.type === 'tool_completed') { entered.resolve(); return never(); }
    },
  }));
  await entered.promise;
  controller.abort();
  const result = await within(pending);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.history[2].content, 'A succeeded');
  assertFailure(result.history[3], 'cancelled', 'b');
  assert.deepEqual(dispatches, ['a']);
  assert.deepEqual(events, ['assistant', 'tool_started', 'tool_completed']);
});

test('cancels while a final round_completed hook hangs and does not falsely report completion', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const events = [];
  const pending = runAgent(options({
    signal: controller.signal,
    onEvent: async (event) => {
      events.push(event.type);
      if (event.type === 'round_completed') { entered.resolve(); return never(); }
    },
  }));
  await entered.promise;
  controller.abort();
  const result = await within(pending);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.rounds, 1);
  assert.equal(result.history[1].content, 'Done');
  assert.deepEqual(events, ['assistant', 'round_completed']);
});

test('event hook failure closes all pending accepted calls with run_failed and invokes no more hooks', async () => {
  const events = [];
  let dispatches = 0;
  const result = await runAgent(options({
    provider: { generate: async () => answer('Accepted', [call('a'), call('b')], { usage: usage(2, 2) }) },
    executeTool: async () => { dispatches++; return { content: 'unused' }; },
    onEvent: async (event) => { events.push(event.type); throw new Error('hook failed'); },
  }));
  assertError(result, 'event_error');
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.usage, usage(2, 2));
  assert.equal(result.history[1].content, 'Accepted');
  assertFailure(result.history[2], 'run_failed', 'a');
  assertFailure(result.history[3], 'run_failed', 'b');
  assert.equal(dispatches, 0);
  assert.deepEqual(events, ['assistant']);
});

test('tool_started hook failure prevents dispatch and closes the pending call', async () => {
  const events = [];
  let dispatches = 0;
  const result = await runAgent(options({
    provider: { generate: async () => answer('', [call()]) },
    executeTool: async () => { dispatches++; return { content: 'unused' }; },
    onEvent: async (event) => { events.push(event.type); if (event.type === 'tool_started') throw 'hook failed'; },
  }));
  assertError(result, 'event_error');
  assertFailure(result.history[2], 'run_failed');
  assert.equal(dispatches, 0);
  assert.deepEqual(events, ['assistant', 'tool_started']);
});

test('tool_completed hook failure keeps completed results and closes only remaining calls', async () => {
  const events = [];
  const dispatches = [];
  const result = await runAgent(options({
    provider: { generate: async () => answer('', [call('a'), call('b')]) },
    executeTool: async (requested) => { dispatches.push(requested.id); return { content: 'A succeeded' }; },
    onEvent: async (event) => { events.push(event.type); if (event.type === 'tool_completed') throw new Error('hook failed'); },
  }));
  assertError(result, 'event_error');
  assert.equal(result.history[2].content, 'A succeeded');
  assertFailure(result.history[3], 'run_failed', 'b');
  assert.deepEqual(dispatches, ['a']);
  assert.deepEqual(events, ['assistant', 'tool_started', 'tool_completed']);
});

test('round_completed hook failure preserves a complete accepted round and prevents another provider call', async () => {
  let generations = 0;
  const events = [];
  const result = await runAgent(options({
    provider: { generate: async () => { generations++; return answer('', [call()]); } },
    onEvent: async (event) => { events.push(event.type); if (event.type === 'round_completed') throw new Error('hook failed'); },
  }));
  assertError(result, 'event_error');
  assert.equal(result.history[2].content, 'Found it');
  assert.equal(generations, 1);
  assert.deepEqual(events, ['assistant', 'tool_started', 'tool_completed', 'round_completed']);
});

test('abort during a hook takes precedence over its rejection and prevents later events', async () => {
  const controller = new AbortController();
  const events = [];
  const result = await runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => answer('', [call()]) },
    onEvent: async (event) => { events.push(event.type); controller.abort(); throw new Error('too late'); },
  }));
  assert.equal(result.status, 'cancelled');
  assertFailure(result.history[2], 'cancelled');
  assert.deepEqual(events, ['assistant']);
});

test('validates malformed run arguments before calling external code', async () => {
  let touched = 0;
  const valid = options({
    provider: { generate: async () => { touched++; return answer(); } },
    executeTool: async () => { touched++; return { content: 'unused' }; },
    onEvent: () => { touched++; },
  });
  const invalid = [
    undefined, null, false, {},
    { ...valid, provider: null },
    { ...valid, provider: {} },
    { ...valid, provider: { generate: 'wrong' } },
    { ...valid, messages: null },
    { ...valid, messages: {} },
    { ...valid, messages: [null] },
    { ...valid, messages: [{ kind: 'message', role: 'assistant', content: 'wrong variant' }] },
    { ...valid, messages: [{ kind: 'message', role: 'user', content: false }] },
    { ...valid, messages: [{ kind: 'unknown', content: 'wrong' }] },
    { ...valid, tools: null },
    { ...valid, tools: {} },
    { ...valid, tools: [null] },
    { ...valid, tools: [{ name: '', description: 'x', parameters: {} }] },
    { ...valid, tools: [{ name: 'lookup', description: 1, parameters: {} }] },
    { ...valid, tools: [{ name: 'lookup', description: 'x', parameters: [] }] },
    { ...valid, tools: [{ name: 'lookup', description: 'x', parameters: { bad: undefined } }] },
    { ...valid, tools: [tool(), tool()] },
    { ...valid, executeTool: null },
    { ...valid, executeTool: 'wrong' },
    { ...valid, onEvent: 'wrong' },
    ...[0, -1, 1.5, NaN, Infinity, 1001, '2'].map((maxRounds) => ({ ...valid, maxRounds })),
  ];
  for (const args of invalid) {
    const result = await runAgent(args);
    assertError(result, 'invalid_input');
    assert.equal(result.rounds, 0);
  }
  assert.equal(touched, 0);
});

test('rejects incomplete, inconsistent, and duplicate-ID prior transcripts', async () => {
  let generations = 0;
  const assistant = (calls) => ({ kind: 'assistant', ...answer('', calls) });
  const toolResult = (id = 'a', name = 'lookup') => ({ kind: 'tool_result', callId: id, name, content: 'done' });
  const invalid = [
    [user(), assistant([call('a')])],
    [user(), toolResult()],
    [user(), assistant([call('a')]), user('Orphaned')],
    [user(), assistant([call('a'), call('b')]), toolResult('a')],
    [user(), assistant([call('a')]), toolResult('wrong-id')],
    [user(), assistant([call('a')]), toolResult('a', 'wrong-name')],
    [user(), assistant([call('a')]), toolResult('a'), toolResult('a')],
    [user(), assistant([call('a'), call('a')]), toolResult('a')],
    [user(), assistant([call('a')]), toolResult('a'), assistant([call('a')]), toolResult('a')],
    [user(), { kind: 'assistant', content: 'x', toolCalls: 'wrong' }],
    [user(), { kind: 'assistant', content: 'x', toolCalls: [], providerState: { provider: 'fake', items: [() => {}] } }],
    [user(), assistant([call('a', 'lookup', { bad: undefined })]), toolResult('a')],
  ];
  for (const messages of invalid) {
    const result = await runAgent(options({
      messages,
      provider: { generate: async () => { generations++; return answer(); } },
    }));
    assertError(result, 'invalid_input');
    assert.equal(result.rounds, 0);
  }
  assert.equal(generations, 0);
});

test('keeps provider-reported totalTokens independent from input/output sums', async () => {
  let generations = 0;
  const result = await runAgent(options({
    provider: { generate: async () => ++generations === 1
      ? answer('', [call()], { usage: usage(4, 3, 99) })
      : answer('Done', [], { usage: usage(2, 1, 8) }) },
  }));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.usage, usage(6, 4, 107));
});

test('rejects malformed provider usage before accepting its turn', async () => {
  const malformed = [
    null, false, {},
    { inputTokens: 1, outputTokens: 1 },
    { inputTokens: -1, outputTokens: 1, totalTokens: 0 },
    { inputTokens: 1, outputTokens: 0.5, totalTokens: 1 },
    { inputTokens: 1, outputTokens: 1, totalTokens: Infinity },
    { inputTokens: NaN, outputTokens: 1, totalTokens: 1 },
    { inputTokens: '1', outputTokens: 1, totalTokens: 2 },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0, totalTokens: 0 },
  ];
  for (const reported of malformed) {
    let dispatches = 0;
    const events = [];
    const result = await runAgent(options({
      provider: { generate: async () => answer('', [call()], { usage: reported }) },
      executeTool: async () => { dispatches++; return { content: 'unused' }; },
      onEvent: (event) => { events.push(event); },
    }));
    assertError(result, 'invalid_provider_output');
    assert.equal(result.rounds, 0);
    assert.deepEqual(result.history, [user()]);
    assert.deepEqual(result.usage, emptyUsage);
    assert.equal(dispatches, 0);
    assert.deepEqual(events, []);
  }
});

test('rejects aggregate usage overflow without accepting or dispatching the overflowing round', async () => {
  let generations = 0;
  const dispatched = [];
  const result = await runAgent(options({
    provider: { generate: async () => ++generations === 1
      ? answer('Accepted', [call('a')], { usage: usage(Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER) })
      : answer('Overflow', [call('b')], { usage: usage(1, 0, 1) }) },
    executeTool: async (requested) => { dispatched.push(requested.id); return { content: 'done' }; },
  }));
  assertError(result, 'invalid_provider_output');
  assert.equal(result.rounds, 1);
  assert.equal(result.history.length, 3);
  assert.deepEqual(result.usage, usage(Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER));
  assert.deepEqual(dispatched, ['a']);
});

test('rejects getters, sparse arrays, symbols, nonplain objects and undefined optional JSON fields', async () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'bad', { enumerable: true, get() { reads++; return 'unsafe'; } });
  const hidden = Object.defineProperty({}, 'bad', { enumerable: false, value: 1 });
  const symbolic = { [Symbol('bad')]: 1 };
  const extraArrayProperty = [];
  extraArrayProperty.extra = true;
  const invalidOutputs = [
    answer('', [call('a', 'lookup', accessor)]),
    answer('', [call('a', 'lookup', hidden)]),
    answer('', [call('a', 'lookup', symbolic)]),
    answer('', [call('a', 'lookup', { bad: new Date() })]),
    answer('', [call('a', 'lookup', { bad: new Map() })]),
    answer('', [call('a', 'lookup', { bad: new Set() })]),
    answer('', [call('a', 'lookup', { bad: [1, , 3] })]),
    answer('', [call('a', 'lookup', { bad: extraArrayProperty })]),
    answer('', [], { usage: undefined }),
    answer('', [], { providerState: undefined }),
    answer('', [], { providerState: { provider: '', items: [] } }),
    answer('', [], { providerState: { provider: ' fake ', items: [] } }),
  ];
  for (const output of invalidOutputs) {
    const result = await runAgent(options({ provider: { generate: async () => output } }));
    assertError(result, 'invalid_provider_output');
    assert.deepEqual(result.history, [user()]);
    assert.equal(result.rounds, 0);
  }
  assert.equal(reads, 0, 'validation must not invoke accessors');
});

test('rejects out-of-order prior tool results even when the call IDs are all present', async () => {
  let generations = 0;
  const result = await runAgent(options({
    messages: [user(), { kind: 'assistant', ...answer('', [call('a'), call('b')]) },
      { kind: 'tool_result', callId: 'b', name: 'lookup', content: 'B' },
      { kind: 'tool_result', callId: 'a', name: 'lookup', content: 'A' }],
    provider: { generate: async () => { generations++; return answer(); } },
  }));
  assertError(result, 'invalid_input');
  assert.equal(generations, 0);
});

test('accepts empty messages and tools with a legal upper maxRounds boundary', async () => {
  let requests = 0;
  const result = await runAgent(options({
    messages: [], tools: [], maxRounds: 1000,
    provider: { generate: async (query) => {
      requests++;
      assert.deepEqual(query, { messages: [], tools: [] });
      return answer('Ready');
    } },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(requests, 1);
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.history, [{ kind: 'assistant', ...answer('Ready') }]);
});

test('prototype property names do not grant unadvertised tool access', async () => {
  let generations = 0;
  let dispatches = 0;
  const result = await runAgent(options({
    tools: [],
    provider: { generate: async () => ++generations === 1
      ? answer('', [call('a', 'toString'), call('b', '__proto__'), call('c', 'constructor')])
      : answer('Handled') },
    executeTool: async () => { dispatches++; return { content: 'unused' }; },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(dispatches, 0);
  for (const [index, id] of ['a', 'b', 'c'].entries()) assertFailure(result.history[index + 2], 'unavailable_tool', id);
});

test('rejects malformed optional non-JSON arguments before work starts', async () => {
  let generations = 0;
  const base = options({ provider: { generate: async () => { generations++; return answer(); } } });
  for (const args of [
    { ...base, signal: null },
    { ...base, signal: {} },
    { ...base, onEvent: null },
    { ...base, maxRounds: null },
  ]) {
    assertError(await runAgent(args), 'invalid_input');
  }
  assert.equal(generations, 0);
});

test('validates JSON in prior history and tool definitions without invoking accessors', async () => {
  let accessorReads = 0;
  let generations = 0;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { accessorReads++; return 1; } });
  const cycle = {}; cycle.self = cycle;
  const invalid = [
    { messages: [user(), { kind: 'assistant', ...answer(), providerState: undefined }] },
    { messages: [user(), { kind: 'assistant', ...answer('', [call('a')]) },
      { kind: 'tool_result', callId: 'a', name: 'lookup', content: 'done', isError: undefined }] },
    { messages: [user(), { kind: 'assistant', ...answer(), providerState: { provider: 'fake', items: [accessor] } }] },
    { messages: [user(), { kind: 'assistant', ...answer('', [call('a', 'lookup', cycle)]) }] },
    { tools: [{ ...tool(), parameters: accessor }] },
    { tools: [{ ...tool(), parameters: { nested: cycle } }] },
    { tools: [{ ...tool(), parameters: { nested: new Date() } }] },
    { tools: [{ ...tool(), parameters: { nested: [1, , 3] } }] },
  ];
  for (const extra of invalid) {
    const result = await runAgent(options({
      ...extra,
      provider: { generate: async () => { generations++; return answer(); } },
    }));
    assertError(result, 'invalid_input');
    assert.equal(result.rounds, 0);
  }
  assert.equal(accessorReads, 0);
  assert.equal(generations, 0);
});

test('requires trimmed nonempty tool-call IDs and names before any dispatch', async () => {
  let dispatches = 0;
  for (const requested of [call(' '), call(' id '), call('a', ' '), call('a', ' lookup ')]) {
    const result = await runAgent(options({
      provider: { generate: async () => answer('', [requested]) },
      executeTool: async () => { dispatches++; return { content: 'unused' }; },
    }));
    assertError(result, 'invalid_provider_output');
    assert.equal(result.rounds, 0);
    assert.deepEqual(result.history, [user()]);
  }
  assert.equal(dispatches, 0);
});

test('synchronous provider exceptions and non-Error rejections yield provider_error', async () => {
  for (const generate of [
    () => { throw new Error('sync provider failure'); },
    () => Promise.reject('provider unavailable'),
    () => Promise.reject(null),
  ]) {
    const result = await runAgent(options({ provider: { generate } }));
    assertError(result, 'provider_error');
    assert.deepEqual(result.history, [user()]);
    assert.equal(result.rounds, 0);
  }
});

test('synchronous host exceptions become tool_error and do not stop later tools', async () => {
  let generations = 0;
  const dispatches = [];
  const result = await runAgent(options({
    provider: { generate: async () => ++generations === 1 ? answer('', [call('a'), call('b')]) : answer('Done') },
    executeTool: (requested) => {
      dispatches.push(requested.id);
      if (requested.id === 'a') throw 'sync host failure';
      return Promise.resolve({ content: 'success' });
    },
  }));
  assert.equal(result.status, 'completed');
  assertFailure(result.history[2], 'tool_error', 'a');
  assert.equal(result.history[3].content, 'success');
  assert.deepEqual(dispatches, ['a', 'b']);
});

test('late host success cannot change the returned cancellation transcript', async () => {
  const controller = new AbortController();
  const entered = deferred();
  const late = deferred();
  const events = [];
  const pending = runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => answer('', [call()]) },
    executeTool: async () => { entered.resolve(); return late.promise; },
    onEvent: (event) => { events.push(event.type); },
  }));
  await entered.promise;
  controller.abort();
  const result = await within(pending);
  const returnedHistory = structuredClone(result.history);
  late.resolve({ content: 'too late' });
  await tick();
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.history, returnedHistory);
  assertFailure(result.history[2], 'cancelled');
  assert.deepEqual(events, ['assistant', 'tool_started']);
});

test('abort while provider rejects still returns cancellation', async () => {
  const controller = new AbortController();
  const result = await runAgent(options({
    signal: controller.signal,
    provider: { generate: async () => { controller.abort(); throw new Error('aborted provider failure'); } },
  }));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.rounds, 0);
  assert.deepEqual(result.history, [user()]);
});

function unprintableErrors() {
  const messageAccessor = Object.defineProperty(new Error(), 'message', {
    get() { throw new Error('message accessor failed'); },
  });
  return [
    Object.create(null),
    { toString() { throw new Error('toString failed'); } },
    { [Symbol.toPrimitive]() { throw new Error('primitive conversion failed'); } },
    messageAccessor,
  ];
}

test('unprintable provider failures retain provider_error without rejecting runAgent', async () => {
  for (const thrown of unprintableErrors()) {
    const result = await runAgent(options({
      provider: { async generate() { throw thrown; } },
    }));
    assertError(result, 'provider_error');
    assert.equal(result.error.message, 'Unprintable thrown value');
    assert.deepEqual(result.history, [user()]);
    assert.equal(result.rounds, 0);
  }
});

test('unprintable host failures remain tool_error and allow later tools and rounds', async () => {
  for (const thrown of unprintableErrors()) {
    let generations = 0;
    const dispatches = [];
    const result = await runAgent(options({
      provider: { generate: async () => ++generations === 1
        ? answer('', [call('a'), call('b')]) : answer('Done') },
      async executeTool(requested) {
        dispatches.push(requested.id);
        if (requested.id === 'a') throw thrown;
        return { content: 'success' };
      },
    }));
    assert.equal(result.status, 'completed');
    assertFailure(result.history[2], 'tool_error', 'a');
    assert.equal(JSON.parse(result.history[2].content).error.message, 'Unprintable thrown value');
    assert.equal(result.history[3].content, 'success');
    assert.deepEqual(dispatches, ['a', 'b']);
    assert.equal(generations, 2);
  }
});

test('unprintable hook failures retain event_error and close pending calls consistently', async () => {
  for (const thrown of unprintableErrors()) {
    let dispatches = 0;
    let events = 0;
    const result = await runAgent(options({
      provider: { generate: async () => answer('', [call('a'), call('b')]) },
      async executeTool() { dispatches++; return { content: 'unused' }; },
      onEvent() { events++; throw thrown; },
    }));
    assertError(result, 'event_error');
    assert.equal(result.error.message, 'Unprintable thrown value');
    assert.equal(dispatches, 0);
    assert.equal(events, 1);
    assertFailure(result.history[2], 'run_failed', 'a');
    assertFailure(result.history[3], 'run_failed', 'b');
  }
});
