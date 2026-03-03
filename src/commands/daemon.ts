import { Argument, Command, Flag } from "effect/unstable/cli";
import { Console, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { ConfigService } from "../services/Config.js";
import { BrainError } from "../errors/index.js";
import { lockExists, readState, requireHome } from "./daemon/state.js";
import { runReflect } from "./daemon/reflect.js";
import { runRuminate } from "./daemon/ruminate.js";
import { runMeditate } from "./daemon/meditate.js";
import {
  ALL_JOBS,
  installUnifiedPlist,
  uninstallUnifiedPlist,
  uninstallLegacyPlists,
  isUnifiedLoaded,
  rotateLogs,
  type DaemonJob,
} from "./daemon/launchd.js";
import { resolveJob, type TickInput } from "./daemon/schedule.js";

const jsonFlag = Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"));

const jobArg = Argument.string("job").pipe(
  Argument.withDescription("Job to run (reflect, ruminate, meditate)"),
);

const logsJobArg = Argument.string("job").pipe(
  Argument.optional,
  Argument.withDescription("Filter logs by job name"),
);

const tailFlag = Flag.boolean("tail").pipe(
  Flag.withAlias("f"),
  Flag.withDescription("Follow log output"),
);

// --- Helpers ---

const UNIFIED_SCHEDULE = "9am, 1pm, 5pm, 9pm Sun-Thu";

const relativeTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${String(mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)}d ago`;
};

// --- Subcommands ---

const start = Command.make("start", { json: jsonFlag }).pipe(
  Command.withDescription("Install and start the daemon scheduler"),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      yield* uninstallLegacyPlists();
      if (!json) yield* Console.error("  Cleaned up legacy per-job plists");

      yield* installUnifiedPlist();
      if (!json) yield* Console.error("  Installed unified scheduler");

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(JSON.stringify({ schedule: UNIFIED_SCHEDULE, status: "started" }));
      } else {
        yield* Console.error(`\nDaemon started — ${UNIFIED_SCHEDULE}`);
      }
    }),
  ),
);

const stop = Command.make("stop", { json: jsonFlag }).pipe(
  Command.withDescription("Stop and uninstall the daemon scheduler"),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      yield* uninstallUnifiedPlist();
      yield* uninstallLegacyPlists();

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(JSON.stringify({ status: "stopped" }));
      } else {
        yield* Console.error("\nDaemon stopped");
      }
    }),
  ),
);

const status = Command.make("status", { json: jsonFlag }).pipe(
  Command.withDescription("Show daemon status and last run times"),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const brainDir = yield* config.globalVaultPath();
      const state = yield* readState(brainDir);
      const loaded = yield* isUnifiedLoaded();
      const processedCount = Object.keys(state.reflect?.processedSessions ?? {}).length;

      const jobs: Array<{ name: string; lastRun: string | null; locked: boolean }> = [];
      for (const job of ALL_JOBS) {
        const locked = yield* lockExists(brainDir, job);
        jobs.push({ name: job, lastRun: state[job]?.lastRun ?? null, locked });
      }

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(
          JSON.stringify({
            loaded,
            schedule: UNIFIED_SCHEDULE,
            jobs,
            processedSessions: processedCount,
          }),
        );
      } else {
        yield* Console.log(`Scheduler: ${loaded ? "loaded" : "not loaded"} (${UNIFIED_SCHEDULE})`);
        yield* Console.log("");
        for (const j of jobs) {
          const lastRunStr = j.lastRun !== null ? relativeTime(j.lastRun) : "never";
          const lockStr = j.locked ? " [LOCKED]" : "";
          yield* Console.log(`  ${j.name}: last run ${lastRunStr}${lockStr}`);
        }
        if (processedCount > 0) {
          yield* Console.log(`\nProcessed sessions: ${String(processedCount)}`);
        }
      }
    }),
  ),
);

const VALID_JOBS = new Set<string>(ALL_JOBS);

const run = Command.make("run", { job: jobArg, json: jsonFlag }).pipe(
  Command.withDescription("Run a specific daemon job immediately"),
  Command.withHandler(({ job, json }) =>
    Effect.gen(function* () {
      if (!VALID_JOBS.has(job)) {
        return yield* new BrainError({
          message: `Unknown job "${job}". Valid: ${ALL_JOBS.join(", ")}`,
          code: "INVALID_JOB",
        });
      }

      yield* rotateLogs();

      const typedJob = job as DaemonJob;
      switch (typedJob) {
        case "reflect":
          yield* runReflect();
          break;
        case "ruminate":
          yield* runRuminate();
          break;
        case "meditate":
          yield* runMeditate();
          break;
      }

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(JSON.stringify({ job, status: "completed" }));
      }
    }),
  ),
);

const tick = Command.make("tick", { json: jsonFlag }).pipe(
  Command.withDescription("Scheduler tick — dispatches the appropriate job based on current time"),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const now = new Date();
      const input: TickInput = { day: now.getDay(), hour: now.getHours() };
      const job = resolveJob(input);

      if (job === null) {
        if (json) {
          // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
          yield* Console.log(JSON.stringify({ job: null, status: "skipped" }));
        } else {
          yield* Console.error("No job scheduled for this timeslot");
        }
        return;
      }

      if (!json) yield* Console.error(`Tick resolved to: ${job}`);

      yield* rotateLogs();

      switch (job) {
        case "reflect":
          yield* runReflect();
          break;
        case "ruminate":
          yield* runRuminate();
          break;
        case "meditate":
          yield* runMeditate();
          break;
      }

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(JSON.stringify({ job, status: "completed" }));
      }
    }),
  ),
);

const logs = Command.make("logs", { job: logsJobArg, tail: tailFlag }).pipe(
  Command.withDescription("View daemon logs"),
  Command.withHandler(({ job, tail }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const home = yield* requireHome();
      const logsDir = path.join(home, ".brain", "logs");

      const exists = yield* fs.exists(logsDir).pipe(Effect.catch(() => Effect.succeed(false)));
      if (!exists) {
        yield* Console.error("No daemon logs found. Run 'brain daemon start' first");
        return;
      }

      const files = yield* fs
        .readDirectory(logsDir)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])));
      const logFiles = files
        .filter((f) => (f === "daemon.log" || f.startsWith("daemon-")) && f.endsWith(".log"))
        .filter((f) => {
          if (job === undefined) return true;
          return f === `daemon-${job}.log` || f === "daemon.log";
        })
        .sort();

      if (logFiles.length === 0) {
        yield* Console.error("No matching log files found");
        return;
      }

      if (tail) {
        // tail -f on the log files
        const paths = logFiles.map((f) => path.join(logsDir, f));
        yield* Effect.tryPromise({
          try: async () => {
            const proc = Bun.spawn(["tail", "-f", ...paths], {
              stdout: "inherit",
              stderr: "inherit",
            });
            await proc.exited;
          },
          catch: () => new BrainError({ message: "Cannot tail logs", code: "READ_FAILED" }),
        });
      } else {
        for (const file of logFiles) {
          const filePath = path.join(logsDir, file);
          const content = yield* fs
            .readFileString(filePath)
            .pipe(Effect.catch(() => Effect.succeed("")));
          if (content.length > 0) {
            yield* Console.error(`--- ${file} ---`);
            yield* Console.log(content);
          }
        }
      }
    }),
  ),
);

// --- Root ---

const daemonRoot = Command.make("daemon").pipe(
  Command.withDescription("Automated vault maintenance scheduler"),
);

export const daemon = daemonRoot.pipe(
  Command.withSubcommands([start, stop, status, run, tick, logs]),
);
