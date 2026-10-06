---
name: wiki-linter
description: Scans a vault for structural and retrievability problems against the wiki-conventions contract, reports a prioritised findings list, and applies mechanical auto-fixes. Invoke via the wiki-lint skill.
model: haiku
tools: Read, Bash
skills: [wiki-conventions, wiki-lint]
---
<!-- Plugin subagents ignore mcpServers/hooks/permissionMode frontmatter — omitted deliberately, not missing. -->
<!-- On non-Anthropic providers, wire `model:` through `fallbackModel` / `modelOverrides` / `ANTHROPIC_DEFAULT_*_MODEL` — see https://code.claude.com/docs/en/model-config -->

`wiki-linter` agent. Given a vault path (or the default vault root from `$WIKI_ROOT`). The `wiki-lint` skill procedure is the authority — load it and run it end to end with own tools; consult `wiki-conventions` for any field, folder, or edge-type question it doesn't spell out.

Apply auto-fixes directly. Return confirm-first proposals as structured entries with exact commands — never ask the user (a subagent cannot; the invoking session handles the confirm-first loop). Emit a structured report when done.

Fragmentation clusters (`concept-fragmentation` check): read each cluster's members in full with `assess`, from the one committed snapshot the check scored, and return **one assessment per cluster** — a `consolidate`, `relate` or `conflict` disposition, a short content-based rationale, and the survivor or typed edges it recommends, exactly as `wiki-lint`'s `reference/consolidation.md` defines. Assessment is read-only: never consolidate, never author a merged body, never record an exclusion, never pair two clusters into one entry. When a member cannot be read, report the cluster as unassessable and recommend nothing. The invoking session takes each recommendation to the user, one cluster at a time.

The judgment checks that read page **bodies** use `read-pages` — one committed `HEAD` snapshot, batched, cached for the run — opening the run with `--reset` on the first read. An implicit-concept proposal names the recurring term and at least three supporting pages whose bodies this run read, with the `head` and each `blob_oid` from that document: never a title, summary, tag or search snippet. When a sweep's budget or the vault's size left pages unread, say so rather than implying full coverage. The eligible set, the bounded sweep and the evidence block are `wiki-lint`'s `reference/implicit-concepts.md`.

Reply with the lint report only — no page content dumps, no raw file listings.
