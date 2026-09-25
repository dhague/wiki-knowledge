/** Unit tests for sessionstate: mock env lookups and temp-dir state, so no real
 * Claude Code environment or hook is touched. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sessionsDir,
  findSessionsDir,
  writeTranscriptPath,
  readTranscriptPath,
} from "./sessionstate.js";
import type { LookupEnv } from "./sessionstate.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sessionstate-test-"));
}

/** Build a LookupEnv from a fixed map (missing keys report not-present). */
function env(map: Record<string, string>): LookupEnv {
  return (key: string): [string | undefined, boolean] => {
    const value = map[key];
    return [value, value !== undefined];
  };
}

/** A cwd with no `.claude` above it, for the unresolvable-root tests. The sandbox
 * is injected as $HOME so the walk-up stops at the boundary instead of escaping
 * into the real filesystem, where a stray marker would change the answer. */
function sandbox(): { home: string; cwd: string } {
  const home = tmp();
  const cwd = path.join(home, "no", "project", "here");
  fs.mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

// ---------------------------------------------------------------------------
// sessionsDir resolution order
// ---------------------------------------------------------------------------

test("sessionsDir: CLAUDE_PROJECT_DIR wins over a .claude ancestor", () => {
  const project = tmp();
  const elsewhere = tmp();
  fs.mkdirSync(path.join(elsewhere, ".claude"), { recursive: true });
  const got = sessionsDir(elsewhere, env({ CLAUDE_PROJECT_DIR: project }));
  assert.equal(
    got,
    path.join(project, ".claude", "wiki-knowledge", "sessions"),
  );
});

test("sessionsDir: walks up to the nearest .claude ancestor", () => {
  const root = tmp();
  const nested = path.join(root, "a", "b");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  const got = sessionsDir(nested, env({}));
  assert.equal(got, path.join(root, ".claude", "wiki-knowledge", "sessions"));
});

test("sessionsDir: falls back to cwd when no .claude ancestor exists", () => {
  const { home, cwd } = sandbox();
  const got = sessionsDir(cwd, env({ HOME: home }));
  assert.equal(got, path.join(cwd, ".claude", "wiki-knowledge", "sessions"));
});

test("sessionsDir: empty CLAUDE_PROJECT_DIR is ignored", () => {
  const root = tmp();
  const nested = path.join(root, "a");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  const got = sessionsDir(nested, env({ CLAUDE_PROJECT_DIR: "" }));
  assert.equal(got, path.join(root, ".claude", "wiki-knowledge", "sessions"));
});

test("sessionsDir: the walk stops at the home directory", () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const cwd = path.join(home, "scratch");
  fs.mkdirSync(cwd, { recursive: true });
  const got = sessionsDir(cwd, env({ HOME: home }));
  assert.equal(got, path.join(cwd, ".claude", "wiki-knowledge", "sessions"));
});

// ---------------------------------------------------------------------------
// findSessionsDir — the same rule, refusing the cwd guess
// ---------------------------------------------------------------------------

test("findSessionsDir: CLAUDE_PROJECT_DIR, without a .claude on disk", () => {
  const project = tmp();
  const { home, cwd } = sandbox();
  const got = findSessionsDir(
    cwd,
    env({ HOME: home, CLAUDE_PROJECT_DIR: project }),
  );
  assert.equal(
    got,
    path.join(project, ".claude", "wiki-knowledge", "sessions"),
  );
});

test("findSessionsDir: walks up to the nearest .claude ancestor", () => {
  const root = tmp();
  const nested = path.join(root, "a", "b");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  const got = findSessionsDir(nested, env({}));
  assert.equal(got, path.join(root, ".claude", "wiki-knowledge", "sessions"));
});

test("findSessionsDir: undefined when no project is identifiable (#485)", () => {
  const { home, cwd } = sandbox();
  assert.equal(findSessionsDir(cwd, env({ HOME: home })), undefined);
});

test("findSessionsDir: undefined rather than the home directory (#485)", () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const cwd = path.join(home, "scratch");
  fs.mkdirSync(cwd, { recursive: true });
  assert.equal(findSessionsDir(cwd, env({ HOME: home })), undefined);
});

test("findSessionsDir: a project under the home directory still resolves", () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const project = path.join(home, "code", "vault");
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  const got = findSessionsDir(
    path.join(project, "wiki", "concepts"),
    env({ HOME: home }),
  );
  assert.equal(
    got,
    path.join(project, ".claude", "wiki-knowledge", "sessions"),
  );
});

// ---------------------------------------------------------------------------
// write / read transcript path
// ---------------------------------------------------------------------------

test("writeTranscriptPath then readTranscriptPath round-trips", () => {
  const stateDir = path.join(tmp(), ".claude", "wiki-knowledge", "sessions");
  writeTranscriptPath("sess-123", "/tmp/transcript.jsonl", stateDir);
  assert.equal(
    readTranscriptPath("sess-123", stateDir),
    "/tmp/transcript.jsonl",
  );
});

test("writeTranscriptPath creates the state directory", () => {
  const stateDir = path.join(tmp(), "nested", "state");
  writeTranscriptPath("sess-1", "/t.jsonl", stateDir);
  assert.ok(fs.statSync(stateDir).isDirectory());
  const raw = fs.readFileSync(path.join(stateDir, "sess-1.json"), "utf8");
  assert.deepEqual(JSON.parse(raw), { transcript_path: "/t.jsonl" });
});

test("readTranscriptPath is undefined for a missing session", () => {
  const stateDir = path.join(tmp(), "state");
  assert.equal(readTranscriptPath("nope", stateDir), undefined);
});

test("readTranscriptPath is undefined for unparsable state", () => {
  const stateDir = path.join(tmp(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "bad.json"), "not json");
  assert.equal(readTranscriptPath("bad", stateDir), undefined);
});

test("readTranscriptPath is undefined when transcript_path is not a string", () => {
  const stateDir = path.join(tmp(), "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "x.json"),
    JSON.stringify({ transcript_path: 42 }),
  );
  assert.equal(readTranscriptPath("x", stateDir), undefined);
});
