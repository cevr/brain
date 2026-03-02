import { Console, Effect } from "effect";
import { ClaudeService } from "../../services/Claude.js";
import { ConfigService } from "../../services/Config.js";
import { acquireLock, readState, releaseLock, writeState } from "./state.js";

/** Run the meditate daemon job — audits, prunes, and distills vault quality */
export const runMeditate = Effect.fn("runMeditate")(function* () {
  const config = yield* ConfigService;
  const claude = yield* ClaudeService;
  const brainDir = yield* config.globalVaultPath();

  yield* acquireLock(brainDir, "meditate");

  yield* Effect.gen(function* () {
    yield* Console.error("Meditating...");
    yield* claude.invoke("/meditate", "opus");

    const state = yield* readState(brainDir);
    yield* writeState(brainDir, {
      ...state,
      meditate: { lastRun: new Date().toISOString() },
    });

    yield* Console.error("Meditate complete");
  }).pipe(Effect.ensuring(releaseLock(brainDir, "meditate")));
});
