# What a paired device can do (TB-S-05)

**Date:** 2026-08-15
**Subject:** the authority a device holds once it has completed `POST /api/pair/exchange`.
**Raised by:** TB-S-05 in [2026-08-14-streamer-review.md](./2026-08-14-streamer-review.md) — "no per-session or per-project scoping", DREAD 35, ranked 6th.
**Status:** the property is recorded, not changed. Scoping is deliberately not built, and nothing here proposes it.

This file exists because the decision it records had never been written down.
The review found the gap, the answer was "document the property, do not build scoping", and until now a reader had to derive the answer from six files.

---

## The property

**A paired device sees, controls and administers everything on this machine.**

Not everything in a project, not everything it was shown — everything the streamer can reach.
Every session on the box, every conversation in the cache, the whole browsable filesystem, and the administration of the server itself.
There is no narrower grant than that except `read-only`, which narrows the *verbs* and nothing else.

## Verified state, checked 2026-08-15 against `main`

The claim is assembled from five places, none of which is wrong on its own.

- **The session list is unicast whole.** `handleWsOpen` sends `{ type: "session_list", sessions }` — the entire reconciled list — to any socket that clears the upgrade (`src/server-wiring.ts:630-633`).
  There is no per-socket filter to apply one to.
- **`subscribe_session` checks that the caller may read *something*, never that it may read *this*.** It asks `wsAllows(principal, "history:read")` and then accepts any session id, replaying 200 lines of terminal output plus the session's input history (`src/server-wiring.ts:664-686`).
  The comment there already says it is "the seam any future per-project scoping hangs off" — which is an accurate description of a seam that is not used.
- **`/api/conversations` returns the cache.** It is mapped to `history:read` like every other read (`src/services/security/capabilities.ts:109`), and the capability carries no argument to restrict it with.
- **`fs:browse` is all-or-nothing.** One capability for `/api/browse` (`src/services/security/capabilities.ts:113`), covering whatever `browse_root` resolves to.
  The 2026-07-24 design already listed this under Known limits ([device identity and capabilities](../architecture/2026-07-24-device-identity-and-capabilities.md)); it is still true.
- **Since [#592](https://github.com/RonenMars/threadbase-streamer/pull/592), the `full` preset carries `admin`.** `FULL_CAPABILITIES` lists all six capabilities including `admin` (`src/services/security/capabilities.ts:40-47`), so an ordinary paired phone can also revoke its siblings, take a backup, change the model and effort, and rotate the API key.
  That was a deliberate change with its reasoning in place: the phone *is* the administration surface, and a device without `admin` loses four working screens the moment it presents its own token instead of the shared key.

The single fact underneath all five: **the capability model has one axis.**
`CAPABILITIES` is a list of six verbs (`src/services/security/capabilities.ts:11-18`) and `ROUTE_CAPABILITIES` maps a path prefix to one of them (`:105-146`).
A verb is the whole grant. There is no object anywhere in the model for a verb to apply *to* — no session id, no project path, no filesystem root — so "may read history" cannot be narrowed to "may read *this* history" by any configuration a user or an operator can reach today.

## Why this is deliberate

The streamer runs on one developer's own machine, spawns agents as that user, and is paired to that user's own phones.
Every device on the far side is the same person as the process on this side, which is what makes "sees everything" the correct default rather than an oversight: a scoped grant would be one person hiding data from themselves.

The realistic threat is not a paired device exceeding its remit.
It is an *unwanted* device becoming paired at all — the photographed QR of TB-S-01, which the pairing window, the single-use token and `GET /api/devices` plus revocation address, and which per-session scoping would not have prevented.
Since the pairing grant is all-or-nothing in practice, the control that matters is the one on the pairing, not one on the session.

`read-only` is where the narrowing that does exist lives (`READ_ONLY_CAPABILITIES`, `src/services/security/capabilities.ts:53`), and it is enough for the case it was built for: pair a device to watch, not to drive.

## What would have to change if a streamer were shared between people

Stated so the size of the change is known, not as a plan.

The capability model would need a second dimension — an object beside the verb — and that dimension does not exist anywhere today.
Adding it is not a matter of adding a capability, because every consumer of the model assumes a grant is answerable from the principal alone:

- `hasCapability(principal, required)` takes no object, and neither does the route table that calls it. Every `/api` route's authorization would have to become a function of the request's target rather than its path prefix.
- `handleWsOpen` would need a filter to build a per-device session list, where today there is one list broadcast to everyone.
- `subscribe_session` has the seam, but a seam is not a mechanism: something would have to know which sessions a device may see, which means sessions and projects would need an owner, which they do not have.
- A shared streamer also changes who the agent runs as. The PTY spawns as the machine's user with that user's filesystem and credentials, so scoping the API without scoping the agent would move the boundary without enforcing it.

That last point is the reason this is a product decision rather than a patch: a multi-user streamer is a different product, and the authorization model is the smallest part of the difference.

## What this document does not do

It does not design scoping, propose a capability, reserve a field, or mark a TODO.
The decision was to state the property accurately and leave the model alone.
If a shared deployment is ever a real requirement, the work starts from that requirement, not from a placeholder left here.
