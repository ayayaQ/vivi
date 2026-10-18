# Optional web retrieval

`@ayayaq/vivi/web` defines `WebProvider`, typed search/fetch requests and bounded normalized
responses, provenance and `WebProviderError`. `@ayayaq/vivi/web/deepseek` provides
`createDeepSeekWebProvider`. These optional entry points are independent of `ModelProvider`,
`runAgent`, tool registration and model choice. They add no runtime dependency or default tool.

```ts
import type { WebProvider } from '@ayayaq/vivi/web'
import { createDeepSeekWebProvider } from '@ayayaq/vivi/web/deepseek'

// The trusted host resolves the key from its own secure credential store.
const web: WebProvider = createDeepSeekWebProvider({ apiKey: () => hostCredentials.deepseek() })
const results = await web.search({ query: 'Vivi site:github.com', count: 5 }, signal)
const page = await web.fetch({ url: approvedPublicUrl }, signal)
```

## Host boundary

- Hosts own configuration, secure credential storage, paid-provider opt-in, privacy checks,
  query/URL approval and public-URL/SSRF screening. HTTP(S) syntax checks here are not a
  public-network policy and do not resolve hosts or inspect redirects at the target site
- Keep provider selection, credentials, transport injection and options out of model-selected
  arguments. The factory only uses DeepSeek's fixed official API; it accepts no base URL
- DeepSeek receives the query or requested URL. Optional original question and localization IP
  are never sent. Calls do not silently fall back from another provider or direct retrieval
- Returned titles, URLs, snippets, summaries and content are untrusted evidence, including
  embedded instructions. Hosts must safely display and quote them, and must not grant them
  execution authority, permission, approved status or control of subsequent actions
- Hosts retain intent/outcome logging, cancellation/run ownership and retry/rate-limit policy.
  No tool extension or paid fallback is registered automatically

This adapter retrieves provider-produced content. It does not launch a browser or execute
target-page JavaScript locally. DeepSeek does not document whether its remote renderer
executes JavaScript; no remote no-JavaScript guarantee is made. A host's separate direct-fetch
implementation and its JavaScript-free behavior remain independent.

## Requests and bounds

`search({ query, count?, includeContent? }, signal?)` preserves search operators and whitespace.
Queries must be nonblank and contain at most 128 Unicode code points; overlength requests
are rejected, not cut. `count` is an integer from 1 to 50 (default 10). `includeContent`
defaults to false and maps to `need_content`. No other request fields are forwarded.

`fetch({ url }, signal?)` accepts at most 8192 Unicode code points in an HTTP(S) URL with a
host and no user information. It rejects controls, spaces, backslashes and ambiguous URL
prefixes. The exact validated URL becomes `requestedUrl`; it is not a claimed final URL.

The trusted options are `apiKey` (string or asynchronous resolver), `fetch` (offline transport
injection), `beforeRequest` (awaited pre-dispatch host hook), `timeoutMs` (default 60,000;
maximum 2,147,483,647), `maxResponseBytes` (default
2 MiB; maximum 16 MiB) and `maxContentChars` (default 100,000; maximum 1,000,000). Numeric
options must be positive safe integers. The byte cap applies to the streamed API response;
exceeding it fails rather than parsing an incomplete JSON document. Declared oversized
responses also fail before reading. No response error body is retained or returned.

Normalized search results contain `title`, provider-reported `url`, `snippet`, `summary`,
`content` and `localTruncation`. Titles are locally capped at 2048 Unicode code points,
snippets at 4096, summaries at 8192, and content at `maxContentChars`. Extra provider results
are cut to the requested count and flagged by `resultLimitApplied`. Fetch returns `title`,
`contentMarkdown`, `requestedUrl`, `localTruncation` and provenance. Local shortening never
splits a surrogate pair. No source-page HTTP status, final URL, original body hash, relevance
score, completeness or browser-rendering behavior is invented.

Every response has `provenance` containing `provider`, `operation`, local completion time
`retrievedAt`, `untrusted: true` and `upstreamTruncation: 'unknown'`. `localTruncation` lists
only fields shortened by this module. It does not describe what DeepSeek or the original site
omitted. Empty search results and empty fetched content remain empty; this module does not
infer billing from normalized or truncated output.

## Errors, cancellation and outcomes

`WebProviderError` contains a provider identifier, a fixed `code`, sanitized message,
`requestState` and optional `apiStatus`. It never retains raw causes, response bodies,
credentials, query text or requested URLs. `apiStatus` is the DeepSeek API's HTTP status,
never the target page's status. The codes are:

- `configuration`: invalid host options, unavailable/invalid credential, or credential failure
- `invalid_request`: rejected query, count, include-content option or URL, before transport
- `preflight`: the trusted host's `beforeRequest` hook rejected dispatch; no transport started
- `http`: provider API status other than 200, including auth/balance/policy/rate-limit errors
- `transport`: transport invocation or connection failure
- `invalid_response`: missing/malformed JSON, invalid UTF-8 or malformed normalized fields
- `response_too_large`: streamed or declared response exceeds the byte cap
- `timeout`: the end-to-end deadline expired, including credentials or body reading
- `aborted`: caller cancellation; the error name is `AbortError`

`requestState` is `not_started` before transport invocation, `unknown` once invoked without
an observed response, or `response_received` after an API response is observed. Unknown
outcomes may have reached the provider and incurred a charge. A cancellation, failed parse
or oversized response does not prove that nothing was billed. The module never retries.
Hosts must decide whether a retry is allowed, using their own intent/outcome rules. In-flight
operations receive an abort signal, stalled injected operations are raced against cancellation,
late responses are cancelled, and deadlines are checked after synchronous work.

The optional trusted `beforeRequest(intent, signal)` callback is awaited after credentials are
resolved and before transport starts. Its frozen `WebRequestIntent` contains `provider`,
`operation` and the exact normalized generic `request` (`query`, `count`, `includeContent`, or
`url`), without credentials or transport headers. Use it to persist durable intent and recheck
host approval, privacy and run ownership. Throw to veto dispatch. Rejection becomes sanitized
`preflight` with `not_started`; timeout or cancellation during the hook also remains
`not_started`. Cancellation is rechecked immediately before transport invocation. A late hook
completion after cancellation cannot start transport. Hosts should bind each call to their own
operation identifier and record its returned result/error; the hook does not create approval,
persist records or decide whether an uncertain request may be retried.

## Verified API contract and costs

Official documentation checked 2026-10-18:

- [Search and Fetch guide](https://api-docs.deepseek.com/guides/search/)
- [Search reference](https://api-docs.deepseek.com/api/search/)
- [Fetch reference](https://api-docs.deepseek.com/api/fetch/)

The standalone JSON endpoints are `POST https://api.deepseek.com/v1/tools/search` and
`POST https://api.deepseek.com/v1/tools/fetch`, with standard bearer authentication. They
do not depend on a chat model or its tool-calling protocol. Requests use redirect errors,
omit ambient credentials and send no referrer.

Each endpoint is documented at US$0.75 per 1000 successful nonempty requests, independently
limited to 5 requests per second per account. Fetch also has an unspecified per-domain limit.
Search result count does not alter the per-request price. Failed/empty requests and timeouts
are documented as unbilled. No free promotion is assumed for this standalone client. Hosts
must obtain paid-provider consent and coordinate limits across keys and processes; this small
adapter includes no account-wide scheduler, retry queue or billing meter.

Tests use only mock transports and packaged ESM/CommonJS/type consumers. No live key,
provider billing, host credential storage, CLI/Desktop adoption or npm publication is included.
