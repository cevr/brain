import { Argument, Command, Flag } from "effect/unstable/cli";
import { Console, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { ConfigService } from "../services/Config.js";
import { BrainError } from "../errors/index.js";
import { readState } from "./daemon/state.js";
import { runReflect } from "./daemon/reflect.js";
import { runRuminate } from "./daemon/ruminate.js";
import { runMeditate } from "./daemon/meditate.js";
import {
  ALL_JOBS,
  installPlist,
  uninstallPlist,
  isLoaded,
  rotateLogs,
  type DaemonJob,
} from "./daemon/launchd.js";

const jsonFlag = Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"));

const jobArg = Argument.string("job").pipe(
  Argument.withDescription("Job to run (reflect, ruminate, meditate)"),
);

const jobFlag = Flag.string("job").pipe(
  Flag.optional,
  Flag.withDescription("Filter logs by job name"),
);

const tailFlag = Flag.boolean("tail").pipe(
  Flag.withAlias("f"),
  Flag.withDescription("Follow log output"),
);

// --- Subcommands ---

const start = Command.make("start").pipe(
  Command.withDescription("Install and start all daemon jobs"),
  Command.withHandler(() =>
    Effect.gen(function* () {
      for (const job of ALL_JOBS) {
        yield* installPlist(job);
        yield* Console.error(`  Installed ${job}`);
      }
      yield* Console.error("\nDaemon started — 3 jobs scheduled");
    }),
  ),
);

const stop = Command.make("stop").pipe(
  Command.withDescription("Stop and uninstall all daemon jobs"),
  Command.withHandler(() =>
    Effect.gen(function* () {
      for (const job of ALL_JOBS) {
        yield* uninstallPlist(job);
        yield* Console.error(`  Removed ${job}`);
      }
      yield* Console.error("\nDaemon stopped");
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

      const jobs: Array<{
        name: string;
        loaded: boolean;
        lastRun: string | null;
      }> = [];

      for (const job of ALL_JOBS) {
        const loaded = yield* isLoaded(job);
        const jobState = state[job];
        jobs.push({
          name: job,
          loaded,
          lastRun: jobState?.lastRun ?? null,
        });
      }

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(JSON.stringify({ jobs }));
      } else {
        for (const j of jobs) {
          const loadedStr = j.loaded ? "loaded" : "not loaded";
          const lastRunStr = j.lastRun ?? "never";
          yield* Console.log(`${j.name}: ${loadedStr}, last run: ${lastRunStr}`);
        }
      }
    }),
  ),
);

const VALID_JOBS = new Set<string>(ALL_JOBS);

const run = Command.make("run", { job: jobArg }).pipe(
  Command.withDescription("Run a specific daemon job immediately"),
  Command.withHandler(({ job }) =>
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
          return yield* runReflect();
        case "ruminate":
          return yield* runRuminate();
        case "meditate":
          return yield* runMeditate();
      }
    }),
  ),
);

const logs = Command.make("logs", { job: jobFlag, tail: tailFlag }).pipe(
  Command.withDescription("View daemon logs"),
  Command.withHandler(({ job, tail }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const home = process.env["HOME"] ?? "";
      const logsDir = path.join(home, ".brain", "logs");

      const exists = yield* fs.exists(logsDir).pipe(Effect.catch(() => Effect.succeed(false)));
      if (!exists) {
        yield* Console.error("No daemon logs found");
        return;
      }

      const files = yield* fs
        .readDirectory(logsDir)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])));
      const logFiles = files
        .filter((f) => f.startsWith("daemon-") && f.endsWith(".log"))
        .filter((f) => {
          if (job === undefined) return true;
          return f === `daemon-${job}.log`;
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

export const daemon = daemonRoot.pipe(Command.withSubcommands([start, stop, status, run, logs]));
