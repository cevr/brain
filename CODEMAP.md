# Brain CLI Codemap

## Structure

```
src/
├── main.ts              # Entry point, CLI runner, error handler
├── globals.d.ts         # Compile-time constants (APP_VERSION, REPO_ROOT)
├── errors/index.ts      # BrainError, VaultError, ConfigError (TaggedErrorClass)
├── services/
│   ├── Config.ts        # Paths, env detection, project name resolution
│   ├── Vault.ts         # Vault init, reindex, status, snapshot, file listing
│   ├── BuildInfo.ts     # Compile-time repo root + version
│   └── Claude.ts        # Claude CLI invocation (layerTest captures calls via Ref)
├── commands/
│   ├── index.ts         # Root command, subcommand wiring
│   ├── init.ts          # Vault scaffold, hooks, skills install (largest command)
│   ├── inject.ts        # SessionStart hook output — global + project notes
│   ├── skills.ts        # skills list/sync — nested subcommand
│   ├── reindex.ts       # Rebuild index.md from disk
│   ├── status.ts        # Vault health check
│   ├── vault.ts         # Print active vault path
│   ├── list.ts          # List vault files
│   ├── snapshot.ts      # Concatenate .md files
│   ├── extract.ts       # Parse JSONL conversations
│   ├── daemon.ts        # Daemon parent command + subcommands (start/stop/status/run/logs)
│   └── daemon/
│       ├── state.ts     # DaemonState schema, read/write, lockfiles, requireHome, requireDarwin, deriveProjectName
│       ├── reflect.ts   # Hourly: scan sessions, pass file paths to Claude /reflect per project
│       ├── ruminate.ts  # Weekly: invoke /ruminate
│       ├── meditate.ts  # Monthly: invoke /meditate
│       └── launchd.ts   # Plist generation, install/uninstall, isLoaded, log rotation
scripts/
└── build.ts             # Bun.build with compile-time defines → bin/brain
starter/
├── principles/          # Seed principles copied on first init
└── principles.md        # Seed principles index
skills/                  # Brain-managed skills (copied to ~/.claude/skills/ by init)
tests/
├── helpers/index.ts     # Shared withTempDir helper
├── services/            # Config, Vault service tests
├── commands/            # Command handler tests (inject, init, etc.)
└── commands/daemon/     # Daemon state + reflect tests
```

## Key Patterns

| Pattern                   | Where                            | Notes                                                                      |
| ------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| Service layer composition | `main.ts:27-32`                  | `ConfigService + VaultService + BuildInfo + ClaudeService` → `BunServices` |
| Recursive dir comparison  | `skills.ts:dirsHaveDiff`         | Byte-level file comparison for outdated detection                          |
| Minimal init mode         | `Vault.ts:init({ minimal })`     | Project sub-vaults get only dir + index.md                                 |
| Project auto-detection    | `Config.ts:currentProjectName`   | `BRAIN_PROJECT` → git root → cwd basename                                  |
| Error code matching       | All commands                     | `e.code === "INDEX_MISSING"`, never string match on `e.message`            |
| Atomic lock (O_EXCL)      | `state.ts:acquireLock`           | `writeFileSync(path, pid, { flag: "wx" })` — no TOCTOU race                |
| Effect.ensuring for locks | `reflect/ruminate/meditate.ts`   | Guarantees lock release even on fiber interruption                         |
| File-path prompts         | `reflect.ts:buildFilePathPrompt` | Passes session file paths to Claude instead of inlining content            |
| Platform guard            | `state.ts:requireDarwin`         | Fails with `UNSUPPORTED_PLATFORM` on non-macOS for launchd commands        |
