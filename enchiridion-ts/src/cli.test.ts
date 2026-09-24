/**
 * CLI-level smoke tests (#252's "Testing Decisions": one test per
 * subcommand is enough at this level — correctness lives in module tests
 * once those land; these confirm the commander wiring).
 *
 * Spawns `tsx src/cli.ts` as a subprocess for each case so commander's own
 * process.exit()/process.exitCode calls behave exactly as they would for a
 * real invocation, without taking down the test runner.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as git from "isomorphic-git";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, "cli.ts");
const tsxBin = path.join(__dirname, "..", "node_modules", ".bin", "tsx");

function run(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return runEnv(args, {});
}

/** Run the CLI with a custom cwd and/or extra env layered over the current. */
function runEnv(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(tsxBin, [cliPath, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Write a temp markdown page and return its path. */
function writeTempPage(frontmatter: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-page-"));
  const file = path.join(dir, "page.md");
  fs.writeFileSync(file, frontmatter + body);
  return file;
}

/** Write a throwaway vault holding files ({vault-relative ref: text}) and
 * return its absolute root. */
function makeVault(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vault-"));
  for (const [ref, text] of Object.entries(files)) {
    const abs = path.join(root, ...ref.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

/** The absolute path of a vault-relative page under root. */
function pagePath(root: string, ref: string): string {
  return path.join(root, ...ref.split("/"));
}

/** Run the CLI with `input` piped to its stdin, and optional extra env. */
function runWithStdin(
  args: string[],
  input: string,
  env?: Record<string, string>,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(tsxBin, [cliPath, ...args], {
    encoding: "utf8",
    input,
    env: env ? { ...process.env, ...env } : undefined,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("no arguments: prints help, exits 0", () => {
  const { status, stdout } = run([]);
  assert.equal(status, 0);
  assert.match(stdout, /Usage:/);
  assert.match(stdout, /enchiridion/);
});

test("--help: prints help, exits 0", () => {
  const { status, stdout } = run(["--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /Usage:/);
});

test("place: prints the vault-relative path from kind and title", () => {
  const { status, stdout, stderr } = run([
    "place",
    "concept",
    "Connection Pooling",
  ]);
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), "wiki/concepts/connection-pooling.md");
});

test("place: errors non-zero on an unknown kind", () => {
  const { status, stderr } = run(["place", "nonsense", "X"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /unknown kind "nonsense"/);
});

test("place: errors on wrong argument count", () => {
  const { status } = run(["place", "concept"]);
  assert.notEqual(status, 0);
});

test("vault (bare): prints the resolved root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vault-"));
  fs.mkdirSync(path.join(root, "wiki"));
  const { status, stdout, stderr } = runEnv(["vault"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), fs.realpathSync(root));
});

test("vault root: prints the resolved root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vault-"));
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  const { status, stdout, stderr } = runEnv(["vault", "root"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), fs.realpathSync(root));
});

test("vault move: moves a page and fixes inbound links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vault-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.mkdirSync(path.join(root, "wiki", "entities"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "a.md"),
    "See [B](b.md).\n",
  );
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "b.md"),
    "Back to [A](a.md).\n",
  );
  const { status, stdout, stderr } = runEnv(
    ["vault", "move", "wiki/concepts/b.md", "wiki/entities/b.md"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  // The moved page is newly written and the referencing page changed — both
  // are reported, sorted (matches MovePage's changed set).
  assert.equal(stdout.trim(), "wiki/concepts/a.md\nwiki/entities/b.md");
  assert.equal(
    fs.existsSync(path.join(root, "wiki", "concepts", "b.md")),
    false,
  );
  assert.ok(
    fs
      .readFileSync(path.join(root, "wiki", "concepts", "a.md"), "utf8")
      .includes("../entities/b.md"),
  );
});

test("vault move: wrong argument count errors non-zero", () => {
  const { status } = run(["vault", "move", "only-one-arg"]);
  assert.notEqual(status, 0);
});

test("vault move: missing source errors non-zero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vault-"));
  fs.mkdirSync(path.join(root, "wiki"));
  const { status } = runEnv(
    ["vault", "move", "wiki/concepts/missing.md", "wiki/entities/missing.md"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.notEqual(status, 0);
});

test("vault move resolves the vault root; place resolves none (boundary)", () => {
  // `place` is pure path computation: it must succeed from a directory with
  // no vault marker and no WIKI_ROOT, resolving no vault root at all.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vault-"));
  const place = runEnv(["place", "concept", "A Thing"], {
    cwd: plain,
    env: { WIKI_ROOT: "" },
  });
  assert.equal(place.status, 0, place.stderr);
  assert.equal(place.stdout.trim(), "wiki/concepts/a-thing.md");

  // A `vault` subcommand with no marker anywhere above cwd and no WIKI_ROOT
  // falls back to cwd as the root (ADR-0004 step 3) — so `vault root` prints
  // the cwd itself, not a path computed in isolation.
  const vault = runEnv(["vault", "root"], {
    cwd: plain,
    env: { WIKI_ROOT: "" },
  });
  assert.equal(vault.status, 0, vault.stderr);
  assert.equal(vault.stdout.trim(), fs.realpathSync(plain));
});

test("page get: prints the frontmatter value", () => {
  const file = writeTempPage("---\nkind: concept\n---\nbody\n", "");
  const { status, stdout } = run(["page", "get", file, "kind"]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "concept");
});

test("page get: prints a list as ['a', 'b']", () => {
  const file = writeTempPage("---\ntags:\n  - a\n  - b\n---\nbody\n", "");
  const { status, stdout } = run(["page", "get", file, "tags"]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "['a', 'b']");
});

test("page get: absent key exits non-zero", () => {
  const file = writeTempPage("---\nkind: concept\n---\nbody\n", "");
  const { status } = run(["page", "get", file, "nope"]);
  assert.notEqual(status, 0);
});

test("page set: writes the file back", () => {
  const file = writeTempPage("---\nkind: concept\n---\nbody\n", "");
  const { status } = run(["page", "set", file, "volatility", "stable"]);
  assert.equal(status, 0);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "---\nkind: concept\nvolatility: stable\n---\nbody\n",
  );
});

test("page set: canonicalises source_date, truncating a clock", () => {
  const file = writeTempPage("---\nkind: concept\n---\nbody\n", "");
  const { status, stderr } = run([
    "page",
    "set",
    file,
    "source_date",
    "2026-07-20T14:30:00Z",
  ]);
  assert.equal(status, 0, stderr);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "---\nkind: concept\nsource_date: 2026-07-20\n---\nbody\n",
  );
});

test("page set: rejects an invalid calendar date in source_date", () => {
  // The bug this guards: `page set` accepted 2026-13-40 (its regex truncated
  // without validating) while ingest refused it. Both now share the one
  // sourcedate rule and reject exactly the same spellings.
  const file = writeTempPage("---\nkind: concept\n---\nbody\n", "");
  const { status, stderr } = run([
    "page",
    "set",
    file,
    "source_date",
    "2026-13-40",
  ]);
  assert.notEqual(status, 0);
  assert.match(stderr, /valid date/);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "---\nkind: concept\n---\nbody\n",
  );
});

test("page set: rejects a non-date source_date", () => {
  const file = writeTempPage("---\nkind: concept\n---\nbody\n", "");
  const { status, stderr } = run(["page", "set", file, "source_date", "nope"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /valid date/);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "---\nkind: concept\n---\nbody\n",
  );
});

test("page merge: unions values into a list-valued key", () => {
  const file = writeTempPage("---\ntags:\n  - a\n---\nbody\n", "");
  const { status } = run(["page", "merge", file, "tags", '["b", "a"]']);
  assert.equal(status, 0);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "---\ntags:\n  - a\n  - b\n---\nbody\n",
  );
});

// #548: `page merge`/`page set` used to write the value verbatim, so a caller
// reusing `ingest`'s documented vault-relative-ref shape produced malformed
// frontmatter edges. These pin the asymmetric-fix: a ref is composed, a link
// passes through, and anything else fails without touching the file.

test("page merge: composes a vault-relative ref into an edge link", () => {
  const root = makeVault({
    "wiki/concepts/foo.md": "---\ntitle: Foo\n---\nbody\n",
    "wiki/concepts/bar.md": "---\ntitle: Bar\n---\nbody\n",
  });
  const file = pagePath(root, "wiki/concepts/bar.md");
  const { status, stderr } = runEnv(
    ["page", "merge", file, "related", '["wiki/concepts/foo.md"]'],
    { cwd: root, env: { WIKI_ROOT: "" } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    '---\ntitle: Bar\nrelated:\n  - "[Foo](foo.md)"\n---\nbody\n',
  );
});

test("page merge: relativises across folders and percent-encodes", () => {
  const root = makeVault({
    "wiki/entities/A B.md": "---\ntitle: A B\n---\nbody\n",
    "wiki/concepts/bar.md": "---\ntitle: Bar\n---\nbody\n",
  });
  const file = pagePath(root, "wiki/concepts/bar.md");
  const { status, stderr } = runEnv(
    ["page", "merge", file, "related", '["wiki/entities/A B.md"]'],
    { cwd: root, env: { WIKI_ROOT: "" } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    '---\ntitle: Bar\nrelated:\n  - "[A B](../entities/A%20B.md)"\n---\nbody\n',
  );
});

test("page set: on an edge key writes a list, replacing the old one", () => {
  const root = makeVault({
    "wiki/concepts/foo.md": "---\ntitle: Foo\n---\nbody\n",
    "wiki/concepts/bar.md":
      '---\ntitle: Bar\nrefines:\n  - "[Old](old.md)"\n---\nbody\n',
  });
  const file = pagePath(root, "wiki/concepts/bar.md");
  const { status, stderr } = runEnv(
    ["page", "set", file, "refines", "wiki/concepts/foo.md"],
    { cwd: root, env: { WIKI_ROOT: "" } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    '---\ntitle: Bar\nrefines:\n  - "[Foo](foo.md)"\n---\nbody\n',
  );
});

test("page set --json: an empty list clears a list-valued edge key", () => {
  const root = makeVault({
    "wiki/concepts/bar.md":
      '---\ntitle: Bar\nrelated:\n  - "[Foo](foo.md)"\n---\nbody\n',
  });
  const file = pagePath(root, "wiki/concepts/bar.md");
  const { status, stderr } = runEnv(
    ["page", "set", file, "related", "[]", "--json"],
    { cwd: root, env: { WIKI_ROOT: "" } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "---\ntitle: Bar\nrelated: []\n---\nbody\n",
  );
});

test("page set: passes an already-composed link through unchanged", () => {
  const root = makeVault({
    "wiki/concepts/bar.md": "---\ntitle: Bar\n---\nbody\n",
  });
  const file = pagePath(root, "wiki/concepts/bar.md");
  const { status, stderr } = runEnv(
    ["page", "set", file, "related", "[Foo](foo.md#ttl)"],
    { cwd: root, env: { WIKI_ROOT: "" } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    '---\ntitle: Bar\nrelated:\n  - "[Foo](foo.md#ttl)"\n---\nbody\n',
  );
});

test("page set: composes raw_source from a vault-relative raw path", () => {
  const root = makeVault({
    "wiki/sources/stub.md": "---\ntitle: Stub\n---\nbody\n",
    "raw/notes/x y.txt": "raw body\n",
  });
  const file = pagePath(root, "wiki/sources/stub.md");
  const { status, stderr } = runEnv(
    ["page", "set", file, "raw_source", "raw/notes/x y.txt"],
    { cwd: root, env: { WIKI_ROOT: "" } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    '---\ntitle: Stub\nraw_source: "[x y.txt](../../raw/notes/x%20y.txt)"\n---\nbody\n',
  );
});

test("page set: a page's own vault wins over cwd", () => {
  const root = makeVault({
    "wiki/concepts/foo.md": "---\ntitle: Foo\n---\nbody\n",
    "wiki/concepts/bar.md": "---\ntitle: Bar\n---\nbody\n",
  });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-away-"));
  const file = pagePath(root, "wiki/concepts/bar.md");
  const { status, stderr } = runEnv(
    ["page", "merge", file, "related", '["wiki/concepts/foo.md"]'],
    { cwd: elsewhere, env: { WIKI_ROOT: "" } },
  );
  assert.equal(status, 0, stderr);
  assert.match(fs.readFileSync(file, "utf8"), /"\[Foo\]\(foo\.md\)"/);
});

test(
  "page merge: composes through a symlinked vault path",
  { skip: process.platform === "win32" },
  () => {
    const root = makeVault({
      "wiki/concepts/foo.md": "---\ntitle: Foo\n---\nbody\n",
      "wiki/concepts/bar.md": "---\ntitle: Bar\n---\nbody\n",
    });
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-link-"));
    const link = path.join(linkDir, "vault");
    fs.symlinkSync(root, link);
    const file = path.join(link, "wiki", "concepts", "bar.md");
    const { status, stderr } = runEnv(
      ["page", "merge", file, "related", '["wiki/concepts/foo.md"]'],
      { cwd: linkDir, env: { WIKI_ROOT: "" } },
    );
    assert.equal(status, 0, stderr);
    assert.match(fs.readFileSync(file, "utf8"), /"\[Foo\]\(foo\.md\)"/);
  },
);

test("page merge: refuses an unresolvable ref, naming key and value", () => {
  const root = makeVault({
    "wiki/concepts/bar.md": "---\ntitle: Bar\n---\nbody\n",
  });
  const file = pagePath(root, "wiki/concepts/bar.md");
  const before = fs.readFileSync(file, "utf8");
  const { status, stderr } = runEnv(
    ["page", "merge", file, "related", '["wiki/concepts/nope.md"]'],
    { cwd: root, env: { WIKI_ROOT: "" } },
  );
  assert.notEqual(status, 0);
  assert.match(stderr, /related/);
  assert.match(stderr, /wiki\/concepts\/nope\.md/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("page set: refuses a link embedded in prose", () => {
  const root = makeVault({
    "wiki/concepts/bar.md": "---\ntitle: Bar\n---\nbody\n",
  });
  const file = pagePath(root, "wiki/concepts/bar.md");
  const before = fs.readFileSync(file, "utf8");
  const { status, stderr } = runEnv(
    ["page", "set", file, "related", "see [Foo](foo.md) here"],
    { cwd: root, env: { WIKI_ROOT: "" } },
  );
  assert.notEqual(status, 0);
  assert.match(stderr, /related/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("page set: refuses a value that is neither link nor ref", () => {
  const root = makeVault({
    "wiki/concepts/bar.md": "---\ntitle: Bar\n---\nbody\n",
  });
  const file = pagePath(root, "wiki/concepts/bar.md");
  const before = fs.readFileSync(file, "utf8");
  const { status, stderr } = runEnv(["page", "set", file, "related", "junk"], {
    cwd: root,
    env: { WIKI_ROOT: "" },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /related/);
  assert.match(stderr, /junk/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("page merge: raw_source is a single link, not a list", () => {
  const root = makeVault({
    "wiki/sources/stub.md": "---\ntitle: Stub\n---\nbody\n",
  });
  const file = pagePath(root, "wiki/sources/stub.md");
  const before = fs.readFileSync(file, "utf8");
  const { status, stderr } = runEnv(
    ["page", "merge", file, "raw_source", '["raw/notes/x.txt"]'],
    { cwd: root, env: { WIKI_ROOT: "" } },
  );
  assert.notEqual(status, 0);
  assert.match(stderr, /raw_source/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("hook session-start: reads stdin, records transcript path, exits 0", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-hook-"));
  const sessionID = "hook-sess-1";
  const payload = JSON.stringify({
    session_id: sessionID,
    transcript_path: "/x/transcript.jsonl",
    cwd: project,
  });
  const { status, stderr } = runWithStdin(["hook", "session-start"], payload);
  assert.equal(status, 0, stderr);
  const stateDir = path.join(project, ".claude", "wiki-knowledge", "sessions");
  assert.equal(
    fs.readFileSync(path.join(stateDir, `${sessionID}.json`), "utf8"),
    JSON.stringify({ transcript_path: "/x/transcript.jsonl" }),
  );
});

test("hook session-start: malformed stdin fails open, exits 0", () => {
  const { status, stderr } = runWithStdin(
    ["hook", "session-start"],
    "not json",
  );
  assert.equal(status, 0, stderr);
});

test("hook post-tool-use: reads stdin, appends one JSON line, exits 0", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-hook-"));
  const sessionID = "hook-sess-2";
  // The tool call runs in a content folder, while $CLAUDE_PROJECT_DIR — which
  // Claude Code exports to every hook process — still names the project, so
  // the line belongs at the project root, not beside the tool call (#485).
  const contentDir = path.join(project, "wiki", "concepts");
  fs.mkdirSync(contentDir, { recursive: true });
  const payload = JSON.stringify({
    session_id: sessionID,
    cwd: contentDir,
    tool_name: "Bash",
    tool_use_id: "tu_1",
    prompt_id: "pr_1",
    duration_ms: 42,
  });
  const { status, stderr } = runWithStdin(["hook", "post-tool-use"], payload, {
    CLAUDE_PROJECT_DIR: project,
  });
  assert.equal(status, 0, stderr);
  assert.ok(
    !fs.existsSync(path.join(contentDir, ".claude")),
    "session state was scattered into a content directory",
  );
  const logDir = path.join(project, ".claude", "wiki-knowledge", "sessions");
  const lines = fs
    .readFileSync(path.join(logDir, `${sessionID}-tool-calls.jsonl`), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.tool, "Bash");
  assert.equal(event.duration_ms, 42);
});

test("hook post-tool-use: malformed stdin fails open, exits 0", () => {
  const { status, stderr } = runWithStdin(
    ["hook", "post-tool-use"],
    "not json",
  );
  assert.equal(status, 0, stderr);
});

test("hook (bare): errors listing the events, non-zero", () => {
  const { status, stderr } = run(["hook"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /name the event, one of session-start, post-tool-use/);
});

test("init: scaffolds a vault, commits it, and prints the root", () => {
  const root = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-init-")),
    "vault",
  );
  const { status, stdout, stderr } = run(["init", root, "--mode", "dedicated"]);
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), path.resolve(root));
  for (const folder of ["concepts", "entities", "sources", "synthesis"]) {
    assert.ok(
      fs.existsSync(path.join(root, "wiki", folder, ".gitkeep")),
      `${folder} missing`,
    );
  }
  assert.ok(fs.existsSync(path.join(root, "raw", ".gitkeep")));
  assert.ok(fs.existsSync(path.join(root, ".gitignore")));
  // The scaffold is committed — the vault's git history is complete from page
  // one.
  const { status: logStatus } = spawnSync("git", ["-C", root, "log"], {
    encoding: "utf8",
  });
  assert.equal(logStatus, 0);
});

test("init: requires --mode", () => {
  const root = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-init-")),
    "vault",
  );
  const { status, stderr } = run(["init", root]);
  assert.notEqual(status, 0);
  assert.match(stderr, /mode/);
});

test("init: refuses a directory that already looks like a vault", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-init-"));
  fs.mkdirSync(path.join(root, "wiki"));
  // A marker alone is not a vault (#323) — a repo is what makes it one.
  const { status: initStatus } = spawnSync("git", ["-C", root, "init"], {
    encoding: "utf8",
  });
  assert.equal(initStatus, 0);
  const { status, stderr } = run(["init", root, "--mode", "dedicated"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /already looks like a vault/);
});

test("init: seeds a repo around an existing wiki/ tree without git (#323)", () => {
  const root = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-init-")),
    "vault",
  );
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "existing.md"),
    "---\ntitle: Existing\n---\n\nBody.\n",
  );
  const { status, stdout, stderr } = run(["init", root, "--mode", "dedicated"]);
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), path.resolve(root));
  // The initial commit sweeps the pre-existing page in.
  const { status: lsStatus, stdout: ls } = spawnSync(
    "git",
    ["-C", root, "ls-files"],
    { encoding: "utf8" },
  );
  assert.equal(lsStatus, 0);
  assert.ok(ls.includes("wiki/concepts/existing.md"), ls);
});

test("init: query-from-anywhere requires --plugin-root", () => {
  const root = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-init-")),
    "vault",
  );
  const { status, stderr } = run([
    "init",
    root,
    "--mode",
    "query-from-anywhere",
  ]);
  assert.notEqual(status, 0);
  assert.match(stderr, /requires a plugin root/);
});

test("save-session: writes a raw capture and prints its vault-relative path", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-ss-"));
  const vault = path.join(project, "vault");
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, ".wiki-root"), "");

  const stateDir = path.join(project, ".claude", "wiki-knowledge", "sessions");
  fs.mkdirSync(stateDir, { recursive: true });
  const sessionID = "abc123-deadbeef";
  const transcript = path.join(project, `${sessionID}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "user",
      isMeta: false,
      isSidechain: false,
      message: { role: "user", content: "hello" },
    }),
    JSON.stringify({
      type: "assistant",
      isMeta: false,
      isSidechain: false,
      message: { role: "assistant", content: "world" },
    }),
  ];
  fs.writeFileSync(transcript, lines.join("\n"));
  fs.writeFileSync(
    path.join(stateDir, `${sessionID}.json`),
    JSON.stringify({ transcript_path: transcript }),
  );

  // cwd must be inside `project` (which carries `.claude`) so the SessionStart
  // hook's state is found; WIKI_ROOT points at the vault. OPENCODE_SESSION_ID is
  // cleared so an inherited value can't divert this onto the OpenCode path.
  const { status, stdout, stderr } = runEnv(
    ["save-session", "--slug", "a session"],
    {
      cwd: project,
      env: {
        CLAUDE_CODE_SESSION_ID: sessionID,
        OPENCODE_SESSION_ID: "",
        WIKI_ROOT: vault,
      },
    },
  );
  assert.equal(status, 0, stderr);
  const rel = stdout.trim();
  assert.match(
    rel,
    /^raw\/conversations\/\d{4}-\d{2}-\d{2}-\d{4}-a-session-abc123\.md$/,
  );
  assert.ok(fs.existsSync(path.join(vault, ...rel.split("/"))));
});

test("save-session: errors and exits non-zero when no session id is set", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-ss-"));
  const vault = path.join(project, "vault");
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, ".wiki-root"), "");

  const { status, stderr } = runEnv(["save-session"], {
    cwd: project,
    env: {
      WIKI_ROOT: vault,
      // Explicitly clear any inherited session-id vars (the outer process may
      // run inside a real session) so this exercises the no-id path.
      CLAUDE_CODE_SESSION_ID: "",
      OPENCODE_SESSION_ID: "",
    },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /CLAUDE_CODE_SESSION_ID|OPENCODE_SESSION_ID/);
});

test("tool-call-stats: prints the summary for a session log", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-tcs-"));
  const sessionID = "abc123-deadbeef";
  const logDir = path.join(project, ".claude", "wiki-knowledge", "sessions");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, `${sessionID}-tool-calls.jsonl`),
    `${JSON.stringify({ tool: "Bash", prompt_id: "p1" })}\n` +
      `${JSON.stringify({ tool: "Bash", prompt_id: "p1" })}\n` +
      `${JSON.stringify({ tool: "Read", prompt_id: "p2" })}\n`,
  );

  const { status, stdout, stderr } = runEnv(
    ["tool-call-stats", "--session-id", sessionID],
    {
      cwd: project,
    },
  );
  assert.equal(status, 0, stderr);
  assert.match(stdout, /Total tool calls: 3/);
  assert.match(stdout, /Bash/);
  assert.match(stdout, /Read/);
  assert.match(stdout, /1\.5 calls\/prompt/);
});

test("tool-call-stats: errors when no session id is set", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-tcs-"));
  const { status, stderr } = runEnv(["tool-call-stats"], {
    cwd: project,
    env: { CLAUDE_CODE_SESSION_ID: "" },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /no session_id/);
});

test("tool-call-stats: errors when no log exists for the session", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-tcs-"));
  const { status, stderr } = runEnv(
    ["tool-call-stats", "--session-id", "nope-none"],
    { cwd: project },
  );
  assert.notEqual(status, 0);
  assert.match(stderr, /no log found/);
});

test("unknown command: commander itself errors non-zero", () => {
  const { status } = run(["totally-bogus-command"]);
  assert.notEqual(status, 0);
});

test("ingest: executes a plan against a real git vault, printing the SHA first", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "enchiridion-cli-ingest-"),
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  await git.init({ fs, dir: root });
  await git.commit({
    fs,
    dir: root,
    message: "initial",
    author: { name: "test", email: "t@e.com", timestamp: 1, timezoneOffset: 0 },
    committer: {
      name: "test",
      email: "t@e.com",
      timestamp: 1,
      timezoneOffset: 0,
    },
  });
  fs.mkdirSync(path.join(root, "raw"), { recursive: true });
  fs.writeFileSync(path.join(root, "raw", "doc.md"), "raw\n");
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "a.md"),
    "---\ntitle: A\n---\nbody\n",
  );

  const planPath = path.join(root, "plan.json");
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      title: "Deploy notes",
      action: "ingest",
      source_date: "2026-03-01",
      raw: "raw/doc.md",
      pages: [
        {
          op: "create",
          title: "Doc",
          kind: "source",
          body: "stub body\n",
          frontmatter: { summary: "the doc", raw_source: true },
        },
        {
          op: "create",
          title: "Prepared Statements",
          kind: "concept",
          body: "page body\n",
          frontmatter: { summary: "s" },
          edges: { source: ["wiki/sources/doc.md"] },
        },
        {
          op: "update",
          title: "A",
          page_ref: "wiki/concepts/a.md",
          body: "new body\n",
          edges: { source: ["wiki/sources/doc.md"] },
        },
      ],
    }),
  );

  const { status, stdout, stderr } = runEnv(["ingest", "--plan", planPath], {
    cwd: root,
    env: { WIKI_ROOT: root, CLAUDE_CODE_SESSION_ID: "" },
  });
  assert.equal(status, 0, stderr);
  // The commit SHA is always the first line of stdout.
  const firstLine = stdout.split("\n")[0];
  assert.match(firstLine, /^[0-9a-f]{40}$/);
  // The pages were written and committed.
  assert.ok(fs.existsSync(path.join(root, "wiki", "sources", "doc.md")));
  assert.ok(
    fs.existsSync(
      path.join(root, "wiki", "concepts", "prepared-statements.md"),
    ),
  );
  // Plan file deleted on success.
  assert.ok(
    !fs.existsSync(planPath),
    "plan file should be deleted after successful ingest",
  );

  const { status: logStatus } = spawnSync(
    "git",
    ["-C", root, "log", "--oneline"],
    {
      encoding: "utf8",
    },
  );
  assert.equal(logStatus, 0);
});

test("ingest: a consolidate plan absorbs, deletes and commits once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-cli-con-"));
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "caching.md"),
    "---\ntitle: Caching\n---\nCaching is remembering a value.\n",
  );
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "caching-ttl.md"),
    "---\ntitle: Caching TTL\n---\nA cache entry expires after its TTL.\n",
  );

  // Committed first: the executor stages the deleted loser as a removal, and an
  // untracked missing path is still an error (vaultgit.add).
  const signature = {
    name: "test",
    email: "t@e.com",
    timestamp: 1,
    timezoneOffset: 0,
  };
  await git.init({ fs, dir: root });
  await git.add({ fs, dir: root, filepath: "." });
  await git.commit({
    fs,
    dir: root,
    message: "seed",
    author: signature,
    committer: signature,
  });

  const planPath = path.join(root, "plan.json");
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      title: "Caching",
      action: "consolidate",
      consolidates: ["wiki/concepts/caching-ttl.md"],
      pages: [
        {
          op: "update",
          page_ref: "wiki/concepts/caching.md",
          body: "Caching is remembering a value.\n\nA cache entry expires after its TTL.\n",
        },
      ],
    }),
  );

  const { status, stdout, stderr } = runEnv(["ingest", "--plan", planPath], {
    cwd: root,
    env: { WIKI_ROOT: root, CLAUDE_CODE_SESSION_ID: "" },
  });
  assert.equal(status, 0, stderr);
  assert.match(stdout.split("\n")[0], /^[0-9a-f]{40}$/);
  assert.ok(
    !fs.existsSync(path.join(root, "wiki", "concepts", "caching-ttl.md")),
    "the absorbed page should be deleted",
  );
  assert.ok(!fs.existsSync(planPath), "plan file should be deleted");

  const { stdout: shown } = spawnSync(
    "git",
    ["-C", root, "show", "--format=%s%n%b", "--no-patch", "HEAD"],
    { encoding: "utf8" },
  );
  assert.match(shown, /consolidate: Caching/);
  assert.match(shown, /deleted: wiki\/concepts\/caching-ttl\.md/);

  const { stdout: tree } = spawnSync(
    "git",
    ["-C", root, "ls-tree", "-r", "--name-only", "HEAD"],
    { encoding: "utf8" },
  );
  assert.ok(!tree.includes("caching-ttl.md"), tree);
});

test("ingest: plan file NOT deleted when ingest fails", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "enchiridion-cli-ingest-"),
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  await git.init({ fs, dir: root });
  await git.commit({
    fs,
    dir: root,
    message: "initial",
    author: { name: "test", email: "t@e.com", timestamp: 1, timezoneOffset: 0 },
    committer: {
      name: "test",
      email: "t@e.com",
      timestamp: 1,
      timezoneOffset: 0,
    },
  });

  // Plan references a non-existent raw file — validation fails, ingest errors.
  const planPath = path.join(root, "plan.json");
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      title: "Broken plan",
      action: "ingest",
      source_date: "2026-03-01",
      raw: "raw/missing.md",
      pages: [
        {
          op: "create",
          title: "T",
          kind: "concept",
          body: "b\n",
          frontmatter: { summary: "s" },
        },
      ],
    }),
  );

  const { status } = runEnv(["ingest", "--plan", planPath], {
    cwd: root,
    env: { WIKI_ROOT: root, CLAUDE_CODE_SESSION_ID: "" },
  });
  assert.notEqual(status, 0);
  assert.ok(fs.existsSync(planPath), "plan file must survive a failed ingest");
});

test("ingest: --dry-run prints the describe, writes nothing", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "enchiridion-cli-ingest-"),
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  await git.init({ fs, dir: root });
  await git.commit({
    fs,
    dir: root,
    message: "initial",
    author: { name: "test", email: "t@e.com", timestamp: 1, timezoneOffset: 0 },
    committer: {
      name: "test",
      email: "t@e.com",
      timestamp: 1,
      timezoneOffset: 0,
    },
  });

  const planPath = path.join(root, "plan.json");
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      title: "T",
      pages: [{ op: "create", title: "A", kind: "concept", body: "b\n" }],
    }),
  );

  const { status, stdout, stderr } = runEnv(
    ["ingest", "--plan", planPath, "--dry-run"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), "ingest: T\n  create wiki/concepts/a.md");
  assert.ok(!fs.existsSync(path.join(root, "wiki", "concepts", "a.md")));
});

test("ingest: --plan and --ignore are mutually exclusive, one required", () => {
  const { status, stderr } = run(["ingest"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /--plan|--ignore/);
});

test("ingest: --ignore appends to the folder's .ingestignore", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "enchiridion-cli-ingest-"),
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  fs.mkdirSync(path.join(root, "raw", "emails"), { recursive: true });
  fs.writeFileSync(path.join(root, "raw", "emails", "foo.eml"), "x");

  const { status, stderr } = runEnv(
    ["ingest", "--ignore", "raw/emails/foo.eml", "--ignore-comment", "done"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  const ignoreFile = fs.readFileSync(
    path.join(root, "raw", "emails", ".ingestignore"),
    "utf8",
  );
  assert.equal(ignoreFile, "foo.eml  # done\n");
});

test("ingest: multiple --ignore flags in one call all get written", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "enchiridion-cli-ingest-"),
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  fs.mkdirSync(path.join(root, "raw", "emails"), { recursive: true });
  fs.writeFileSync(path.join(root, "raw", "emails", "a.eml"), "x");
  fs.writeFileSync(path.join(root, "raw", "emails", "b.eml"), "x");

  const { status, stderr } = runEnv(
    [
      "ingest",
      "--ignore",
      "raw/emails/a.eml",
      "--ignore",
      "raw/emails/b.eml",
      "--ignore-comment",
      "bulk",
    ],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  const ignoreFile = fs.readFileSync(
    path.join(root, "raw", "emails", ".ingestignore"),
    "utf8",
  );
  assert.ok(ignoreFile.includes("a.eml  # bulk\n"), ignoreFile);
  assert.ok(ignoreFile.includes("b.eml  # bulk\n"), ignoreFile);
});

test("ingest: --ignore rejects a path outside raw/", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "enchiridion-cli-ingest-"),
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  const { status, stderr } = runEnv(["ingest", "--ignore", "notes/x.md"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /under raw\//);
});

test("commit: writes one structured commit per manifest, printing the SHA", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "enchiridion-cli-commit-"),
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  await git.init({ fs, dir: root });
  await git.commit({
    fs,
    dir: root,
    message: "initial",
    author: { name: "test", email: "t@e.com", timestamp: 1, timezoneOffset: 0 },
    committer: {
      name: "test",
      email: "t@e.com",
      timestamp: 1,
      timezoneOffset: 0,
    },
  });

  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "a.md"),
    "---\ntitle: A\n---\nbody\n",
  );

  const manifest = path.join(root, "manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({ title: "T", created: ["wiki/concepts/a.md"] }),
  );

  const { status, stdout, stderr } = runEnv(
    ["commit", "--manifest", manifest],
    {
      cwd: root,
      env: { WIKI_ROOT: root },
    },
  );
  assert.equal(status, 0, stderr);
  assert.match(stdout.trim(), /^[0-9a-f]{40}$/);
});

test("commit: a missing --manifest flag errors non-zero", () => {
  const { status, stderr } = run(["commit"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /manifest/);
});

test("commit: a manifest failing chain-of-evidence is rejected non-zero", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "enchiridion-cli-commit-"),
  );
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "a.md"),
    "---\ntitle: A\n---\nbody\n",
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");

  await git.init({ fs, dir: root });
  await git.add({ fs, dir: root, filepath: "." });
  await git.commit({
    fs,
    dir: root,
    message: "initial",
    author: { name: "test", email: "t@e.com", timestamp: 1, timezoneOffset: 0 },
    committer: {
      name: "test",
      email: "t@e.com",
      timestamp: 1,
      timezoneOffset: 0,
    },
  });

  const manifest = path.join(root, "manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      title: "T",
      created: ["wiki/concepts/a.md"],
      raw_source: "raw/doc.md",
    }),
  );

  const { status, stderr } = runEnv(["commit", "--manifest", manifest], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /needs a sources\/ page/);
});

test("place: prints the vault-relative path for a valid kind and title", () => {
  const { status, stdout } = run(["place", "concept", "Connection Pooling"]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "wiki/concepts/connection-pooling.md");
});

test("place: unknown kind errors non-zero", () => {
  const { status, stderr } = run(["place", "nonsense", "X"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /unknown kind/);
});

test("read-page: prints a page's full markdown by vault-relative ref", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-rp-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "a.md"),
    "---\ntitle: A\nsummary: s\n---\n\nbody text\n",
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");

  const { status, stdout, stderr } = runEnv(
    ["read-page", "wiki/concepts/a.md"],
    {
      cwd: root,
      env: { WIKI_ROOT: root },
    },
  );
  assert.equal(status, 0, stderr);
  assert.equal(stdout, "---\ntitle: A\nsummary: s\n---\n\nbody text\n");
});

test("read-page --json: emits {page_ref, frontmatter, body} as one compact line", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-rp-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "a.md"),
    "---\ntitle: A\ntags:\n  - db\n---\n\nbody text\n",
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");

  const { status, stdout, stderr } = runEnv(
    ["read-page", "wiki/concepts/a.md", "--json"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  const payload = JSON.parse(stdout);
  assert.equal(payload.page_ref, "wiki/concepts/a.md");
  assert.deepEqual(payload.frontmatter, { title: "A", tags: ["db"] });
  assert.equal(payload.body, "\nbody text\n");
  // One document, one line: the page is not pretty-printed across many.
  assert.equal(stdout, JSON.stringify(payload) + "\n");
});

test("read-page: a missing ref errors non-zero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-rp-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".wiki-root"), "");

  const { status, stderr } = runEnv(["read-page", "wiki/concepts/missing.md"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /page not found/);
});

test("read-page: wrong argument count errors non-zero", () => {
  const { status } = run(["read-page"]);
  assert.notEqual(status, 0);
});

test("superseded-by: resolves a seed to its current head", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-ssby-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "old.md"),
    "---\ntitle: Old\nsummary: s\ntags: []\nsource_date: 2026-01-01\nvolatility: stable\n---\n\n",
  );
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "new.md"),
    '---\ntitle: New\nsummary: s\ntags: []\nsource_date: 2026-01-01\nvolatility: stable\nsupersedes:\n  - "[Old](old.md)"\n---\n\n',
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");

  const { status, stdout, stderr } = runEnv(
    ["superseded-by", "wiki/concepts/old.md"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), "wiki/concepts/old.md  ->  wiki/concepts/new.md");
});

test("superseded-by: a current page prints (current)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-ssby-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "a.md"),
    "---\ntitle: A\nsummary: s\ntags: []\nsource_date: 2026-01-01\nvolatility: stable\n---\n\n",
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");

  const { status, stdout, stderr } = runEnv(
    ["superseded-by", "wiki/concepts/a.md"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(stdout.trim(), "wiki/concepts/a.md  (current)");
});

test("superseded-by: no args errors non-zero", () => {
  const { status } = run(["superseded-by"]);
  assert.notEqual(status, 0);
});

test("ingest-scan: lists eligible raw files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-iscan-"));
  fs.mkdirSync(path.join(root, "raw"), { recursive: true });
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(path.join(root, "raw", "foo.md"), "raw");
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "a.md"),
    "---\ntitle: A\n---\n\n",
  );
  fs.writeFileSync(path.join(root, ".wiki-root"), "");

  const { status, stdout, stderr } = runEnv(["ingest-scan", "--json"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);
  const records = stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "eligible");
  assert.equal(records[0].raw_rel, "raw/foo.md");
  assert.equal(records[0].reason, "never-ingested");
});

// ---------------------------------------------------------------------------
// check / fix — the vault-health pair
// ---------------------------------------------------------------------------

/** A vault with two structural violations and two well-formed pages. */
function buildLintableVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-check-"));
  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write("wiki/loose.md", "---\ntitle: Loose\nsummary: s\n---\n\n");
  write(
    "wiki/concepts/nested/deep.md",
    "---\ntitle: Deep\nsummary: s\n---\n\n",
  );
  write("wiki/concepts/a.md", "---\ntitle: A\nsummary: s\n---\n\n");
  write("wiki/concepts/b.md", "---\ntitle: B\nsummary: s\n---\n\n");
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  return root;
}

/** The same vault plus one page whose frontmatter carries an unquoted YAML
 * list link — check 3's and fix 3's shared defect. Kept out of
 * buildLintableVault: the sequence `- [B](b.md)` does not merely look wrong,
 * it is unparseable, so every record-reading check on that vault throws. */
function buildQuotelessVault(): string {
  const root = buildLintableVault();
  fs.writeFileSync(
    path.join(root, "wiki/concepts/a.md"),
    "---\ntitle: A\nsummary: s\nrelated:\n  - [B](b.md)\n---\n\n",
  );
  return root;
}

test("check --json: one finding per line, each a self-contained object", () => {
  const root = buildLintableVault();
  const { status, stdout, stderr } = runEnv(
    ["check", "kind-folder-conformance", "--json"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  const rows = stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    rows.map((r) => r.pageRef),
    ["wiki/concepts/nested/deep.md", "wiki/loose.md"],
  );
  assert.match(rows[1].detail, /at wiki\/ root/);
  // One object per line, not one array wrapping them — a consumer iterates
  // stdout line by line without buffering the whole result.
  assert.notEqual(stdout.trim()[0], "[");
});

test("check --json: a clean check is silence, not []", () => {
  const root = buildLintableVault();
  const { status, stdout, stderr } = runEnv(
    ["check", "contradiction-callouts", "--json"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(stdout, "");
});

test("check: an unknown name errors non-zero, naming the known ones", () => {
  const root = buildLintableVault();
  const { status, stderr } = runEnv(["check", "nope"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /unknown check "nope"/);
});

/** A committed vault with one fragmented concept pair, for check 10 at the
 * CLI seam. Committed because the check reads the search index, which is a
 * view of HEAD (ADR-0015). */
async function buildFragmentedVault(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-frag-"));
  const files = {
    "wiki/concepts/cache-eviction.md":
      "---\ntitle: Cache eviction\ntags:\n  - caching\n  - performance\n---\n" +
      "See [cache invalidation](cache-invalidation.md).\n",
    "wiki/concepts/cache-invalidation.md":
      "---\ntitle: Cache invalidation\ntags:\n  - caching\n  - performance\n---\n" +
      "Body.\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  await git.init({ fs, dir: root });
  for (const filepath of Object.keys(files)) {
    await git.add({ fs, dir: root, filepath });
  }
  const author = {
    name: "t",
    email: "t@e.com",
    timestamp: 1,
    timezoneOffset: 0,
  };
  await git.commit({
    fs,
    dir: root,
    message: "init",
    author,
    committer: author,
  });
  return root;
}

test("check concept-fragmentation --json: a cluster carries the structured proposal", async () => {
  const root = await buildFragmentedVault();
  const { status, stdout, stderr } = runEnv(
    ["check", "concept-fragmentation", "--json"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  const rows = stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pageRef, "wiki/concepts/cache-invalidation.md");
  assert.equal(
    rows[0].cluster.suggestedSurvivor,
    "wiki/concepts/cache-invalidation.md",
  );
  assert.deepEqual(
    rows[0].cluster.members.map((m: { pageRef: string }) => m.pageRef),
    ["wiki/concepts/cache-eviction.md", "wiki/concepts/cache-invalidation.md"],
  );
  assert.deepEqual(rows[0].cluster.basis, {
    tags: ["caching", "performance"],
    titleTokens: ["cache"],
  });
});

test("check --min-similarity: a value above every pair scores is silent", async () => {
  const root = await buildFragmentedVault();
  const { status, stdout, stderr } = runEnv(
    ["check", "concept-fragmentation", "--min-similarity", "0.9", "--json"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(stdout, "");
});

test("check --min-similarity: rejects a value outside [0, 1]", () => {
  const root = buildLintableVault();
  const { status, stderr } = runEnv(
    ["check", "concept-fragmentation", "--min-similarity", "1.5"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.notEqual(status, 0);
  assert.match(stderr, /min-similarity/);
});

test("fix: prints each changed page ref, one per line", () => {
  const root = buildQuotelessVault();
  const { status, stdout, stderr } = runEnv(
    ["fix", "frontmatter-link-format"],
    {
      cwd: root,
      env: { WIKI_ROOT: root },
    },
  );
  assert.equal(status, 0, stderr);
  assert.equal(stdout, "wiki/concepts/a.md\n");
  assert.match(
    fs.readFileSync(path.join(root, "wiki/concepts/a.md"), "utf8"),
    /- "\[B\]\(b\.md\)"/,
  );
});

test("fix: an unknown name errors non-zero, naming the known ones", () => {
  const root = buildLintableVault();
  const { status, stderr } = runEnv(["fix", "nope"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /unknown fix "nope"/);
});

test("watch --dequeue: removes one queue entry and exits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-watch-"));
  const wk = path.join(root, ".wiki-knowledge");
  fs.mkdirSync(wk, { recursive: true });
  fs.writeFileSync(path.join(wk, "watch-queue.jsonl"), "raw/a.md\nraw/b.md\n");
  fs.writeFileSync(path.join(root, ".wiki-root"), "");

  const { status, stderr } = runEnv(["watch", "--dequeue", "raw/a.md"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);
  const remaining = fs
    .readFileSync(path.join(wk, "watch-queue.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.deepEqual(remaining, ["raw/b.md"]);
});

test("watch: without --dequeue requires a lock and errors when held", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-watch-"));
  const wk = path.join(root, ".wiki-knowledge");
  fs.mkdirSync(wk, { recursive: true });
  fs.mkdirSync(path.join(root, "raw"), { recursive: true });
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  // A live lock (this pid is alive) makes a second watcher refuse to start.
  fs.writeFileSync(
    path.join(wk, "watch.lock"),
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
  );

  const { status, stderr } = runEnv(["watch", "--poll-interval", "1"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /another watcher is already running/);
});

// ---------------------------------------------------------------------------
// discover — needs a committed vault (search is a view of committed history)
// ---------------------------------------------------------------------------

/** Write a page under a vault's wiki/, then init+commit the whole vault. */
async function buildCommittedVault(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-disc-"));
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  await git.init({ fs, dir: root });

  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  write(
    "wiki/concepts/connection-pooling.md",
    "---\ntitle: Connection Pooling in Postgres\nsummary: Reuse connections instead of opening a new one per request.\ntags:\n  - database\nvolatility: stable\n---\n\nConnection pooling reduces per-request handshake overhead by reusing a fixed set of open connections across callers.\n",
  );
  write(
    "wiki/concepts/sourdough-starter.md",
    "---\ntitle: Feeding a Sourdough Starter\nsummary: Daily flour-and-water feeding keeps a starter active.\ntags:\n  - baking\nvolatility: stable\n---\n\nA sourdough starter needs equal parts flour and water once a day, kept warm, to stay active enough to leaven bread.\n",
  );

  await git.add({ fs, dir: root, filepath: "." });
  await git.commit({
    fs,
    dir: root,
    message: "fixtures",
    author: { name: "test", email: "t@e.com", timestamp: 1, timezoneOffset: 0 },
    committer: {
      name: "test",
      email: "t@e.com",
      timestamp: 1,
      timezoneOffset: 0,
    },
  });
  return root;
}

test("discover: single-page mode finds the overlapping page and emits one candidate per line", async () => {
  const root = await buildCommittedVault();
  const { status, stdout, stderr } = runEnv(
    [
      "discover",
      "--title",
      "Connection Pooling in Postgres",
      "--related-threshold",
      "0.000001",
    ],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  const lines = stdout.trim().split("\n");
  assert.ok(lines.length > 0);
  const first = JSON.parse(lines[0]);
  assert.equal(first.page_ref, "wiki/concepts/connection-pooling.md");
});

test("discover: --plan emits the pages and vocabulary payload", async () => {
  const root = await buildCommittedVault();
  const planPath = path.join(root, "draft.json");
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      title: "Draft",
      pages: [
        {
          op: "create",
          title: "Connection Pooling in Postgres",
          kind: "concept",
          frontmatter: { summary: "" },
          body: "",
        },
      ],
    }),
  );
  const { status, stdout, stderr } = runEnv(["discover", "--plan", planPath], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);
  const payload = JSON.parse(stdout);
  assert.ok(Array.isArray(payload.pages));
  assert.ok(Array.isArray(payload.vocabulary));
  assert.equal(payload.pages.length, 1);
  assert.equal(payload.pages[0].title, "Connection Pooling in Postgres");
});

test("discover: --plan - reads the draft from stdin", async () => {
  const root = await buildCommittedVault();
  const draft = JSON.stringify({
    title: "Draft",
    pages: [
      {
        op: "create",
        title: "Feeding a Sourdough Starter",
        kind: "concept",
        frontmatter: { summary: "" },
        body: "",
      },
    ],
  });
  const result = spawnSync(tsxBin, [cliPath, "discover", "--plan", "-"], {
    encoding: "utf8",
    input: draft,
    cwd: root,
    env: { ...process.env, WIKI_ROOT: root },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.pages));
  assert.equal(payload.pages.length, 1);
});

test("discover: --plan --tags-containing folds the matches into the one document", async () => {
  const root = await buildCommittedVault();
  const planPath = path.join(root, "draft.json");
  fs.writeFileSync(planPath, JSON.stringify({ title: "Draft", pages: [] }));
  const { status, stdout, stderr } = runEnv(
    ["discover", "--plan", planPath, "--tags-containing", "data"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  // Still exactly one JSON document — the matches ride inside it as a named
  // field, not after it as plain text a JSON reader would discard.
  const payload = JSON.parse(stdout);
  assert.deepEqual(payload.tag_matches, ["database"]);
  assert.equal(payload.vocabulary, undefined);
});

test("discover: --plan --tag-count reports each asked-for tag's count in the one document", async () => {
  const root = await buildCommittedVault();
  const planPath = path.join(root, "draft.json");
  fs.writeFileSync(planPath, JSON.stringify({ title: "Draft", pages: [] }));
  const { status, stdout, stderr } = runEnv(
    [
      "discover",
      "--plan",
      planPath,
      "--tags-containing",
      "data",
      "--tag-count",
      "database,never-minted",
    ],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  const payload = JSON.parse(stdout);
  assert.deepEqual(payload.tag_counts, [
    { tag: "database", count: 1 },
    // 0 is the signal that minting the tag is safe.
    { tag: "never-minted", count: 0 },
  ]);
});

// ---------------------------------------------------------------------------
// search — JSON Lines for hits, one document for the index's own state
// ---------------------------------------------------------------------------

test("search --json: one hit object per line", async () => {
  const root = await buildCommittedVault();
  const { status, stdout, stderr } = runEnv(
    ["search", "connection pooling", "--json"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  const rows = stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(rows[0].page_ref, "wiki/concepts/connection-pooling.md");
  // The row's keys are the contract, unchanged by this ticket.
  for (const key of [
    "page_ref",
    "score",
    "title",
    "summary",
    "tags",
    "kind",
    "source_date",
    "git_date",
    "volatility",
    "superseded_by",
    "snippet",
  ]) {
    assert.ok(key in rows[0], `row is missing ${key}`);
  }
});

test("search --json: no hits is silence, not []", async () => {
  const root = await buildCommittedVault();
  const { status, stdout, stderr } = runEnv(
    ["search", "zzzznothingmatchesthis", "--json"],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.equal(status, 0, stderr);
  assert.equal(stdout, "");
});

test("search --reindex --json: one compact JSON document", async () => {
  const root = await buildCommittedVault();
  const { status, stdout, stderr } = runEnv(["search", "--reindex", "--json"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);
  const payload = JSON.parse(stdout);
  assert.equal(payload.pages, 2);
  assert.equal(stdout, JSON.stringify(payload) + "\n");
});

test("search --status --json: one compact JSON document", async () => {
  const root = await buildCommittedVault();
  const { status, stdout, stderr } = runEnv(["search", "--status", "--json"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);
  const payload = JSON.parse(stdout);
  for (const key of [
    "pages",
    "db_size_bytes",
    "backend",
    "schema_version",
    "git_head",
    "uncommitted_pages",
  ]) {
    assert.ok(key in payload, `status is missing ${key}`);
  }
  assert.equal(stdout, JSON.stringify(payload) + "\n");
});

test("vault kinds: canonical-only vault returns four entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vault-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.mkdirSync(path.join(root, "wiki", "entities"), { recursive: true });
  fs.mkdirSync(path.join(root, "wiki", "sources"), { recursive: true });
  fs.mkdirSync(path.join(root, "wiki", "synthesis"), { recursive: true });
  const { status, stdout, stderr } = runEnv(["vault", "kinds"], {
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);
  const kinds = JSON.parse(stdout.trim()) as {
    kind: string;
    folder: string;
    canonical: boolean;
    definition: null;
  }[];
  assert.equal(kinds.length, 4);
  for (const entry of kinds) {
    assert.equal(entry.canonical, true);
    assert.equal(entry.definition, null);
  }
  const kindNames = kinds.map((e) => e.kind);
  assert.ok(kindNames.includes("concept"));
  assert.ok(kindNames.includes("entity"));
  assert.ok(kindNames.includes("source"));
  assert.ok(kindNames.includes("synthesis"));
});

test("vault kinds: custom folder without KIND.md has definition null", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vault-"));
  fs.mkdirSync(path.join(root, "wiki", "decisions"), { recursive: true });
  const { status, stdout, stderr } = runEnv(["vault", "kinds"], {
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);
  const kinds = JSON.parse(stdout.trim()) as {
    kind: string;
    folder: string;
    canonical: boolean;
    definition: unknown;
  }[];
  const custom = kinds.filter((e) => !e.canonical);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].kind, "decision");
  assert.equal(custom[0].folder, "decisions");
  assert.equal(custom[0].definition, null);
});

test("vault kinds: custom folder with KIND.md reports declared kind and summary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vault-"));
  fs.mkdirSync(path.join(root, "wiki", "people"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "people", "KIND.md"),
    "---\nkind: person\nsummary: A human individual.\n---\nOptional body.\n",
  );
  const { status, stdout, stderr } = runEnv(["vault", "kinds"], {
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);
  const kinds = JSON.parse(stdout.trim()) as {
    kind: string;
    folder: string;
    canonical: boolean;
    definition: { kind: string; summary: string } | null;
  }[];
  const custom = kinds.filter((e) => !e.canonical);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].kind, "person");
  assert.equal(custom[0].folder, "people");
  assert.equal(custom[0].canonical, false);
  assert.deepEqual(custom[0].definition, {
    kind: "person",
    summary: "A human individual.",
  });
});

test("vault kinds: respects WIKI_ROOT env var", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vault-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vault-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.mkdirSync(path.join(other, "wiki", "people"), { recursive: true });
  fs.writeFileSync(
    path.join(other, "wiki", "people", "KIND.md"),
    "---\nkind: person\nsummary: A human individual.\n---\n",
  );
  const { status, stdout, stderr } = runEnv(["vault", "kinds"], {
    cwd: root,
    env: { WIKI_ROOT: other },
  });
  assert.equal(status, 0, stderr);
  const kinds = JSON.parse(stdout.trim()) as {
    kind: string;
    canonical: boolean;
  }[];
  const custom = kinds.filter((e) => !e.canonical);
  assert.equal(custom.length, 1);
  assert.equal(custom[0].kind, "person");
});

// ---------------------------------------------------------------------------
// export: --candidates, and the wiki title (#477)
// ---------------------------------------------------------------------------

test("export --candidates: the ranked list is one compact JSON document", async () => {
  const root = await buildCommittedVault();
  const { status, stdout, stderr } = runEnv(["export", "--candidates"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);
  const candidates = JSON.parse(stdout);
  assert.deepEqual(
    candidates.map((c: { pageRef: string }) => c.pageRef),
    [
      "wiki/concepts/connection-pooling.md",
      "wiki/concepts/sourdough-starter.md",
    ],
  );
  // The whole list is one document the caller parses in one go — the dialect
  // is how many documents, not the outer JSON type.
  assert.equal(stdout, JSON.stringify(candidates) + "\n");
  assert.ok(!stdout.includes("\n "));
});

test("export --save-title: persists the title, writes no site", async () => {
  const root = await buildCommittedVault();
  const { status, stdout, stderr } = runEnv(
    ["export", "--save-title", "Team Wiki"],
    {
      cwd: root,
      env: { WIKI_ROOT: root },
    },
  );
  assert.equal(status, 0, stderr);

  const configPath = path.join(root, ".wiki-knowledge", "config.json");
  assert.equal(
    JSON.parse(fs.readFileSync(configPath, "utf8")).title,
    "Team Wiki",
    "the title should be persisted to the vault config",
  );
  assert.ok(stdout.includes("Team Wiki"), "confirmation should name the title");
  assert.ok(
    !fs.existsSync(path.join(root, "web")),
    "saving a title must not export a site",
  );
});

test("export --save-title: a blank title errors non-zero and writes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-cli-save-"));
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  const { status, stderr } = runEnv(["export", "--save-title", "  "], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.notEqual(status, 0);
  assert.match(stderr, /title/i);
  assert.ok(!fs.existsSync(path.join(root, ".wiki-knowledge", "config.json")));
});

test("export: a saved title persists across runs; --title overrides one run only", async () => {
  const root = await buildCommittedVault();
  const env = { cwd: root, env: { WIKI_ROOT: root } };
  const navTitle = (): string => {
    const html = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
    const match = /<span class="wiki-nav-title">([^<]*)<\/span>/.exec(html);
    assert.ok(match, "the exported front page should carry a nav title");
    return match[1];
  };

  runEnv(["export", "--save-title", "Saved Wiki"], env);
  runEnv(["export", "--force"], env);
  assert.equal(navTitle(), "Saved Wiki", "the saved title should apply");

  runEnv(["export", "--force", "--title", "One Off"], env);
  assert.equal(navTitle(), "One Off", "--title should win for this run");
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(root, ".wiki-knowledge", "config.json"),
        "utf8",
      ),
    ).title,
    "Saved Wiki",
    "--title must leave the saved default untouched",
  );

  runEnv(["export", "--force"], env);
  assert.equal(navTitle(), "Saved Wiki", "the saved title should survive");
});

// ---------------------------------------------------------------------------
// export: single-file mode (#478)
// ---------------------------------------------------------------------------

test("export --single-file: defaults to wiki.html at the vault root", async () => {
  const root = await buildCommittedVault();
  const { status, stdout, stderr } = runEnv(["export", "--single-file"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0, stderr);

  const outFile = path.join(root, "wiki.html");
  assert.ok(fs.existsSync(outFile), "the export should write wiki.html");
  assert.ok(
    !fs.existsSync(path.join(root, "web")),
    "single-file mode writes no site directory",
  );
  assert.ok(stdout.includes(outFile), "the run should report where it wrote");
});

test("export --single-file --out: names the file, and re-running replaces it", async () => {
  const root = await buildCommittedVault();
  const outFile = path.join(root, "share", "team.html");
  const env = { cwd: root, env: { WIKI_ROOT: root } };

  const first = runEnv(
    ["export", "--single-file", "--out", outFile, "--allow-dirty"],
    env,
  );
  assert.equal(first.status, 0, first.stderr);
  assert.ok(fs.existsSync(outFile), "the named file should be written");
  const before = fs.readFileSync(outFile, "utf8");

  // A second run refreshes it — no --force, and no refusal for a non-empty
  // parent directory.
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "new-page.md"),
    "---\ntitle: A New Page\nkind: concept\n---\n\nBody.\n",
  );
  const second = runEnv(
    ["export", "--single-file", "--out", outFile, "--allow-dirty"],
    env,
  );
  assert.equal(second.status, 0, second.stderr);
  const after = fs.readFileSync(outFile, "utf8");
  assert.notEqual(after, before, "the file should be replaced");
  assert.ok(
    after.includes('id="wiki-concepts-new-page"'),
    "the refreshed file should carry the new page's section",
  );
});

test("export --single-file: the written file is self-contained", async () => {
  const root = await buildCommittedVault();
  const { status } = runEnv(["export", "--single-file"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.equal(status, 0);

  const html = fs.readFileSync(path.join(root, "wiki.html"), "utf8");
  assert.ok(html.includes("<script>"), "the inline script should be present");
  assert.ok(
    html.includes("Sakura.css v"),
    "the framework CSS should be inlined",
  );
  assert.ok(!html.includes("<link"), "nothing should be linked");
  assert.ok(
    /href="#wiki-concepts-connection-pooling"/.test(html),
    "internal links should be fragment links",
  );
});

test("export --single-file: a directory --out is refused with a clear message", async () => {
  const root = await buildCommittedVault();
  fs.mkdirSync(path.join(root, "web"));
  const { status, stderr } = runEnv(
    ["export", "--single-file", "--out", path.join(root, "web")],
    { cwd: root, env: { WIKI_ROOT: root } },
  );
  assert.notEqual(status, 0, "a directory target should fail");
  assert.match(stderr, /directory/i, "the message should name the problem");
  assert.ok(
    !fs.existsSync(path.join(root, "wiki.html")),
    "nothing should be written elsewhere either",
  );
});

test("export --single-file: a vault with uncommitted changes is still refused", async () => {
  const root = await buildCommittedVault();
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "sourdough-starter.md"),
    "---\ntitle: Dirty\n---\n\nEdited.\n",
  );
  const { status, stderr } = runEnv(["export", "--single-file"], {
    cwd: root,
    env: { WIKI_ROOT: root },
  });
  assert.notEqual(status, 0, "the dirty-tree check applies in this mode too");
  assert.match(stderr, /uncommitted/i);
  assert.ok(
    !fs.existsSync(path.join(root, "wiki.html")),
    "no file should be written when the check fails",
  );
});
