# Source attribution

## Optional skills foundation

The instruction-only skills module prepared for `0.6.0` follows the public
[Agent Skills specification](https://agentskills.io/specification), with name normalization
checked against its [reference validator](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py).
The module, bundled creator and synthetic test fixtures are original Apache-2.0 work; no
third-party skill bodies are copied. Optional frontmatter parsing uses the separately packaged
[`yaml`](https://github.com/eemeli/yaml) dependency, licensed ISC. Its source/license remain
in that installed dependency, rather than being vendored into vivi.

## Initial shared core

vivi's initial agent-loop design is extracted and generalized from Bot Commander Desktop by
ayayaQ, specifically `src/main/services/agentService.ts` at commit
`943e3f84f67e4415a899da8921db84639843c625`:

https://github.com/ayayaQ/bot-commander-desktop/blob/943e3f84f67e4415a899da8921db84639843c625/src/main/services/agentService.ts

The original project supplied the provider/tool-round orchestration and cancellation/approval
integration that motivated this extraction. This version replaces desktop-specific orchestration
with a process-neutral API and adds transcript validation, immutable callback snapshots,
abort-aware waits, and completed error transcripts. The subsequent shared provider extraction generalizes the desktop Responses/Chat history
projection and parsing from `agentProviderAdapter.ts` at reviewed desktop commit
`85274c1a4f5399da98973f4126b9cf118e3014d0`. Shared canonical-history recovery comes from the
same desktop integration. The copyright owner authorized this further shared extraction.
Domain tools, approvals, planning, desktop persistence and UI are deliberately not included.
The CLI is a separate generic reference host, not the desktop application.

The optional calculator extension reuses the bounded arithmetic parser from the Apache-2.0
vivi CLI, `src/tools.ts` at commit `ad31098bd6947411b659f57c0bb85cb129dfb894`:

https://github.com/ayayaQ/vivi-cli/blob/ad31098bd6947411b659f57c0bb85cb129dfb894/src/tools.ts

Its tool name, argument schema, arithmetic bounds, and JSON result shape are preserved so the
CLI can consume the same pure implementation as other hosts. Note storage and approvals stay
in the CLI. The trusted in-process registry is new shared code, not a desktop plugin sandbox.

vivi is released under the Apache License, Version 2.0, with the copyright owner's authorization
to release this extracted core separately. Bot Commander Desktop's existing GNU General Public
License, version 3, remains unchanged; this release does not relicense the upstream desktop
application. The full Apache 2.0 text is included in `LICENSE`, fetched from:

https://www.apache.org/licenses/LICENSE-2.0.txt

Source and build configuration are included in the npm package alongside compiled JavaScript,
declarations, this attribution, and `NOTICE`.

The optional endpoint-aware capability module generalizes the pure metadata semantics
from the Apache-2.0 CLI `src/models.ts` at
`ad31098bd6947411b659f57c0bb85cb129dfb894`. Exact source links, current official fact provenance,
and paired consumer evidence are in `CAPABILITIES.md`. It does not copy either host's catalog
fetch/cache, settings, UI, or desktop code into the shared module.

The optional shared memory module generalizes `src/main/services/agentMemoryService.ts`,
the memory types/tools, and the context formatter/guidance from Bot Commander Desktop at
`67f4ce73a00f2072937b3a6e90f7f6b0ba3f8a2c`:

https://github.com/ayayaQ/bot-commander-desktop/blob/67f4ce73a00f2072937b3a6e90f7f6b0ba3f8a2c/src/main/services/agentMemoryService.ts

The copyright owner's shared-module authorization covers this separate Apache-2.0 extraction.
Desktop atomic persistence, recovery, lifecycle, approval policy and UI are not copied.
See `docs/MEMORY.md` for compatibility and host responsibilities.

## Optional decision review

The optional `src/decisions*` module is original implementation for this repository.
Its wire schemas were checked against the official OpenAI Decisions and OpenRouter Jev
references listed in `docs/DECISIONS.md` on October 7, 2026. No vendor SDK or cookbook
implementation was copied or bundled. Tests use attributed, synthetic protocol fixtures.
