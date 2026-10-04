# Source attribution

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

vivi is released under the Apache License, Version 2.0, with the copyright owner's authorization
to release this extracted core separately. Bot Commander Desktop's existing GNU General Public
License, version 3, remains unchanged; this release does not relicense the upstream desktop
application. The full Apache 2.0 text is included in `LICENSE`, fetched from:

https://www.apache.org/licenses/LICENSE-2.0.txt

Source and build configuration are included in the npm package alongside compiled JavaScript,
declarations, this attribution, and `NOTICE`.
