# Implicit concepts: the eligible set, the sweep, and the evidence

`../SKILL.md` step 4 owns where this check sits among the judgment checks, and
the three-way boundary it shares with `concept-fragmentation` and missing
cross-references. This file owns its input: which pages are eligible, how their
bodies are read inside a budget, and what a proposal must cite.

## The eligible set

A page is eligible when it is a page at `HEAD` — `wiki/<kind-folder>/<file>.md`,
three segments deep, never `KIND.md` or `_index.md`. `read-pages` resolves that
set itself, so a misplaced page and an uncommitted draft are both outside it and
no caller re-derives the rule.

The sweep also skips the pages the mechanical pass already flagged: pass each
finding's `pageRef` as `--exclude`. A flagged page is either about to be
repaired or already reported, so its body is not this check's input.

Eligibility is the **sweep's** rule. An explicit read serves any committed page,
flagged or not, because another judgment check may need it.

## The sweep

Read the eligible bodies in bounded batches from one committed snapshot:

```bash
"$RUNTIME" "$ENCHIRIDION" read-pages --exclude <flagged-ref> [--exclude <flagged-ref> ...]
```

One JSON document:

```json
{
  "head": "<the HEAD every body was read at>",
  "eligible": 214,
  "returned": 12,
  "cached": 3,
  "next_after": "wiki/concepts/x.md",
  "remaining": 202,
  "budget": {"spent": 12, "cap": 60, "exhausted": false},
  "pages": [
    {"page_ref": "wiki/concepts/x.md", "blob_oid": "<git-object-id>", "title": "X", "bytes": 812, "cached": false, "body": "<the page's body>"}
  ]
}
```

One batch is at most `--limit` pages (default 12) or `--max-bytes` of body
(default 49152), whichever comes first, and one oversized page is still returned
rather than stalling the sweep. Continue from the cursor:

```bash
"$RUNTIME" "$ENCHIRIDION" read-pages --after wiki/concepts/x.md --exclude <flagged-ref>
```

The run's ledger and budget are step 4's; `--reset` is passed once, on the run's
first body read. The budget (`--budget`, default 60) bounds what the sweep newly
reads, `spent` counts every body the run has read, and `exhausted: true` means
the sweep stopped at the cap. A body already read this run comes back `cached:
true` and costs nothing.

Stop when a batch returns nothing new, `next_after` is null, or `exhausted` is
true. Missing a term in an unread page costs nothing; claiming coverage the run
did not have does, which is why step 7 reports what went unread.

## The evidence

A proposal is a claim about bodies, so it carries their references:

```json
{
  "head": "<the head the read-pages document named>",
  "term": "backup rotation",
  "supporting": [
    {"page_ref": "wiki/concepts/a.md", "blob_oid": "<read-pages blob_oid>"},
    {"page_ref": "wiki/concepts/b.md", "blob_oid": "<read-pages blob_oid>"},
    {"page_ref": "wiki/concepts/c.md", "blob_oid": "<read-pages blob_oid>"}
  ],
  "rationale": "One or two sentences naming the pages and why the term earns a page of its own."
}
```

- `supporting` holds **at least three** pages, each one whose `body` this run
  read and in which the term appears. One page carrying the term twice is still
  one page.
- `head` and every `blob_oid` come verbatim from the `read-pages` document, so
  anyone — a human, or a test — can re-run `read-pages` on those refs and get the
  same revisions back. That is what makes "the bodies were read" checkable rather
  than asserted, and the run's ledger (`.wiki-knowledge/lint-bodies.json`, keyed
  by `head` and each page's `blob_oid`) records the same read before the proposal
  existed.
- No page of the vault carries the term as its title. A term that is a page's
  title is a missing cross-reference or a missing edge, not an implicit concept.

The proposal's wording, and the command that follows a yes, are
[`proposals.md`](proposals.md)'s.

## What is not evidence

A title, a summary, a tag, a `search` snippet, or a page's mere existence. They
may *nominate* a term worth sweeping for, but recurrence is a fact about bodies:
a term seen only in frontmatter or in a snippet has not been read, and a proposal
resting on one is a guess the run cannot support.

## The direction boundary

This check creates the page that does not exist. It never collapses pages that
do (`concept-fragmentation`) and never joins two that exist (missing
cross-references). Step 4's three-way paragraph is the one statement of the
boundary; nothing here restates it as a second rule.
