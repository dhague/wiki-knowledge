/**
 * The move's effects, observed rather than inferred from the final tree: a
 * recording adapter stands in for the filesystem, so the order of the writes,
 * the removal and the registry rewrite is assertable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { Vault } from "./vault.js";
import type { MoveEffects } from "./vault.js";
import { Page, splitFrontmatter } from "./frontmatter.js";
import { planMove } from "./moveplan.js";
import { semanticFingerprint } from "./fingerprint.js";
import { newPageRecord } from "./pagerecord.js";
import {
  parseRegistry,
  registryRef,
  renderRegistry,
} from "./consolidationexclusions.js";

const kindDirs = [
  "wiki/concepts",
  "wiki/entities",
  "wiki/sources",
  "wiki/synthesis",
];
const pageNames = ["a", "b", "c", "d"];
const MOVE_NUM_RUNS = 100;

type Effect =
  | { op: "write"; pageRef: string; page: Page }
  | { op: "remove"; pageRef: string }
  | {
      op: "followMoveInRegistries";
      oldRef: string;
      newRef: string;
      planned: Record<string, string>;
    };

type WriteEffect = Extract<Effect, { op: "write" }>;
type RemoveEffect = Extract<Effect, { op: "remove" }>;
type FollowEffect = Extract<Effect, { op: "followMoveInRegistries" }>;

/** [MoveEffects] that records each call in order, optionally delegating to the
 * real effects so the same test can assert content and order. */
class RecordingEffects implements MoveEffects {
  readonly calls: Effect[] = [];

  constructor(private readonly inner?: MoveEffects) {}

  write(pageRef: string, page: Page): void {
    this.calls.push({ op: "write", pageRef, page });
    this.inner?.write(pageRef, page);
  }

  remove(pageRef: string): void {
    this.calls.push({ op: "remove", pageRef });
    this.inner?.remove(pageRef);
  }

  followMoveInRegistries(
    oldRef: string,
    newRef: string,
    planned: Record<string, string>,
  ): string | null {
    this.calls.push({ op: "followMoveInRegistries", oldRef, newRef, planned });
    return this.inner
      ? this.inner.followMoveInRegistries(oldRef, newRef, planned)
      : null;
  }

  /** The effect names in call order, `write <ref>` etc. */
  describe(): string[] {
    return this.calls.map((call) =>
      call.op === "followMoveInRegistries"
        ? `${call.op} ${call.oldRef} -> ${call.newRef}`
        : `${call.op} ${call.pageRef}`,
    );
  }
}

function writeVault(pages: Record<string, string>): Vault {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-move-"));
  for (const [ref, text] of Object.entries(pages)) {
    const abs = path.join(root, ...ref.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return new Vault(root);
}

/** A page that links to every other generated page — so a move rewrites
 * several pages, not only the destination. */
function linkedPage(ref: string, refs: string[]): string {
  const dir = path.posix.dirname(ref);
  const body = refs
    .filter((target) => target !== ref)
    .map((target) => `See [t](${path.posix.relative(dir, target)}).\n`)
    .join("");
  return `---\ntitle: ${path.posix.basename(ref)}\n---\n${body}`;
}

interface MoveCase {
  pages: Record<string, string>;
  oldRef: string;
  newRef: string;
}

// A small vault of pages linking to each other, plus the old/new ref of a move
// over it. The destination is either the same ref or a free one, so the move
// never silently absorbs another page.
const genMoveArb: fc.Arbitrary<MoveCase> = fc
  .record({
    names: fc.shuffledSubarray(pageNames, { minLength: 2, maxLength: 4 }),
    dirs: fc.array(fc.constantFrom(...kindDirs), {
      minLength: 4,
      maxLength: 4,
    }),
    oldIdx: fc.nat({ max: 3 }),
    newName: fc.constantFrom(...pageNames),
    newDir: fc.constantFrom(...kindDirs),
  })
  .map(({ names, dirs, oldIdx, newName, newDir }) => {
    const refs = names.map((name, i) =>
      path.posix.join(dirs[i]!, `${name}.md`),
    );
    const pages: Record<string, string> = {};
    for (const ref of refs) pages[ref] = linkedPage(ref, refs);
    const oldRef = refs[oldIdx % refs.length]!;
    const newRef = path.posix.join(newDir, `${newName}.md`);
    return { pages, oldRef, newRef };
  })
  .filter(
    ({ pages, oldRef, newRef }) =>
      newRef === oldRef || !Object.prototype.hasOwnProperty.call(pages, newRef),
  );

test("a move writes every rewritten page before it removes the original", () => {
  fc.assert(
    fc.property(genMoveArb, ({ pages, oldRef, newRef }) => {
      const vault = writeVault(pages);
      const effects = new RecordingEffects();
      const changed = vault.movePage(oldRef, newRef, effects);

      const planned = planMove(pages, oldRef, newRef);
      const writes = effects.calls.filter(
        (call): call is WriteEffect => call.op === "write",
      );
      const removes = effects.calls.filter(
        (call): call is RemoveEffect => call.op === "remove",
      );
      const follows = effects.calls.filter(
        (call): call is FollowEffect => call.op === "followMoveInRegistries",
      );

      // Written iff absent from before or text changed, and the text written is
      // the planned post-move text.
      const expected = Object.keys(planned)
        .filter((ref) => pages[ref] !== planned[ref])
        .sort();
      assert.deepEqual(writes.map((call) => call.pageRef).sort(), expected);
      for (const call of writes) {
        assert.equal(call.page.text, planned[call.pageRef]);
        if (call.pageRef in pages) {
          assert.notEqual(
            call.page.text,
            pages[call.pageRef],
            `${call.pageRef} written without a change`,
          );
        }
      }

      const removeAt = effects.calls.findIndex((call) => call.op === "remove");
      if (oldRef === newRef) {
        assert.deepEqual(removes, []);
      } else {
        assert.deepEqual(
          removes.map((call) => call.pageRef),
          [oldRef],
        );
        assert.ok(writes.some((call) => call.pageRef === newRef));
        for (const call of writes) {
          assert.ok(
            effects.calls.indexOf(call) < removeAt,
            `${call.pageRef} written after ${oldRef} was removed`,
          );
        }
      }

      // The registry is rewritten after the links whose fingerprints it caches
      // are laid down, from the post-move texts rather than the pre-move tree.
      assert.equal(follows.length, 1);
      const follow = follows[0]!;
      assert.deepEqual(follow.planned, planned);
      const followAt = effects.calls.indexOf(follow);
      for (const call of writes) {
        assert.ok(effects.calls.indexOf(call) < followAt);
      }
      if (removeAt >= 0) assert.ok(removeAt < followAt);

      assert.deepEqual(changed, writes.map((call) => call.pageRef).sort());
    }),
    { numRuns: MOVE_NUM_RUNS },
  );
});

const A = "wiki/concepts/a.md";
const B = "wiki/concepts/b.md";
const C = "wiki/concepts/c.md";
const REGISTRY = registryRef("concepts");

function registryWith(members: Array<{ pageRef: string }>): string {
  return renderRegistry([
    {
      members: members.map(({ pageRef }, index) => ({
        pageRef,
        blobOid: String.fromCharCode(97 + index).repeat(40),
        fingerprint: `sha256:${index}`,
      })),
      reason: "Distinct concepts.",
    },
  ]);
}

test("a move records its effects in their exact order", () => {
  const vault = writeVault({
    [A]: "---\ntitle: A\n---\nSee [B](b.md).\n",
    [B]: "---\ntitle: B\n---\nBody.\n",
    [REGISTRY]: registryWith([{ pageRef: A }, { pageRef: B }]),
  });

  const recorder = new RecordingEffects(vault);
  const changed = vault.movePage(B, C, recorder);

  assert.deepEqual(recorder.describe(), [
    `write ${A}`,
    `write ${C}`,
    `remove ${B}`,
    `followMoveInRegistries ${B} -> ${C}`,
  ]);
  assert.deepEqual(changed, [A, C, REGISTRY].sort());
  assert.deepEqual(
    parseRegistry(
      fs.readFileSync(vault.path(REGISTRY), "utf8"),
    ).exclusions[0]!.members.map((member) => member.pageRef),
    [A, C],
  );
});

test("the registry fingerprints planned text, never the pre-move tree", () => {
  const vault = writeVault({
    [A]: "---\ntitle: A\n---\nSee [B](b.md).\n",
    [B]: "---\ntitle: B\n---\nBody.\n",
    [REGISTRY]: registryWith([{ pageRef: A }, { pageRef: B }]),
  });
  const files = vault.loadWikiPages();
  const planned = planMove(files, B, C);

  // The pages are still pre-move on disk: a registry read from disk would cache
  // A's old link and have no text at all for C.
  assert.ok(vault.followMoveInRegistries(B, C, planned) !== null);
  const members = parseRegistry(fs.readFileSync(vault.path(REGISTRY), "utf8"))
    .exclusions[0]!.members;
  assert.equal(
    members.find((member) => member.pageRef === A)?.fingerprint,
    fingerprintOf(A, planned[A]!),
  );
  assert.equal(
    members.find((member) => member.pageRef === C)?.fingerprint,
    fingerprintOf(C, planned[C]!),
  );
  assert.notEqual(fingerprintOf(A, files[A]!), fingerprintOf(A, planned[A]!));
});

/** One page's semantic fingerprint over text, as the registry caches it. */
function fingerprintOf(pageRef: string, text: string): string {
  return semanticFingerprint(
    newPageRecord(pageRef, text),
    splitFrontmatter(text).body,
  );
}
