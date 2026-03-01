# brain CLI — Implementation Plan

## Context

Building a CLI tool that manages an Obsidian-compatible markdown vault for persistent agent memory across Claude Code sessions. Inspired by [poteto/brainmaxxing](https://github.com/poteto/brainmaxxing) but redesigned as a proper CLI that handles all filesystem plumbing — path resolution, vault init, index maintenance, hook wiring — while LLM skills handle the non-deterministic work (reflect, meditate, ruminate, plan, review).

**Problem**: brainmaxxing is per-project (hardcodes `$CLAUDE_PROJECT_DIR/brain/`). We want a global brain that follows you across projects, with optional per-project vaults layered on top.

**Outcome**: `brain` binary at `~/.bun/bin/brain`. Global vault at `~/.brain/`. Skills at `~/Developer/personal/dotfiles/skills/`. Hooks auto-wired into `~/.claude/settings.json`.

## Design Principles

1. **Agent-first output** — every command prints file paths, vault state, and actionable context. An LLM agent reading stdout should have everything it needs to proceed without guessing.
2. **Deterministic where possible** — CLI handles all filesystem operations deterministically. LLM skills handle the non-deterministic thinking.
3. **`--json` everywhere** — every command supports `--json` for structured machine output. Human output is the default on TTY.
4. **stdout = data, stderr = messages** — vault paths, file lists, index contents go to stdout. Progress, warnings go to stderr.
5. **Silence is success** — mutations (init, reindex) print what changed; no-ops print nothing.

## Architecture

```
~/Developer/personal/brain/          # CLI source (git repo)
├── src/
│   ├── main.ts
│   ├── commands/
│   │   ├── index.ts                 # root + subcommands
│   │   ├── init.ts                  # brain init [--project] [--global]
│   │   ├── vault.ts                 # brain vault [--project] [--global]
│   │   ├── reindex.ts               # brain reindex [--all]
│   │   ├── inject.ts                # brain inject (SessionStart hook)
│   │   ├── open.ts                  # brain open [--project]
│   │   ├── status.ts                # brain status
│   │   ├── snapshot.ts              # brain snapshot <dir> (for meditate/ruminate)
│   │   └── extract.ts               # brain extract <dir> (conversation mining)
│   ├── services/
│   │   ├── Config.ts                # path resolution, config load/save
│   │   └── Vault.ts                 # vault filesystem operations
│   └── errors/
│       └── index.ts                 # BrainError, VaultError, ConfigError
├── tests/
│   ├── helpers/test-cli.ts
│   ├── services/Vault.test.ts
│   └── commands/*.test.ts
├── scripts/build.ts                 # Bun.build → bin/brain → ~/.bun/bin/brain
├── package.json
├── tsconfig.json
├── .oxlintrc.json
└── lefthook.yml

~/.brain/                             # Global vault (Obsidian-compatible)
├── .obsidian/                        # Obsidian config (gitignored except core)
├── index.md                          # auto-maintained root index
├── principles.md                     # categorized principle index
├── principles/                       # engineering principles
├── plans/
│   └── index.md
└── projects/                         # optional project namespaces
    └── <project-name>/

~/.config/brain/config.json           # CLI config
```

### Multi-vault

- **Global vault** (`~/.brain/`): always active. Principles, preferences, cross-project knowledge.
- **Project vault** (`$PWD/brain/` or `$CLAUDE_PROJECT_DIR/brain/`): opt-in per project.
  - `brain init --project` → creates `brain/` in project root
  - `brain init --project --global` → creates `~/.brain/projects/<name>/` namespace
- **`brain inject`** merges both indexes (global first, then project).
- **`brain vault`** returns active vault (project if inside one, else global).

### Hook wiring

`brain init` merges into existing `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "brain inject" }] }],
    "PostToolUse": [
      { "matcher": "brain/", "hooks": [{ "type": "command", "command": "brain reindex" }] }
    ]
  }
}
```

Existing hooks (Stop, Notification) preserved. Merge is additive and idempotent.

### File I/O

All filesystem operations use `FileSystem` from `effect` (provided by `BunServices.layer`). No raw `Bun.file()`, `Bun.write()`, or `fs` imports. This ensures:

- Testability — mock `FileSystem` in tests
- Consistent error types — `PlatformError` throughout
- No `Effect.promise` wrappers needed

### Config resolution

Env-first via `Config.*` (Effect's config provider):

- `BRAIN_DIR` → global vault path (default `~/.brain`)
- `BRAIN_PROJECT_DIR` → explicit project vault override
- `CLAUDE_PROJECT_DIR` → auto-detected project vault at `$CLAUDE_PROJECT_DIR/brain/`
- Persistent config at `~/.config/brain/config.json` (for non-env settings)

## Key reference files

- `/Users/cvr/Developer/personal/stacked/src/main.ts` — entry point pattern
- `/Users/cvr/Developer/personal/stacked/src/services/Stack.ts` — ServiceMap.Service, Schema.fromJsonString pattern
- `/Users/cvr/Developer/personal/stacked/src/commands/create.ts` — command pattern (Argument, Flag, withHandler)
- `/Users/cvr/Developer/personal/stacked/src/errors/index.ts` — TaggedErrorClass pattern
- `/Users/cvr/Developer/personal/stacked/package.json` — deps, scripts, tooling
- `/Users/cvr/Developer/personal/stacked/scripts/build.ts` — build script to adapt
- `/Users/cvr/.cache/repo/poteto/brainmaxxing/.claude/hooks/auto-index-brain.sh` — index rebuild logic to port
- `/Users/cvr/.cache/repo/poteto/brainmaxxing/.agents/skills/` — all 6 skills to adapt

## Phases

### Phase 1: Scaffold project

Create `~/Developer/personal/brain/` with full tooling.

**Files**: `package.json`, `tsconfig.json`, `.oxlintrc.json`, `lefthook.yml`, `.gitignore`, `scripts/build.ts`

- Copy patterns exactly from stacked
- `@cvr/brain`, bin `./bin/brain`, same scripts
- `effect@4.0.0-beta.12`, `@effect/platform-bun@4.0.0-beta.12`
- Dev: typescript, oxlint, oxfmt, lefthook, concurrently, effect-bun-test, @effect/language-service
- `scripts/build.ts`: change binary name from "stacked" to "brain"
- `git init`

**Gate**: `bun install && bun run typecheck`

### Phase 2: Errors + schemas

**Files**: `src/errors/index.ts`

```typescript
class BrainError extends Schema.TaggedErrorClass<BrainError>()("BrainError", {
  message: Schema.String,
}) {}
class VaultError extends Schema.TaggedErrorClass<VaultError>()("VaultError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
}) {}
class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}
```

**Gate**: `bun run typecheck && bun run lint`

### Phase 3: ConfigService

**Files**: `src/services/Config.ts`

- Uses `Config.withDefault(Config.string("BRAIN_DIR"), "~/.brain")` for global vault path
- Uses `Config.option(Config.string("BRAIN_PROJECT_DIR"))` for project override
- Detects project vault via `$CLAUDE_PROJECT_DIR/brain/` or `$PWD/brain/` using `FileSystem.exists`
- Returns active vault path (project > global)
- Persistent config at `~/.config/brain/config.json` (for non-env overrides)
- `Schema.fromJsonString` for config parsing
- All file I/O through `FileSystem` from `effect` (provided by `BunServices.layer`) — no raw `Bun.file()`
- `layerTest` with in-memory config

**Gate**: `bun run typecheck && bun run lint`

### Phase 4: VaultService

**Files**: `src/services/Vault.ts`

All file I/O through `FileSystem` from `effect` — no raw `Bun.file()` or `Bun.write()`. This keeps services testable (mock FileSystem in tests) and consistent with Effect platform patterns.

Core operations:

- `init(path)` — scaffold vault structure (index.md, principles.md, principles/, plans/, plans/index.md)
- `rebuildIndex(path)` — port auto-index-brain.sh logic: `fs.readDirectory({ recursive: true })`, filter \*.md, group by dir, emit wikilinks
- `readIndex(path)` — `fs.readFileString` on index.md
- `search(path, query)` — recursive readDirectory + readFileString + regex match per file
- `listFiles(path)` — all .md files relative to vault root
- `status(path)` — file count, orphans (files not linked from any index), sections

All methods `Effect.fn`-wrapped. `layerTest` with in-memory filesystem via `Ref`.

**Gate**: `bun run typecheck && bun run lint`

### Phase 5: Core commands + entry point

**Files**: `src/main.ts`, `src/commands/index.ts`, `src/commands/init.ts`, `src/commands/vault.ts`, `src/commands/reindex.ts`, `src/commands/inject.ts`

Entry point: `BunRuntime.runMain`, layer composition matching stacked pattern. Global `--json` flag on root command.

#### Command output contracts

**`brain init [--project] [--global]`**

```
# Human (stderr: progress, stdout: summary)
Created vault at /Users/cvr/.brain
  index.md
  principles.md
  principles/
  plans/
  plans/index.md
Wrote config to /Users/cvr/.config/brain/config.json
Wired hooks into /Users/cvr/.claude/settings.json

# --json (stdout)
{
  "vault": "/Users/cvr/.brain",
  "config": "/Users/cvr/.config/brain/config.json",
  "hooks": "/Users/cvr/.claude/settings.json",
  "files": ["index.md", "principles.md", "plans/index.md"]
}
```

**`brain vault [--project] [--global]`**

```
# stdout (bare path — pipeable)
/Users/cvr/.brain

# --json
{ "global": "/Users/cvr/.brain", "project": null, "active": "/Users/cvr/.brain" }
```

**`brain reindex [--all]`**

```
# stdout: nothing if no changes (silence = no-op)
# stdout if changed:
Reindexed /Users/cvr/.brain/index.md (14 files, 3 sections)

# --json
{ "vault": "/Users/cvr/.brain", "files": 14, "sections": ["principles", "plans", "projects"], "changed": true }
```

**`brain inject`** (SessionStart hook — always stdout, no --json needed)

```
Brain vault — read relevant files before acting:

# Brain

## Principles
- [[principles/foundational-thinking]]
- [[principles/guard-the-context-window]]
...

## Plans
- [[plans/index]]
```

**Gate**: `bun run gate`

### Phase 6: Utility commands

**Files**: `src/commands/open.ts`, `src/commands/status.ts`, `src/commands/snapshot.ts`, `src/commands/extract.ts`

**`brain search`** — DEFERRED. Future: vector search (embeddings). For now, `rg` on `$(brain vault)` covers text search.

**`brain open [--project]`** — opens in `$EDITOR` or `code`. Prints path to stderr.

**`brain status [--json]`**

```
# Human
Vault: /Users/cvr/.brain
Files: 14
Sections: principles (12), plans (1), projects (1)
Orphans: 0

# --json
{ "vault": "/Users/cvr/.brain", "files": 14, "sections": { "principles": 12, "plans": 1, "projects": 1 }, "orphans": [] }
```

**`brain snapshot <dir> [--output file]`** — concatenate .md files with `=== path ===` delimiters (for meditate). Outputs to stdout or file.

**`brain extract <dir> <output> [--batches N] [--from DATE] [--to DATE]`** — port extract-conversations.py to TS (for ruminate). Prints batch manifest paths to stdout.

**Gate**: `bun run gate`

### Phase 7: Tests

**Files**: `tests/helpers/test-cli.ts`, `tests/services/Vault.test.ts`, `tests/commands/init.test.ts`

- CallRecorder + mock services + createTestLayer (stacked pattern)
- VaultService: test rebuildIndex output, search results, status/orphan detection
- init command: test vault scaffolding, config creation, hook merging

**Gate**: `bun run gate`

### Phase 8: Skills (adapted from brainmaxxing)

**Location**: `~/Developer/personal/dotfiles/skills/`

Port 6 skills, adapting paths to use `brain` CLI:

| Original | New name     | Key changes                                                 |
| -------- | ------------ | ----------------------------------------------------------- |
| brain    | brain-vault  | `$(brain vault)` for paths, reference CLI commands          |
| reflect  | reflect      | Same routing logic, `brain vault` for paths                 |
| meditate | meditate     | Use `brain snapshot`, `brain reindex`                       |
| ruminate | ruminate     | Use `brain extract` instead of python script                |
| plan     | brain-plan   | `$(brain vault)/plans/`, avoids architect conflict          |
| review   | brain-review | `$(brain vault)/principles.md`, avoids code-review conflict |

Skills call the CLI for all path resolution. No hardcoded paths.

Also add `brain` trigger to CLAUDE.md agent protocol's skill table.

**Gate**: Manual — verify skills load with `/brain-vault`, `/reflect`, etc.

### Phase 9: Build + verify end-to-end

- `bun run build` → `bin/brain` → symlinked to `~/.bun/bin/brain`
- `brain init` → creates `~/.brain/` vault, `~/.config/brain/config.json`, wires hooks
- `brain inject` → outputs vault index
- `brain reindex` → rebuilds index from disk
- `brain search "principle"` → finds matches
- `brain status` → shows vault health
- New Claude Code session → SessionStart hook fires `brain inject` → brain index in context

## Verification

1. `bun run gate` passes (typecheck, lint, fmt, test, build)
2. `brain --help` shows all commands
3. `brain init` creates vault at `~/.brain/`, config at `~/.config/brain/config.json`
4. `brain inject` outputs the vault index
5. `brain reindex` correctly rebuilds index.md with wikilinks grouped by section
6. Start new Claude Code session → brain index appears in context via SessionStart hook
7. Write a file to `~/.brain/test.md` → PostToolUse hook fires → index updated
8. `/reflect` skill resolves paths via `brain vault` and writes to `~/.brain/`

## Source sessions

- **Design & planning**: `~/.claude/projects/-Users-cvr-Developer-personal-dotfiles/14bd9dab-dfae-4a6d-8fcc-21df2fa44298.jsonl`
- **Implementation**: `~/.claude/projects/-Users-cvr-Developer-personal-dotfiles/c78474ea-c85e-4aa8-b51a-df78db9bf5a0.jsonl`
- **Audit fixes**: `~/.claude/projects/-Users-cvr-Developer-personal-dotfiles/78150810-5bdb-4659-982b-e9138c697070.jsonl`
- **Test suite**: `~/.claude/projects/-Users-cvr-Developer-personal-dotfiles/3f54f217-07a5-4128-9eda-7cae25c121e1.jsonl`
