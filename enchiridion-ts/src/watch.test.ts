/**
 * watch tests — the debounce/lock/queue machinery behind /wiki-watch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DefaultPollIntervalSeconds,
  DefaultDebounceSeconds,
  Debouncer,
  StaleLockSeconds,
  appendQueue,
  acquireLock,
  checkAndEnqueue,
  forRoot,
  readQueue,
  relForEvent,
  removeFromQueue,
  removeLock,
  runWatch,
  withExclusiveLock,
  writeLock,
  type StalePolicy,
  type StopSignal,
  type Watcher,
} from "./watch.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "watch-test-"));
}

/** A pid no live process on this machine can have. */
const DeadPID = 1 << 30;

function thrownBy(fn: () => void): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  assert.fail("expected fn to throw");
}

/** Writes a lock stamped with pid and an age — what a killed or undecidable
 * holder leaves behind. */
function strandLock(lockPath: string, pid: number, ageSeconds = 0): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  writeLock(lockPath, pid, new Date(Date.now() - ageSeconds * 1000));
}

/** Lock files [lockState] cannot decide: an unparsable file, and a live pid past
 * [StaleLockSeconds]. The `.mutex` reclaims both; the `.writelock` stops on
 * both. */
const undecidableLocks: { name: string; strand: (lockPath: string) => void }[] =
  [
    {
      name: "unparsable",
      strand: (lockPath) => {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, "not json");
      },
    },
    {
      name: "parseable as JSON but not as a lock payload",
      strand: (lockPath) => {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, "null");
      },
    },
    {
      name: "held by a live pid past StaleLockSeconds",
      strand: (lockPath) =>
        strandLock(lockPath, process.pid, StaleLockSeconds + 60),
    },
  ];

// --- debounce timing ---------------------------------------------------------

test("debounce: not settled within window", () => {
  let now = 0;
  const d = new Debouncer(30, () => now);
  for (const ts of [0, 5, 10, 15, 20, 25]) {
    now = ts;
    d.recordEvent("raw/notes/a.md");
  }
  assert.deepEqual(d.settledFiles(), []);
});

test("debounce: settles after final silence", () => {
  let now = 0;
  const d = new Debouncer(30, () => now);
  for (const ts of [0, 10, 20, 35]) {
    now = ts;
    d.recordEvent("raw/notes/a.md");
  }
  now = 35 + 29;
  assert.deepEqual(d.settledFiles(), []);
  now = 35 + 30;
  assert.deepEqual(d.settledFiles(), ["raw/notes/a.md"]);
});

test("debounce: settled files stop being tracked", () => {
  let now = 0;
  const d = new Debouncer(10, () => now);
  d.recordEvent("raw/a.md");
  now = 10;
  assert.deepEqual(d.settledFiles(), ["raw/a.md"]);
  now = 100;
  assert.deepEqual(d.settledFiles(), []);
});

test("debounce: is per-file", () => {
  let now = 0;
  const d = new Debouncer(30, () => now);
  d.recordEvent("raw/a.md");
  now = 15;
  d.recordEvent("raw/b.md");
  now = 30;
  assert.deepEqual(d.settledFiles(), ["raw/a.md"]);
});

// --- lock file lifecycle -----------------------------------------------------

test("write lock then remove", () => {
  const lockPath = path.join(tmpRoot(), ".wiki-knowledge", "watch.lock");
  writeLock(lockPath, 1234, new Date());
  assert.ok(fs.existsSync(lockPath));
  removeLock(lockPath);
  assert.ok(!fs.existsSync(lockPath));
});

test("remove lock missing is a no-op", () => {
  assert.doesNotThrow(() => removeLock(path.join(tmpRoot(), "watch.lock")));
});

test("acquire lock: live PID bails", () => {
  const lockPath = path.join(tmpRoot(), ".wiki-knowledge", "watch.lock");
  writeLock(lockPath, process.pid, new Date());
  const { acquired } = acquireLock(lockPath);
  assert.equal(acquired, false);
});

test("acquire lock: old timestamp is stale", () => {
  const lockPath = path.join(tmpRoot(), ".wiki-knowledge", "watch.lock");
  const old = new Date(Date.now() - (StaleLockSeconds + 60) * 1000);
  writeLock(lockPath, process.pid, old);
  const { acquired } = acquireLock(lockPath);
  assert.equal(acquired, true);
});

test("acquire lock: recent timestamp not stale", () => {
  const lockPath = path.join(tmpRoot(), ".wiki-knowledge", "watch.lock");
  const recent = new Date(Date.now() - (StaleLockSeconds - 60) * 1000);
  writeLock(lockPath, process.pid, recent);
  const { acquired } = acquireLock(lockPath);
  assert.equal(acquired, false);
});

test("acquire lock: no existing lock succeeds", () => {
  const lockPath = path.join(tmpRoot(), ".wiki-knowledge", "watch.lock");
  const { acquired, stalePID } = acquireLock(lockPath);
  assert.equal(acquired, true);
  assert.equal(stalePID, null);
});

test("acquire lock: unparsable lock is stale", () => {
  const lockPath = path.join(tmpRoot(), ".wiki-knowledge", "watch.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "not json");
  const { acquired } = acquireLock(lockPath);
  assert.equal(acquired, true);
});

test("acquire lock: dead PID is stale, reports the removed pid", () => {
  const lockPath = path.join(tmpRoot(), ".wiki-knowledge", "watch.lock");
  const deadPID = 1 << 30;
  writeLock(lockPath, deadPID, new Date());
  const { acquired, stalePID } = acquireLock(lockPath);
  assert.equal(acquired, true);
  assert.equal(stalePID, deadPID);
});

// --- the exclusive locks: one wait, two policies -------------------------------

test("exclusive lock: a dead pid's lock is reclaimed and the critical section runs", () => {
  for (const policy of ["reclaim", "fail"] as StalePolicy[]) {
    const lockPath = path.join(tmpRoot(), "watch.lock.mutex");
    strandLock(lockPath, DeadPID);

    let ran = false;
    withExclusiveLock(lockPath, () => (ran = true), policy);
    assert.equal(ran, true, `${policy}: a provably dead holder is reclaimed`);
    assert.ok(!fs.existsSync(lockPath), `${policy}: the lock is released`);
  }
});

for (const { name, strand } of undecidableLocks) {
  test(`exclusive lock: ${name} is reclaimed under the mutex policy`, () => {
    const lockPath = path.join(tmpRoot(), "watch.lock.mutex");
    strand(lockPath);

    let ran = false;
    withExclusiveLock(lockPath, () => (ran = true), "reclaim");
    assert.equal(ran, true);
    assert.ok(!fs.existsSync(lockPath), "the reclaimed lock is released");
  });

  test(`exclusive lock: ${name} fails loudly under the writelock policy`, () => {
    const lockPath = path.join(tmpRoot(), "watch-queue.jsonl.writelock");
    strand(lockPath);

    let ran = false;
    const err = thrownBy(() =>
      withExclusiveLock(lockPath, () => (ran = true), "fail"),
    );
    assert.match(
      err.message,
      /watch-queue\.jsonl\.writelock/,
      "names the lock",
    );
    assert.equal(ran, false, "the critical section did not run");
  });
}

test("exclusive lock: a live, fresh lock is waited out under either policy", () => {
  for (const policy of ["reclaim", "fail"] as StalePolicy[]) {
    const lockPath = path.join(tmpRoot(), "watch.lock.mutex");
    strandLock(lockPath, process.pid);

    let slept = 0;
    let ran = false;
    withExclusiveLock(lockPath, () => (ran = true), policy, {
      sleep: () => {
        slept++;
        if (slept === 3) removeLock(lockPath); // the holder lets go
      },
    });
    assert.equal(ran, true, `${policy}: it took the lock once released`);
    assert.equal(slept, 3, `${policy}: it waited rather than reclaiming`);
  }
});

test("acquire lock: a mutex stranded by a dead pid is reclaimed, not spun on", () => {
  const lockPath = path.join(tmpRoot(), ".wiki-knowledge", "watch.lock");
  strandLock(lockPath + ".mutex", DeadPID);

  const { acquired } = acquireLock(lockPath);
  assert.equal(acquired, true);
  assert.ok(fs.existsSync(lockPath), "the lock was taken inside the mutex");
  assert.ok(!fs.existsSync(lockPath + ".mutex"), "the mutex was released");
});

test("acquire lock: a live fresh mutex is waited out, not reclaimed", () => {
  const lockPath = path.join(tmpRoot(), ".wiki-knowledge", "watch.lock");
  strandLock(lockPath + ".mutex", process.pid);

  let slept = 0;
  const { acquired } = acquireLock(lockPath, {
    sleep: () => {
      slept++;
      if (slept === 2) removeLock(lockPath + ".mutex");
    },
  });
  assert.equal(acquired, true);
  assert.equal(slept, 2, "it waited for the mutex rather than reclaiming it");
});

test("queue: a writelock stranded by a dead pid is reclaimed", () => {
  const queuePath = path.join(
    tmpRoot(),
    ".wiki-knowledge",
    "watch-queue.jsonl",
  );
  strandLock(queuePath + ".writelock", DeadPID);

  appendQueue(queuePath, "raw/a.md");
  assert.deepEqual(readQueue(queuePath), ["raw/a.md"]);
});

for (const { name, strand } of undecidableLocks) {
  test(`queue: a writelock ${name} fails loudly and leaves the queue alone`, () => {
    const queuePath = path.join(
      tmpRoot(),
      ".wiki-knowledge",
      "watch-queue.jsonl",
    );
    strand(queuePath + ".writelock");

    const err = thrownBy(() => appendQueue(queuePath, "raw/a.md"));
    assert.match(err.message, /watch-queue\.jsonl\.writelock/);
    assert.ok(!fs.existsSync(queuePath), "the queue was not written");
  });
}

// --- queue -------------------------------------------------------------------

test("queue: append creates and appends", () => {
  const queuePath = path.join(
    tmpRoot(),
    ".wiki-knowledge",
    "watch-queue.jsonl",
  );
  appendQueue(queuePath, "raw/a.md");
  appendQueue(queuePath, "raw/b.md");
  assert.deepEqual(readQueue(queuePath), ["raw/a.md", "raw/b.md"]);
});

test("queue: append is idempotent", () => {
  const queuePath = path.join(tmpRoot(), "watch-queue.jsonl");
  appendQueue(queuePath, "raw/a.md");
  appendQueue(queuePath, "raw/a.md");
  assert.deepEqual(readQueue(queuePath), ["raw/a.md"]);
});

test("queue: remove", () => {
  const queuePath = path.join(tmpRoot(), "watch-queue.jsonl");
  appendQueue(queuePath, "raw/a.md");
  appendQueue(queuePath, "raw/b.md");
  removeFromQueue(queuePath, "raw/a.md");
  assert.deepEqual(readQueue(queuePath), ["raw/b.md"]);
});

test("queue: read missing file is empty", () => {
  assert.deepEqual(readQueue(path.join(tmpRoot(), "watch-queue.jsonl")), []);
});

// --- eligibility check on settle ----------------------------------------------

test("check-and-enqueue: enqueues when eligible", () => {
  const queuePath = path.join(tmpRoot(), "watch-queue.jsonl");
  const ok = checkAndEnqueue(new Set(["raw/a.md"]), "raw/a.md", queuePath);
  assert.equal(ok, true);
  assert.deepEqual(readQueue(queuePath), ["raw/a.md"]);
});

test("check-and-enqueue: skips when not eligible", () => {
  const queuePath = path.join(tmpRoot(), "watch-queue.jsonl");
  const ok = checkAndEnqueue(new Set(["raw/other.md"]), "raw/a.md", queuePath);
  assert.equal(ok, false);
  assert.deepEqual(readQueue(queuePath), []);
});

// --- relForEvent --------------------------------------------------------------

test("rel-for-event: maps file under root", () => {
  const root = tmpRoot();
  const p = path.join(root, "raw", "note.md");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
  assert.equal(relForEvent(root, p), "raw/note.md");
});

test("rel-for-event: ignores directory", () => {
  const root = tmpRoot();
  const dir = path.join(root, "raw", "subdir");
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(relForEvent(root, dir), null);
});

test("rel-for-event: ignores path outside root", () => {
  const root = tmpRoot();
  const outside = path.join(tmpRoot(), "note.md");
  fs.writeFileSync(outside, "x");
  assert.equal(relForEvent(root, outside), null);
});

// --- paths + defaults ----------------------------------------------------------

test("for-root: yields the watch paths under .wiki-knowledge", () => {
  const paths = forRoot("/vault");
  assert.equal(paths.lock, "/vault/.wiki-knowledge/watch.lock");
  assert.equal(paths.queue, "/vault/.wiki-knowledge/watch-queue.jsonl");
});

test("defaults: exported constants", () => {
  assert.equal(DefaultDebounceSeconds, 30);
  assert.equal(DefaultPollIntervalSeconds, 5);
  assert.equal(StaleLockSeconds, 600);
});

// --- the watch loop (runWatch seam tests) ------------------------------------

/** A fake watcher: the test fires "ready"/"all" and calls close(), with no
 * chokidar on the loop's seam. */
class FakeWatcher implements Watcher {
  closed = false;
  private readyHandlers: (() => void)[] = [];
  private allHandlers: ((eventName: string, p: string) => void)[] = [];
  private errorHandlers: ((err: unknown) => void)[] = [];
  on(
    event: "all" | "error" | "ready",
    cb: (eventName: string, p: string) => void,
  ): void {
    if (event === "all") this.allHandlers.push(cb);
    else if (event === "error")
      this.errorHandlers.push(cb as (err: unknown) => void);
    else this.readyHandlers.push(cb as () => void);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  emit(event: string, ...args: unknown[]): void {
    if (event === "all") {
      for (const cb of this.allHandlers)
        cb(args[0] as string, args[1] as string);
    } else if (event === "error") {
      for (const cb of this.errorHandlers) cb(args[0]);
    } else {
      for (const cb of this.readyHandlers) cb();
    }
  }
}

/** Await a macrotask so the tick's async sweep chain has run to completion. */
async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

/** A fake signal hub: runWatch's onSignal/offSignal pair, so a test can fire
 * signals without touching the process. */
function recordSignals(): {
  onSignal: (sig: StopSignal, cb: () => void) => void;
  offSignal: (sig: StopSignal, cb: () => void) => void;
  signals: Record<string, (() => void)[]>;
} {
  const signals: Record<string, (() => void)[]> = {};
  return {
    onSignal: (sig, cb) => {
      (signals[sig] ??= []).push(cb);
    },
    offSignal: (sig, cb) => {
      signals[sig] = (signals[sig] ?? []).filter((c) => c !== cb);
    },
    signals,
  };
}

/** Writes a real file under root/raw/, returning its absolute path. */
function rawFile(root: string, name: string): string {
  const abs = path.join(root, "raw", name);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "x");
  return abs;
}

test("run-watch: settle, sweep, enqueue end to end; a signal stops and cleans up", async () => {
  const root = tmpRoot();
  const paths = forRoot(root);
  const abs = rawFile(root, "a.md");

  const watcher = new FakeWatcher();
  const { onSignal, offSignal, signals } = recordSignals();
  const lines: string[] = [];
  const ticks: (() => void)[] = [];
  let pollMs = 0;
  let now = 0;
  let sweepRuns = 0;

  const done = runWatch(paths, {
    debounceSeconds: 30,
    pollIntervalSeconds: 5,
    makeWatcher: () => watcher,
    clock: () => now,
    sweep: async () => {
      sweepRuns++;
      return new Set(["raw/a.md"]);
    },
    onSignal,
    offSignal,
    schedule: (cb, ms) => {
      ticks.push(cb);
      pollMs = ms;
      return () => {};
    },
    pid: 42,
    log: (l) => lines.push(l),
  });

  assert.equal(pollMs, 5 * 1000);
  watcher.emit("ready");
  watcher.emit("all", "add", abs);
  now = 100;
  ticks[0]();
  await flush();

  assert.deepEqual(readQueue(paths.queue), ["raw/a.md"]);
  assert.equal(sweepRuns, 1);
  assert.deepEqual(lines, [
    `watching ${path.join(root, "raw")} (debounce=30s, pid=42)`,
    "queued raw/a.md",
  ]);

  writeLock(paths.lock, 999, new Date());
  signals.SIGTERM?.[0]();
  await done;
  assert.match(lines[lines.length - 1], /watcher stopped/);
  assert.ok(!fs.existsSync(paths.lock), "lock removed on stop");
  assert.equal(watcher.closed, true);
  assert.deepEqual(signals.SIGINT, []);
  assert.deepEqual(signals.SIGTERM, []);
  assert.deepEqual(signals.SIGHUP, []);
});

test("run-watch: SIGHUP stops the watcher and removes the lock", async () => {
  const root = tmpRoot();
  const paths = forRoot(root);

  const watcher = new FakeWatcher();
  const { onSignal, offSignal, signals } = recordSignals();
  const lines: string[] = [];

  const done = runWatch(paths, {
    makeWatcher: () => watcher,
    onSignal,
    offSignal,
    schedule: () => () => {},
    log: (l) => lines.push(l),
  });

  // Closing the terminal must run the same stop as Ctrl-C: a SIGKILL mid
  // critical section is what strands a `.mutex` for the next watcher.
  assert.equal(signals.SIGHUP?.length, 1);
  writeLock(paths.lock, 999, new Date());
  signals.SIGHUP?.[0]();
  await done;

  assert.equal(lines[lines.length - 1], "watcher stopped");
  assert.ok(!fs.existsSync(paths.lock), "lock removed on stop");
  assert.equal(watcher.closed, true);
  assert.deepEqual(signals.SIGHUP, []);
});

test("run-watch: an eligibility miss settles without enqueuing", async () => {
  const root = tmpRoot();
  const paths = forRoot(root);
  const abs = rawFile(root, "b.md");

  const watcher = new FakeWatcher();
  const { onSignal, offSignal, signals } = recordSignals();
  const ticks: (() => void)[] = [];
  let now = 0;
  const sweepSets: Set<string>[] = [
    new Set(["raw/other.md"]),
    new Set(["raw/b.md"]),
  ];
  let sweepRuns = 0;

  const done = runWatch(paths, {
    debounceSeconds: 30,
    makeWatcher: () => watcher,
    clock: () => now,
    sweep: async () => sweepSets[sweepRuns++],
    onSignal,
    offSignal,
    schedule: (cb) => {
      ticks.push(cb);
      return () => {};
    },
    log: () => {},
  });

  watcher.emit("all", "add", abs);
  now = 100;
  ticks[0]();
  await flush();
  assert.deepEqual(readQueue(paths.queue), []);
  assert.equal(sweepRuns, 1);

  // A settled-and-missed file stops being tracked, so the next tick has
  // nothing to sweep even though the sweep would now offer it.
  ticks[0]();
  await flush();
  assert.equal(sweepRuns, 1);
  assert.deepEqual(readQueue(paths.queue), []);

  signals.SIGTERM?.[0]();
  await done;
});
