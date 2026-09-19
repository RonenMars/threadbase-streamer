# Runbooks

Executable procedures. A runbook tells you how to carry out a piece of work that is risky, sequential, or easy to get subtly wrong — and, critically, what failure looks like at each step.

**A runbook is not a postmortem.** Postmortems (`docs/postmortems/`) record what happened at a point in time and stop changing once written. Runbooks are living documents, edited every time reality moves. A runbook should link to its postmortem for the *why* rather than restating it — two copies of the same analysis drift.

Start from [`_template.md`](_template.md), which explains the conventions each section encodes.

| Runbook | Purpose |
|---|---|
| [2026-07-22-land-open-prs.md](2026-07-22-land-open-prs.md) | Land the 18 open streamer PRs onto `main`, in order, without re-hitting the documented conflicts or the two silent-drop traps. |
| [warmup-race/](warmup-race/README.md) | Reproduce and measure the startup warm-up race (`503 SERVER_WARMING_UP` right after `listen()`) with a test-only patch and a stats script. |
