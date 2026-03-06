# @cvr/brain

## 0.6.1

### Patch Changes

- [`6293099`](https://github.com/cevr/brain/commit/629309926f96d9909ce276cb315bca29a31acce1) Thanks [@cevr](https://github.com/cevr)! - Serialize daemon state mutations with a dedicated state lock to avoid cross-job checkpoint races.

## 0.6.0

### Minor Changes

- [`87ae32d`](https://github.com/cevr/brain/commit/87ae32de5fc36360e564ffd8e8ebbe38d52de0be) Thanks [@cevr](https://github.com/cevr)! - Add Codex as a supported provider alongside Claude.

  The CLI can now configure and manage provider-specific integrations for Claude and Codex, and daemon jobs can scan session archives from both providers while executing with one selected provider. This also adds provider-aware daemon state, Codex transcript extraction support, and daemon provider selection flags.

### Patch Changes

- [`b66d507`](https://github.com/cevr/brain/commit/b66d507b1e9484601822f78e40e8730da232ed31) Thanks [@cevr](https://github.com/cevr)! - fix: skip TCC-protected directories in deriveProjectName to prevent macOS permission popups

  The daemon's `deriveProjectName` called `fs.exists()` on reconstructed path candidates, hitting macOS TCC-protected directories (Downloads, Documents, Photos, etc.) and triggering system permission popups. Now skips probing any path under known TCC-protected `$HOME` subdirectories.

## 0.5.0

### Minor Changes

- [`3d1e3a5`](https://github.com/cevr/brain/commit/3d1e3a50727902b6195be3ca4db3785b4ef2d8f6) Thanks [@cevr](https://github.com/cevr)! - Add `brain daemon` for automated vault maintenance via launchd. Three scheduled jobs: `reflect` (hourly, extracts learnings from settled sessions), `ruminate` (weekly, mines archives for missed patterns), `meditate` (monthly, audits vault quality). Subcommands: `start`, `stop`, `status`, `run <job>`, `logs`. Includes `ClaudeService` for testable skill invocation, PID-based lockfiles, atomic state checkpointing, and log rotation.

- [`602be1c`](https://github.com/cevr/brain/commit/602be1c0c379062f9a34a994f2306effcf412a95) Thanks [@cevr](https://github.com/cevr)! - Collapse 3 separate launchd daemon plists into 1 unified scheduler. `brain daemon tick` dispatches the right job (reflect/ruminate/meditate) based on day and hour. Schedule: 9am, 1pm, 5pm, 9pm Sun-Thu; Fri/Sat skip. Meditate weekly (Sun 9am), ruminate daily (Mon-Thu 9am), reflect at all other slots. `brain daemon start` auto-migrates from legacy per-job plists.

## 0.4.0

### Minor Changes

- [`4b26a63`](https://github.com/cevr/brain/commit/4b26a63fd90a7873fe10edb619e82a1f9a0ffde3) Thanks [@cevr](https://github.com/cevr)! - Add `brain skills list` and `brain skills sync` subcommands. `list` shows installed skills with outdated detection (compares against repo source). `sync` copies updated skills from source to installed location, idempotent — skips identical content. Symlink-aware: syncs to resolved symlink targets.

## 0.3.0

### Minor Changes

- [`c687904`](https://github.com/cevr/brain/commit/c68790495c24e8c2647510011f155d36a0f5fa15) Thanks [@cevr](https://github.com/cevr)! - Add project-namespaced vault directories with auto-detection. `brain inject` now detects the current project (via `BRAIN_PROJECT` env, git root basename, or cwd basename) and injects notes from `projects/<name>/` alongside the global index. `brain init --project --global` creates minimal sub-vaults. New `ConfigService.currentProjectName()` method.

## 0.2.0

### Minor Changes

- [`45867a2`](https://github.com/cevr/brain/commit/45867a2199210a5ecc5ea85f74e54e01890f7195) Thanks [@cevr](https://github.com/cevr)! - CLI audit fixes: structured error codes, BuildInfo service, new `list` command, `--json` on snapshot/inject, `--verbose`/`--min-size` flags, status stdout fix, HOME fallback removal, hooks validation, sections consistency, argument descriptions, `--no-skills` rename, and comprehensive command-level tests.
