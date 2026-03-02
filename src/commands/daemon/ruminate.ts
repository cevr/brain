import { Console, Effect } from "effect";
import { BrainError } from "../../errors/index.js";
import { ConfigService } from "../../services/Config.js";
import { acquireLock, readState, releaseLock, writeState } from "./state.js";

/** Run the ruminate daemon job — mines session archives for missed patterns */
export const runRuminate = Effect.fn("runRuminate")(function* () {
  const config = yield* ConfigService;
  const brainDir = yield* config.globalVaultPath();

  yield* acquireLock(brainDir, "ruminate");

  try {
    yield* Console.error("Ruminating...");

    yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          [
            "claude",
            "-p",
            "/ruminate",
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
          message: `Ruminate failed: ${e instanceof Error ? e.message : String(e)}`,
          code: "SPAWN_FAILED",
        }),
    });

    const state = yield* readState(brainDir);
    yield* writeState(brainDir, {
      ...state,
      ruminate: { lastRun: new Date().toISOString() },
    });

    yield* Console.error("Ruminate complete");
  } finally {
    yield* releaseLock(brainDir, "ruminate");
  }
});
