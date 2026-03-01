import { Command } from "effect/unstable/cli";
import { Console, Effect, Option } from "effect";
import { ConfigService } from "../services/Config.js";
import { VaultService } from "../services/Vault.js";

export const inject = Command.make("inject").pipe(
  Command.withDescription("Inject vault index into session (SessionStart hook)"),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const vault = yield* VaultService;

      const [globalPath, projectPath] = yield* Effect.all([
        config.globalVaultPath(),
        config.projectVaultPath(),
      ]);

      const readIndexSafe = (p: string, opts: { required: boolean }) =>
        vault.readIndex(p).pipe(
          Effect.catchTag("errors/VaultError", (e) => {
            if (e.message.includes("Cannot read index")) {
              if (opts.required) return Effect.fail(e);
              return Console.error(`Skipping project vault (no index): ${p}`).pipe(Effect.as(""));
            }
            return Effect.fail(e);
          }),
        );

      // Read indexes concurrently when project vault exists
      const [globalIndex, projectIndex] = Option.isSome(projectPath)
        ? yield* Effect.all([
            readIndexSafe(globalPath, { required: true }),
            readIndexSafe(projectPath.value, { required: false }),
          ])
        : [yield* readIndexSafe(globalPath, { required: true }), ""];

      let output = "Brain vault — read relevant files before acting:\n\n";
      output += globalIndex;

      if (Option.isSome(projectPath) && projectIndex.length > 0) {
        output += "\n---\n\n";
        output += `Project vault: ${projectPath.value}\n\n`;
        output += projectIndex;
      }

      yield* Console.log(output);
    }),
  ),
);
