# Release workflow

## Prepared stable 0.11.0, not yet published

This additive release includes CORE-13's optional `/presentation` contract: bounded
host-prepared tool display snapshots, safe text fallback, and explicit status/effect,
provenance and warnings outside collapsed/truncated details. It imports no runtime
modules or host UI and grants no approval/execution authority. See
[TOOL_PRESENTATION.md](docs/TOOL_PRESENTATION.md) and [PR #30](https://github.com/ayayaQ/vivi/pull/30).
The foundation merged at `4684a3cc6b87f89846e6879855b91285d00a1b23`, tree
`1acbe3405d3bf468952c5e58733ac78b69d7c97d`: full Node22/24 checks each passed 635 tests,
all examples and installed ESM/CommonJS/NodeNext consumers across 13 public subpaths;
independent review and exact-head/post-main Linux/Windows22/24 CI passed.

Public npm latest remains verified `0.10.0`. The final `0.11.0` metadata/docs and
archive require their own exact-tree/archive review and CI. Publish only the exact
separately recorded reviewed archive, not a repacked working directory. The user
performs npm authentication/security challenges and publication; no credentials
are shared. After publication, verify public tags, exact archive/installed bytes and
Node22/24 consumers before independent CLI-21/Desktop-15 adapter changes.
Runtime dependencies and all earlier registry archives remain unchanged.

## Published stable 0.10.0

`@ayayaq/vivi@0.10.0` is published and registry-verified, with latest observed at `0.10.0`.
Publication time: `2026-10-10T17:54:04.509Z`. It batches reviewed owned scopes and bounded
session/run records. Public archive bytes and all 334 installed files match the reviewed
archive; installed Node22/24 ESM/CommonJS/NodeNext consumers passed.

- Source: `a7d49edc5f784a915cd90258cc7e49a23464d3fe`, tree `5f87edbccb53f3c5694a07958b98ff96ef6fdc8a`
- Archive: `ayayaq-vivi-0.10.0.tgz`, 297166 bytes, 334 files
- SHA-256: `cc5c6e89a0e54cd7685cecbf712119049132bb972d684889e019a2aa1c9ea366`
- SHA-1: `28a5012e97fc389a81c748f8e95e56c41c7ce126`
- Integrity: `sha512-oK3NY4hpzlOIuW7/YkIonTVaFjVzEAkjEtYV24KjE6Ei48e5vJ9bx7kLtKTrHOeK0/+XgwQRLUsh87kn2v7epQ==`

Earlier prepared text remains in the immutable npm archive. This repository record does
not repack or replace it. See [AGENT_STREAM.md](docs/AGENT_STREAM.md) for bounded replay,
complete-chain recovery and host-owned privacy/durability/outcome responsibilities.

## Published stable 0.9.0

`@ayayaq/vivi@0.9.0` is published and verified. Public npm `latest` was `0.9.0` at publication;
publication time was `2026-10-10T02:08:06.620Z`. The actual registry archive equals the
reviewed frozen archive byte-for-byte and all 262 installed file identities match.

- Tarball: [vivi-0.9.0.tgz](https://registry.npmjs.org/@ayayaq/vivi/-/vivi-0.9.0.tgz), 233,863 bytes, 262 files
- SHA-256: `50ce7d16682214ce2053f79dbb3d6a01f0a8ea6cb495b263009463121e4fe88e`
- SHA-1: `08f8659c2617ec75f1910b5efdfdacd667c5546e`
- Integrity: `sha512-UkM7KUCydEPtcALkfFVtZaJD/h7mZSHoNk3nIt0obVuzLmF1WhfleVs0aqU8AWm9B99AG2iTKBAnJ731t9eN6g==`
- Release source: `b9e0041723e505838d8d3ea154d3db8db0b2914c`
- Reviewed source tree: `aef5731a764e18b591e9c4e7827fd16e85844efe`
- MCP foundation: [PR #23](https://github.com/ayayaQ/vivi/pull/23); release preparation: [PR #24](https://github.com/ayayaQ/vivi/pull/24)

The optional dependency-free MCP bridge preserves exact host review/schema/privacy and
intent/outcome ledger authority. Clean ESM/CommonJS, strict NodeNext and installed offline
consumers passed on Node22/24 before separate host adoption. Registry bytes remain immutable.

## Published stable 0.8.0

**`@ayayaq/vivi@0.8.0` is published and verified**, with npm `latest` observed at
`0.8.0` on 2026-10-08. Registry publication time: `2026-10-08T07:42:38.290Z`.
The actual public registry archive equals the independently reviewed frozen archive byte-for-byte.

- Tarball: [`vivi-0.8.0.tgz`](https://registry.npmjs.org/@ayayaq/vivi/-/vivi-0.8.0.tgz), **188,799 bytes, 215 files**
- SHA-256: `821703c1a4d5d5c484182556de30ec4611c76c808744b8a39924402c6babaf64`
- SHA-1: `fb5a08da2f48e58810020e4ae2fca08fafadd34f`
- Integrity: `sha512-8uyVIES42ZYSYKvmrU53WdVVFpu6TtWACBR1DVDv4p6hvvbRLkxRRHJlInT6virfrowhl4gYcIqbvSbny3Cjog==`
- Reviewed/merged source: `dec635f09a5f259fb8d203f9aab6f516e923825f`
- Reviewed source tree: `8fc296bd6f5c4ff896b9ff15e0b11616513711b8`
- Prepared-action foundation: [PR #20](https://github.com/ayayaQ/vivi/pull/20);
  frozen release preparation: [PR #21](https://github.com/ayayaQ/vivi/pull/21)

Version metadata, tags, full archive bytes, and all 215 file hashes/size/modes match the
reviewed identity. Exact `yaml@2.9.1` and its registry integrity are unchanged. Separate
fresh exact-name registry installs on Node **22.23.3** and **24.19.0** resolve the public
`0.8.0` URL and reviewed integrity; all 215 installed files match. Nine public subpaths
pass ESM/CommonJS runtime and strict NodeNext declarations, all six offline examples and
mocked consumers pass, and 63 installed decisions/prepared-routing tests pass in each of
ESM and CommonJS on both runtimes.

The additive host-authored effect metadata and pure `routePreparedAction` helper grant no
access or execution authority. Host adoption remains separately reviewed; privacy, target
resolution, hard policy and atomic execution stay host-owned. Mock checks do not establish
live-model accuracy or threshold calibration. No live provider calls or npm authentication/
publication were performed by this verification.

The immutable npm archive retains its preparation documentation. This postpublication
record does not repack or replace it. Earlier published records and archives remain unchanged.

## Published stable 0.7.0

**`@ayayaq/vivi@0.7.0` is published and verified**, with npm `latest` observed at `0.7.0` on
2026-10-08. Registry publication time is `2026-10-08T00:51:08.028Z`. The actual public registry
archive is byte-identical to the independently reviewed frozen archive.

- Tarball: [`vivi-0.7.0.tgz`](https://registry.npmjs.org/@ayayaq/vivi/-/vivi-0.7.0.tgz), **182,588 bytes, 206 files**
- SHA-256: `bc1f4426f2a4de8706a751caffec8db09d52ad856e26f49ae94dc0e8b27a7225`
- SHA-1: `be02861ddd246d10286a2c216d2c76d56f7eb535`
- Integrity: `sha512-uUsVR28nUDWIVySUCjjBMzyoopjviMHtqhAhqUM+V+W68pVDAWf8+FD9cd7wOsULuiNHzBq8PhVMQ/ew0UTUOA==`
- Reviewed/merged source commit: `9f50889e038c47d30dd5e92bb70a70a0633899d1`
- Reviewed source tree: `71cfb280df1f2d67a5e30df184d2a1663da77d89`
- Decisions: [PR #17](https://github.com/ayayaQ/vivi/pull/17); frozen release preparation:
  [PR #18](https://github.com/ayayaQ/vivi/pull/18)

The public version metadata, package name/version, `latest`, complete archive bytes and
all 206 archive-file hashes match the reviewed release identity. The sole runtime dependency
remains exact `yaml@2.9.1`, with its unchanged registry integrity verified.
Fresh exact-name registry installs on Node **22.23.3** and **24.19.0** resolve the public
`0.7.0` URL and reviewed integrity. Every installed package file matches the registry archive.
All nine public subpaths pass ESM/CommonJS runtime and strict NodeNext declaration consumers;
all six offline examples and mocked core/provider/cache/model/memory/skills consumers pass.
The 56 decisions tests also pass against each installed ESM and CommonJS implementation on
both runtimes, covering exact-snapshot binding, fail-closed malformed answers, fixed mocked
endpoints, cancellation and deadlines.

These are mock-transport checks; they do not establish real-model accuracy or threshold
calibration. Host adoption and native-platform readiness remain separately reviewed.
Hard policy, eligibility, privacy, manual review, atomic resource checks, execution and audit
remain host-owned. No live provider calls or npm authentication/publication were performed
by this verification. Earlier published release records remain unchanged.

The immutable npm archive retains its prepublication preparation documentation. This
postpublication repository record reports the completed registry gate without repacking,
overwriting or republishing that archive.

## Account-holder publication workflow

For a future release, freeze and independently review its exact archive after final
aggregate checks on Node 22 and 24. Record the source commit/tree, full file list, SHA-256,
SHA-1 and SHA-512 integrity, and exact installed-file, runtime/example and NodeNext
verification. Any change to source, documentation, metadata or archive requires a new
archive identity and review. Do not commit archives, vendor binaries or credentials.

The account holder publishes the reviewed archive from a trusted computer, completing
npm browser login and security challenges personally. Never share credentials, tokens,
recovery codes or `.npmrc`. Confirm the publisher and public versions/tags before upload.
If the name/version exists, stop and compare actual registry bytes; if `latest` is newer,
stop rather than move it backward. Never repack or change a version to bypass a conflict.
After any client-side upload error, inspect public state before retrying. npm name/version
pairs are immutable. See [npm browser login](https://docs.npmjs.com/cli/v11/commands/npm-login/)
and [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

After publication, independently retrieve the actual public archive, compare exact bytes
and all hashes, verify name/version and tags, and repeat clean exact-name installed-file,
runtime/example and declaration checks on Node 22/24. Only then may separately authorized
host changes adopt the exact registry version and regenerate locks through npm.

## Published stable 0.6.0

**`@ayayaq/vivi@0.6.0` is published and verified**, with npm `latest` set to `0.6.0` on
2026-10-06. Registry publication time is `2026-10-06T10:55:16.382Z`. The actual public registry
archive matches the exact independently reviewed frozen archive. This record was prepared after
publication; do not repack this documentation checkout to replace the published archive.

- Skills foundation: [PR #14](https://github.com/ayayaQ/vivi/pull/14), merged at `4583498d036c755863706c98ce27bd67588c105f`
- Release preparation: [PR #15](https://github.com/ayayaQ/vivi/pull/15)
- Merged release source: `fec11c3438f8f88013dfbf68df6bae3b34feb0ae`
- Reviewed source commit: `c839d7309a5f2796b44949c322bb42d93286bc08`
- Source tree: `d4fa6b13f29c7eb688bf88ee59a39e97959e42dd`
- Archive: `ayayaq-vivi-0.6.0.tgz` (159 files, 150187 bytes)
- SHA-256: `c621d76ed154e7e81ee12e30eaac0214b3386b17d48ff7b8fce7d68c9523ece7`
- SHA-1: `7f0b6d412ee712e5ba7f82ac624326c897b03bd3`
- Integrity: `sha512-hMj6QtpL7XmAWIanTW7iyF3PgoFHS7m1JxqOs7J+ASs5liV7T/pB/geZW0E7iI6QDoEH4AqX+y1svauiLsbvSg==`

Registry metadata, `latest`, archive byte equality, SHA-256/SHA-1/SHA-512 and the complete
safe-path file list were checked. A fresh empty-cache exact-name public registry install on
Node 24.19.0 matched all 159 installed files. That clean registry consumer passed all eight
ESM/CommonJS export subpaths, mocked provider and streamed/nonstreamed cache usage, memory and
skills consumers, the original read-only skill creator, denied read-only saves, installed
headless/memory/skills examples, and strict NodeNext ESM/CommonJS declarations under both
Node 24.19.0 and 22.23.3. This is one fresh registry installation checked with both runtimes;
it does not claim a separate completed fresh Node 22 registry installation.

Frontmatter uses exact `yaml@2.9.1`, licensed ISC, as a normal runtime dependency of the optional
skills subpath, not vendored into vivi. The npm-generated consumer lock contains the real registry
URLs and matching integrity for both packages. A separately downloaded public YAML tarball and
all 233 installed dependency files match; its installed ISC license was checked. YAML's resolved
URL is `https://registry.npmjs.org/yaml/-/yaml-2.9.1.tgz`, and its integrity is
`sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==`.

The earlier cloud YAML metadata HTTP 403 was not retried. The post-publication clean registry
installation above is separate from the prepublication offline-cache checks. Full aggregate
checks with 268 mock tests passed on Node 22/24 before freezing.
[Exact-head release CI](https://github.com/ayayaQ/vivi/actions/runs/37449465772) and subsequent
[merged-main CI](https://github.com/ayayaQ/vivi/actions/runs/37450017690) also passed; the source
aggregate was not redundantly rerun after publication. Independent review confirmed the registry and installed
bytes, effective published metadata, runtime/declaration evidence and dependency license.
No live provider calls, credentials or npm authentication/publication by dot were used.

Hosts may now integrate exact registry `0.6.0`, regenerate lockfiles with npm and run their own
integrated checks. Skills are untrusted instruction guidance, not executable plugins or a
permission/security boundary. Approved disk roots, scanning/resource containment, approval UI,
revision-checked atomic save transactions and operation admission/drain remain host-owned.
Publication does not establish host adoption, native platform readiness or CLI session-note
migration. All earlier published records and archives remain unchanged.

## Published stable 0.5.0

**`@ayayaq/vivi@0.5.0` is published and verified**, with npm `latest` set to `0.5.0` on
2026-10-06. Registry publication time is `2026-10-06T06:35:01.995Z`. The account holder
published the exact independently reviewed archive. This record was prepared after the
archive was frozen and published; do not repack this documentation checkout to replace it.

- Merged release source: `b59f8631d6d0e8ce122e8b3c4d2bfff4220cd6dd`
- Reviewed source commit: `4d8b57a76f1fcfc80a478e31ac1cab1bb2156baa`
- Source tree: `0a2e746b592d039b6e9e6608c7a13ab80a7ba7ff`
- Memory extraction: [PR #11](https://github.com/ayayaQ/vivi/pull/11)
- Release preparation: [PR #12](https://github.com/ayayaQ/vivi/pull/12)
- Archive: `ayayaq-vivi-0.5.0.tgz` (138 files, 120826 bytes)
- SHA-256: `85bf71d012cbc79479130cbbe36980f4e20be5788c8e8d158af8b1fea2979ee5`
- SHA-1: `917283a250b26934ab09030a8fac5952e442b04a`
- Integrity: `sha512-9Y8PJF4EGKEJRfNoP1adJ3zhCe3mGebSl9bX3u6RmBPC6IOzflAo6wJyFeZV4JLsgFrfMzi0WrGMCYRbNeXPmA==`

The actual registry archive matched the frozen archive byte-for-byte. A clean exact-name
registry install on Node 24.19.0 matched all 138 installed files and passed all seven
ESM/CommonJS export subpaths, mock streamed/nonstreamed cache usage, memory consumers,
installed headless and memory examples, and strict NodeNext ESM/CommonJS declarations.
The npm-generated lock contained the real registry URL and matching integrity. The exact-byte
match also preserves the independent frozen-archive installed-file/runtime/declaration pass
on Node 22.23.3. Full aggregate checks with 234 mock tests passed on Node 22/24 before the
archive was frozen; the source suite was not redundantly rerun after publication.
No live provider calls, credentials or npm authentication were used for verification.

Hosts may now integrate exact registry `0.5.0`, regenerate lockfiles with npm and run separate
host checks. Atomic persistence/recovery/durability notices, approvals, operation admission/drain
and cross-process file transactions remain host-owned. Publication does not establish host
integration, native platform readiness or CLI session-note migration. All immutable earlier
published-release records and archives remain unchanged.

## Published stable 0.4.0

**`@ayayaq/vivi@0.4.0` is published and verified**, with npm `latest` set to `0.4.0` on
2026-10-05. The account holder published the exact independently reviewed archive. This record
was added after the archive was frozen; do not repack this documentation checkout to replace it.

- Merged release source: `c0d6ccbc29afb3c225992dd94a39d773b9d1630a`
- Reviewed source commit: `4e3306d3157ced581e029fd4b11b18106b44724d`
- Source tree: `8f000650674e80e8a8a51cc82526aafbbb9d1e13`
- Archive: `ayayaq-vivi-0.4.0.tgz` (127 files, 104088 bytes)
- SHA-256: `459a1df0677aeabbb3516dfd93cc0cc8c62d5ebad9aa1bdf8990342b45009107`
- SHA-1: `bf70f0e91b90cadb712dccbd6565de0877eb62b2`
- Integrity: `sha512-dejKuQcP5YxHuiqL16Vbg7h36mNkruZhEOyyt4ErjOAKxL/Cr9DXjvr+rPDvcjcASWYJ0/jzRpWCbt/eeQkglg==`

The actual registry archive matched the frozen archive byte-for-byte. Clean registry installs
on Node 22.23.3 and 24.19.0 matched all 127 installed files and passed core/history/provider/
extension/calculator/model-capability ESM/CommonJS runtime, streamed/nonstreamed cache usage,
installed headless example and strict NodeNext ESM/CommonJS declarations. npm-generated locks
contained the real registry URL and matching integrity. No live provider calls or credentials
were used. The published `0.3.0` archive and its record below are unchanged.

Hosts may integrate exact registry `0.4.0`, regenerate lockfiles with npm and run their final
checks. Publication does not establish host integration or native platform readiness.

The capability contract is deliberately bounded: unreviewed OpenAI IDs and OpenRouter Responses
remain unknown, and gateway metadata does not establish routed/account support. Hosts must retain
existing coverage, fetching and fallback policy, distinguish default from explicit disable, and
map OpenRouter disable separately from named efforts. See [CAPABILITIES.md](CAPABILITIES.md).

## Published 0.3.0 record

**`@ayayaq/vivi@0.3.0` is published and verified**, with npm `latest` set to `0.3.0` on
2026-10-05. The account holder published the exact independently reviewed archive. This record
was added after the archive was frozen; do not repack this documentation checkout to replace it.

- Merged release source: `19be05db50c8f9c53f6296d01ffa34b95391d522`
- Reviewed source commit: `bc09df9e3e027240bcbdacb3d7b7060cef0e108e`
- Source tree: `9f6bbcc958af6adc8b74985860f522cb888f8166`
- Archive: `ayayaq-vivi-0.3.0.tgz` (116 files, 88474 bytes)
- SHA-256: `114013f3f0067fc9d956e6699770548894cf58323f303bac12d1fac4cb264eb7`
- SHA-1: `cde1eabd39392ea7f2030c20a635b7bc492b2690`
- Integrity: `sha512-9Evt8vBmwyGQEQG5eowb3R1onJCyEru4pqqVwzGA4TX9sgaWE2p7AdcDAtVTt6wDERFiM0yXNUwQAVPK2TSz3A==`

The actual registry archive matched the frozen archive byte-for-byte. Clean registry installs
on Node 22.23.3 and 24.19.0 matched all 116 installed files and passed core/history/provider/
extension/calculator ESM/CommonJS runtime, streamed/nonstreamed cache usage, installed headless
example and strict NodeNext ESM/CommonJS declarations. npm-generated locks contained the real
registry URL and matching integrity. No live provider calls or credentials were used.

Hosts may now integrate exact registry `0.3.0`, regenerate lockfiles with npm and run their final
checks. This verification does not establish host integration or native platform readiness.
The later capability normalization module is outside `0.3.0`.

The commands below document the historical `0.6.0` preparation and publication workflow.
`0.6.0` and all earlier published versions must never be replaced or republished. For a future
release, select a new version in every command and repeat source, archive, registry and host
verification. All published records and archives remain immutable.

## Prepare and independently review

Use Node.js 22 or newer and the locked development dependency:

```sh
npm ci
npm run check
npm pack --dry-run --json
RELEASE_DIR="$(mktemp -d /tmp/vivi-release-XXXXXX)"
npm pack --json --pack-destination "$RELEASE_DIR"
sha256sum "$RELEASE_DIR/ayayaq-vivi-0.11.0.tgz"
git rev-parse HEAD HEAD^{tree}
git status --short
```

The final source checkout must be clean. Save the commit, tree, archive SHA-256, SHA-1 and
SHA-512 integrity in a separate release record. Inspect the archive file list and independently
check its source, version, exports, declarations and licenses. Verify ESM, CommonJS, strict
NodeNext consumers and the installed headless example on Node 22 and 24. Core checks use mock
providers only; no provider credentials are needed.

The pack includes builds and declarations, source/build configuration, examples, docs, README,
changelog, this guide, LICENSE, NOTICE, attribution and audit. Exclude credentials, private data,
node_modules, tests, old archives and development-only files. Keep the frozen archive and release
record outside the repository; do not commit vendor tarballs or fabricated registry lock entries.
Any source, metadata, documentation or archive change requires a new pack, hash and review.

## Account-holder publication

Use the exact approved `ayayaq-vivi-0.11.0.tgz` and its supplied release record on your trusted
computer. Verify the publisher is `ayayaq` or an explicitly authorized package maintainer.
Complete sign-in and security challenges yourself. Never share passwords, tokens, recovery codes
or `.npmrc` in chat. No separately created token or trusted-publisher setup is needed.

If required, use [npm browser login](https://docs.npmjs.com/cli/v11/commands/npm-login/):

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view @ayayaq/vivi versions --json --registry=https://registry.npmjs.org/
sha256sum ./ayayaq-vivi-0.11.0.tgz
```

Match SHA-256 to the approved release record. If `0.11.0` already exists, stop and compare registry
integrity and bytes before taking another action. Name/version pairs are immutable even after
unpublication. Do not change the version or archive without another review.

```sh
npm publish ./ayayaq-vivi-0.11.0.tgz --access public --tag latest --registry=https://registry.npmjs.org/
```

This publishes all archive contents and updates `latest` to `0.11.0`. See
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/) for tags and authentication.
A client-side failure can follow a successful upload; inspect the registry before retrying,
and never substitute a newly packed working directory for the reviewed archive.

## Verify registry bytes and integrate hosts

```sh
npm view @ayayaq/vivi@0.11.0 name version dist.integrity dist.shasum --json --registry=https://registry.npmjs.org/
npm view @ayayaq/vivi dist-tags --json --registry=https://registry.npmjs.org/
REGISTRY_DIR="$(mktemp -d /tmp/vivi-registry-XXXXXX)"
npm pack @ayayaq/vivi@0.11.0 --json --pack-destination "$REGISTRY_DIR" --registry=https://registry.npmjs.org/
cmp ./ayayaq-vivi-0.11.0.tgz "$REGISTRY_DIR/ayayaq-vivi-0.11.0.tgz"
```

Verify name/version, SHA-512 integrity, SHA-1, exact archive bytes, and `latest`. Install exact
`@ayayaq/vivi@0.11.0` into clean registry consumers and repeat ESM/CommonJS runtime, strict
NodeNext declaration, extension/cache and headless-example checks. Record the verified release
without repacking or replacing published bytes.

Only then set exact `"@ayayaq/vivi": "0.11.0"` in authorized CLI/desktop changes and regenerate
lockfiles with npm from the real registry. Remove obsolete tracked vendor archives/provenance,
preserve dependency license/notice/attribution, and rerun each host's final integrated checks.
Local prototypes may temporarily install a pack with `--no-save --package-lock=false`, but local
packs do not establish release or clean registry integration. Publishing core does not publish
or upgrade either host.

## Immutable earlier release records

`0.2.1` is published. Public npm metadata observed on 2026-10-05:

- SHA-1: `5c3bafacb0265dacde85a19d1b98d8de7f8c573d`
- Integrity: `sha512-iMuY7HbBfRljH9yTMS0unR98WctuNjYVUYrXOOuLYbwlscydW2TKwVKhw9ec6SVjtqFwjPQdn7tLkoYi4pUkmA==`

The existing reviewed `0.2.0` record is unchanged:

- Source commit: `063b84a009d8cc9c553f508e8d3cfece59fe0b1a`
- Source tree: `692d9fc00412ebcf0c36843390c5714f4ed52a63`
- Archive: `ayayaq-vivi-0.2.0.tgz`
- SHA-256: `aab013aef6ae939dba5f07391358b3fa4c5cc83b7f5b6a9f520ed8d8c76dd9a9`
- SHA-1: `9d9ddc7f9e07d7fba878b260931da06d81abc714`
- Integrity: `sha512-4qxPGSjhKgJKx01fV18V4qvzlVQxkhyiXhPX+KpnbevDYFMilAlnlhx7JIPyWZENG6zUOYSRB6xnQkTT0K1usw==`

Its registry archive and all 96 installed files matched the frozen archive, with clean runtime
and declaration checks. The published immutable `0.1.0` reviewed archive SHA-256 is
`9f5faecf9959f722bfa799efa8b0610b383b3d888bc13659b73be37306b6e2f6`.
Never publish this candidate's new bytes as any earlier version.
