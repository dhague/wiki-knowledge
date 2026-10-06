# Ingestion-authoring rules

The rules an ingestion follows when it authors a page: the chain of evidence that makes a citation checkable, verifying every claim against the artifact that owns it, and keeping a page to facts. [`wiki-conventions`](../../wiki-conventions/SKILL.md) owns the format these rules produce.

## The chain of evidence

**Every raw file a pass produces pages from gets a `sources/` stand-in, and every page produced carries a `source` edge back to it.** Reader can always walk *page → `sources/` stub → `raw/` artifact* — the one path that makes a citation checkable.

- **No exemption for distillation.** When raw file's value lands in `concepts/`/`entities/` pages, stub still created — just a **thin stub**: `title`, one-paragraph `summary`, required `raw_source` link. Its job is to be the addressable link target.
- **`source` back-edge is not judgment.** Unlike `refines`/`contradicts`/`example-of`/`related` (weighed per page), this edge is mandatory on every page of the pass — each page of a multi-chunk split, and a page **updated in place** as much as newly created.
- **Enforced, not merely conventional.** `enchiridion ingest` validates both halves before writing: plan naming a `raw` artifact must place a `sources/` page whose `raw_source` resolves to it, and every other page in that plan must carry a `source` edge to that stub. Plan that doesn't is rejected.
- **Raw file ingestion declines outright** — spam, exact duplicate, junk — produces no pages; rule doesn't apply.

## Verify against the source

**The edge makes a citation checkable; it does not make it checked.** Every claim — a figure, a date, a name, a superlative ("best", "first", "only") — is verified when written, against the artifact that owns it: the page's own `raw/` artifact, or the primary source behind it where the artifact is silent. A `synthesis/` page has no artifact of its own, so it follows the input page carrying the claim through to *that* page's artifact — the input page points at the evidence, it is not the evidence. **A sibling `wiki/` page is never evidence:** restating one copies its error, which is how one wrong figure reaches six pages while every structural check stays green.

Going past the headline rule:

- **The artifact decides a disagreement.** Two pages at odds → check each against its own artifact; the loser does not win by being read last. Record the loser as a `contradicts` edge, plus `supersedes` on the page that replaces it ([directions](../../wiki-conventions/SKILL.md#typed-edges)).
- **Recompute derived figures.** Percentages, sums, totals and surplus/deficit are checked arithmetically against components already on the page or in the artifact — components sum to the stated total, income minus expenditure reconciles with the stated surplus/deficit. Arithmetic settles the claim that reading alone cannot.

Where an artifact refutes itself under these rules, the page takes the corrected claim by the rules above, and correcting the artifact itself is [a separate, vault-owner-authorised act](../../wiki-conventions/SKILL.md#the-raw-layer).

## Pages state facts

**A page records what is true — not what was previously believed, and not how the page came to be written.** Correction narration ("this corrects", "the brief's premise", "previously said") and vault-process meta ("this page records a `contradicts` edge", "the page ingested on <date>", "earlier passes recorded") do not belong in a page. Both read as diligence while adding nothing a reader needs, and both turn a reference work into a changelog.

Where an earlier statement or an outside source conflicts with the current one, record the [`contradicts`/`supersedes`](../../wiki-conventions/SKILL.md#typed-edges) edge and — if the disagreement is live — say so in a `> [!warning] Contradiction` callout, **in facts, naming both statements**. The disagreement is knowledge; the page's own history is not.
