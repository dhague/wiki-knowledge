/**
 * Summarises the tool-call log written by the PostToolUse hook: totals, a
 * per-tool histogram, and a prompt count with calls-per-prompt.
 *
 * "Prompts" is a proxy, not a turn count: the payload carries no
 * per-assistant-message id, and prompt_id spans a whole user turn.
 */

import fs from "node:fs";
import path from "node:path";
import { sessionsDir, processLookupEnv } from "./sessionstate.js";

/** The log path for sessionID; an empty stateDir resolves the session state
 * directory. */
export function logPath(sessionID: string, stateDir: string): string {
  const dir = stateDir === "" ? sessionsDir("", processLookupEnv) : stateDir;
  return path.join(dir, `${sessionID}-tool-calls.jsonl`);
}

/** Logged events for sessionID, oldest first; empty when no log exists.
 * Malformed and blank lines are skipped. */
export function readLog(
  sessionID: string,
  stateDir: string,
): Array<Record<string, unknown>> {
  const file = logPath(sessionID, stateDir);
  if (!fs.existsSync(file)) return [];
  const data = fs.readFileSync(file, "utf8");
  const events: Array<Record<string, unknown>> = [];
  for (const line of data.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // malformed line — skip
    }
  }
  return events;
}

export interface ToolCount {
  tool: string;
  count: number;
}

/** One run's aggregate of its tool-call log. */
export interface Summary {
  total: number;
  /** Per-tool histogram, most-called first; ties by first-seen order. */
  byTool: ToolCount[];
  /** The prompt-count proxy; see the module comment. */
  prompts: number;
  /** Valid only when hasCallsPerPrompt (at least one prompt to divide by). */
  callsPerPrompt: number;
  hasCallsPerPrompt: boolean;
}

export function summarize(events: Array<Record<string, unknown>>): Summary {
  const total = events.length;

  const counts = new Map<string, number>();
  const order: string[] = [];
  const promptIDs = new Set<string>();
  for (const event of events) {
    let tool = typeof event["tool"] === "string" ? event["tool"] : "";
    if (tool === "") tool = "?";
    if (!counts.has(tool)) order.push(tool);
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
    const id = event["prompt_id"];
    if (typeof id === "string" && id !== "") promptIDs.add(id);
  }

  const byTool: ToolCount[] = order.map((tool) => ({
    tool,
    count: counts.get(tool) ?? 0,
  }));
  // sort is stable, so ties keep first-seen order.
  byTool.sort((a, b) => b.count - a.count);

  const prompts = promptIDs.size;
  const s: Summary = {
    total,
    byTool,
    prompts,
    callsPerPrompt: 0,
    hasCallsPerPrompt: false,
  };
  if (prompts > 0) {
    s.callsPerPrompt = total / prompts;
    s.hasCallsPerPrompt = true;
  }
  return s;
}

/** The summary as the fixed text the CLI prints. */
export function formatSummary(s: Summary): string {
  let out = `Total tool calls: ${s.total}\n`;
  for (const tc of s.byTool) {
    out += `  ${String(tc.count).padStart(3)}  ${tc.tool}\n`;
  }
  if (s.prompts > 0) {
    out +=
      `Prompts (proxy for turns, not exact — see #99): ${s.prompts}, ` +
      `${s.callsPerPrompt.toFixed(1)} calls/prompt`;
  }
  return out;
}
