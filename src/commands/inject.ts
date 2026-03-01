import { Command, Flag } from "effect/unstable/cli";
import { Console, Effect, Option } from "effect";
import { ConfigService } from "../services/Config.js";
import { VaultService } from "../services/Vault.js";

const jsonFlag = Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"));

export const inject = Command.make("inject", { json: jsonFlag }).pipe(
  Command.withDescription("Inject vault index into session (SessionStart hook)"),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const vault = yield* VaultService;

      const [globalPath, projectPath] = yield* Effect.all([
        config.globalVaultPath(),
        config.projectVaultPath(),
      ]);

      const readIndexSafe = (p: string) =>
        vault.readIndex(p).pipe(
          Effect.catchTag("@cvr/brain/VaultError", (e) => {
            if (e.code === "INDEX_MISSING" || e.code === "READ_FAILED") {
              return Console.error(`brain: vault not found at ${p} — run \`brain init\``).pipe(
                Effect.as(""),
              );
            }
            return Effect.fail(e);
          }),
        );

      // Read indexes concurrently when project vault exists
      const [globalIndex, projectIndex] = Option.isSome(projectPath)
        ? yield* Effect.all([readIndexSafe(globalPath), readIndexSafe(projectPath.value)])
        : [yield* readIndexSafe(globalPath), ""];

      // Both empty means no vault — already warned to stderr, exit cleanly
      if (globalIndex.length === 0 && projectIndex.length === 0) return;

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(
          JSON.stringify({
            global: globalIndex,
            project: Option.isSome(projectPath) && projectIndex.length > 0 ? projectIndex : null,
            index: globalIndex + (projectIndex.length > 0 ? "\n" + projectIndex : ""),
          }),
        );
        return;
      }

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
