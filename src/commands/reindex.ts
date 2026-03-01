import { Command, Flag } from "effect/unstable/cli";
import { Console, Effect, Option } from "effect";
import { ConfigService } from "../services/Config.js";
import { VaultService } from "../services/Vault.js";
import { VaultError } from "../errors/index.js";

const allFlag = Flag.boolean("all").pipe(
  Flag.withAlias("a"),
  Flag.withDescription("Reindex all vaults (global + project)"),
);
const jsonFlag = Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"));

export const reindex = Command.make("reindex", {
  all: allFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Rebuild vault index"),
  Command.withHandler(({ all, json }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const vault = yield* VaultService;

      const vaults: string[] = [];

      if (all) {
        const globalPath = yield* config.globalVaultPath();
        vaults.push(globalPath);
        const projectPath = yield* config.projectVaultPath();
        if (Option.isSome(projectPath)) {
          vaults.push(projectPath.value);
        }
      } else {
        vaults.push(yield* config.activeVaultPath());
      }

      for (const vaultPath of vaults) {
        const result = yield* vault.rebuildIndex(vaultPath).pipe(
          Effect.catchTag("VaultError", (e) => {
            if (e.message.includes("Cannot read vault")) {
              return Effect.fail(
                new VaultError({ message: "Vault not initialized — run `brain init`" }),
              );
            }
            return Effect.fail(e);
          }),
        );

        if (json) {
          // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
          yield* Console.log(JSON.stringify(result));
        } else if (result.changed) {
          yield* Console.error(
            `Reindexed ${vaultPath}/index.md (${result.files} files, ${result.sections.length} sections)`,
          );
        }
      }
    }),
  ),
);
