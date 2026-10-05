/**
 * The Consolidation recommendation and exclusion flow, end to end against real
 * committed vaults: conflict-edge suppression, the registry's two-tier
 * validation, `exclusion add`, `fix consolidation-exclusions`, `assess`, and a
 * page move that follows the registry (ADR-0028).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as git from "isomorphic-git";
import {
  conceptFragmentation,
  consolidationExclusions,
  fixConsolidationExclusions,
  type Finding,
} from "./check.js";
import { VaultRead } from "./vaultread.js";
import { Vault } from "./vault.js";
import { VaultGit } from "./vaultgit.js";
import type { Snapshot } from "./vaultgit.js";
import { addExclusion } from "./exclusioncommand.js";
import { assessCluster, assessmentErrors, ErrAssess } from "./assess.js";
import {
  parseRegistry,
  registryRef,
  renderRegistry,
} from "./consolidationexclusions.js";
import { decodePlan, resolve } from "./ingest.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const A = "wiki/concepts/cache-eviction.md";
const B = "wiki/concepts/cache-invalidation.md";
const C = "wiki/concepts/cache-warming.md";
const REGISTRY = registryRef("concepts");

function taggedPage(
  title: string,
  tags: string[],
  extra = "",
  body = "Body text.\n",
): string {
  const lines = tags.map((t) => `  - ${t}`).join("\n");
  return `---\ntitle: ${title}\nsummary: ${title}.\ntags:\n${lines}\n${extra}---\n${body}`;
}

/** The fragmentation fixture: two concept pages above the default similarity
 * bar, plus a third that joins them. */
function fixture(): Record<string, string> {
  return {
    [A]: taggedPage("Cache eviction", ["caching", "performance"]),
    [B]: taggedPage("Cache invalidation", ["caching", "performance"]),
    ".gitignore": ".wiki-knowledge/\n",
  };
}

async function commitAll(root: string, message = "fixture"): Promise<string> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".wiki-knowledge") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else files.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  };
  walk(root);
  // Deleted-but-tracked paths must be named too: VaultGit.add stages a removal
  // only for a missing path it was handed, and those fixtures delete pages.
  let tracked: string[];
  try {
    tracked = await git.listFiles({ fs, dir: root, ref: "HEAD" });
  } catch {
    tracked = [];
  }
  for (const file of tracked) {
    if (!fs.existsSync(path.join(root, file))) files.push(file);
  }
  // VaultGit.add, not git.add: isomorphic-git stages no removals.
  await new VaultGit(root).add(files);
  return git.commit({
    fs,
    dir: root,
    message,
    author: {
      name: "t",
      email: "t@e.com",
      timestamp: 1700000000,
      timezoneOffset: 0,
    },
    committer: {
      name: "t",
      email: "t@e.com",
      timestamp: 1700000000,
      timezoneOffset: 0,
    },
  });
}

async function committedVault(pages: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-consol-"));
  for (const [rel, text] of Object.entries(pages)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  await git.init({ fs, dir: root });
  await commitAll(root);
  return root;
}

function read(root: string): VaultRead {
  return new VaultRead(root);
}

function registryText(root: string): string {
  return fs.readFileSync(path.join(root, ...REGISTRY.split("/")), "utf8");
}

function writeRegistry(root: string, text: string): void {
  const abs = path.join(root, ...REGISTRY.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** The registry blob as HEAD holds it, or null when it isn't committed. */
async function committedRegistry(root: string): Promise<string | null> {
  try {
    let oid: string | null = null;
    await git.walk({
      fs,
      dir: root,
      trees: [git.TREE({ ref: "HEAD" })],
      map: async (filepath, [entry]) => {
        if (!entry) return null;
        if (filepath === REGISTRY) oid = await entry.oid();
        return (await entry.type()) === "tree" ? filepath : null;
      },
    });
    if (oid === null) return null;
    const { blob } = await git.readBlob({ fs, dir: root, oid });
    return Buffer.from(blob).toString("utf8");
  } catch {
    return null;
  }
}

function clusterRefs(findings: Finding[]): string[] {
  return findings.flatMap(
    (f) => f.cluster?.members.map((m) => m.pageRef) ?? [],
  );
}

// ---------------------------------------------------------------------------
// Conflict edges suppress a proposal
// ---------------------------------------------------------------------------

test("a contradicts edge between candidate pages suppresses the cluster", async () => {
  const root = await committedVault({
    ...fixture(),
    [A]: taggedPage(
      "Cache eviction",
      ["caching", "performance"],
      'contradicts:\n  - "[Cache invalidation](cache-invalidation.md)"\n',
    ),
  });
  assert.deepEqual(await conceptFragmentation(read(root)), []);
});

test("a supersedes edge between candidate pages suppresses the cluster", async () => {
  const root = await committedVault({
    ...fixture(),
    [A]: taggedPage(
      "Cache eviction",
      ["caching", "performance"],
      'supersedes:\n  - "[Cache invalidation](cache-invalidation.md)"\n',
    ),
  });
  assert.deepEqual(await conceptFragmentation(read(root)), []);
});

test("a conflict edge anywhere in the transitive cluster drops the whole proposal", async () => {
  const pages: Record<string, string> = {
    ...fixture(),
    [C]: taggedPage("Cache warming", ["caching", "performance"]),
  };
  const clean = await committedVault(pages);
  assert.deepEqual(
    clusterRefs(await conceptFragmentation(read(clean))).sort(),
    [A, B, C],
  );

  pages[A] = taggedPage(
    "Cache eviction",
    ["caching", "performance"],
    'contradicts:\n  - "[Cache warming](cache-warming.md)"\n',
  );
  const conflicted = await committedVault(pages);
  assert.deepEqual(await conceptFragmentation(read(conflicted)), []);
});

// ---------------------------------------------------------------------------
// exclusion add, suppression, and the two-tier validation
// ---------------------------------------------------------------------------

test("exclusion add records the cluster's HEAD revisions in one commit", async () => {
  const root = await committedVault(fixture());
  await addExclusion(root, [B, A], "Distinct concepts: identity vs access.");

  const text = registryText(root);
  const parsed = parseRegistry(text);
  assert.equal(parsed.error, null);
  assert.deepEqual(
    parsed.exclusions[0].members.map((m) => m.pageRef),
    [A, B],
  );
  assert.equal(
    parsed.exclusions[0].reason,
    "Distinct concepts: identity vs access.",
  );
  for (const member of parsed.exclusions[0].members) {
    assert.match(member.blobOid, /^[0-9a-f]{40}$/);
    assert.match(member.fingerprint, /^sha256:[0-9a-f]{64}$/);
  }
  assert.equal(await committedRegistry(root), text);
  assert.ok(
    (await git.listFiles({ fs, dir: root, ref: "HEAD" })).includes(REGISTRY),
    "the registry is committed",
  );
});

test("an exact valid exclusion suppresses its cluster", async () => {
  const root = await committedVault(fixture());
  assert.equal((await conceptFragmentation(read(root))).length, 1);
  await addExclusion(root, [A, B], "Distinct concepts.");
  assert.deepEqual(await conceptFragmentation(read(root)), []);
});

test("a subset or superset of an excluded cluster is assessed afresh", async () => {
  const root = await committedVault(fixture());
  await addExclusion(root, [A, B], "Distinct concepts.");
  fs.writeFileSync(
    path.join(root, C),
    taggedPage("Cache warming", ["caching", "performance"]),
  );
  await commitAll(root, "add a third");
  assert.deepEqual(clusterRefs(await conceptFragmentation(read(root))).sort(), [
    A,
    B,
    C,
  ]);
});

test("an irrelevant edit preserves the exclusion and fix refreshes the cached blob id", async () => {
  const root = await committedVault(fixture());
  await addExclusion(root, [A, B], "Distinct concepts.");
  const before = parseRegistry(registryText(root)).exclusions[0];

  // Tags are outside the fingerprint, so the cached oid is stale but valid.
  fs.writeFileSync(
    path.join(root, A),
    taggedPage("Cache eviction", ["caching", "performance", "memory"]),
  );
  await commitAll(root, "retag");
  assert.deepEqual(await conceptFragmentation(read(root)), []);

  assert.deepEqual(await fixConsolidationExclusions(root), [REGISTRY]);
  const after = parseRegistry(registryText(root)).exclusions[0];
  const memberA = after.members.find((m) => m.pageRef === A)!;
  const oldA = before.members.find((m) => m.pageRef === A)!;
  assert.notEqual(memberA.blobOid, oldA.blobOid);
  assert.equal(memberA.fingerprint, oldA.fingerprint);
});

test("unchanged members keep suppressing after a third member changes meaning", async () => {
  const D = "wiki/concepts/cache-coherence.md";
  const root = await committedVault({
    ...fixture(),
    [C]: taggedPage("Cache warming", ["caching", "performance"]),
  });
  await addExclusion(root, [A, B, C], "One cluster.");
  assert.deepEqual(await conceptFragmentation(read(root)), []);

  // B is rewritten onto another subject, so only A and C still cluster — the
  // exclusion's effective set, whose members stay excluded.
  fs.writeFileSync(
    path.join(root, B),
    taggedPage("Sourdough starter", ["baking"], "", "Unrelated now.\n"),
  );
  await commitAll(root, "repurpose B");
  assert.deepEqual(
    await conceptFragmentation(read(root)),
    [],
    "the unchanged members of a declined cluster stay excluded",
  );

  // A new near-duplicate makes the set a superset of the effective one, which
  // is a fresh assessment.
  fs.writeFileSync(
    path.join(root, D),
    taggedPage("Cache coherence", ["caching", "performance"]),
  );
  await commitAll(root, "a fourth page joins");
  assert.deepEqual(
    clusterRefs(await conceptFragmentation(read(root))).sort(),
    [A, C, D].sort(),
  );
});

test("a semantically changed member drops the exclusion and the cluster returns", async () => {
  const root = await committedVault(fixture());
  await addExclusion(root, [A, B], "Distinct concepts.");
  fs.writeFileSync(
    path.join(root, A),
    taggedPage(
      "Cache eviction",
      ["caching", "performance"],
      "",
      "Now a different claim.\n",
    ),
  );
  await commitAll(root, "rewrite");
  assert.deepEqual(clusterRefs(await conceptFragmentation(read(root))).sort(), [
    A,
    B,
  ]);
});

// ---------------------------------------------------------------------------
// consolidation-exclusions check and fix
// ---------------------------------------------------------------------------

test("a malformed registry fails open and reports a registry-integrity finding", async () => {
  const root = await committedVault({
    ...fixture(),
    [REGISTRY]: "exclusions: nope\n",
  });
  const findings = await conceptFragmentation(read(root));
  assert.equal(findings.length, 1, "a malformed registry suppresses nothing");

  const integrity = await consolidationExclusions(read(root));
  assert.equal(integrity.length, 1);
  assert.equal(integrity[0].pageRef, REGISTRY);
  assert.match(integrity[0].detail, /registry integrity/);
  assert.match(integrity[0].detail, /not a list/);
});

test("the check reports stale members and duplicate records", async () => {
  const root = await committedVault(fixture());
  await addExclusion(root, [A, B], "Distinct concepts.");
  // A second copy of the one record, plus a member edited since it was cached.
  const single = registryText(root);
  writeRegistry(root, single + single.slice("exclusions:\n".length));
  fs.writeFileSync(
    path.join(root, B),
    taggedPage(
      "Cache invalidation",
      ["caching", "performance"],
      "",
      "Changed.\n",
    ),
  );
  await commitAll(root, "change B");

  const findings = await consolidationExclusions(read(root));
  const details = findings.map((f) => f.detail).join("\n");
  assert.match(details, /identical records/);
  assert.match(details, /--prune/);
});

test("fix canonicalises order and refreshes caches without pruning", async () => {
  const root = await committedVault(fixture());
  await addExclusion(root, [A, B], "Distinct concepts.");
  const parsed = parseRegistry(registryText(root)).exclusions[0];
  // Hand-write a non-canonical registry: members reversed, a stale oid.
  const stale = {
    ...parsed,
    members: [{ ...parsed.members[1], blobOid: "stale" }, parsed.members[0]],
  };
  writeRegistry(
    root,
    "exclusions:\n" +
      "  - members:\n" +
      `      - page_ref: ${stale.members[0].pageRef}\n` +
      `        blob_oid: ${stale.members[0].blobOid}\n` +
      `        fingerprint: ${stale.members[0].fingerprint}\n` +
      `      - page_ref: ${stale.members[1].pageRef}\n` +
      `        blob_oid: ${stale.members[1].blobOid}\n` +
      `        fingerprint: ${stale.members[1].fingerprint}\n` +
      '    reason: "Distinct concepts."\n',
  );
  assert.deepEqual(await fixConsolidationExclusions(root), [REGISTRY]);
  const fixed = parseRegistry(registryText(root)).exclusions[0];
  assert.deepEqual(
    fixed.members.map((m) => m.pageRef),
    [A, B],
  );
  assert.match(fixed.members[1].blobOid, /^[0-9a-f]{40}$/);
});

test("fix --prune deletes a record whose members no longer match HEAD", async () => {
  const root = await committedVault(fixture());
  await addExclusion(root, [A, B], "Distinct concepts.");
  fs.rmSync(path.join(root, B));
  await commitAll(root, "delete B");
  assert.deepEqual(await fixConsolidationExclusions(root, { prune: true }), [
    REGISTRY,
  ]);
  assert.deepEqual(parseRegistry(registryText(root)).exclusions, []);
});

test("fix leaves a malformed registry alone", async () => {
  const root = await committedVault({
    ...fixture(),
    [REGISTRY]: "exclusions: nope\n",
  });
  assert.deepEqual(await fixConsolidationExclusions(root), []);
  assert.equal(registryText(root), "exclusions: nope\n");
});

// ---------------------------------------------------------------------------
// Moves follow the registry
// ---------------------------------------------------------------------------

test("a move within a kind rewrites the registry's page reference", async () => {
  const root = await committedVault(fixture());
  await addExclusion(root, [A, B], "Distinct concepts.");
  const moved = "wiki/concepts/cache-invalidation-notes.md";
  const changed = new Vault(root).movePage(B, moved);
  assert.ok(changed.includes(REGISTRY));
  const parsed = parseRegistry(registryText(root));
  assert.deepEqual(
    parsed.exclusions[0].members.map((m) => m.pageRef),
    [A, moved],
  );
});

test("a move within a kind refreshes the fingerprints of members whose links it rewrote", async () => {
  const root = await committedVault({
    ...fixture(),
    [A]: taggedPage(
      "Cache eviction",
      ["caching", "performance"],
      "",
      "See [invalidation](cache-invalidation.md).\n",
    ),
  });
  await addExclusion(root, [A, B], "Distinct concepts.");
  const before = parseRegistry(registryText(root)).exclusions[0].members.find(
    (m) => m.pageRef === A,
  )!;

  const moved = "wiki/concepts/cache-invalidation-notes.md";
  assert.ok(new Vault(root).movePage(B, moved).includes(REGISTRY));
  const after = parseRegistry(registryText(root)).exclusions[0];
  assert.deepEqual(
    after.members.map((m) => m.pageRef),
    [A, moved],
  );
  const memberA = after.members.find((m) => m.pageRef === A)!;
  assert.notEqual(
    memberA.fingerprint,
    before.fingerprint,
    "the rewritten inbound link changed A's cached meaning",
  );
  assert.equal(
    memberA.blobOid,
    before.blobOid,
    "the oid is the fix's to refresh, at HEAD",
  );

  await commitAll(root, "move B");
  assert.deepEqual(
    await conceptFragmentation(read(root)),
    [],
    "the exclusion survives the move it was rewritten by",
  );
});

test("deleting a record by hand lets its cluster be proposed again", async () => {
  const root = await committedVault(fixture());
  await addExclusion(root, [A, B], "Distinct concepts.");
  assert.deepEqual(await conceptFragmentation(read(root)), []);
  writeRegistry(root, renderRegistry([]));
  await commitAll(root, "drop the record");
  assert.deepEqual(clusterRefs(await conceptFragmentation(read(root))).sort(), [
    A,
    B,
  ]);
});

test("a move to another kind removes the member from the old record", async () => {
  const root = await committedVault(fixture());
  await addExclusion(root, [A, B], "Distinct concepts.");
  const changed = new Vault(root).movePage(
    B,
    "wiki/entities/cache-invalidation.md",
  );
  assert.ok(changed.includes(REGISTRY));
  assert.deepEqual(parseRegistry(registryText(root)).exclusions, []);
});

// ---------------------------------------------------------------------------
// assess
// ---------------------------------------------------------------------------

test("assess reads every member in full from one committed snapshot", async () => {
  const root = await committedVault(fixture());
  const assessed = await assessCluster(root, [A, B]);
  assert.equal(
    assessed.head,
    await git.resolveRef({ fs, dir: root, ref: "HEAD" }),
  );
  assert.deepEqual(
    assessed.members.map((m) => m.page_ref),
    [A, B],
  );
  const member = assessed.members[0];
  assert.match(member.blob_oid, /^[0-9a-f]{40}$/);
  assert.match(member.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(member.title, "Cache eviction");
  assert.equal(
    member.bytes,
    Buffer.byteLength(fs.readFileSync(path.join(root, A), "utf8")),
  );
  assert.match(member.text, /Cache eviction/);
});

test("assess reads HEAD, so an uncommitted edit is invisible", async () => {
  const root = await committedVault(fixture());
  fs.writeFileSync(
    path.join(root, A),
    taggedPage("Cache eviction", ["caching"], "", "Draft rewrite.\n"),
  );
  const assessed = await assessCluster(root, [A]);
  assert.doesNotMatch(assessed.members[0].text, /Draft rewrite/);
});

test("assess refuses a member that is not a committed page", async () => {
  const root = await committedVault(fixture());
  await assert.rejects(
    () => assessCluster(root, [A, "wiki/concepts/absent.md"]),
    ErrAssess,
  );
});

test("the snapshot guard catches a moved HEAD, a changed member and an unnamed ref", async () => {
  const root = await committedVault(fixture());
  const assessed = await assessCluster(root, [A, B]);
  const pin = {
    head: assessed.head,
    members: assessed.members.map((m) => ({
      page_ref: m.page_ref,
      blob_oid: m.blob_oid,
    })),
  };
  assert.deepEqual(await assessmentErrors(pin, [A, B], root), []);

  // HEAD moves.
  fs.writeFileSync(
    path.join(root, C),
    taggedPage("Cache warming", ["caching"]),
  );
  await commitAll(root, "another commit");
  const moved = await assessmentErrors(pin, [A, B], root);
  assert.equal(moved.length, 1);
  assert.match(moved[0], /HEAD moved/);

  // A ref the pin never named, at the current HEAD.
  const fresh = await assessCluster(root, [A, B, C]);
  const freshPin = {
    head: fresh.head,
    members: fresh.members.map((m) => ({
      page_ref: m.page_ref,
      blob_oid: m.blob_oid,
    })),
  };
  const unpinned = await assessmentErrors(
    freshPin,
    [A, B, "wiki/concepts/other.md"],
    root,
  );
  assert.match(unpinned.join("; "), /was not assessed/);

  // A member that changed, with the HEAD itself unchanged.
  const staleMember = {
    head: fresh.head,
    members: freshPin.members.map((m) =>
      m.page_ref === A ? { ...m, blob_oid: "0".repeat(40) } : m,
    ),
  };
  const changed = await assessmentErrors(staleMember, [A, B], root);
  assert.match(changed.join("; "), /changed since it was assessed/);

  // A member no longer committed.
  const deleted = {
    head: fresh.head,
    members: freshPin.members.map((m) =>
      m.page_ref === C ? { ...m, blob_oid: "0".repeat(40) } : m,
    ),
  };
  fs.rmSync(path.join(root, C));
  await commitAll(root, "delete C");
  const gone = await assessmentErrors(
    { ...deleted, head: await git.resolveRef({ fs, dir: root, ref: "HEAD" }) },
    [A, B, C],
    root,
  );
  assert.match(gone.join("; "), /no longer a committed page/);
});

// ---------------------------------------------------------------------------
// The plan's assessed pin
// ---------------------------------------------------------------------------

test("a consolidate plan validates its assessed pin", async () => {
  const root = await committedVault(fixture());
  const assessed = await assessCluster(root, [A, B]);
  const base = {
    title: "Consolidate cache pages",
    action: "consolidate",
    source_date: "2026-01-01",
    consolidates: [A, B],
    assessed: {
      head: assessed.head,
      members: assessed.members.map((m) => ({
        page_ref: m.page_ref,
        blob_oid: m.blob_oid,
      })),
    },
    pages: [
      {
        op: "create",
        kind: "concept",
        title: "Cache coherence",
        body: "Body text.\n\n## Cache invalidation\n\nBody text.\n",
        frontmatter: { volatility: "stable" },
      },
    ],
  };

  const ok = resolve(decodePlan(JSON.stringify(base)), root);
  assert.doesNotThrow(() => ok.validate());

  const unnamed = resolve(
    decodePlan(JSON.stringify({ ...base, consolidates: [A, B, C] })),
    root,
  );
  assert.throws(() => unnamed.validate(), /not named by plan\.assessed/);

  const wrongAction = resolve(
    decodePlan(JSON.stringify({ ...base, action: "ingest" })),
    root,
  );
  assert.throws(() => wrongAction.validate(), /plan\.assessed is only valid/);

  const nonObject = () =>
    decodePlan(JSON.stringify({ ...base, assessed: "nope" }));
  assert.throws(nonObject, /"assessed" must be an object/);
});

// ---------------------------------------------------------------------------
// Snapshot races
// ---------------------------------------------------------------------------

test("exclusion add refuses when HEAD moves while the snapshot is captured", async () => {
  const root = await committedVault(fixture());
  const real = new VaultGit(root);
  let calls = 0;
  const racing = {
    async committedPages(since: string): Promise<Snapshot> {
      const snapshot = await real.committedPages(since);
      calls++;
      return calls === 1 ? snapshot : { ...snapshot, head: "moved" };
    },
    stageAndCommit: real.stageAndCommit.bind(real),
  };

  await assert.rejects(
    () => addExclusion(root, [A, B], "Distinct concepts.", racing),
    /HEAD moved while the snapshot was captured/,
  );
  assert.equal(fs.existsSync(path.join(root, ...REGISTRY.split("/"))), false);
});
