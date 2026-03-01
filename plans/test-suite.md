# brain CLI — Test Suite

## Context

The brain CLI has no tests. Adding comprehensive tests following the stacked repo's patterns: `effect-bun-test`, `it.effect()`, mock layers via `Layer.succeed`, and `FileSystem.layerNoop` for filesystem-dependent services.

## Approach

Two layers of testing:

1. **Service tests** — test `VaultService` and `ConfigService` in isolation using `FileSystem.layerNoop` (in-memory filesystem stubs) + `Path.layer` (pure POSIX)
2. **Integration tests** — test actual commands (extract, init) using real temp directories via `BunFileSystem.layer`

### Key infrastructure

- `FileSystem.layerNoop(partial)` — from `effect/FileSystem`, every method fails by default, override what you need
- `Path.layer` — from `effect/Path`, pure JS POSIX path impl, no platform deps
- `BunFileSystem.layer` — from `@effect/platform-bun`, real filesystem for integration tests
- `it.effect(name, () => Effect.gen(...).pipe(Effect.provide(layer)))` — from `effect-bun-test`

### No test helper file

Unlike stacked, brain's services are simpler (ConfigService + VaultService, both pure filesystem). Instead of a shared `test-cli.ts`, tests will inline their mock layers — each test's setup is self-contained and readable.

## Files

| File                             | Purpose                                                           |
| -------------------------------- | ----------------------------------------------------------------- |
| `tests/services/Vault.test.ts`   | VaultService: init, listFiles, rebuildIndex, status, snapshot     |
| `tests/services/Config.test.ts`  | ConfigService: path resolution, load/save, XDG                    |
| `tests/commands/extract.test.ts` | Extract: JSONL parsing, date filtering, sort order, output format |
| `tests/commands/init.test.ts`    | Init: hooks wiring, starter principles, idempotency               |

## Test Plan

### `tests/services/Vault.test.ts`

Uses real temp dirs (`BunFileSystem.layer` + `Path.layer`) since Vault does heavy filesystem work (recursive directory reads, file creation, content comparison). Mocking all those calls would be brittle.

**Tests:**

1. `init` creates directories and seed files
2. `init` is idempotent — second call creates nothing
3. `listFiles` returns .md files (sans extension), excludes index.md and node_modules
4. `rebuildIndex` generates correct index with sections
5. `rebuildIndex` is no-op when unchanged (`changed: false`)
6. `rebuildIndex` strips wikilink anchors in comparison
7. `status` returns correct file count, sections, orphans
8. `snapshot` concatenates files with delimiters
9. `snapshot` creates parent directories for output
10. `snapshot` excludes node_modules

### `tests/services/Config.test.ts`

Uses `FileSystem.layerNoop` to control exactly what files "exist" — Config does simple reads/writes.

**Tests:**

1. `globalVaultPath` returns `BRAIN_DIR` env when set
2. `globalVaultPath` falls back to `~/.brain`
3. `loadConfigFile` returns `{}` when no config exists
4. `configFilePath` uses `XDG_CONFIG_HOME` when set
5. `claudeSettingsPath` returns `~/.claude/settings.json`

### `tests/commands/extract.test.ts`

Uses real temp dirs. Writes synthetic JSONL files, runs extract logic, verifies output.

**Tests:**

1. Parses `{type: "user", message: {content: "text"}}` correctly
2. Parses content arrays `[{type: "text", text: "..."}]`
3. Skips system-reminder-only messages
4. Skips `isMeta: true` messages
5. Skips small files (<500 bytes)
6. Sorts conversations newest-first
7. Formats output as `[USER]: ` / `[ASSISTANT]: `
8. Creates batch manifests
9. Date filtering with `--from`/`--to`

### `tests/commands/init.test.ts`

Uses real temp dirs. Tests the wireHooks logic and starter principles copy.

**Tests:**

1. `wireHooks` adds SessionStart + PostToolUse hooks to empty settings
2. `wireHooks` preserves existing hooks
3. `wireHooks` updates matcher on existing brain inject hook
4. `wireHooks` is idempotent (no change on second run)
5. Starter principles copied to empty vault
6. Starter principles NOT copied when principles/ is non-empty

## Verification

```bash
bun test
bun run gate  # typecheck + lint + fmt + test + build
```
