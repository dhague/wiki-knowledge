/**
 * The plugin's automatic hook handlers.
 *
 * Both read a Claude Code hook payload as JSON on stdin and write per-session
 * state under the *project's* `.claude/wiki-knowledge/sessions/` — so state
 * lands in the project the session belongs to, never in this process's cwd and
 * never in the vault (which, in query-from-anywhere mode, is somewhere else).
 *
 * The two hooks locate that project differently, and deliberately so. The
 * payload's `cwd` is the directory the session is in *when the hook fires*:
 * the project root at SessionStart, but wherever Claude has since `cd`'d — or
 * a worktree it has entered — by PostToolUse time. So only SessionStart may
 * treat it as the project root; PostToolUse resolves the project through
 * `findSessionsDir` and writes nothing at all when it can't (#485).
 *
 * Unlike a skill, a hook runs automatically and unattended, so it must never
 * interrupt the session that triggered it (#153). These functions return errors
 * for the caller to decide about; the `hook` subcommands swallow them, and
 * hooks.json additionally tolerates the bootstrap itself failing, so a flaky
 * binary download degrades one session's side effects instead of blocking it.
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

/** The subset of the SessionStart payload this hook uses. */
interface SessionStartPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

/**
 * Records this session's transcript_path so /save-conversation can retrieve it
 * later by session_id, rather than guessing "most recently modified
 * transcript" — which breaks when sessions run in parallel (#23).
 *
 * A payload missing either field is a silent no-op: there is nothing to record,
 * and creating the state directory anyway would be a lie about it.
 */
export function sessionStart(
  payload: unknown,
  lookupEnv: LookupEnv = processLookupEnv,
): void {
  const p = (payload ?? {}) as SessionStartPayload;
  if (!p.session_id || !p.transcript_path) return;
  // sessionsDir's cwd fallback is right here: at session start the payload cwd
  // *is* the project root, and creating its state directory is this hook's job.
  writeTranscriptPath(
    p.session_id,
    p.transcript_path,
    sessionsDir(p.cwd ?? "", lookupEnv),
  );
}

/** The subset of the PostToolUse payload this hook logs. */
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

/** One line of the tool-call log. `unknown` fields, so an absent payload key
 * is logged as an explicit null rather than being dropped — toolcallstats
 * reads back a stable key set either way. */
interface LoggedCall {
  tool: unknown;
  tool_use_id: unknown;
  prompt_id: unknown;
  agent_id: unknown;
  agent_type: unknown;
  duration_ms: unknown;
}

/**
 * Appends one JSON line per tool call to the session's log, so
 * `enchiridion tool-call-stats` can summarise a run's cost (#100).
 *
 * Per #99's spike the payload carries no per-assistant-message identifier and
 * no timestamp, so tool-call count — not exact turn count — is the recoverable
 * metric. prompt_id is logged anyway as the closest available grouping key, and
 * agent_id/agent_type separate subagent calls from the top-level agent's own.
 *
 * The log goes to the *project's* state directory, never to the payload's
 * `cwd`: that field follows the session around as the agent works, so treating
 * it as the project root scattered `.claude/wiki-knowledge/sessions/` trees
 * through content folders (#485). Where the project can't be identified, this
 * hook writes nothing — a lost line is cheaper than state in a directory that
 * isn't the project's.
 */
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
