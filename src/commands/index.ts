import { Command } from "effect/unstable/cli";
import { init } from "./init.js";
import { vault } from "./vault.js";
import { reindex } from "./reindex.js";
import { inject } from "./inject.js";
import { status } from "./status.js";
import { open } from "./open.js";
import { snapshot } from "./snapshot.js";
import { extract } from "./extract.js";

const root = Command.make("brain").pipe(Command.withDescription("Persistent agent memory vault"));

export const command = root.pipe(
  Command.withSubcommands([init, vault, reindex, inject, status, open, snapshot, extract]),
);
