import { Console, Effect } from "effect";
import { ClaudeService } from "../../services/Claude.js";
import { ConfigService } from "../../services/Config.js";
import { acquireLock, readState, releaseLock, writeState } from "./state.js";

/** Run the ruminate daemon job — mines session archives for missed patterns */
export const runRuminate = Effect.fn("runRuminate")(function* () {
  const config = yield* ConfigService;
  const claude = yield* ClaudeService;
  const brainDir = yield* config.globalVaultPath();

  yield* acquireLock(brainDir, "ruminate");

  yield* Effect.gen(function* () {
    yield* Console.error("Ruminating...");
    yield* claude.invoke("/ruminate", "opus");

    const state = yield* readState(brainDir);
    yield* writeState(brainDir, {
      ...state,
      ruminate: { lastRun: new Date().toISOString() },
    });

    yield* Console.error("Ruminate complete");
  }).pipe(Effect.ensuring(releaseLock(brainDir, "ruminate")));
});
