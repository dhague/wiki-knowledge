/**
 * The stdout lines, fields and reply blocks shipped procedures parse, declared
 * once so the structural checks can tie the prose to them. [output.ts] owns the
 * *format*; this owns the caller-visible content.
 */

/** `ingest`'s stdout, in the order it is written: the commit SHA first, then
 * the refs of the pages it wrote, then the tool-call cost summary — the last
 * only when a hook log exists. */
export const IngestStdout = [
  "commit SHA",
  "written page refs",
  "tool-call cost summary",
] as const;

/** The fields of one `vault kinds` entry, in emitted order. */
export const KindFields = [
  "kind",
  "folder",
  "canonical",
  "consolidatable",
  "definition",
] as const;

/** The fields of an entry's `definition`, or `null` when it declares none. */
export const KindDefinitionFields = ["kind", "summary"] as const;

/** `watch`'s two startup lines, as the literal prefix a caller keys on: a
 * running watcher, and the refusal when another holds the vault's lock. */
export const WatchStartedMarker = "watching ";
export const WatchLockedMarker = "another watcher is already running (lock at ";

/** `kind-md-proposal`: the block `wiki-ingest` emits for a missing `KIND.md`. */
export const KindMdProposalBlock = "kind-md-proposal";
/** The fields a `kind-md-proposal` block carries, in declared order. */
export const KindMdProposalFields = ["kind", "summary", "folder"] as const;

/** `save-candidate`: the block read-only retrieval emits for a keepable answer. */
export const SaveCandidateBlock = "save-candidate";
/** The fields a `save-candidate` block carries, in declared order. */
export const SaveCandidateFields = [
  "title",
  "summary",
  "tags",
  "source_date",
  "volatility",
  "source",
] as const;
