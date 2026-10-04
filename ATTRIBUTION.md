# Source attribution

vivi's initial agent-loop design is extracted and generalized from Bot Commander Desktop by
ayayaQ, specifically `src/main/services/agentService.ts` at commit
`943e3f84f67e4415a899da8921db84639843c625`:

https://github.com/ayayaQ/bot-commander-desktop/blob/943e3f84f67e4415a899da8921db84639843c625/src/main/services/agentService.ts

The original project supplied the provider/tool-round orchestration and cancellation/approval
integration that motivated this extraction. This version replaces desktop-specific orchestration
with a process-neutral API and adds transcript validation, immutable callback snapshots,
abort-aware waits, and completed error transcripts. Desktop providers, tools, approvals, planning,
persistence, and UI are deliberately not included.

vivi is released under the Apache License, Version 2.0, with the copyright owner's authorization
to release this extracted core separately. Bot Commander Desktop's existing GNU General Public
License, version 3, remains unchanged; this release does not relicense the upstream desktop
application. The full Apache 2.0 text is included in `LICENSE`, fetched from:

https://www.apache.org/licenses/LICENSE-2.0.txt

Source and build configuration are included in the npm package alongside compiled JavaScript,
declarations, this attribution, and `NOTICE`.
