import { Argument, Command, Flag } from "effect/unstable/cli";
import { Console, Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { BrainError } from "../errors/index.js";

const dirArg = Argument.string("dir");
const outputArg = Argument.string("output");
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

export const extract = Command.make("extract", {
  dir: dirArg,
  output: outputArg,
  batches: batchesFlag,
  from: fromFlag,
  to: toFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Extract conversations for ruminate"),
  Command.withHandler(({ dir, output, batches, from: fromDate, to: toDate, json }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;

      const fromMs = Option.map(fromDate, (d) => new Date(d).getTime());
      const toMs = Option.map(toDate, (d) => new Date(d).getTime() + 86400000 - 1);

      const files = yield* fs
        .readDirectory(dir)
        .pipe(
          Effect.mapError(
            (e: PlatformError) => new BrainError({ message: `Cannot read ${dir}: ${e.message}` }),
          ),
        );

      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();

      const conversations: Conversation[] = [];

      for (const file of jsonlFiles) {
        const fullPath = path.join(dir, file);

        const stat = yield* fs
          .stat(fullPath)
          .pipe(
            Effect.mapError(
              (e: PlatformError) =>
                new BrainError({ message: `Cannot stat ${file}: ${e.message}` }),
            ),
          );

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
              (e: PlatformError) =>
                new BrainError({ message: `Cannot read ${file}: ${e.message}` }),
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

          // Skip meta messages (tool results, etc.)
          if (parsed["isMeta"] === true) continue;

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
            if (clean.startsWith("<system-reminder>") && clean.endsWith("</system-reminder>"))
              continue;

            const maxLen = msgType === "user" ? 3000 : 800;
            messages.push({
              role: msgType,
              content: clean.slice(0, maxLen),
            });
          }
        }

        if (messages.length < 2) continue;

        const uuid = file.replace(".jsonl", "");
        conversations.push({ uuid, messages, modifiedAt: mtime });
      }

      // Newest first (match brainmaxxing)
      conversations.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

      yield* fs
        .makeDirectory(output, { recursive: true })
        .pipe(
          Effect.mapError(
            (e: PlatformError) =>
              new BrainError({ message: `Cannot create ${output}: ${e.message}` }),
          ),
        );

      const writtenPaths: string[] = [];

      for (const [idx, conv] of conversations.entries()) {
        const lines: string[] = [];
        for (const msg of conv.messages) {
          const tag = msg.role === "user" ? "[USER]:" : "[ASSISTANT]:";
          lines.push(`${tag} ${msg.content}`);
        }
        const outFile = path.join(output, `${String(idx).padStart(3, "0")}_${conv.uuid}.txt`);
        yield* fs
          .writeFileString(outFile, lines.join("\n\n"))
          .pipe(
            Effect.mapError(
              (e: PlatformError) =>
                new BrainError({ message: `Cannot write ${outFile}: ${e.message}` }),
            ),
          );
        writtenPaths.push(outFile);
      }

      // Create batch manifests from written paths (no re-read of output dir)
      const batchDir = path.join(output, "batches");
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

      if (json) {
        // @effect-diagnostics-next-line effect/preferSchemaOverJson:off
        yield* Console.log(
          JSON.stringify({
            conversations: conversations.length,
            batches: batchPaths,
            output,
          }),
        );
      } else {
        yield* Console.error(`Extracted ${conversations.length} conversations`);
        for (const bp of batchPaths) {
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
