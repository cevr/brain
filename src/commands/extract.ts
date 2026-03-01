import { Argument, Command, Flag } from "effect/unstable/cli";
import { Console, Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { BrainError } from "../errors/index.js";

const dirArg = Argument.string("dir");
const outputFlag = Flag.string("output").pipe(
  Flag.withAlias("o"),
  Flag.withDescription("Output directory"),
);
const batchesFlag = Flag.integer("batches").pipe(
  Flag.withDefault(3),
  Flag.withAlias("b"),
  Flag.withDescription("Number of batch manifests to create"),
);
const fromFlag = Flag.string("from").pipe(
  Flag.optional,
  Flag.withDescription("Include conversations modified on or after this date (YYYY-MM-DD)"),
);
const toFlag = Flag.string("to").pipe(
  Flag.optional,
  Flag.withDescription("Include conversations modified on or before this date (YYYY-MM-DD)"),
);
const jsonFlag = Flag.boolean("json").pipe(Flag.withDescription("Output as JSON"));

interface Message {
  readonly role: string;
  readonly content: string;
}

interface Conversation {
  readonly uuid: string;
  readonly messages: Message[];
  readonly modifiedAt: Date;
}

/** @internal */
export const extractConversations = Effect.fn("extractConversations")(function* (
  inputDir: string,
  outputDir: string,
  opts: { batches?: number; from?: Option.Option<string>; to?: Option.Option<string> } = {},
) {
  const fs = yield* FileSystem;
  const path = yield* Path;

  const fromMs = Option.map(opts.from ?? Option.none(), (d) => new Date(d).getTime());
  const toMs = Option.map(opts.to ?? Option.none(), (d) => new Date(d).getTime() + 86400000 - 1);

  if (Option.isSome(fromMs) && Number.isNaN(fromMs.value)) {
    return yield* new BrainError({ message: "Invalid --from date. Use YYYY-MM-DD format." });
  }
  if (Option.isSome(toMs) && Number.isNaN(toMs.value)) {
    return yield* new BrainError({ message: "Invalid --to date. Use YYYY-MM-DD format." });
  }

  const files = yield* fs
    .readDirectory(inputDir)
    .pipe(
      Effect.mapError(
        (e: PlatformError) => new BrainError({ message: `Cannot read ${inputDir}: ${e.message}` }),
      ),
    );

  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();

  const conversations: Conversation[] = [];

  for (const file of jsonlFiles) {
    const fullPath = path.join(inputDir, file);

    const stat = yield* fs
      .stat(fullPath)
      .pipe(
        Effect.mapError(
          (e: PlatformError) => new BrainError({ message: `Cannot stat ${file}: ${e.message}` }),
        ),
      );

    // Skip directories (e.g. foo.jsonl/)
    if (stat.type !== "File") continue;

    // Skip small files (< 500 bytes)
    if ((stat.size ?? 0) < 500) continue;

    const mtime = stat.mtime ?? new Date(0);
    const mtimeMs = mtime.getTime();

    // Date filtering on file mtime
    if (Option.isSome(fromMs) && mtimeMs < fromMs.value) continue;
    if (Option.isSome(toMs) && mtimeMs > toMs.value) continue;

    const content = yield* fs
      .readFileString(fullPath)
      .pipe(
        Effect.mapError(
          (e: PlatformError) => new BrainError({ message: `Cannot read ${file}: ${e.message}` }),
        ),
      );

    const lines = content.trim().split("\n");
    const messages: Message[] = [];

    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const parsed = parseLine(line);
      if (parsed === null) continue;

      // Top-level type determines role (not message.role)
      const msgType = parsed["type"] as string | undefined;
      if (msgType !== "user" && msgType !== "assistant") continue;

      // Skip meta messages and tool-related subTypes (preserve thinking, etc.)
      if (parsed["isMeta"] === true) continue;
      const subType = parsed["subType"] as string | undefined;
      if (
        subType === "tool_use" ||
        subType === "tool_result" ||
        subType === "mcp_tool_use" ||
        subType === "mcp_tool_result"
      )
        continue;

      // Content is nested under message
      const msg = parsed["message"];
      if (typeof msg !== "object" || msg === null) continue;
      const msgObj = msg as Record<string, unknown>;
      const rawContent = msgObj["content"];

      const texts: string[] = [];
      if (typeof rawContent === "string") {
        texts.push(rawContent);
      } else if (Array.isArray(rawContent)) {
        for (const c of rawContent as Array<Record<string, unknown>>) {
          if (
            typeof c === "object" &&
            c !== null &&
            c["type"] === "text" &&
            typeof c["text"] === "string"
          ) {
            texts.push(c["text"] as string);
          }
        }
      }

      for (const t of texts) {
        const clean = t.trim();
        if (clean.length <= 10) continue;

        // Skip system-reminder-only messages
        if (clean.startsWith("<system-reminder>") && clean.endsWith("</system-reminder>")) continue;

        const maxLen = msgType === "user" ? 3000 : 800;
        messages.push({
          role: msgType,
          content: clean.slice(0, maxLen),
        });
      }
    }

    if (messages.length < 2) continue;

    const uuid = file.endsWith(".jsonl") ? file.slice(0, -6) : file;
    conversations.push({ uuid, messages, modifiedAt: mtime });
  }

  // Newest first (match brainmaxxing)
  conversations.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  yield* fs
    .makeDirectory(outputDir, { recursive: true })
    .pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new BrainError({ message: `Cannot create ${outputDir}: ${e.message}` }),
      ),
    );

  const writtenPaths: string[] = [];

  for (const [idx, conv] of conversations.entries()) {
    const outLines: string[] = [];
    for (const msg of conv.messages) {
      const tag = msg.role === "user" ? "[USER]:" : "[ASSISTANT]:";
      outLines.push(`${tag} ${msg.content}`);
    }
    const outFile = path.join(outputDir, `${String(idx).padStart(3, "0")}_${conv.uuid}.txt`);
    yield* fs
      .writeFileString(outFile, outLines.join("\n\n"))
      .pipe(
        Effect.mapError(
          (e: PlatformError) =>
            new BrainError({ message: `Cannot write ${outFile}: ${e.message}` }),
        ),
      );
    writtenPaths.push(outFile);
  }

  // Create batch manifests from written paths (no re-read of output dir)
  const batches = opts.batches ?? 3;
  const batchDir = path.join(outputDir, "batches");
  yield* fs
    .makeDirectory(batchDir, { recursive: true })
    .pipe(
      Effect.mapError(
        (e: PlatformError) =>
          new BrainError({ message: `Cannot create ${batchDir}: ${e.message}` }),
      ),
    );

  const batchCount = Math.min(batches, Math.max(1, writtenPaths.length));
  const batchSize = Math.max(1, Math.ceil(writtenPaths.length / batchCount));

  const batchPaths: string[] = [];
  for (let b = 0; b < batchCount; b++) {
    const batchFiles = writtenPaths.slice(b * batchSize, (b + 1) * batchSize);
    if (batchFiles.length === 0) continue;
    const batchPath = path.join(batchDir, `batch_${b}.txt`);
    yield* fs
      .writeFileString(batchPath, batchFiles.join("\n") + "\n")
      .pipe(
        Effect.mapError(
          (e: PlatformError) => new BrainError({ message: `Cannot write batch: ${e.message}` }),
        ),
      );
    batchPaths.push(batchPath);
  }

  return { conversations, writtenPaths, batchPaths };
});

export const extract = Command.make("extract", {
  dir: dirArg,
  output: outputFlag,
  batches: batchesFlag,
  from: fromFlag,
  to: toFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Extract conversations for ruminate"),
  Command.withHandler(({ dir, output, batches, from: fromDate, to: toDate, json }) =>
    Effect.gen(function* () {
      const result = yield* extractConversations(dir, output, {
        batches,
        from: fromDate,
        to: toDate,
      });

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(
          JSON.stringify({
            conversations: result.conversations.length,
            batches: result.batchPaths,
            output,
          }),
        );
      } else {
        yield* Console.error(`Extracted ${result.conversations.length} conversations`);
        for (const bp of result.batchPaths) {
          yield* Console.log(bp);
        }
      }
    }),
  ),
);

function parseLine(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}
