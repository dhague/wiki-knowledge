// The Consolidation-exclusion command group: recording a declined cluster in a
// kind-folder's `CONSOLIDATION_EXCLUSIONS.yaml` (ADR-0028). This is the one write
// path — it captures and verifies one HEAD snapshot before committing.

import type { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { Vault, resolveRoot } from "./vault.js";
import { headPageFacts, headPages, type HeadPage } from "./assess.js";
import { VaultGit } from "./vaultgit.js";
import type { Snapshot } from "./vaultgit.js";
import { Page } from "./wikipage.js";
import {
  folderOf,
  parseRegistry,
  refreshExclusions,
  registryRef,
  renderRegistry,
  upsertExclusion,
} from "./consolidationexclusions.js";
import type { Exclusion, ExclusionMember } from "./consolidationexclusions.js";
import { fail } from "./output.js";

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** One member's captured revision, or a failure naming why the cluster cannot be
 * assessed. */
function captureMember(
  ref: string,
  page: HeadPage | undefined,
): ExclusionMember {
  if (page === undefined) {
    fail(
      `${ref} is not a committed page at HEAD, so the cluster cannot be assessed`,
    );
  }
  if (page.fingerprint === null) {
    fail(`${ref} could not be read at HEAD as a page`);
  }
  return { pageRef: ref, blobOid: page.blobOid, fingerprint: page.fingerprint };
}

function exclusionMessage(members: ExclusionMember[], reason: string): string {
  const refs = members.map((m) => m.pageRef).join("\n");
  return `exclusion: Consolidation exclusion for ${members.length} pages\n\n${refs}\n\n${reason}\n`;
}

/** The git surface [addExclusion] needs, so a test can drive the snapshot race
 * the two HEAD reads guard against. */
export interface ExclusionGit {
  committedPages(since: string): Promise<Snapshot>;
  stageAndCommit(paths: string[], message: string): Promise<string>;
}

/** Record one declined cluster, committing the registry on its own. Exported
 * for the black-box tests, which drive it against a real vault. */
export async function addExclusion(
  root: string,
  refs: string[],
  reason: string,
  git: ExclusionGit = new VaultGit(root),
): Promise<void> {
  const vault = new Vault(root);
  const members = [...new Set(refs.map((ref) => path.posix.normalize(ref)))];
  if (members.length < 2) {
    fail("an exclusion names at least two member pages");
  }
  const folder = folderOf(members[0]);
  for (const ref of members) {
    if (folderOf(ref) !== folder) {
      fail(
        `an exclusion's members share one kind-folder; ${ref} is not in wiki/${folder}/`,
      );
    }
  }
  if (!vault.isConsolidatable(folder)) {
    fail(
      `wiki/${folder}/ is not a consolidatable kind-folder, so it holds no Consolidation exclusions (ADR-0027)`,
    );
  }

  const before = await git.committedPages("");
  if (before.head === "") {
    fail(`no commits at ${root}; an exclusion is recorded against HEAD`);
  }
  const snapshot = await headPages(root);
  const captured = members
    .map((ref) => captureMember(ref, snapshot.pages.get(ref)))
    .sort((a, b) => a.pageRef.localeCompare(b.pageRef));

  const ref = registryRef(folder);
  let existing: Exclusion[] = [];
  let text: string | null = null;
  try {
    text = fs.readFileSync(vault.path(ref), "utf8");
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
  if (text !== null) {
    const parsed = parseRegistry(text);
    if (parsed.error !== null) {
      fail(
        `${ref} is malformed (${parsed.error}); repair it by hand before recording an exclusion`,
      );
    }
    // The whole file lands on the captured snapshot, not just the new record:
    // a refreshed cache is one the fast path can use at once, and a member that
    // no longer matches keeps its stale cache — pruning is confirm-first.
    existing = refreshExclusions(
      parsed.exclusions,
      headPageFacts(snapshot.pages),
    );
  }

  const rendered = renderRegistry(
    upsertExclusion(existing, { members: captured, reason }),
  );
  if (rendered === text) {
    console.log(ref);
    return;
  }
  // The registry must land on the snapshot the blob oids were captured from; a
  // commit that raced past it would pin revisions from two different trees.
  if (before.head !== (await git.committedPages("")).head) {
    fail(
      "HEAD moved while the snapshot was captured; re-run against a fresh snapshot",
    );
  }
  vault.write(ref, new Page(rendered));
  await git.stageAndCommit([ref], exclusionMessage(captured, reason));
  console.log(ref);
}

export function registerExclusionCommand(program: Command): void {
  const exclusion = program
    .command("exclusion")
    .description(
      "Record a declined Consolidation cluster so lint stops proposing it (an exact member-set match)",
    );

  exclusion
    .command("add")
    .argument(
      "<page_ref...>",
      "the declined cluster's members, all in one consolidatable kind-folder",
    )
    .requiredOption("--reason <text>", "why the cluster should not consolidate")
    .description(
      "Capture the members' HEAD revisions and commit them to the kind-folder's CONSOLIDATION_EXCLUSIONS.yaml",
    )
    .action(async (refs: string[], opts: { reason: string }) => {
      await addExclusion(resolveRoot(), refs, opts.reason);
    });
}
