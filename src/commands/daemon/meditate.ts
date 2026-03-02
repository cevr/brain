import { Console, Effect } from "effect";
import { BrainError } from "../../errors/index.js";
import { ConfigService } from "../../services/Config.js";
import { acquireLock, readState, releaseLock, writeState } from "./state.js";

/** Run the meditate daemon job — audits, prunes, and distills vault quality */
export const runMeditate = Effect.fn("runMeditate")(function* () {
  const config = yield* ConfigService;
  const brainDir = yield* config.globalVaultPath();

  yield* acquireLock(brainDir, "meditate");

  try {
    yield* Console.error("Meditating...");

    yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          [
            "claude",
            "-p",
            "/meditate",
            "--dangerously-skip-permissions",
            "--model",
            "opus",
            "--no-session-persistence",
          ],
          { stdout: "ignore", stderr: "inherit" },
        );
        const code = await proc.exited;
        if (code !== 0) throw new Error(`claude exited with code ${code}`);
      },
      catch: (e) =>
        new BrainError({
          message: `Meditate failed: ${e instanceof Error ? e.message : String(e)}`,
          code: "SPAWN_FAILED",
        }),
    });

    const state = yield* readState(brainDir);
    yield* writeState(brainDir, {
      ...state,
      meditate: { lastRun: new Date().toISOString() },
    });

    yield* Console.error("Meditate complete");
  } finally {
    yield* releaseLock(brainDir, "meditate");
  }
});
