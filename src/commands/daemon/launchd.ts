import { Console, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { BrainError } from "../../errors/index.js";
import { requireDarwin, requireHome } from "./state.js";

const LABEL_PREFIX = "com.cvr.brain-daemon";
const JOBS = ["reflect", "ruminate", "meditate"] as const;
export type DaemonJob = (typeof JOBS)[number];

export const ALL_JOBS: readonly DaemonJob[] = JOBS;

const label = (job: DaemonJob) => `${LABEL_PREFIX}-${job}`;

const plistPath = (home: string, job: DaemonJob, path: Path) =>
  path.join(home, "Library", "LaunchAgents", `${label(job)}.plist`);

const logDir = (home: string, path: Path) => path.join(home, ".brain", "logs");

const logPath = (home: string, job: DaemonJob, path: Path) =>
  path.join(logDir(home, path), `daemon-${job}.log`);

/** Generate a launchd plist XML string for a daemon job */
export const generatePlist = (
  job: DaemonJob,
  home: string,
  brainBin: string,
  path: Path,
): string => {
  const pathEnv = process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";

  const scheduleKey =
    job === "reflect"
      ? `  <key>StartInterval</key>\n  <integer>3600</integer>`
      : job === "ruminate"
        ? `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Weekday</key>\n    <integer>0</integer>\n    <key>Hour</key>\n    <integer>3</integer>\n  </dict>`
        : `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Day</key>\n    <integer>1</integer>\n    <key>Hour</key>\n    <integer>3</integer>\n  </dict>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label(job)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${brainBin}</string>
    <string>daemon</string>
    <string>run</string>
    <string>${job}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${home}</string>
    <key>PATH</key>
    <string>${pathEnv}</string>
  </dict>
${scheduleKey}
  <key>StandardOutPath</key>
  <string>${logPath(home, job, path)}</string>
  <key>StandardErrorPath</key>
  <string>${logPath(home, job, path)}</string>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`;
};

/** Install a launchd plist for a daemon job */
export const installPlist = Effect.fn("installPlist")(function* (job: DaemonJob) {
  yield* requireDarwin();
  const fs = yield* FileSystem;
  const path = yield* Path;
  const home = yield* requireHome();
  const brainBin = yield* resolveBrainBin();

  // Ensure log directory exists
  yield* fs.makeDirectory(logDir(home, path), { recursive: true }).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new BrainError({
          message: `Cannot create log dir: ${e.message}`,
          code: "WRITE_FAILED",
        }),
    ),
  );

  // Ensure LaunchAgents dir exists
  const agentsDir = path.join(home, "Library", "LaunchAgents");
  yield* fs.makeDirectory(agentsDir, { recursive: true }).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new BrainError({
          message: `Cannot create LaunchAgents dir: ${e.message}`,
          code: "WRITE_FAILED",
        }),
    ),
  );

  const plist = plistPath(home, job, path);
  const content = generatePlist(job, home, brainBin, path);

  // Unload if already loaded
  const loaded = yield* isLoaded(job);
  if (loaded) {
    yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(["launchctl", "unload", plist], {
          stdout: "ignore",
          stderr: "ignore",
        });
        await proc.exited;
      },
      catch: () =>
        new BrainError({ message: `Cannot unload ${label(job)}`, code: "LAUNCHD_FAILED" }),
    });
  }

  yield* fs.writeFileString(plist, content).pipe(
    Effect.mapError(
      (e: PlatformError) =>
        new BrainError({
          message: `Cannot write plist: ${e.message}`,
          code: "WRITE_FAILED",
        }),
    ),
  );

  yield* Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["launchctl", "load", plist], { stdout: "ignore", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(stderr.trim() || `exit code ${code}`);
      }
    },
    catch: (e) =>
      new BrainError({
        message: `Cannot load ${label(job)}: ${e instanceof Error ? e.message : String(e)}`,
        code: "LAUNCHD_FAILED",
      }),
  });
});

/** Uninstall a launchd plist for a daemon job */
export const uninstallPlist = Effect.fn("uninstallPlist")(function* (job: DaemonJob) {
  yield* requireDarwin();
  const fs = yield* FileSystem;
  const path = yield* Path;
  const home = yield* requireHome();
  const plist = plistPath(home, job, path);

  const loaded = yield* isLoaded(job);
  if (loaded) {
    yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(["launchctl", "unload", plist], {
          stdout: "ignore",
          stderr: "ignore",
        });
        await proc.exited;
      },
      catch: () =>
        new BrainError({ message: `Cannot unload ${label(job)}`, code: "LAUNCHD_FAILED" }),
    });
  }

  yield* fs.remove(plist).pipe(Effect.catch(() => Effect.void));
});

/** Check if a launchd job is loaded */
export const isLoaded = Effect.fn("isLoaded")(function* (job: DaemonJob) {
  return yield* Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["launchctl", "list", label(job)], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      return code === 0;
    },
    catch: () => new BrainError({ message: "Cannot check launchctl", code: "LAUNCHD_FAILED" }),
  });
});

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const KEEP_LINES = 1000;

/** Rotate daemon logs — truncate to last 1000 lines when > 10MB */
export const rotateLogs = Effect.fn("rotateLogs")(function* () {
  const fs = yield* FileSystem;
  const path = yield* Path;
  const home = yield* requireHome();
  const dir = logDir(home, path);

  const exists = yield* fs.exists(dir).pipe(Effect.catch(() => Effect.succeed(false)));
  if (!exists) return;

  const files = yield* fs
    .readDirectory(dir)
    .pipe(Effect.catch(() => Effect.succeed([] as string[])));

  for (const file of files) {
    if (!file.startsWith("daemon-") || !file.endsWith(".log")) continue;
    const filePath = path.join(dir, file);
    const stat = yield* fs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
    if (stat === null) continue;
    if ((stat.size ?? 0) <= MAX_LOG_SIZE) continue;

    // Truncate to last KEEP_LINES lines
    const content = yield* fs.readFileString(filePath).pipe(Effect.catch(() => Effect.succeed("")));
    if (content.length === 0) continue;

    const lines = content.split("\n");
    const kept = lines.slice(-KEEP_LINES).join("\n");
    yield* fs.writeFileString(filePath, kept).pipe(Effect.catch(() => Effect.void));
    yield* Console.error(`  Rotated ${file} (truncated to ${String(KEEP_LINES)} lines)`);
  }
});

/** Resolve the brain binary path */
const resolveBrainBin = Effect.fn("resolveBrainBin")(function* () {
  return yield* Effect.try({
    try: () => {
      const proc = Bun.spawnSync(["which", "brain"], { stderr: "ignore" });
      if (proc.success) {
        const result = new TextDecoder().decode(proc.stdout).trim();
        if (result.length > 0) return result;
      }
      // Fallback to ~/.bun/bin/brain
      const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
      return `${home}/.bun/bin/brain`;
    },
    catch: () => new BrainError({ message: "Cannot resolve brain binary", code: "READ_FAILED" }),
  });
});
