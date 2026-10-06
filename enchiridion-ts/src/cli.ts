#!/usr/bin/env node
/**
 * enchiridion CLI entry point: one subcommand per capability (ADR-0017).
 *
 * `vault`, `page`, and `hook` are deliberately spelled with the nested
 * sub-subcommands CLAUDE.md documents (`vault root|move`, `page
 * get|set|merge`, `hook session-start|post-tool-use`).
 */

import { Command } from "commander";
import path from "node:path";
import { pathToFileURL } from "node:url";
import util from "node:util";
import { failureMessage } from "./output.js";
import { registerPageCommands } from "./pagecommand.js";
import { registerSearchCommand } from "./searchcommand.js";
import { registerIngestCommands } from "./ingestcommand.js";
import {
  registerPlacementCommands,
  registerVaultCommand,
} from "./vaultcommand.js";
import { registerCheckFixCommands } from "./checkcommand.js";
import { registerAssessCommand } from "./assesscommand.js";
import { registerReadPagesCommand } from "./lintbodiescommand.js";
import { registerExclusionCommand } from "./exclusioncommand.js";
import {
  registerSessionCommands,
  registerHookCommands,
  registerExportCommands,
} from "./exportcommand.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("enchiridion")
    .description(
      "Wiki-knowledge plugin script layer (TypeScript bundle — ADR-0017)",
    )
    .allowExcessArguments(true)
    .allowUnknownOption(true);

  registerSearchCommand(program);
  registerPlacementCommands(program);
  registerSessionCommands(program);

  registerVaultCommand(program);

  registerCheckFixCommands(program);

  registerAssessCommand(program);

  registerReadPagesCommand(program);

  registerExclusionCommand(program);

  registerPageCommands(program);

  registerIngestCommands(program);

  registerHookCommands(program);

  registerExportCommands(program);

  return program;
}

/** Detect a direct CLI invocation across both execution shapes: the esbuild
 * CJS bundle (require.main === module) and the tsx/ESM source path
 * (import.meta.url vs argv[1]). */
function isMainModule(): boolean {
  if (typeof require !== "undefined" && require.main === module) return true;
  const arg = process.argv[1];
  if (arg === undefined) return false;
  return import.meta.url === pathToFileURL(path.resolve(arg)).href;
}

/** The in-process (plugin) entry. Captures stdout/stderr as data instead of
 * writing to the process streams, and overrides commander's exit so neither
 * help() nor an error can terminate the host process. */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function run(argv: string[]): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildProgram();
  program.exitOverride().configureOutput({
    writeOut: (s: string) => stdout.push(s),
    writeErr: (s: string) => stderr.push(s),
  });

  // Swap both the process streams and console for the run (console.log
  // bypasses process.stdout.write on Bun) and restore them in a finally, so
  // the host process keeps its own streams.
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  const consoleLog = console.log;
  const consoleError = console.error;
  process.stdout.write = ((chunk: unknown, ..._rest: unknown[]) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ..._rest: unknown[]) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.log = (...args: unknown[]) => {
    stdout.push(util.format(...args) + "\n");
  };
  console.error = (...args: unknown[]) => {
    stderr.push(util.format(...args) + "\n");
  };

  try {
    // Bare invocation: usage to stdout, exit 0. Under exitOverride help()
    // writes to the captured streams and throws a CommanderError with
    // exitCode 0 instead of process.exit(0).
    if (argv.length === 0) {
      try {
        program.help();
      } catch {
        /* CommanderError with exitCode 0 — swallowed */
      }
      return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: 0 };
    }

    try {
      await program.parseAsync([process.execPath, "enchiridion", ...argv]);
    } catch (err) {
      // CommanderError (help/version/exit) — its .exitCode is the outcome.
      if (err && typeof err === "object" && "exitCode" in err) {
        return {
          stdout: stdout.join(""),
          stderr: stderr.join(""),
          exitCode: (err as { exitCode: number }).exitCode,
        };
      }
      // An action handler failed — `fail`, or an error commander rejected
      // parseAsync with rather than wrapping in a CommanderError. Render it as
      // main() does: message on stderr, exit 1, as data rather than an exit.
      stderr.push(failureMessage(err));
      return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: 1 };
    }
    // Read a leaked process.exitCode so it is reported rather than swallowed,
    // but never leave it set on the host process.
    const exitCode = Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    console.log = consoleLog;
    console.error = consoleError;
  }
}

function main(): void {
  const program = buildProgram();
  if (process.argv.slice(2).length === 0) {
    // Commander would treat bare invocation as a missing subcommand (help to
    // stderr, exit 1); match the established usage-to-stdout, exit-0 behaviour
    // instead.
    program.help();
    return;
  }
  // Render a failed command exactly as run() does: message on stderr, exit 1,
  // no stack trace standing in for a diagnostic.
  void program.parseAsync(process.argv).catch((err: unknown) => {
    process.stderr.write(failureMessage(err));
    process.exitCode = 1;
  });
}

// Importing the module must be inert, so a host can import it and call run()
// without hijacking the process.
if (isMainModule()) {
  main();
}
