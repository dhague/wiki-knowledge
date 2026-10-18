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
import {
  ExitBadInvocation,
  ExitSuccess,
  OutputSink,
  exitCodeFor,
  failureMessage,
  processSink,
  setOutputSink,
} from "./output.js";
import { PluginVersion } from "./version.js";
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
    .version(PluginVersion, "-V, --version", "print the plugin version")
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

/** The root command owns no option but help and version, and allows unknown
 * options so a host-injected flag cannot break invocation. Commander then
 * answers a stray leading option by printing the whole usage, naming nothing,
 * so the stray token is refused here instead. */
function rootOptionRefusal(argv: string[]): string | null {
  const first = argv[0];
  if (
    first === undefined ||
    first === "-" ||
    first === "--" ||
    first === "-h" ||
    first === "--help" ||
    first === "-V" ||
    first === "--version" ||
    !first.startsWith("-")
  ) {
    return null;
  }
  return (
    `unknown option '${first}' — options come after the subcommand; ` +
    "run `enchiridion --help` for the command list, or `enchiridion <command> --help`"
  );
}

/** Commander's own outcome as an exit code: help and version carry 0, and
 * every parse refusal (unknown command or option, missing argument, an
 * `InvalidArgumentError` from an option parser) is the caller's invocation at
 * fault. Null when the throw did not come from commander. */
function commanderExitCode(err: unknown): number | null {
  if (
    err === null ||
    typeof err !== "object" ||
    !("exitCode" in err) ||
    typeof (err as { exitCode: unknown }).exitCode !== "number"
  ) {
    return null;
  }
  return (err as { exitCode: number }).exitCode === 0
    ? ExitSuccess
    : ExitBadInvocation;
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

/** Commander copies a setting into a subcommand only when it is *created*, so
 * each setting is applied to the whole tree after `buildProgram`. */
function forEveryCommand(
  program: Command,
  visit: (cmd: Command) => void,
): void {
  visit(program);
  for (const cmd of program.commands) forEveryCommand(cmd, visit);
}

/** One command left out would answer a parse refusal with process.exit(1),
 * killing an in-process host. */
function overrideEveryExit(program: Command): void {
  forEveryCommand(program, (cmd) => cmd.exitOverride());
}

/** One command left out would write the process streams, escaping run's sink. */
function configureEveryOutput(program: Command, sink: OutputSink): void {
  forEveryCommand(program, (cmd) =>
    cmd.configureOutput({
      writeOut: (chunk: string) => sink.out(chunk),
      writeErr: (chunk: string) => sink.err(chunk),
    }),
  );
}

/** The contract's data shape: what one invocation wrote, and its exit code. */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The in-process (plugin) entry and the one implementation of the contract:
 * writes through `sink` — the process streams by default — and returns the same
 * bytes. One run at a time; the sink is installed for the run and restored
 * after. */
export async function run(
  argv: string[],
  sink: OutputSink = processSink,
): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const tee: OutputSink = {
    out: (chunk) => {
      stdout.push(chunk);
      sink.out(chunk);
    },
    err: (chunk) => {
      stderr.push(chunk);
      sink.err(chunk);
    },
  };
  const result = (exitCode: number): RunResult => ({
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    exitCode,
  });

  const program = buildProgram();
  overrideEveryExit(program);
  configureEveryOutput(program, tee);
  setOutputSink(tee);

  try {
    // Bare invocation: usage to stdout, exit 0. Under exitOverride help() writes
    // to the sink and throws a CommanderError with exitCode 0 instead of
    // process.exit(0).
    if (argv.length === 0) {
      try {
        program.help();
      } catch {
        /* CommanderError with exitCode 0 — swallowed */
      }
      return result(ExitSuccess);
    }

    const stray = rootOptionRefusal(argv);
    if (stray !== null) {
      tee.err(stray + "\n");
      return result(ExitBadInvocation);
    }

    try {
      await program.parseAsync([process.execPath, "enchiridion", ...argv]);
    } catch (err) {
      const commanderCode = commanderExitCode(err);
      if (commanderCode !== null) return result(commanderCode);
      // An action handler failed — `fail`, or an error commander rejected
      // parseAsync with rather than wrapping in a CommanderError.
      tee.err(failureMessage(err));
      return result(exitCodeFor(err));
    }
    // Read a leaked process.exitCode so it is reported rather than swallowed,
    // but never leave it set on the host process.
    const exitCode = Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return result(exitCode);
  } finally {
    setOutputSink(null);
  }
}

/** The process edge: collect argv, run once, and carry the result's exit code
 * onto the process. Output reached the process streams through run's default
 * sink as it was written. */
function main(): void {
  void run(process.argv.slice(2)).then((result) => {
    process.exitCode = result.exitCode;
  });
}

// Importing the module must be inert, so a host can import it and call run()
// without hijacking the process.
if (isMainModule()) {
  main();
}
