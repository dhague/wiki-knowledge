/**
 * assess tests — the committed-snapshot pin a Consolidation is assessed at, and
 * the re-check that refuses a stale one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as git from "isomorphic-git";
import { assessCluster, assessmentErrors } from "./assess.js";

const FIXED_SIGNATURE = {
  name: "test",
  email: "test@example.com",
  timestamp: Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000),
  timezoneOffset: 0,
};

const refA = "wiki/concepts/a.md";

/** A real repo holding one committed page at refA. */
async function committedVault(): Promise<{
  root: string;
  head: string;
  blobOid: string;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-assess-"));
  await git.init({ fs, dir: root });
  const abs = path.join(root, ...refA.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "---\ntitle: A\nvolatility: stable\n---\nbody\n");
  await git.add({ fs, dir: root, filepath: refA });
  await git.commit({
    fs,
    dir: root,
    message: "a",
    author: FIXED_SIGNATURE,
    committer: FIXED_SIGNATURE,
  });
  const cluster = await assessCluster(root, [refA]);
  return { root, head: cluster.head, blobOid: cluster.members[0].blob_oid };
}

test("a pin matching HEAD has no problems", async () => {
  const { root, head, blobOid } = await committedVault();
  const problems = await assessmentErrors(
    { head, members: [{ page_ref: refA, blob_oid: blobOid }] },
    [refA],
    root,
  );
  assert.deepEqual(problems, []);
});

test("a moved HEAD is refused, naming the assess command", async () => {
  const { root } = await committedVault();
  const problems = await assessmentErrors(
    { head: "0".repeat(40), members: [] },
    [],
    root,
  );
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /^the vault's HEAD moved since the cluster was assessed \(assessed 0{40}, now [0-9a-f]{40}\); /,
  );
  assert.ok(
    problems[0].includes(
      "re-run `enchiridion assess <page_ref...>` and repin plan.assessed",
    ),
    problems[0],
  );
});

test("a ref the plan names but never assessed is refused with a remedy", async () => {
  const { root, head } = await committedVault();
  const problems = await assessmentErrors({ head, members: [] }, [refA], root);
  assert.ok(
    problems.includes(
      `${refA} is named by the plan but was not assessed — assess it, or drop it from plan.consolidates`,
    ),
    String(problems),
  );
  assert.ok(
    problems.includes(
      "re-run `enchiridion assess <page_ref...>` and repin plan.assessed",
    ),
    String(problems),
  );
});

test("an assessed page that changed is refused with a remedy", async () => {
  const { root, head } = await committedVault();
  const problems = await assessmentErrors(
    { head, members: [{ page_ref: refA, blob_oid: "0".repeat(40) }] },
    [],
    root,
  );
  assert.ok(
    problems.includes(
      `${refA} changed since it was assessed — re-assess and repin`,
    ),
    String(problems),
  );
});

test("an assessed page no longer at HEAD is refused with a remedy", async () => {
  const { root, head } = await committedVault();
  const gone = "wiki/concepts/gone.md";
  const problems = await assessmentErrors(
    { head, members: [{ page_ref: gone, blob_oid: "0".repeat(40) }] },
    [],
    root,
  );
  assert.ok(
    problems.includes(
      `${gone} is no longer a committed page at HEAD — commit it, or pick a ref that is committed`,
    ),
    String(problems),
  );
});
