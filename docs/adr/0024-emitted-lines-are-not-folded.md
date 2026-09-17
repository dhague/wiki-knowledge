# Emitted frontmatter is never line-folded

**Context.** A frontmatter link scalar is a doubly-encoded value: the link's own percent-encoding, then YAML's quoting. The emitter (`eemeli/yaml`) folds any scalar that outgrows its line width — 80 by default — at a space when it finds one, and **mid-token with a trailing backslash** when it does not. A percent-encoded destination holds no space, so a long slug folded mid-token as a matter of course, and a long title folded at a space, splitting the link's own label.

The limit was never this project's decision. The Python writer that preceded the TypeScript layer set `y.width = 4096  # never line-wrap long scalars` — deliberately off. The Go rewrite could not carry the setting across (`gopkg.in/yaml.v3` exposes no width knob), and this port passed no `lineWidth` at all, so the default came back twice without anyone choosing it. Nothing in the repo ever asked for a width: no ADR, no `CONTEXT.md` entry, no conventions rule, no issue.

What folding costs is not bytes but readers. A folded destination is a link no longer on one line, so every raw-text reader — `iterLinks` and everything built on it — has to be taught the shape, and #486 is what happens when one is not: `check orphans` reported 32 false orphans in a 119-page vault, `enchiridion vault move` silently left a dangling link, `check frontmatter-link-format` read a folded unencoded destination as clean, and export backlink counts missed folded edges. A near-miss attended it: the linter's fragmentation check is confirm-first, which is the only reason a run that surfaced the folds did not delete 32 live pages.

**Decision — the writer folds nothing; readers keep their tolerance.** `renderFrontmatter` passes `lineWidth: 0`, so a link scalar reaches the file on one line however long it is. This is the only mechanism under which that is true *by construction*: stripping escaped line breaks from otherwise-folded output would fix the 187 destination folds the Windsor vault carries and leave all 338 label folds, which are plain newlines rather than continuations.

The reader-side machinery stays with no expiry date. Folds exist on disk — 110 of Windsor's 124 pages carry at least one — and a page restored from backup or written by an older plugin is indistinguishable from a legacy one, so `ESCAPED_LINE_BREAK_RE`, `DEST_ATOM`, `ANGLE_DEST` and the whole-span splice (#488) keep their tests and their behaviour. The move property test's fixture now writes its fold by hand for the same reason: the fixture must carry the shape the oracle exists to compare, whatever the emitter does.

## Consequences

- A long destination is a long line. Measured, that shape is already everywhere: the dogfood vault has 490 frontmatter link lines past the fold trigger with no folds at all, the longest 220 columns, and every reader handles them.
- Line width is not a retrievability property. The search index stores parsed `title`/`summary` and the raw body, so folding never affected recall; nothing downstream of the vault reads line structure either.
- The `wiki-conventions` spec states the contract in both directions — the writer emits no fold, and a fold already on disk is legal YAML that readers resolve. #486 is the cost of leaving that implicit.
- [ADR-0012](0012-frontmatter-round-trip-relaxed.md)'s measured divergence was understated when it recorded scalar quote style as the only difference: folding was a second, unmeasured class, invisible because its property pool held only short values. The pool now carries a value long enough to fold, so the round-trip property is a fold guard too.
- A folded destination is still splices-whole: a move that rewrites one flattens it, so a page can lose a line but never gain one. That stays asserted.

## What would reopen this

A reader that genuinely needs bounded lines — a diff tool, a terminal viewer, a formatter in the write path — would be the first named consumer of a width limit this project has ever had. The answer then would be a formatter applied to whole files under its own decision, not a fold reintroduced into the emitter, because the fold's real cost is the reader tolerance it forces on everyone else.
