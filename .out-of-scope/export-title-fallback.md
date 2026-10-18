# Resolved export title on `ExportMeta`

The export does not carry a wiki title on `ExportMeta`, and the render layer keeps
its own neutral `"Wiki"` fallback. The title is resolved once in the writer, travels
in `ExportOptions.title`, and `exportTitle()` at the render edge stays.

## Why this is out of scope

**The premise that would make it a fix does not hold.** No production render call
can miss the resolved title. The only non-test caller of a render entry point is
`runExport`, which resolves at one site (`resolveExportTitle` in
[`exportconfig.ts`](../../enchiridion-ts/src/exportconfig.ts)) and passes the result
into all three render entries through the same `ExportOptions` object it passes to
`buildExportMeta` ([`exportwriter.ts`](../../enchiridion-ts/src/exportwriter.ts)).
Every call site that reaches a renderer with no title is a test. The sole literal
divergence is a filesystem root, whose `basename` is empty — and there `exportTitle`
produces the better answer: a neutral nav label rather than an empty one.

**ADR-0023 decides the two-level arrangement on purpose.** Decision 2 describes the
filesystem-root case as landing "on the render layer's neutral label … the
last-resort default #476 already established, not a second resolution". Decision 3
is explicit that "renderers receive the resolved string and never inspect a vault,
and a render pass invoked with no vault at all keeps the neutral `"Wiki"` label from
#476". Moving the title onto `ExportMeta` and deleting `exportTitle` would not make
the code match the ADR; it would delete a provision the ADR blesses.

**It is a re-shuffle, not an ownership fix.** `ExportOptions.title` is already
documented as "already resolved by the caller", and it arrives in the same call as
`meta` everywhere `meta` is built. [#490](https://github.com/dhague/wiki-knowledge/issues/490)
moved the exported set onto `ExportMeta` because three modules independently
re-derived it; the title has no such duplication — one resolver in the writer plus
one render-side default for the no-vault case, two different jobs.

## What would reopen this

A consumer that has `ExportMeta` but not `ExportOptions` and needs the title — a
render entry that never receives opts, or code that persists `meta` across a
boundary. Name that consumer in the request. The additive field alone is not a
reason; with no consumer it is an unused property.

## Prior requests

- [#713](https://github.com/dhague/wiki-knowledge/issues/713): "export: keep the
  render-side title fallback (ADR-0023 calls it not a second resolution)" —
  architecture review 2026-10-12, candidate 7 of 7.
