# Release workflow

## Current status

This checkout prepares **`@ayayaq/vivi@0.3.0`** for CORE-02. A stable version in package.json
is release metadata, not proof of publication. As checked on 2026-10-05, npm `latest` is `0.2.1`
and `0.3.0` is absent. Extensions and cache usage are new in this candidate. The later capability
normalization module is outside this release.

Publication remains an npm account-holder step. First merge the independently reviewed release
change after final-head CI passes, then publish the exact frozen archive and verify registry bytes.
Do not upgrade CLI/desktop registry dependencies or advertise `0.3.0` as available before that gate.

## Prepare and independently review

Use Node.js 22 or newer and the locked development dependency:

```sh
npm ci
npm run check
npm pack --dry-run --json
RELEASE_DIR="$(mktemp -d /tmp/vivi-release-XXXXXX)"
npm pack --json --pack-destination "$RELEASE_DIR"
sha256sum "$RELEASE_DIR/ayayaq-vivi-0.3.0.tgz"
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

Use the exact approved `ayayaq-vivi-0.3.0.tgz` and its supplied release record on your trusted
computer. Verify the publisher is `ayayaq` or an explicitly authorized package maintainer.
Complete sign-in and security challenges yourself. Never share passwords, tokens, recovery codes
or `.npmrc` in chat. No separately created token or trusted-publisher setup is needed.

If required, use [npm browser login](https://docs.npmjs.com/cli/v11/commands/npm-login/):

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view @ayayaq/vivi versions --json --registry=https://registry.npmjs.org/
sha256sum ./ayayaq-vivi-0.3.0.tgz
```

Match SHA-256 to the approved release record. If `0.3.0` already exists, stop and compare registry
integrity and bytes before taking another action. Name/version pairs are immutable even after
unpublication. Do not change the version or archive without another review.

```sh
npm publish ./ayayaq-vivi-0.3.0.tgz --access public --tag latest --registry=https://registry.npmjs.org/
```

This publishes all archive contents and updates `latest` to `0.3.0`. See
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/) for tags and authentication.
A client-side failure can follow a successful upload; inspect the registry before retrying,
and never substitute a newly packed working directory for the reviewed archive.

## Verify registry bytes and integrate hosts

```sh
npm view @ayayaq/vivi@0.3.0 name version dist.integrity dist.shasum --json --registry=https://registry.npmjs.org/
npm view @ayayaq/vivi dist-tags --json --registry=https://registry.npmjs.org/
REGISTRY_DIR="$(mktemp -d /tmp/vivi-registry-XXXXXX)"
npm pack @ayayaq/vivi@0.3.0 --json --pack-destination "$REGISTRY_DIR" --registry=https://registry.npmjs.org/
cmp ./ayayaq-vivi-0.3.0.tgz "$REGISTRY_DIR/ayayaq-vivi-0.3.0.tgz"
```

Verify name/version, SHA-512 integrity, SHA-1, exact archive bytes, and `latest`. Install exact
`@ayayaq/vivi@0.3.0` into clean registry consumers and repeat ESM/CommonJS runtime, strict
NodeNext declaration, extension/cache and headless-example checks. Record the verified release
without repacking or replacing published bytes.

Only then set exact `"@ayayaq/vivi": "0.3.0"` in authorized CLI/desktop changes and regenerate
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
