# Agent-facing errors name what failed, and a remedy only where one is not derivable

`enchiridion` is a script layer an *agent* drives, not a person at a terminal ([ADR-0017](0017-bundled-typescript-on-installed-interpreter.md)). Its only channel for "this did not work" is a line on stderr and exit 1 (`output.ts`). The design review in [#658](https://github.com/dhague/wiki-knowledge/issues/658) produced the general principle — any enchiridion behaviour an agent must *react to* belongs in the skill text — and [#662](https://github.com/dhague/wiki-knowledge/issues/662) carries that sweep for the shipped prose. The error surface is the other half of the same principle: before an agent consults the skill text, it has to understand what the CLI just told it.

That surface had never been held to any bar. [#661](https://github.com/dhague/wiki-knowledge/issues/661) fixed one instance — the Consolidation losslessness gate now names the block that failed to match. The audit in [#667](https://github.com/dhague/wiki-knowledge/issues/667) enumerated every agent-reachable refusal (validator problems in `ingest.ts`, argument parsing, vault-root resolution, git and commit failures, the search index, the export writer, session capture) and found a spectrum: the vault-root refusal names the root, the rule and the `init` command that fixes it; `enchiridion --badflag` printed thirty lines of usage to stderr, exit 1, and never named `--badflag`; `page get` on a missing file surfaced the host runtime's `ENOENT: no such file or directory, open '…'`; an agent-authored plan with `"pages": [null]` surfaced `Cannot read properties of null (reading 'op')`; and the legacy kind-folder remedy printed `git mv wiki/entity/* wiki/entitys/`, a command that creates the wrong folder.

## Decision

Every failure an agent can reach names **(1) the offending entity** — the ref, key, file, flag, index or path — and **(2) the rule or cause**. It names **(3) a concrete next step only where an agent could not derive one** from (1) and (2).

A leaked host-runtime error, or a message that names no entity, is a defect in the message layer — not a cosmetic one — even when the refusal itself is correct.

The bar is a property of the message text. Exit codes are unchanged, no new failure mode is introduced, and a wrapped error names the path the *agent* supplied, never an internal one.

## Why

- **The agent's fallback is reading the bundle.** With no usable message its next move is to read `scripts/enchiridion.cjs` — a build artifact ADR-0017 regenerates, and not a spec. A message that says what to do is what prevents that, and #662 is the complementary half rather than a substitute: a document the agent must read to interpret a line is one more thing that can drift.
- **Remedy clauses are not free, so they are not universal.** Most validator problems — `plan.title is required`, `pages[0].kind must not be set for op=update` — already name the field and the rule, and the remedy is their mechanical inverse. Demanding a remedy on every string would be churn, and churn is what makes the next genuine gap invisible. The clause is spent where the fix is *not* derivable: which valid kind, which `op`, which command produces the snapshot pin, which lock file to remove.
- **A wrong cause is worse than no cause.** The legacy kind-folder remedy is the clearest case: it named an entity and a next step, and the next step was wrong. So the bar applies to the *content* of each clause, not merely its presence.
- **The message is the only channel that has to carry it.** Prose is the whole contract today, and the surface question — a stable code, or a `--json` error document — has no caller that needs it yet; it is split out to [#674](https://github.com/dhague/wiki-knowledge/issues/674).

## Considered options

- **A strict three-part bar on every message.** Rejected: it converts ~200 mechanical restatements into diff noise and buries the handful that actually fail.
- **Fix only the messages that name nothing at all.** Rejected: it leaves the messages whose cause is *wrong*, which is the more expensive failure — an agent follows the advice and creates `wiki/entitys/`.
- **A stable leading error code, or a `--json` error document.** Deferred to [#674](https://github.com/dhague/wiki-knowledge/issues/674). It is a cross-cutting change to the output contract, and the distinction an agent most needs — bad invocation versus bad environment — is an exit-code change, which is out of scope here.
- **A command-name prefix on every failure** (`enchiridion check: …`). Rejected: the verb is usually already in the message, so the prefix duplicates rather than informs.
- **Do nothing to the messages and document them all in the skill text.** Rejected: it makes the agent interpret a one-line refusal through a document, and the two drift apart.

## Consequences

- `output.ts` stays the single renderer; the bar constrains what a `fail()` or throw hands it. Enforcement is review plus the tests that pin the audited strings.
- A refusal that crosses a module boundary names the caller's entity: `decodePlan` takes the plan path, `ingestignore.parse` takes the policy file, and the `page` commands prefix the file they were given.
- Findings the audit surfaced that are **not** message defects are their own tickets, not part of this one: `init` inside an existing work tree creates a broken vault, because `VaultGit.isWorkTree` walks up while `commit` does not ([#671](https://github.com/dhague/wiki-knowledge/issues/671)); several commands silently accept typos and unvalidated input, exiting 0 ([#673](https://github.com/dhague/wiki-knowledge/issues/673)); a page with unparsable frontmatter vanishes from the index and is reported as uncommitted ([#672](https://github.com/dhague/wiki-knowledge/issues/672)); and the hooks swallow every diagnostic with no trace anywhere ([#675](https://github.com/dhague/wiki-knowledge/issues/675)).
- Hooks are out of scope by decision: they fail open, swallow their errors, and no hook diagnostic reaches an agent, so there is no agent-facing message to hold to the bar.
