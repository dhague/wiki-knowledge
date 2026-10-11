# Consolidation losslessness compares content, not presentation

[ADR-0021](0021-consolidation-is-lossless-delete-not-supersede.md) made a Consolidation a *lossless delete*: every absorbed page's content becomes part of the survivor, so deleting the original drops nothing. The executor's gate implemented "content" as *bytes* — each absorbed body had to appear as one unbroken byte run in the survivor's authored body, after link canonicalisation. That made the real acceptance criterion *copy the absorbed bytes*, and three failures followed, each reproduced live:

- **Line endings.** `assess` reads committed `HEAD` blobs (LF); the gate read the working tree, where a `core.autocrlf=true` checkout holds CRLF. Following the documented procedure — assess, author from that text, pin, `ingest` — failed every time on such a checkout, in both directions.
- **Reflow.** An absorbed paragraph rewrapped onto one line failed.
- **Nesting.** The procedure tells the agent to carry each absorbed page in as a section, which demotes any page's own level-2 headings. That failed, so the procedure and the executor contradicted each other.

The gate also checked only the pages being deleted. For an `update` survivor, replacing its entire body with the absorbed content passed. And because containment is one-directional, an absorbed paragraph lost between `assess` and `ingest` still passed whenever the survivor was longer.

## Decision

The losslessness gate asserts **content containment**: every word of each absorbed page, and of an `update` survivor's own former body, survives in the survivor's authored body, in order, as a contiguous run, with its links still resolving to the same pages. Presentation is not compared.

The comparison canonicalises links by resolved target (unchanged), splits each body into its top-level markdown blocks, renders each block to HTML and normalises it, and requires the absorbed block sequence to appear as a contiguous sub-sequence of the survivor's. The boundary between presentation and content — every row of what is normalised away and what stays significant — is specified once, in `bodycontent.ts`'s module comment, as that module's only spec. This ADR records the principle and the non-obvious exclusions; it deliberately does not restate the enumeration.

## Why

- **The vocabulary was already right; the implementation had drifted.** ADR-0021 says a Consolidation's safeguard is that "the survivor must contain the losers' content". A gate that refuses a merge which loses nothing, and passes one that rewrites the survivor, is enforcing something else. Naming the boundary in one place is how "content" stops drifting from the code the next time.
- **The procedure's instructions are content-preserving by design.** Carrying an absorbed page in as a section necessarily changes heading levels; rewrapping a paragraph for flow changes line breaks. If the gate refuses those, it is refusing the procedure it is meant to guard, and the agent must choose between coherent structure and passing.
- **Some differences look like content but are rendering artifacts.** markdown-it renders a hard break as `<br>`, an ordered list's start number as `<ol start="3">`, and table alignment as a cell `style`, so each of those must be stripped explicitly or a presentation-only difference stays significant. Conversely, inline code, fenced-code content and its language, and strong-vs-emphasis are *content*: `**x**` and `*x*` say different things, so they must stay significant even though both are "just formatting".
- **An oracle that guards only the deleted pages is not a losslessness guarantee.** The survivor is the page being kept; its own former body is exactly what a careless merge would overwrite. Checking it closes the gap for `update` survivors at no cost, since a `create` survivor has no prior body.
- **The snapshot pin is the only guard against resurrection.** Containment cannot see an absorbed page that *shrank* between `assess` and `ingest`: the shorter new body is still contained in the survivor's longer text, so the merge resurrects nothing but silently drops the removed text. Making `assessed` required for `consolidate` costs nothing — an absorbed page git has never tracked already hard-errors at commit — and turns an optional guard into the rule.

## Considered options

- **Document the gate's byte sensitivity instead of changing it.** The maintainer's decision was to normalize, not document: the sensitivity is an implementation artifact, and making agents copy bytes verbatim is a worse contract than making the gate mean what its name says.
- **Normalize line endings only** (the original scope of this work). It fixes the reported `core.autocrlf` failure but leaves reflow and heading demotion — the other two contradictions between the procedure and the executor — in place.
- **Compare the two bodies' rendered HTML wholesale.** Loses block order as a distinct fact and makes "contiguous run" meaningless; a block that merely moved would read as a whole-document change.
- **A line-level diff or similarity threshold.** A reflow rewrites every line it touches, so a line diff reports a small change as total; a threshold reintroduces the judgment call the gate exists to make deterministically, and would pass genuine content loss.
- **Normalize more — interior spacing, trailing whitespace, punctuation, formatting.** Erases distinctions that are content: `no, X` and `no X`, or a word and its emphasis. Trailing whitespace and hard breaks are the edge, and they are normalised because HTML renders them as insignificant.
- **Keep `assessed` optional and rely on it only when present.** Leaves the resurrection gap open for every plan that omits it, which is the default.

## Consequences

- `bodycontent.ts` owns the boundary; `ingest.ts`'s module comment cites it rather than restating it, and no other document enumerates it. A second list is how ADR-0021's "content" drifted from the code's "bytes" in the first place.
- The gate normalises only for comparison. The survivor's body is written with the line endings the plan authored, unmodified.
- A refusal names the first absorbed (or survivor-former) block that failed to match, by its opening source line, so an agent can act on the message without reading the script.
- `assessed` is required on `consolidate`; `decodeAssessment` and `assessmentErrors` are unchanged, and several existing plans needed a pin added.
- **The gate's skill-text section is not part of this change.** [#658](https://github.com/dhague/wiki-knowledge/issues/658) documents the semantics for the agent and is blocked on this ADR. Absorbed-page frontmatter — typed edges and `raw_source` — remains outside the comparison ([#666](https://github.com/dhague/wiki-knowledge/issues/666)).
