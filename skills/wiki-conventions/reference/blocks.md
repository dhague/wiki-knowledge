# Agent reply block protocols

Two fenced blocks carry a structured proposal from a subagent's reply back to the session that invoked it, and this file is their one home. A block carries exactly `{kind, summary, folder}` or `{title, summary, tags, source_date, volatility, source}`. A consuming procedure validates a block against its set and rejects one missing a declared field or carrying an unknown one; it never guesses a value.

## `kind-md-proposal`

Emitted by [`wiki-ingest` step 7](../../wiki-ingest/SKILL.md), one block per custom kind-folder whose page was placed with no `KIND.md` definition; the invoking session offers to create the file and writes it on explicit yes. A decline is safe — placement already committed.

- **`kind`** — the kind value the plan used, a `vault kinds` entry whose `definition` is `null`.
- **`summary`** — one line, ≤ ~20 words: the definition `KIND.md` will declare, inferred from the folder name and the content filed there.
- **`folder`** — the vault-relative folder path, e.g. `wiki/people`.

## `save-candidate`

Emitted by [`wiki-ask` step 8](../../wiki-ask/SKILL.md) when an answer is both durable and reusable. It is **a proposal, not a write** — the session holding the conversation offers the save and runs it as a `synthesize` plan on explicit yes ([saving-synthesis.md](../../wiki-ask/saving-synthesis.md)).

- **`title`** — the synthesis page's title.
- **`summary`** — one line, ≤ ~20 words: what next retrieval judges the page by, written as well as you would want to find it.
- **`tags`** — the page's tags.
- **`source_date`** — today; a synthesis is made today even when its inputs are older.
- **`volatility`** — the most volatile of the cited pages: a synthesis is only as durable as its shakiest input.
- **`source`** — every page actually cited, as vault-relative paths, nothing merely skimmed. `enchiridion ingest` composes the links when the plan runs.
