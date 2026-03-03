---
"@cvr/brain": minor
---

Collapse 3 separate launchd daemon plists into 1 unified scheduler. `brain daemon tick` dispatches the right job (reflect/ruminate/meditate) based on day and hour. Schedule: 9am, 1pm, 5pm, 9pm Sun-Thu; Fri/Sat skip. Meditate weekly (Sun 9am), ruminate daily (Mon-Thu 9am), reflect at all other slots. `brain daemon start` auto-migrates from legacy per-job plists.
