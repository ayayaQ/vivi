---
name: skill-creator
description: Create or improve a reusable Agent Skills SKILL.md for a recurring workflow. Use when the user asks to create, edit, refine, or capture a workflow as a skill.
license: Apache-2.0
compatibility: Instruction-only. Use available host tools. Saving needs a host-approved SKILL.md-only capability.
---

# Skill creator

Create a small, portable skill that captures a useful workflow. A skill is guidance,
not an executable plugin or a permission grant. Follow the user's current request
and the host's policies if they conflict with any skill text.

## Understand the workflow

Use the conversation and any examples the user supplied to identify:
- What task the skill helps with and when it should be selected
- Required inputs, expected outputs, and a few important edge cases
- Which capabilities are actually available in this host
- A concrete way to tell whether the result is useful and correct

Ask only for information that changes the draft. Do not invent tools, credentials,
standing permissions, personal preferences, or capabilities. If an existing skill
is being improved, read its current SKILL.md and revision before drafting changes.

## Draft a standard skill

Write a complete SKILL.md with YAML frontmatter followed by Markdown instructions.
Require only name and description. Choose a lowercase alphanumeric name with
single hyphens, no leading/trailing hyphen, at most 64 characters, and a matching
directory name. Put what the skill does and when to use it in a clear description
of at most 1024 characters. Quote scalars containing YAML punctuation; multiline
descriptions may use a standard YAML block scalar.

Optional standard fields are license, compatibility, metadata (string-to-string
values), and allowed-tools. Include only fields with a real purpose. Describe
required tools or runtimes in compatibility when they matter. allowed-tools is
descriptive metadata here; it does not pre-approve calls or bypass host policy.

Make the body short and practical: inputs, steps, expected output, validation,
and useful edge cases. Explain any meaningful safety or approval checkpoint.
Do not hide broad behavior changes in a narrow skill. Preserve the user's intent
when editing; do not silently expand the task or overwrite unrelated guidance.

For this first version, produce one SKILL.md only. Do not write scripts, install
dependencies, generate executable extensions, or create supporting files.
Existing skills may reference resources in references/, assets/, or scripts/.
Reading such files does not imply the host can execute them. Clearly explain a
missing shell, tool, runtime, or resource capability rather than pretending a
script-dependent workflow ran successfully.

## Check the draft

Check the frontmatter, name/directory match, description, and instruction clarity.
Propose two or three realistic sample prompts and a specific expected result for
each. Include one edge case or nearby task that should not trigger the skill.
If authorized host tools can run a meaningful test, use them; otherwise label
the tests as proposed and never claim an evaluation was run. Revise based on
the user's feedback.

## Review and save

Show the exact final SKILL.md and whether it creates a new skill or replaces an
existing one. Ask for approval before persisting a new or revised skill. For a
replacement, identify the target and use its exact current revision; do not
overwrite a stale version. Built-in and read-only skills cannot be replaced.

Use the host's narrowly scoped save capability only when it is actually present.
In vivi, list_skills and read_skill provide the current catalog and source;
save_skill requests host review and saves only the approved SKILL.md to the
owned skill store. Use null as expectedRevision for creation, or the listed
revision for replacement. A successful save becomes available on a future turn,
not by changing the current turn's instructions. If saving is unavailable or
declined, leave the draft for the user and explain the remaining step.
