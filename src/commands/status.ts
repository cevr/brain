import { Command, Flag } from "effect/unstable/cli";
import { Console, Effect } from "effect";
import { ConfigService } from "../services/Config.js";
import { VaultService } from "../services/Vault.js";
import { VaultError } from "../errors/index.js";

const jsonFlag = Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"));

export const status = Command.make("status", { json: jsonFlag }).pipe(
  Command.withDescription("Show vault status"),
  Command.withHandler(({ json }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService;
      const vault = yield* VaultService;

      const vaultPath = yield* config
        .activeVaultPath()
        .pipe(
          Effect.catchTag("ConfigError", () =>
            Effect.fail(new VaultError({ message: "Vault not initialized — run `brain init`" })),
          ),
        );
      const result = yield* vault.status(vaultPath).pipe(
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
      } else {
        yield* Console.error(`Vault: ${result.vault}`);
        yield* Console.error(`Files: ${result.files}`);
        const sectionParts = Object.entries(result.sections)
          .map(([k, v]) => `${k} (${v})`)
          .join(", ");
        yield* Console.error(`Sections: ${sectionParts}`);
        yield* Console.error(`Orphans: ${result.orphans.length}`);
      }
    }),
  ),
);
