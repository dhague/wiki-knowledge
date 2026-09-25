/** hooks tests — the session-start and post-tool-use handlers, failing open. Each
 * test drives an injected LookupEnv rather than mutating the real one. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionStart, postToolUse } from "./hooks.js";
import { sessionsDir, readTranscriptPath } from "./sessionstate.js";
import type { LookupEnv } from "./sessionstate.js";

/** Build a LookupEnv from a fixed map (missing keys report not-present). */
function env(map: Record<string, string>): LookupEnv {
  return (key: string): [string | undefined, boolean] => {
    const value = map[key];
    return [value, value !== undefined];
  };
}

/** Where the hooks should have written for `project`. */
function sessionsDirFor(project: string): string {
  return sessionsDir("", env({ CLAUDE_PROJECT_DIR: project }));
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-hooks-"));
}

/** A project no hook has touched: no `.claude` in it, with `home` injected as
 * $HOME so a walk-up stops there. */
function freshProject(): {
  home: string;
  project: string;
  contentDir: string;
} {
  const home = tmp();
  const project = path.join(home, "project");
  const contentDir = path.join(project, "wiki", "concepts");
  fs.mkdirSync(contentDir, { recursive: true });
  return { home, project, contentDir };
}

// --- SessionStart ------------------------------------------------------------

test("sessionStart records transcript path under $CLAUDE_PROJECT_DIR", () => {
  const project = tmp();
  sessionStart(
    {
      session_id: "abc123",
      transcript_path: "/x/abc123.jsonl",
      cwd: "/somewhere/else",
    },
    env({ CLAUDE_PROJECT_DIR: project }),
  );
  assert.equal(
    readTranscriptPath("abc123", sessionsDirFor(project)),
    "/x/abc123.jsonl",
  );
});

test("sessionStart falls back to the payload cwd", () => {
  // At session start the payload cwd is the project root, unlike in postToolUse.
  const { home, project } = freshProject();
  sessionStart(
    {
      session_id: "abc123",
      transcript_path: "/x/abc123.jsonl",
      cwd: project,
    },
    env({ HOME: home }),
  );
  assert.equal(
    readTranscriptPath("abc123", sessionsDirFor(project)),
    "/x/abc123.jsonl",
  );
});

test("sessionStart incomplete payload is a silent no-op", () => {
  for (const payload of [
    { transcript_path: "/x/abc123.jsonl", cwd: tmp() },
    { session_id: "abc123", cwd: tmp() },
  ]) {
    sessionStart(payload, env({}));
    const root = payload.cwd as string;
    assert.ok(
      !fs.existsSync(sessionsDirFor(root)),
      "sessions dir was created; want no state written",
    );
  }
});

// --- PostToolUse -------------------------------------------------------------

function logLines(
  project: string,
  sessionID: string,
): Array<Record<string, unknown>> {
  const data = fs.readFileSync(
    path.join(sessionsDirFor(project), `${sessionID}-tool-calls.jsonl`),
    "utf8",
  );
  return data
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("postToolUse appends one JSON line under the project", () => {
  const project = tmp();
  postToolUse(
    {
      session_id: "abc123",
      cwd: project,
      tool_name: "Bash",
      tool_use_id: "tu_1",
      prompt_id: "pr_1",
      duration_ms: 42,
    },
    env({ CLAUDE_PROJECT_DIR: project }),
  );
  const events = logLines(project, "abc123");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    tool: "Bash",
    tool_use_id: "tu_1",
    prompt_id: "pr_1",
    agent_id: null,
    agent_type: null,
    duration_ms: 42,
  });
});

test("postToolUse second call appends rather than overwrites", () => {
  const project = tmp();
  const lookupEnv = env({ CLAUDE_PROJECT_DIR: project });
  postToolUse(
    { session_id: "abc123", cwd: project, tool_name: "Bash" },
    lookupEnv,
  );
  postToolUse(
    { session_id: "abc123", cwd: project, tool_name: "Read" },
    lookupEnv,
  );
  const events = logLines(project, "abc123");
  assert.equal(events.length, 2);
  assert.equal(events[0].tool, "Bash");
  assert.equal(events[1].tool, "Read");
});

test("postToolUse records subagent fields", () => {
  const project = tmp();
  postToolUse(
    {
      session_id: "abc123",
      cwd: project,
      tool_name: "Read",
      agent_id: "agent_1",
      agent_type: "general-purpose",
    },
    env({ CLAUDE_PROJECT_DIR: project }),
  );
  const event = logLines(project, "abc123")[0];
  assert.equal(event.agent_id, "agent_1");
  assert.equal(event.agent_type, "general-purpose");
});

test("postToolUse missing session id is a silent no-op", () => {
  const project = tmp();
  postToolUse(
    { tool_name: "Bash", cwd: project },
    env({ CLAUDE_PROJECT_DIR: project }),
  );
  assert.ok(
    !fs.existsSync(sessionsDirFor(project)),
    "sessions dir was created; want no log written",
  );
});

// --- The payload cwd follows the session, so it is not the root -------------

test("postToolUse ignores the payload cwd (#485)", () => {
  const project = tmp();
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  const contentDir = path.join(project, "wiki", "concepts");
  fs.mkdirSync(contentDir, { recursive: true });

  postToolUse(
    { session_id: "abc123", cwd: contentDir, tool_name: "Bash" },
    env({ CLAUDE_PROJECT_DIR: project }),
  );

  assert.equal(logLines(project, "abc123").length, 1);
  assert.ok(
    !fs.existsSync(path.join(contentDir, ".claude")),
    "session state was scattered into a content directory",
  );
});

test("postToolUse walks up from the payload cwd when the env var is unset", () => {
  const project = tmp();
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  const contentDir = path.join(project, "wiki", "concepts");
  fs.mkdirSync(contentDir, { recursive: true });

  postToolUse(
    { session_id: "abc123", cwd: contentDir, tool_name: "Bash" },
    env({}),
  );

  assert.equal(logLines(project, "abc123").length, 1);
  assert.ok(!fs.existsSync(path.join(contentDir, ".claude")));
});

test("postToolUse writes nothing when no project is identifiable (#485)", () => {
  const { home, project, contentDir } = freshProject();
  postToolUse(
    { session_id: "abc123", cwd: contentDir, tool_name: "Bash" },
    env({ HOME: home }),
  );
  assert.ok(
    !fs.existsSync(path.join(project, ".claude")),
    "a state tree was created in a directory that is not a project root",
  );
});

test("sessionStart and postToolUse agree on one directory (#485)", () => {
  const { home, project, contentDir } = freshProject();
  const lookupEnv = env({ HOME: home });

  sessionStart(
    { session_id: "abc123", transcript_path: "/x/abc123.jsonl", cwd: project },
    lookupEnv,
  );
  postToolUse(
    { session_id: "abc123", cwd: contentDir, tool_name: "Bash" },
    lookupEnv,
  );

  const dir = sessionsDirFor(project);
  assert.equal(readTranscriptPath("abc123", dir), "/x/abc123.jsonl");
  assert.equal(
    fs.readFileSync(path.join(dir, "abc123-tool-calls.jsonl"), "utf8").trim()
      .length > 0,
    true,
  );
  assert.deepEqual(fs.readdirSync(path.dirname(contentDir)), ["concepts"]);
});
