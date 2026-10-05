# vivi

A small, headless TypeScript tool-calling loop. `@ayayaq/vivi` provides messages, provider
adapters, agent turns, and optional trusted tools. Your host owns approvals, credentials,
storage, filesystem policy, and UI. Node.js 22+, ESM and CommonJS; no runtime dependencies.

## Install

The latest verified npm release is `0.3.0`:

```sh
npm install --save-exact @ayayaq/vivi@0.3.0
```

`0.3.0` adds trusted tool extensions and optional cache usage counts. Its registry bytes and
clean ESM/CommonJS consumers were verified; see [RELEASING.md](RELEASING.md).

## Prepared 0.4.0: optional model capabilities

This checkout prepares stable `0.4.0`, which is not yet published. Its optional
`@ayayaq/vivi/providers/models` subpath is absent from registry `0.3.0`; host adoption waits for
the account holder to publish the reviewed archive and for registry-byte verification.

```js
import { normalizeModelCapabilities, reasoningSelectionSupport } from '@ayayaq/vivi/providers/models'

const capabilities = normalizeModelCapabilities({
  apiVersion: 1,
  provider: 'openai',
  protocol: 'responses',
  model: { id: 'gpt-5.1' }
})
console.log(capabilities.tools) // supported
console.log(reasoningSelectionSupport(capabilities, { mode: 'disabled' })) // supported
```

Normalization is pure and endpoint-aware. It preserves exact IDs and supported/unsupported/unknown
states, including separate reasoning, effort selection, explicit disable, and mandatory status.
Default means no override, independently of explicit disable. No models are fetched or selected,
and no request is changed. Hosts retain credentials, catalog fetching/cache, defaults, moderation,
and access policy. The [contract and provenance](CAPABILITIES.md) explains the bounded seed registry,
paired host evidence, and the release/adoption gate.

## Small headless example

This example needs no terminal framework, app, provider key, or network request:

```js
import { runAgent } from '@ayayaq/vivi'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import { calculatorExtension } from '@ayayaq/vivi/extensions/calculator'

const registry = createToolRegistry([calculatorExtension])
const result = await runAgent({
  provider: { async generate({ messages }) {
    const answer = messages.find(message => message.kind === 'tool_result')
    return answer
      ? { content: answer.content, toolCalls: [] }
      : { content: '', toolCalls: [
        { id: 'calc-1', name: 'calculate', arguments: { expression: '2*(3+4)' } }
      ] }
  } },
  messages: [{ kind: 'message', role: 'user', content: 'Calculate 2*(3+4)' }],
  tools: registry.tools,
  executeTool: registry.executeTool
})
console.log(result.status, result.content) // completed {"result":14}
```

Extension code runs in-process and is trusted. Registration is not a security sandbox; each
host enforces its own permissions and approvals. Real provider adapters are available through
`@ayayaq/vivi/providers/openai` and `@ayayaq/vivi/providers/openrouter`.

## Develop and learn more

```sh
npm ci
npm run check
```

Checks use fake providers and HTTP, build both module formats, and install packed consumers.
The package includes builds, declarations, source, examples, and documentation; installation
runs no build script.

- [API and host integration](docs/API.md): contracts, usage, providers, history, and extensions
- [Runnable headless example](examples/headless.mjs) and [inventory policy example](examples/inventory.mjs)
- [Changelog](CHANGELOG.md), [release status and workflow](RELEASING.md), [shared-use audit](REUSE_AUDIT.md)
- Apache-2.0: [LICENSE](LICENSE), [NOTICE](NOTICE), [origin and attribution](ATTRIBUTION.md)
