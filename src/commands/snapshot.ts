import { Argument, Command, Flag } from "effect/unstable/cli";
import { Console, Effect, Option } from "effect";
import { VaultService } from "../services/Vault.js";

const dirArg = Argument.string("dir");
const outputFlag = Flag.string("output").pipe(
  Flag.optional,
  Flag.withAlias("o"),
  Flag.withDescription("Write snapshot to file instead of stdout"),
);

export const snapshot = Command.make("snapshot", {
  dir: dirArg,
  output: outputFlag,
}).pipe(
  Command.withDescription("Create a single-file snapshot of a markdown directory"),
  Command.withHandler(({ dir, output }) =>
    Effect.gen(function* () {
      const vault = yield* VaultService;
      // output is already Option<string>, pass directly
      const result = yield* vault.snapshot(dir, output);

      if (Option.isSome(output)) {
        yield* Console.error(`Wrote snapshot to ${result}`);
      } else {
        yield* Console.log(result);
      }
    }),
  ),
);
