# vivi

A small, headless TypeScript tool-calling loop. `@ayayaq/vivi` provides messages, provider
adapters, agent turns, and optional trusted tools. Your host owns approvals, credentials,
storage, filesystem policy, and UI. Node.js 22+, ESM and CommonJS; no runtime dependencies.

## Install

The latest verified npm release is `0.2.1`:

```sh
npm install --save-exact @ayayaq/vivi@0.2.1
```

This checkout prepares stable `0.3.0`, adding trusted tool extensions and optional cache usage
counts. It is not published yet. Follow [RELEASING.md](RELEASING.md) before using `0.3.0` as a
registry dependency. Existing stable versions remain immutable.

## Small headless example

Run this against the prepared `0.3.0` package. It needs no terminal framework, app, provider key,
or network request:

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
