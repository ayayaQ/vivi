# vivi

A small, headless TypeScript tool-calling loop. `@ayayaq/vivi` provides messages, provider
adapters, agent turns, and optional trusted tools. Your host owns approvals, credentials,
storage, filesystem policy, and UI. Node.js 22+, ESM and CommonJS. Only the optional skills
module loads the maintained YAML parser dependency.

## Optional decision review

This addition is unreleased source; no npm version change is included in it.

`@ayayaq/vivi/decisions` provides frozen exact-action snapshots, `allow` / `ask` / `deny`
recommendations, and dedicated OpenAI Decisions / OpenRouter Jev adapters. It never grants
permissions or executes tools. Host rules, eligibility, privacy, manual review, and audit stay
with your application. See [DECISIONS.md](docs/DECISIONS.md) and the offline
[`examples/decisions.mjs`](examples/decisions.mjs) before adopting it.

## Install

The latest verified npm release is `0.5.0`:

```sh
npm install --save-exact @ayayaq/vivi@0.5.0
```

`0.5.0` includes trusted tool extensions, optional cache usage counts, the optional model
capability module, and optional shared memory. Registry bytes and clean ESM/CommonJS consumers
were verified; see
[RELEASING.md](RELEASING.md).

## Optional model capabilities

The optional `@ayayaq/vivi/providers/models` subpath is published in verified registry `0.4.0`
and absent from immutable `0.3.0`. Hosts can adopt it through separate reviewed changes that
preserve their documented capability coverage and selection behavior.

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

## Optional shared memory (published 0.5.0)

The optional `@ayayaq/vivi/extensions/memory` module extracts the desktop v1 bounded memory
service, codec, revisions, user-level context formatter and tool guidance. It is published in
verified `0.5.0` and absent from immutable `0.4.0`. Hosts supply atomic persistence/recovery
and mandatory tool-policy callbacks; approvals,
planning mode, operation admission/drain, app-wide store paths and multi-process locking remain
host-owned. See the [memory contract](docs/MEMORY.md) and [offline policy example](examples/memory.mjs).
No host integration or session-note migration is included.

## Optional instruction-only skills (0.6.0 release candidate)

The optional `@ayayaq/vivi/extensions/skills` module reads ordinary Agent Skills `SKILL.md`
files, advertises a compact per-turn catalog, and loads instructions/resources on demand.
It includes an original read-only skill creator and an optional SKILL.md-only save tool
behind exact-content host approval and revision-checked persistence. Hosts choose approved
sources, own their app-wide stores and apply existing permissions. No scripts/plugins execute,
no workspace is scanned, and no current turn hot-reloads. This module is not in published
`0.5.0`; `0.6.0` is prepared and not published. Desktop/CLI adoption follows verified publication. See the
[format and host contract](docs/SKILLS.md) and [offline example](examples/skills.mjs).

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
