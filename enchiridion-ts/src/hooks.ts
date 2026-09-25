/**
 * The plugin's automatic hook handlers: each reads a Claude Code hook payload as
 * JSON on stdin and writes per-session state under the project's
 * `.claude/wiki-knowledge/sessions/`.
 *
 * Hooks run automatically and unattended and must fail open: the `hook`
 * subcommands swallow every handler error, and hooks.json tolerates even the
 * bootstrap failing, so a failure costs one session's side effect rather than
 * blocking the session.
 *
 * The two hooks locate the project differently on purpose. The payload's `cwd` is
 * the project root at SessionStart but has followed the session's `cd`s by
 * PostToolUse, so only SessionStart treats it as the root; PostToolUse resolves
 * through `findSessionsDir` and writes nothing when it cannot.
 */

import fs from "node:fs";
import path from "node:path";
import { mkdirSafe } from "./fsutil.js";
import {
  findSessionsDir,
  processLookupEnv,
  sessionsDir,
  writeTranscriptPath,
} from "./sessionstate.js";
import type { LookupEnv } from "./sessionstate.js";
import { logPath } from "./toolcallstats.js";

interface SessionStartPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

/** Records transcript_path by session_id; a payload missing either field is a
 * silent no-op. */
export function sessionStart(
  payload: unknown,
  lookupEnv: LookupEnv = processLookupEnv,
): void {
  const p = (payload ?? {}) as SessionStartPayload;
  if (!p.session_id || !p.transcript_path) return;
  // Here the payload cwd is the project root, so sessionsDir's fallback is right.
  writeTranscriptPath(
    p.session_id,
    p.transcript_path,
    sessionsDir(p.cwd ?? "", lookupEnv),
  );
}

interface PostToolUsePayload {
  session_id?: string;
  cwd?: string;
  tool_name?: unknown;
  tool_use_id?: unknown;
  prompt_id?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  duration_ms?: unknown;
}

/** One line of the tool-call log; `unknown` fields log an absent key as an
 * explicit null, keeping the key set stable for toolcallstats. */
interface LoggedCall {
  tool: unknown;
  tool_use_id: unknown;
  prompt_id: unknown;
  agent_id: unknown;
  agent_type: unknown;
  duration_ms: unknown;
}

/** Appends one JSON line per tool call to the session's log, for
 * `enchiridion tool-call-stats`; the payload carries no timestamp, so tool-call
 * count is the recoverable metric. */
export function postToolUse(
  payload: unknown,
  lookupEnv: LookupEnv = processLookupEnv,
): void {
  const p = (payload ?? {}) as PostToolUsePayload;
  if (!p.session_id) return;

  const stateDir = findSessionsDir(p.cwd ?? "", lookupEnv);
  if (stateDir === undefined) return;

  const line = JSON.stringify({
    tool: p.tool_name ?? null,
    tool_use_id: p.tool_use_id ?? null,
    prompt_id: p.prompt_id ?? null,
    agent_id: p.agent_id ?? null,
    agent_type: p.agent_type ?? null,
    duration_ms: p.duration_ms ?? null,
  } satisfies LoggedCall);

  const logFile = logPath(p.session_id, stateDir);
  mkdirSafe(path.dirname(logFile), 0o755);
  fs.appendFileSync(logFile, line + "\n", { mode: 0o644 });
}
