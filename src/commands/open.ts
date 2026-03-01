import { Command, Flag } from "effect/unstable/cli";
import { Console, Effect, Option } from "effect";
import { ConfigService } from "../services/Config.js";
import { BrainError } from "../errors/index.js";

const projectFlag = Flag.boolean("project").pipe(
  Flag.withAlias("p"),
  Flag.withDescription("Open project vault instead of active"),
);

export const open = Command.make("open", { project: projectFlag }).pipe(
  Command.withDescription("Open vault in editor"),
  Command.withHandler(({ project }) =>
    Effect.gen(function* () {
      const config = yield* ConfigService;

      let vaultPath: string;
      if (project) {
        const p = yield* config.projectVaultPath();
        if (Option.isNone(p)) {
          yield* Console.error("No project vault found");
          return;
        }
        vaultPath = p.value;
      } else {
        vaultPath = yield* config.activeVaultPath();
      }

      const editor = process.env["EDITOR"] ?? "code";
      yield* Console.error(`Opening ${vaultPath}`);
      yield* Effect.tryPromise({
        try: () => Bun.spawn([editor, vaultPath], { stdout: "inherit", stderr: "inherit" }).exited,
        catch: () => new BrainError({ message: `Failed to open ${editor}` }),
      });
    }),
  ),
);
