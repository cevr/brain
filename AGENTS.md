# Brain CLI

Effect v4 CLI for persistent agent memory. Bun runtime, single-binary build.

## Commands

```bash
bun run gate          # typecheck + lint + fmt + test + build (pre-commit hook)
bun run typecheck     # tsc --noEmit
bun run build         # compile to bin/brain, symlink to ~/.bun/bin/brain
bun run test          # bun test
```

## Architecture

- Effect v4 (effect-smol): `ServiceMap.Service`, `Effect.fn`, `Schema.TaggedErrorClass`
- Four services: `ConfigService` (paths/env), `VaultService` (fs ops), `BuildInfo` (compile-time constants), `ClaudeService` (claude CLI invocation)
- Commands are `Command.make` from `effect/unstable/cli`, composed in `src/commands/index.ts`
- Errors use structured `code` fields — match with `e.code`, not string parsing
- `main.ts` wraps CLI in custom error handler: app errors → stderr, `--json` → structured JSON

## Gotchas

- `BuildInfo.repoRoot` resolves differently in dev (`import.meta.url`) vs compiled (`REPO_ROOT` define). Test with `BuildInfo.layerTest`
- `init.ts` exports `wireHooks`, `copyStarterPrinciples`, `installSkills`, `copyDir` as `@internal` — tests import them directly
- `Effect.fn` with recursive calls needs explicit type annotation on the binding (see `copyDir`, `dirsHaveDiff`)
- `brain skills list` compares repo `skills/` against `~/.claude/skills/` — only flags skills that exist in both
- `brain skills sync` follows symlinks: if `~/.claude/skills/foo` is a symlink, it syncs to the resolved target
- Vault `filterMdFiles` strips `.md` extension from returned paths — callers get `principles/testing`, not `principles/testing.md`
- `brain inject` must never fail (exit 0 always) — it runs as a SessionStart hook
- `ClaudeService` wraps `Bun.spawn` for `claude` CLI — use `.layerTest(ref)` in tests to capture invocations without spawning
- **Daemon**: macOS-only (launchd). `requireDarwin()` guards install/uninstall. `requireHome()` replaces raw `process.env["HOME"]` access
- **Daemon locks**: atomic acquisition via `O_EXCL` (`writeFileSync` with `wx` flag). `Effect.ensuring` guarantees release on interruption
- **Daemon state**: `~/.brain/.daemon.json` tracks processed sessions and last run times. Lockfiles at `~/.brain/.daemon-{job}.lock`
- **Daemon reflect**: passes file paths (not inlined transcripts) to Claude. Max 2000 lines across all sessions per group
- **`deriveProjectName`**: resolves dashified dir names back to real paths on disk via `fs.exists`, takes `path.basename`. Effectful (`Effect.fn`)
- **Error codes**: `NO_HOME` (HOME unset), `UNSUPPORTED_PLATFORM` (non-macOS), `LOCKED` (job already running)

## For Related Docs

| Topic                | Location                              |
| -------------------- | ------------------------------------- |
| Vault ops, CLI usage | `skills/brain/SKILL.md`               |
| Effect v4 patterns   | `~/.claude/skills/effect-v4/SKILL.md` |
| Test helpers         | `tests/helpers/index.ts`              |
