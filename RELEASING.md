# Release workflow

## Prepared stable 0.5.0 candidate (unpublished)

The optional shared memory extraction is merged at
`4bcbe4579a0065e41c0563798349357a98da9587`. This checkout prepares the additive `0.5.0`
release. It is not a publication record: `0.4.0` remains the latest verified registry release.
The package includes the optional memory subpath; host adoption is still separate.

After independent source review and final Node 22/24 checks, freeze one exact archive and keep
its commit/tree, hashes, file list and verification receipt outside Git. The account holder
performs npm authentication and publication using that archive. Verify the actual registry bytes
and clean consumers before recording publication or integrating exact `0.5.0` in either host.
Never replace any published version or upload a newly repacked checkout instead of that archive.

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

The workflow below prepares the unpublished `0.5.0` candidate. For a future release, select a
new version, update package/lock metadata and substitute that version in every archive and registry command,
then repeat independent review and verification. Never publish changed bytes under an already published
version; all published records and archives remain immutable.

## Prepare and independently review

Use Node.js 22 or newer and the locked development dependency:

```sh
npm ci
npm run check
npm pack --dry-run --json
RELEASE_DIR="$(mktemp -d /tmp/vivi-release-XXXXXX)"
npm pack --json --pack-destination "$RELEASE_DIR"
sha256sum "$RELEASE_DIR/ayayaq-vivi-0.5.0.tgz"
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

Use the exact approved `ayayaq-vivi-0.5.0.tgz` and its supplied release record on your trusted
computer. Verify the publisher is `ayayaq` or an explicitly authorized package maintainer.
Complete sign-in and security challenges yourself. Never share passwords, tokens, recovery codes
or `.npmrc` in chat. No separately created token or trusted-publisher setup is needed.

If required, use [npm browser login](https://docs.npmjs.com/cli/v11/commands/npm-login/):

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view @ayayaq/vivi versions --json --registry=https://registry.npmjs.org/
sha256sum ./ayayaq-vivi-0.5.0.tgz
```

Match SHA-256 to the approved release record. If `0.5.0` already exists, stop and compare registry
integrity and bytes before taking another action. Name/version pairs are immutable even after
unpublication. Do not change the version or archive without another review.

```sh
npm publish ./ayayaq-vivi-0.5.0.tgz --access public --tag latest --registry=https://registry.npmjs.org/
```

This publishes all archive contents and updates `latest` to `0.5.0`. See
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/) for tags and authentication.
A client-side failure can follow a successful upload; inspect the registry before retrying,
and never substitute a newly packed working directory for the reviewed archive.

## Verify registry bytes and integrate hosts

```sh
npm view @ayayaq/vivi@0.5.0 name version dist.integrity dist.shasum --json --registry=https://registry.npmjs.org/
npm view @ayayaq/vivi dist-tags --json --registry=https://registry.npmjs.org/
REGISTRY_DIR="$(mktemp -d /tmp/vivi-registry-XXXXXX)"
npm pack @ayayaq/vivi@0.5.0 --json --pack-destination "$REGISTRY_DIR" --registry=https://registry.npmjs.org/
cmp ./ayayaq-vivi-0.5.0.tgz "$REGISTRY_DIR/ayayaq-vivi-0.5.0.tgz"
```

Verify name/version, SHA-512 integrity, SHA-1, exact archive bytes, and `latest`. Install exact
`@ayayaq/vivi@0.5.0` into clean registry consumers and repeat ESM/CommonJS runtime, strict
NodeNext declaration, extension/cache and headless-example checks. Record the verified release
without repacking or replacing published bytes.

Only then set exact `"@ayayaq/vivi": "0.5.0"` in authorized CLI/desktop changes and regenerate
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
