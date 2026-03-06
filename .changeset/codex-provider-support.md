---
"@cvr/brain": minor
---

Add Codex as a supported provider alongside Claude.

The CLI can now configure and manage provider-specific integrations for Claude and Codex, and daemon jobs can scan session archives from both providers while executing with one selected provider. This also adds provider-aware daemon state, Codex transcript extraction support, and daemon provider selection flags.
