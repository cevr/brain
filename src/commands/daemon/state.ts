import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { BrainError } from "../../errors/index.js";

// --- Schemas ---

const JobState = Schema.Struct({
  lastRun: Schema.optional(Schema.String),
});

const ReflectState = Schema.Struct({
  lastRun: Schema.optional(Schema.String),
  processedSessions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const DaemonStateSchema = Schema.Struct({
  reflect: Schema.optional(ReflectState),
  ruminate: Schema.optional(JobState),
  meditate: Schema.optional(JobState),
});

export type DaemonState = typeof DaemonStateSchema.Type;

const DaemonStateJson = Schema.fromJsonString(DaemonStateSchema);
const decodeDaemonState = Schema.decodeUnknownEffect(DaemonStateJson);
const encodeDaemonState = Schema.encodeEffect(DaemonStateJson);

// --- Constants ---

const SETTLE_MS = 30 * 60 * 1000; // 30 minutes
const STATE_FILE = ".daemon.json";

// --- State IO ---

/** Read daemon state from ~/.brain/.daemon.json, returns default if missing */
export const readState = Effect.fn("readState")(function* (brainDir: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const filePath = path.join(brainDir, STATE_FILE);

  const exists = yield* fs.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)));

  if (!exists) {
    return { reflect: {}, ruminate: {}, meditate: {} } satisfies DaemonState;
  }

  const text = yield* fs.readFileString(filePath).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new BrainError({
          message: `Cannot read daemon state: ${e.message}`,
          code: "READ_FAILED",
        }),
    ),
  );

  return yield* decodeDaemonState(text).pipe(
    Effect.catch(() =>
      Effect.succeed({ reflect: {}, ruminate: {}, meditate: {} } satisfies DaemonState),
    ),
  );
});

/** Atomic write of daemon state */
export const writeState = Effect.fn("writeState")(function* (brainDir: string, state: DaemonState) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const filePath = path.join(brainDir, STATE_FILE);
  const tmpPath = `${filePath}.tmp`;

  const text = yield* encodeDaemonState(state).pipe(
    Effect.mapError(
      () =>
        new BrainError({
          message: "Cannot encode daemon state",
          code: "WRITE_FAILED",
        }),
    ),
  );

  yield* fs.writeFileString(tmpPath, text + "\n").pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new BrainError({
          message: `Cannot write daemon state: ${e.message}`,
          code: "WRITE_FAILED",
        }),
    ),
  );

  yield* fs.rename(tmpPath, filePath).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new BrainError({
          message: `Cannot rename daemon state: ${e.message}`,
          code: "WRITE_FAILED",
        }),
    ),
  );
});

// --- Locking ---

const lockPath = (brainDir: string, job: string, path: Path) =>
  path.join(brainDir, `.daemon-${job}.lock`);

/** Acquire a lock for a daemon job. Fails if another process holds it. */
export const acquireLock = Effect.fn("acquireLock")(function* (brainDir: string, job: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const lock = lockPath(brainDir, job, path);

  const exists = yield* fs.exists(lock).pipe(Effect.catch(() => Effect.succeed(false)));

  if (exists) {
    const content = yield* fs.readFileString(lock).pipe(Effect.catch(() => Effect.succeed("")));
    const pid = parseInt(content.trim(), 10);

    if (!Number.isNaN(pid) && isProcessAlive(pid)) {
      return yield* new BrainError({
        message: `Daemon job "${job}" is already running (PID ${pid})`,
        code: "LOCKED",
      });
    }
    // Stale lock — remove it
  }

  yield* fs.writeFileString(lock, `${process.pid}\n`).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new BrainError({
          message: `Cannot write lock: ${e.message}`,
          code: "WRITE_FAILED",
        }),
    ),
  );
});

/** Release lock for a daemon job */
export const releaseLock = Effect.fn("releaseLock")(function* (brainDir: string, job: string) {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const lock = lockPath(brainDir, job, path);

  yield* fs.remove(lock).pipe(Effect.catch(() => Effect.void));
});

// --- Utilities ---

/** Check if a file's mtime indicates it's settled (no writes for 30+ min) */
export const isSettled = (mtime: Date): boolean => Date.now() - mtime.getTime() > SETTLE_MS;

/**
 * Derive a project name from a Claude projects dir name.
 * Claude uses dashified absolute paths: `-Users-cvr-Developer-personal-brain`
 * We extract the last path segment: `brain`
 */
export const deriveProjectName = (dirName: string): string => {
  // Split on dashes that represent path separators
  // Claude convention: leading dash + capitalized segments = path
  const segments = dirName.split("-").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  return last ?? dirName;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
