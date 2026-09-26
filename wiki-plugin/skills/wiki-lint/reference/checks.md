# Check semantics and fix rationale

Why each mechanical check reports what it does, and why each fix declines an
ambiguous page. Rationale only: the run block, the fix-level table and the
report shape live in [`../SKILL.md`](../SKILL.md).

## `kind-folder-conformance`

Every `.md` under `wiki/` must sit directly under a valid kind-folder —
`KIND.md` and `_index.md` excepted. That covers the canonical four and any
custom kind-folder already present in the vault, which the plugin treats as a
peer target and never auto-creates. A page at the `wiki/` root, or nested below
a kind-folder, is a violation.

Confirm first because the repair is `enchiridion vault move`, which is correct
but touches every inbound and outbound link — cheap to run, expensive to get
wrong unattended.

## `ingestion-source-integrity`

Every `wiki/sources/*.md` page must carry `raw_source:`, the one pointer into
the immutable artifact the page stands in for.

Auto-fix only when the body holds exactly one `raw/` link: that link is
unambiguously the artifact, so quoting it into `raw_source:` invents nothing.
Two or more links make the choice a judgment, so the page falls to report only.

## `frontmatter-link-format`

Frontmatter edge values must be quoted markdown links with percent-encoded
destinations — the link form [`wiki-conventions`](../../wiki-conventions/SKILL.md#links)
owns.

Quoting and encoding are mechanical rewrites, so they auto-fix. An edge value
that is not a markdown link at all — a bare `wiki/concepts/foo.md`, a non-string
entry — is report only, because a fix cannot invent a label; re-set it with
`page set`, which composes a vault-relative ref into a link, or `page merge`
with a JSON list. Such a value is also why the other checks read on past it
instead of aborting blank: the record parser refuses the key, so a later check
would otherwise report an unrelated page as broken.

## `tags-shape`

Every page's `tags` must be a YAML sequence of plain tags — a non-empty token
carrying no whitespace, comma or quote. A numeric or boolean entry is read as
its string form, exactly as the index reads it, so it is a reachable tag.

A scalar value reads as no tags at all, and an entry holding a delimited list
collapsed into one string indexes as a single junk tag. Either way the page
still shows a value while every tag filter misses it, so the failure is silent
at both ends: nothing else in `check` or retrieval names it. A missing `tags`,
or a bare `tags:`, is no tags rather than a malformed one, and stays clean.

Report only. The repair re-types the tag list, and which tags the author meant
is judgment a rewrite cannot recover — a comma-or-quote-bearing entry is exactly
the case where guessing would invent tags.

## `stale-synthesis`

Synthesis pages whose last commit is more than 30 days old. Any churn in their
inputs can move a saved query result out of date, and the check cannot tell
whether it did. Report only — refreshing is an authored judgment, not a rewrite.

## `missing-volatility-source-date`

Pages missing `volatility` or `source_date`. Both values are judgment git cannot
reconstruct: `volatility` is authored, and `source_date` is valid time rather
than commit time. Report only.

## `unresolved-supersession`

A page with a `contradicts:` edge, no `supersedes:` edge, and no active
contradiction callout — a contradiction that was settled but never recorded as a
replacement. The pair to it is `contradiction-callouts`, which owns the case
where `contradicts:` and an active callout are both present: that is a live
contradiction, not an unrecorded resolution. Report only.

## `contradiction-callouts`

Pages carrying an active `> [!warning] Contradiction` callout. Report only —
this check surfaces the conflict; deciding which side wins is judgment.

## `orphans`

Pages with zero inbound links, body or frontmatter. Confirm first, because the
repair deletes committed pages.

## `split-links`

No link may be split across lines. Three shapes exist, all legal YAML in
frontmatter: a destination folded mid-slug with a trailing `\`, a label folded
at a space, and a break between a label's `]` and its destination's `(`. All
three fold back to the same value under any conforming parser, and the fix joins
all three: a destination and the label/destination boundary join with nothing, a
label with one space — the way YAML folds one.

The check is scoped to double-quoted frontmatter scalars: raw text cannot tell a
block scalar (`related: |`) from a fold, so nothing outside that shape is
reported or joined. A body split is report only because it is not a link at all
under CommonMark — `[T](path.md` and `"title")` on separate lines render as
prose — so `vault move` never rewrites it, and joining on sight could silently
repoint one. That rule and its reason are deliberate: a legal markdown break is
not the agent's to join.

## `duplicate-frontmatter`

A page's frontmatter is exactly one leading `---` block. A second block is
invisible: the parser stops at the first, so the later block's typed edges reach
no check, and its text renders as body prose in a Markdown viewer. No check that
reads edges can see it — they all read the first block — and the raw-text checks
see well-formed frontmatter either way.

Auto-fix when one block holds every key and list entry of the others: dropping
the rest is lossless, whichever block wins, and the fix promotes the winner when
it is the later one. Report only when the blocks diverge — two different
`title:` values, or a key present with a different value — or when a block is
not a readable YAML mapping, because neither which side is current nor what the
block holds is recoverable by a rewrite.

## `concept-fragmentation`

Clusters of small, closely-related `concept` pages — and custom-kind pages that
behave like concepts — whose knowledge reads better as one page with sections
(CONTEXT.md, **Concept fragmentation**). `entity`, `source` and `synthesis`
pages are never in scope: their one-per-thing or one-per-artifact identity
forbids consolidation.

One finding per cluster. Its `cluster` payload carries the members with committed
byte size and inbound-link count, the shared basis (tags or title words), the
weakest pairwise similarity holding the cluster together, and a suggested
survivor (most inbound links, largest body as tie-break). The `pageRef` is that
survivor and the `detail` a one-line summary; the suggestion is a hint, not a
verdict, and the user may override it.

`--min-similarity <n>` (default `0.5`) is the one cutoff. Similarity is computed
over tags and title tokens, and the reported number is the *weakest* pair in the
cluster — the bare minimum the cluster needs to hold together, not an average
that a strong pair could inflate past the bar. At or above the cutoff a pair is
one concept; below it the pair belongs to missing cross-references.

The check reads the committed index, so it sees only committed pages: an
uncommitted draft is invisible until committed.

Confirm first — a Consolidation, always one cluster per handoff and never
auto-applied, because absorbing a cluster deletes committed pages.

## Why a fix skips an ambiguous page

Both auto-fixes that touch links act only where the answer is forced: one `raw/`
link in the body, or exactly one page bearing the matching title. Ambiguity
means the fix cannot know which target the author meant, and a wrong guess is
silent — a link that resolves to the wrong page passes every later check. So the
fix leaves the page alone and the check reports it, and the invoking session
proposes the repair instead.
