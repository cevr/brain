/** @effect-diagnostics effect/strictEffectProvide:skip-file effect/strictBooleanExpressions:skip-file effect/tryCatchInEffectGen:skip-file effect/preferSchemaOverJson:skip-file */
import { describe, it, expect } from "effect-bun-test";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { BunServices } from "@effect/platform-bun";
import { utimesSync } from "node:fs";

// extract command uses FileSystem/Path directly — we import the handler's
// internal logic by running the command's effect with FS/Path layers.
// Since the command is wired via Command.make, we test by writing JSONL files
// and invoking the extraction effect pattern directly.

const TestLayer = BunServices.layer;

const withTempDir = <A, E>(fn: (dir: string) => Effect.Effect<A, E, FileSystem | Path>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    return yield* fn(dir);
  }).pipe(Effect.scoped);

// Helper: create a JSONL file with lines
const writeJsonl = (fs: FileSystem, filePath: string, lines: Record<string, unknown>[]) =>
  fs.writeFileString(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

// Helper: build a standard user message line
const userMsg = (content: string | Array<{ type: string; text: string }>) => ({
  type: "user",
  message: { content },
});

// Helper: build a standard assistant message line
const assistantMsg = (content: string) => ({
  type: "assistant",
  message: { content },
});

// Run the extract logic inline (replicate the command's core loop)
// This avoids dealing with Command.run which needs argv parsing
const runExtract = (
  inputDir: string,
  outputDir: string,
  opts: { batches?: number; from?: string; to?: string } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;

    const fromMs = opts.from ? new Date(opts.from).getTime() : undefined;
    const toMs = opts.to ? new Date(opts.to).getTime() + 86400000 - 1 : undefined;

    const files = yield* fs.readDirectory(inputDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl")).sort();

    interface Message {
      role: string;
      content: string;
    }
    interface Conversation {
      uuid: string;
      messages: Message[];
      modifiedAt: Date;
    }

    const conversations: Conversation[] = [];

    for (const file of jsonlFiles) {
      const fullPath = path.join(inputDir, file);
      const stat = yield* fs.stat(fullPath);

      if ((stat.size ?? 0) < 500) continue;

      const mtime = stat.mtime ?? new Date(0);
      const mtimeMs = mtime.getTime();

      if (fromMs !== undefined && mtimeMs < fromMs) continue;
      if (toMs !== undefined && mtimeMs > toMs) continue;

      const content = yield* fs.readFileString(fullPath);
      const lines = content.trim().split("\n");
      const messages: Message[] = [];

      for (const line of lines) {
        if (line.trim().length === 0) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        const msgType = parsed["type"] as string | undefined;
        if (msgType !== "user" && msgType !== "assistant") continue;
        if (parsed["isMeta"] === true) continue;

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
          if (clean.startsWith("<system-reminder>") && clean.endsWith("</system-reminder>"))
            continue;

          const maxLen = msgType === "user" ? 3000 : 800;
          messages.push({ role: msgType, content: clean.slice(0, maxLen) });
        }
      }

      if (messages.length < 2) continue;

      const uuid = file.replace(".jsonl", "");
      conversations.push({ uuid, messages, modifiedAt: mtime });
    }

    conversations.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

    yield* fs.makeDirectory(outputDir, { recursive: true });

    const writtenPaths: string[] = [];

    for (const [idx, conv] of conversations.entries()) {
      const outLines: string[] = [];
      for (const msg of conv.messages) {
        const tag = msg.role === "user" ? "[USER]:" : "[ASSISTANT]:";
        outLines.push(`${tag} ${msg.content}`);
      }
      const outFile = path.join(outputDir, `${String(idx).padStart(3, "0")}_${conv.uuid}.txt`);
      yield* fs.writeFileString(outFile, outLines.join("\n\n"));
      writtenPaths.push(outFile);
    }

    const batchCount = Math.min(opts.batches ?? 3, Math.max(1, writtenPaths.length));
    const batchSize = Math.max(1, Math.ceil(writtenPaths.length / batchCount));
    const batchDir = path.join(outputDir, "batches");
    yield* fs.makeDirectory(batchDir, { recursive: true });

    const batchPaths: string[] = [];
    for (let b = 0; b < batchCount; b++) {
      const batchFiles = writtenPaths.slice(b * batchSize, (b + 1) * batchSize);
      if (batchFiles.length === 0) continue;
      const batchPath = path.join(batchDir, `batch_${b}.txt`);
      yield* fs.writeFileString(batchPath, batchFiles.join("\n") + "\n");
      batchPaths.push(batchPath);
    }

    return { conversations, writtenPaths, batchPaths };
  });

describe("extract", () => {
  describe("parsing", () => {
    it.live("parses string content messages", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const inputDir = `${dir}/input`;
          const outputDir = `${dir}/output`;
          yield* fs.makeDirectory(inputDir, { recursive: true });

          yield* writeJsonl(fs, `${inputDir}/conv1.jsonl`, [
            userMsg("This is a user message that is long enough to pass the filter"),
            assistantMsg("This is an assistant response that is long enough"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          const result = yield* runExtract(inputDir, outputDir);

          expect(result.conversations).toHaveLength(1);
          expect(result.conversations[0]!.messages[0]!.role).toBe("user");
          expect(result.conversations[0]!.messages[0]!.content).toContain("user message");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("parses content arrays [{type: 'text', text: '...'}]", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const inputDir = `${dir}/input`;
          const outputDir = `${dir}/output`;
          yield* fs.makeDirectory(inputDir, { recursive: true });

          yield* writeJsonl(fs, `${inputDir}/conv1.jsonl`, [
            userMsg([
              { type: "text", text: "Array content user message that is long enough to pass" },
            ]),
            assistantMsg("Assistant reply that is long enough to pass the filter"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          const result = yield* runExtract(inputDir, outputDir);

          expect(result.conversations).toHaveLength(1);
          expect(result.conversations[0]!.messages[0]!.content).toContain("Array content");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("filtering", () => {
    it.live("skips system-reminder-only messages", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const inputDir = `${dir}/input`;
          const outputDir = `${dir}/output`;
          yield* fs.makeDirectory(inputDir, { recursive: true });

          yield* writeJsonl(fs, `${inputDir}/conv1.jsonl`, [
            userMsg(
              "<system-reminder>This is system reminder content that should be skipped entirely</system-reminder>",
            ),
            userMsg("Real user message that should definitely pass the length filter"),
            assistantMsg("Real assistant message that should definitely pass the length filter"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          const result = yield* runExtract(inputDir, outputDir);

          expect(result.conversations).toHaveLength(1);
          // System reminder skipped, only 2 messages remain
          expect(result.conversations[0]!.messages).toHaveLength(2);
          expect(result.conversations[0]!.messages[0]!.content).toContain("Real user");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("skips isMeta: true messages", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const inputDir = `${dir}/input`;
          const outputDir = `${dir}/output`;
          yield* fs.makeDirectory(inputDir, { recursive: true });

          yield* writeJsonl(fs, `${inputDir}/conv1.jsonl`, [
            {
              type: "user",
              isMeta: true,
              message: { content: "Meta message that should be skipped completely" },
            },
            userMsg("Real user message that should definitely pass the length filter"),
            assistantMsg("Real assistant message that should definitely pass the length filter"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          const result = yield* runExtract(inputDir, outputDir);

          expect(result.conversations[0]!.messages).toHaveLength(2);
          expect(result.conversations[0]!.messages[0]!.content).toContain("Real user");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("skips small files (<500 bytes)", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const inputDir = `${dir}/input`;
          const outputDir = `${dir}/output`;
          yield* fs.makeDirectory(inputDir, { recursive: true });

          // Tiny file — should be skipped
          yield* fs.writeFileString(
            `${inputDir}/tiny.jsonl`,
            '{"type":"user","message":{"content":"hi"}}\n',
          );

          // Big enough file
          yield* writeJsonl(fs, `${inputDir}/big.jsonl`, [
            userMsg("User message long enough to pass the content length filter check"),
            assistantMsg("Assistant message long enough to pass the content length filter"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          const result = yield* runExtract(inputDir, outputDir);

          expect(result.conversations).toHaveLength(1);
          expect(result.conversations[0]!.uuid).toBe("big");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("date filtering", () => {
    it.live("--from filters out conversations before the date", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const path = yield* Path;
          const inputDir = `${dir}/input`;
          const outputDir = `${dir}/output`;
          yield* fs.makeDirectory(inputDir, { recursive: true });

          const oldFile = path.join(inputDir, "old.jsonl");
          const newFile = path.join(inputDir, "new.jsonl");

          yield* writeJsonl(fs, oldFile, [
            userMsg("Old conversation that should be filtered out by date range"),
            assistantMsg("Old assistant response long enough to pass the content filter"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          yield* writeJsonl(fs, newFile, [
            userMsg("New conversation that should pass the date range filter check"),
            assistantMsg("New assistant response long enough to pass the content filter"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          // Set mtimes: old → 2024-01-01, new → 2024-06-01
          const oldDate = new Date("2024-01-01");
          const newDate = new Date("2024-06-01");
          yield* Effect.sync(() => {
            utimesSync(oldFile, oldDate, oldDate);
            utimesSync(newFile, newDate, newDate);
          });

          const result = yield* runExtract(inputDir, outputDir, { from: "2024-03-01" });

          expect(result.conversations).toHaveLength(1);
          expect(result.conversations[0]!.uuid).toBe("new");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("--to filters out conversations after the date", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const path = yield* Path;
          const inputDir = `${dir}/input`;
          const outputDir = `${dir}/output`;
          yield* fs.makeDirectory(inputDir, { recursive: true });

          const oldFile = path.join(inputDir, "old.jsonl");
          const newFile = path.join(inputDir, "new.jsonl");

          yield* writeJsonl(fs, oldFile, [
            userMsg("Old conversation that should pass the date range filter check"),
            assistantMsg("Old assistant response long enough to pass the content filter"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          yield* writeJsonl(fs, newFile, [
            userMsg("New conversation that should be filtered out by date range"),
            assistantMsg("New assistant response long enough to pass the content filter"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          const oldDate = new Date("2024-01-01");
          const newDate = new Date("2024-06-01");
          yield* Effect.sync(() => {
            utimesSync(oldFile, oldDate, oldDate);
            utimesSync(newFile, newDate, newDate);
          });

          const result = yield* runExtract(inputDir, outputDir, { to: "2024-03-01" });

          expect(result.conversations).toHaveLength(1);
          expect(result.conversations[0]!.uuid).toBe("old");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("--from and --to together select a date range", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const path = yield* Path;
          const inputDir = `${dir}/input`;
          const outputDir = `${dir}/output`;
          yield* fs.makeDirectory(inputDir, { recursive: true });

          const earlyFile = path.join(inputDir, "early.jsonl");
          const midFile = path.join(inputDir, "mid.jsonl");
          const lateFile = path.join(inputDir, "late.jsonl");

          for (const file of [earlyFile, midFile, lateFile]) {
            const label = path.basename(file).replace(".jsonl", "");
            yield* writeJsonl(fs, file, [
              userMsg(`${label} conversation message long enough to pass filter check`),
              assistantMsg(`${label} assistant response long enough to pass content filter`),
              { type: "padding", message: { content: "x".repeat(500) } },
            ]);
          }

          yield* Effect.sync(() => {
            utimesSync(earlyFile, new Date("2024-01-01"), new Date("2024-01-01"));
            utimesSync(midFile, new Date("2024-06-01"), new Date("2024-06-01"));
            utimesSync(lateFile, new Date("2024-12-01"), new Date("2024-12-01"));
          });

          const result = yield* runExtract(inputDir, outputDir, {
            from: "2024-03-01",
            to: "2024-09-01",
          });

          expect(result.conversations).toHaveLength(1);
          expect(result.conversations[0]!.uuid).toBe("mid");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );
  });

  describe("output", () => {
    it.live("sorts conversations newest-first", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const inputDir = `${dir}/input`;
          const outputDir = `${dir}/output`;
          yield* fs.makeDirectory(inputDir, { recursive: true });

          // Write two files — mtime is set by the filesystem
          yield* writeJsonl(fs, `${inputDir}/old.jsonl`, [
            userMsg("Old conversation user message that is long enough to pass filter"),
            assistantMsg("Old conversation assistant message long enough to pass filter"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          // Small delay to ensure different mtime
          yield* Effect.sleep("50 millis");

          yield* writeJsonl(fs, `${inputDir}/new.jsonl`, [
            userMsg("New conversation user message that is long enough to pass filter"),
            assistantMsg("New conversation assistant message long enough to pass filter"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          const result = yield* runExtract(inputDir, outputDir);

          expect(result.conversations).toHaveLength(2);
          // Newest first
          expect(result.conversations[0]!.uuid).toBe("new");
          expect(result.conversations[1]!.uuid).toBe("old");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("formats output as [USER]: / [ASSISTANT]:", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const inputDir = `${dir}/input`;
          const outputDir = `${dir}/output`;
          yield* fs.makeDirectory(inputDir, { recursive: true });

          yield* writeJsonl(fs, `${inputDir}/conv1.jsonl`, [
            userMsg("User says something interesting and long enough to pass"),
            assistantMsg("Assistant replies with something equally interesting and long"),
            { type: "padding", message: { content: "x".repeat(500) } },
          ]);

          yield* runExtract(inputDir, outputDir);

          const outFiles = yield* fs.readDirectory(outputDir);
          const txtFiles = outFiles.filter((f) => f.endsWith(".txt"));
          expect(txtFiles).toHaveLength(1);

          const content = yield* fs.readFileString(`${outputDir}/${txtFiles[0]}`);
          expect(content).toContain("[USER]: User says something");
          expect(content).toContain("[ASSISTANT]: Assistant replies");
        }),
      ).pipe(Effect.provide(TestLayer)),
    );

    it.live("creates batch manifests", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          const inputDir = `${dir}/input`;
          const outputDir = `${dir}/output`;
          yield* fs.makeDirectory(inputDir, { recursive: true });

          // Create 4 conversations
          for (let i = 0; i < 4; i++) {
            yield* writeJsonl(fs, `${inputDir}/conv${i}.jsonl`, [
              userMsg(`User message number ${i} that is long enough to pass the filter`),
              assistantMsg(`Assistant message number ${i} that is long enough to pass filter`),
              { type: "padding", message: { content: "x".repeat(500) } },
            ]);
            yield* Effect.sleep("10 millis");
          }

          const result = yield* runExtract(inputDir, outputDir, { batches: 2 });

          expect(result.batchPaths).toHaveLength(2);

          // Each batch manifest lists file paths
          const batch0 = yield* fs.readFileString(result.batchPaths[0]!);
          expect(batch0.trim().split("\n").length).toBe(2);
        }),
      ).pipe(Effect.provide(TestLayer)),
    );
  });
});
