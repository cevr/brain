---
"@cvr/brain": minor
---

Add `brain daemon` for automated vault maintenance via launchd. Three scheduled jobs: `reflect` (hourly, extracts learnings from settled sessions), `ruminate` (weekly, mines archives for missed patterns), `meditate` (monthly, audits vault quality). Subcommands: `start`, `stop`, `status`, `run <job>`, `logs`. Includes `ClaudeService` for testable skill invocation, PID-based lockfiles, atomic state checkpointing, and log rotation.
