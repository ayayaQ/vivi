# Optional instruction-only skills

`@ayayaq/vivi/extensions/skills` is published in verified stable `0.6.0` and absent from
immutable `0.5.0`. The portable contract is ready for both hosts; desktop/CLI adoption,
app-wide stores and approval UI remain separately reviewed host changes.

## Format and interoperability

A skill is a directory named after its `name`, containing an ordinary `SKILL.md`:

```markdown
---
name: concise-summary
description: Summarize supplied text into three bullets. Use when a three-bullet summary is requested.
---

Read the text, identify its three main points, and return three short factual bullets.
```

No vivi-specific manifest, frontmatter, ZIP, import syntax or executable module is required.
The parser follows the [Agent Skills specification](https://agentskills.io/specification)
and the official [reference validator's Unicode name normalization](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py).
It uses maintained `yaml@2.9.1`, not an improvised YAML parser. The dependency is installed
with vivi but imported only by the optional skills subpath; the agent loop does not load it.

- Required `name` and `description`; quotes, comments, block/folded scalars, CRLF and UTF-8 BOM
- Lowercase Unicode alphanumeric names with single hyphens, at most 64 characters, no edge
  hyphen; names are trimmed and NFKC-normalized as in the reference validator
- Description at most 1024 Unicode characters; compatibility at most 500
- Optional `license`, `compatibility`, string-to-string `metadata`, and `allowed-tools`
- Unknown fields are ignored with returned warnings; the exact source is retained, so an edit
  can preserve extension fields. Host-specific fields such as `disable-model-invocation` are
  not implemented. Hosts must show diagnostics and decide whether unsupported semantics
  make a source unsuitable for discovery
- Relative resources in `references/`, `assets/`, `scripts/`, or other directories may be
  read as inert UTF-8 text by an explicitly supplied host callback. No special folder is required

This is an instruction-only implementation, not a claim that every existing skill's workflow
can run. Skills requiring shell commands, executable scripts, binary assets, unavailable
tools/runtimes or third-party permissions need corresponding authorized host capabilities.
Nothing is rewritten or silently installed. `allowed-tools` is descriptive and never grants
access or pre-approves a call.

Implementation limits are explicit: 100 skills, 64 KiB per document/resource, 8 KiB frontmatter,
2 MiB total documents and 24 KiB catalog summaries. YAML is bounded to 256 AST nodes and
four levels; aliases/anchors, explicit tags, duplicate keys and unresolved YAML warnings are
rejected. Metadata allows up to 32 string pairs with bounded keys/values. Resource paths have
at most eight safe relative components and 240 characters; traversal, absolute/drive paths,
backslashes, control characters, Windows device names and trailing dot/space components are
rejected. This bounded subset is a compatibility limitation, not a proprietary skill format.

Tests use original synthetic fixtures matching common public skill structures, including
the standard optional fields, Unicode, folded/quoted descriptions, links, resources and
script-dependent instructions. They copy no third-party skill bodies. The format references
are [Agent Skills](https://agentskills.io/specification) and
[Pi's documented skills conventions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md).
The bundled creator is original Apache-2.0 content.

A separate read-only check on 2026-10-06 parsed the actual public
[Anthropic frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md)
(blob `a5333457c414d20d625f307df945842c0952ecc3`, 9390 UTF-8 bytes) and
[Anthropic skill-creator](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)
(blob `65b3a402dbd09b8e83f9d637c6b553875189085c`, 33168 bytes) SKILL.md files unchanged,
with matching directory names and no parser warnings. Their bodies are not vendored and their
workflows were not executed; in particular, their script/tool dependencies remain host-specific.

## Shared API

`parseSkillDocument(content, directoryName?)` returns frozen metadata, exact source, body,
warnings and SHA-256 revision. Supply the discovered directory name to enforce its match.
`skillRevision` hashes the exact UTF-8 source, including frontmatter and newline choices;
it is not an approval token.

`createSkillCatalog(sources)` receives only host-approved `SkillSource` entries. It keeps a
fixed per-turn snapshot, rejects duplicate canonical names instead of silently shadowing,
and exposes summaries plus explicit document/resource reads. `skillCreatorSource` is the
read-only original creator, also packaged at `skills/skill-creator/SKILL.md`. Include it
explicitly; there is no global registration or automatic filesystem scan.

`createSkillsExtension({ catalog, authorizeRead, save? })` uses the existing `ToolExtension`
registry. Host callbacks are captured when the extension is created. Ordinary catalog factory
data is frozen; custom catalog implementations must preserve the same immutable-turn contract.

- `list_skills`: names, descriptions, exact revisions, read-only flags and limits
- `read_skill`: name, safe relative path and expected catalog revision; host policy runs before
  any resource callback. `SKILL.md` reads use the captured document, without new disk I/O
- `save_skill`: optional SKILL.md-only create/update tool. `expectedRevision: null` means
  create; a listed revision means replace. Parse/name checks, snapshot stale checks and
  read-only checks run before the host receives a deeply frozen exact-content proposal

No save tool is advertised if its host capability is absent. `save.authorize` must resolve
literal `true` after exact draft/destination review. `save.commit` owns actual atomic persistence
and the post-review on-disk compare-and-swap. A successful save reports its new revision and
availability on a future turn; it never replaces this turn's catalog or activated instructions.
The first writer supports only one SKILL.md, not resources, scripts, arbitrary workspace files,
deletion, installing dependencies or editable built-ins.

See [the runnable offline host example](../examples/skills.mjs) for create/read/save wiring.
Its synthetic in-memory approval is illustrative, not production authorization.

## Host filesystem and approval obligations

The module chooses no paths, opens no files, grants no authority and creates no directories.
Each host remains responsible for:

1. An app-wide skill store separate from memories/session notes and a read-only built-in source
2. Explicitly approved additional roots, if offered. Never autoload an arbitrary working
   directory, ancestors, a home directory, `node_modules`, or untrusted project skills
3. Bounded scanning, counts/depth and file reads. Enforce byte limits BEFORE allocating/reading,
   then decode UTF-8 strictly. Check declared/directory names and show invalid/unsupported diagnostics
4. Filesystem containment using the actual approved canonical root. Refuse escaping symlinks,
   junctions/reparse points and path races; do not rely only on string-prefix checks. Bind each
   resource callback to one identified root and exact document revision. Revalidate after an
   async approval; refuse resources whose source changed instead of mixing revisions
5. Resource reads that return only text, with no import, eval, shell or process execution. Binary
   asset use needs a separate authorized capability. Reading script text does not authorize running it
6. A single owned-store save destination derived from the canonical validated skill name, with
   platform-safe path validation. Show create/replace, exact before/after source and destination
   through existing host approval UI. Never interpret a skill's own text as permission
7. An operation admission/drain mechanism plus cross-process lock or file transaction. Under it,
   reload the actual current SKILL.md after approval, compare its full SHA-256 revision or verify
   nonexistence, then atomically commit. A catalog precheck alone does not prevent stale writes
8. Cancellation before commit, committed receipts, crash recovery and durability notices. Reject
   only before a committed rename; retain any committed outcome even if the turn is cancelled
9. A fresh catalog/registry at each future turn. Edits/imports must not hot-reload midway through
   model execution, and removing a root must prevent future reads/saves

The existing generic tool registry/runner rejects results for an aborted turn even if a host
operation has already committed. The direct save executor preserves its committed success,
but this does not override generic registry cancellation. Hosts must retain/report the final
commit receipt while draining operations; an aborted turn is not evidence that a save rolled
back. Before retrying, inspect the actual stored revision. This module changes no loop hooks.

## Context and trust

`formatSkillCatalogContext(catalog)` is compact name/description data for a user-level message.
Insert it once per host turn, replacing any prior catalog instead of appending another copy.
Do not persist it as a user message or place skill-provided text at system/developer priority.
Load full instructions/resources through explicit tool results only when relevant. Hosts own
history trimming; preserve the source provenance and avoid accumulating every skill body.

Skill text, descriptions and resources are untrusted, lower-priority guidance. They can contain
prompt injection. A format parser, catalog label or JSON wrapper is not a security boundary.
Keep actual tools, approval policy, planning mode, credentials, persistent grants, operation
admission and path policy in trusted host code. Skill instructions cannot invent a tool, grant
themselves approval, override current user instructions, or authorize executable loading.

The creator drafts an ordinary skill, proposes example tests without claiming unrun evaluations,
shows exact content, requests approval, and uses the host's scoped save capability if present.
It creates no scripts/resources in v1. Read-only hosts still support discovery and draft creation.
