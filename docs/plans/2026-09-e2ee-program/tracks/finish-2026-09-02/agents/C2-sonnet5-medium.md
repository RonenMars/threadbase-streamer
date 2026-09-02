# C2 — the silence timer and the pending-prompt guard

**Model: Sonnet 5. Effort: medium.** Reason: two well-understood defects whose fix shape is already written down. The care needed is in not over-reaching — neither fix should grow into a redesign of the reconnect machinery or the prompt system.

Repo: `threadbase-mobile`, worktree `../tb-mobile-worktrees/<slug>`.

**Do not start until the owner tells you C1's PR has merged.** You share the mobile PR slot; a branch opened early only rots behind a rebase.

**File an issue for each defect before fixing it**, per the repo's conventions, with the analysis below attached. Neither issue exists yet.

## Defect 3 — the 45-second silence timer

`hooks/useTerminalStream.ts:25` sets `WS_SILENCE_TIMEOUT_MS = 45_000`, and `resetSilenceTimer()` calls `wsManager.forceReconnect(serverId)` when no WebSocket traffic arrives inside that window, then re-arms itself. Its comment gives the reason and it is a good one: iOS silently kills TCP without firing `onclose`.

**The problem is that it cannot tell a dead socket from an idle session**, so on an idle session it fires forever. Before E2EE that cost one socket dial. Now each redial costs a full Noise handshake — two Diffie-Hellmans server-side on a public pre-authentication endpoint, plus a context and ticket allocation.

Measured on hardware, 2026-09-02, with nobody touching the phone: `/ws` upgrades at 56, 74, 46, 45, 46, 27, 46, 45, 46 second intervals, and **3.1 context opens per minute against a server limit of 5 per device per minute — 62 % of the budget spent doing nothing**. Full evidence: `tracks/D/evidence/d2-row6-silence-timer-churn.md`.

Compounding it: **every foreground rotates every REST context** (`services/e2ee/rest-session.ts:60-63` sets `needsRollover` unconditionally on `active`), so a foreground costs two more handshakes.

**The likely fix**, stated as a direction rather than a specification: any inbound frame should reset the timer, not only session output. The server already sends `host_pressure` and `session_list` frames that prove the socket is alive. Alternatively a server-side ping the client treats as liveness — but that is a two-repo change and needs the owner's agreement before you start it.

**Not the fix:** raising the server's rate limit. The limit is doing its job; the client is spending its budget on nothing. Anyone who proposes changing `PAIR_EXCHANGE_LIMIT` has misread the finding.

Verification: a test that observes the timer firing on a genuinely idle session, a positive control proving it still fires when the socket really is dead, and a mutation that removes the reset-on-any-frame behaviour and turns the idle test red.

## Defect 4 — the pending-prompt guard blocks every input path

When an agent asks a question the user cannot answer — an unauthenticated CLI's login selector, for instance — the *"A prompt is waiting for an answer; answer or dismiss it before sending text"* guard blocks sending in the **Terminal** view as well as chat. Neither a message nor a raw keystroke can get through, so the session is completely uninteractive from the phone and cannot be recovered there.

Observed on hardware: the guard persisted even after the prompt card reported *"That question isn't open anymore"*, and an `ESC` sent to the PTY server-side did not clear it.

This is independent of E2EE.

**Judgment call that is yours to make and the owner's to approve:** whether the Terminal view should be exempt from the guard entirely (it sends raw keys, which is precisely how a human would dismiss a stuck selector), or whether the guard should clear itself when the underlying prompt is no longer open. The second is more correct and more work. Say which you chose and why.

Verification: a test that reproduces a stuck prompt and asserts the terminal path can still send, a positive control proving the guard still works for the case it exists for, and a mutation.

## Both defects

Documented on mobile `main` in `docs/e2ee-client.md` under "Traps found on hardware". Cite the issue numbers in the commit bodies once filed.

The usual bar: real objects on the production path, positive and negative controls, one falsifiability mutation per rule reported as `<file>::<test>` with the verbatim assertion, then tsc, lint and the full unit suite before asking the owner for commit approval.

Report to the owner at each gate: issues filed, fix shape chosen, mutations red, suite green. Ask before opening the PR.

## Documents you keep current

The owner commits after each milestone and can only commit what exists.

- File both issues first, and record their numbers where the analysis lives (`docs/e2ee-client.md` on mobile main already carries the findings; the issues should cite it).
- If either fix is deferred rather than built, write down why — a deferred defect with reasoning is a result; a deferred defect with silence is a loss.

Your milestones: both issues filed · each fix merged. Tell the owner at each.
