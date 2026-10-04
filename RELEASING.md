# First npm release

Target: `@ayayaq/vivi@0.1.0`, public, Apache-2.0. This package is **not published yet**.
Preparation and local checks do not authorize npm publication. Obtain separate approval for the
exact reviewed archive before publishing. No release step is automated by this repository.

## Prepare and review without signing in

Use Node.js 22 or newer and the locked development dependency:

```sh
npm ci
npm run check
npm pack --dry-run --json
npm pack --json
shasum -a 256 ayayaq-vivi-0.1.0.tgz
```

Save the reviewed source commit, archive SHA-256, and npm's reported integrity. Inspect the pack
file list: it must include ESM/CommonJS builds and declarations, source/build configuration,
README, this guide, LICENSE, NOTICE, and attribution. It must exclude credentials, private data,
and node_modules. `check` installs a generated archive into clean runtime and TypeScript consumers.

Keep the approved archive unchanged. Any source, metadata, documentation, or archive change
requires a new pack, hash, and focused review. Publish the reviewed tarball, not a newly packed
working directory. Local archive installation remains supported before release; see the README.

## User-only authentication and publication, after approval

The npm account holder performs these steps on their own trusted computer. npm user accounts
have a matching [personal scope](https://docs.npmjs.com/cli/v12/using-npm/scope/); the account must be
`ayayaq` to own `@ayayaq`. Confirm the account's email and enable account 2FA using npm's
[official 2FA guide](https://docs.npmjs.com/configuring-two-factor-authentication/) if needed.
Interactive publishing requires a [2FA challenge](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/).

After separate approval, sign in yourself using npm's browser flow, then verify your identity:

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

The output must be `ayayaq`. [npm login](https://docs.npmjs.com/cli/v12/commands/npm-login/)
saves authentication material locally; never share passwords, tokens, recovery codes, or `.npmrc`.
This workflow does not require creating a separate token or configuring automated publishing.
Complete sign-in and security challenges directly in npm's trusted CLI/browser, not in chat.

Check the approved archive's SHA-256 again, then publish that exact file:

```sh
npm publish ./ayayaq-vivi-0.1.0.tgz --access public --registry=https://registry.npmjs.org/
```

This makes the package and its archive contents public. `publishConfig` also selects the public
npm registry and public access. The [npm publish reference](https://docs.npmjs.com/cli/v12/commands/npm-publish/)
supports tarball publication and explains registry, access, and 2FA prompts. If npm reports a
conflicting package/version, stop and investigate; do not replace the reviewed artifact or change
the release version without another review and approval.

## Verify the actual release

```sh
npm view @ayayaq/vivi@0.1.0 name version dist.integrity --json --registry=https://registry.npmjs.org/
```

Confirm name/version and integrity match the approved archive, then install the exact registry
version in a clean consumer and repeat ESM/CommonJS runtime and declaration checks. Only after
registry installation is verified should the README advertise registry installation. Keep the
release commit and archive hash with the release record.
