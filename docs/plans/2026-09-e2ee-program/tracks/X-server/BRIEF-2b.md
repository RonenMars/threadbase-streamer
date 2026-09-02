# Slice 2b — the rebase and the wire-up (implementer brief, pre-written while blocked)

Held until W1b's release tag is on the remote. Dispatch verbatim, filling `<TAG>` from the owner's message **after I have verified it myself**.

## Preconditions I verify BEFORE dispatching (not the implementer's job)

1. `git ls-remote --tags origin <TAG>` returns it.
2. `git show <TAG>:src/e2ee/context.ts` contains `authenticateContext` whose failure arm is `{ ok: false; reason: "device-revoked" | "credential-mismatch" | "no-device-store" }` and whose input takes a resolved `E2eeContext`.
3. **If the arm set differs, or the failure arm carries `status`/`body`, or the helper destroys on any path — STOP and report to the owner.** Do not dispatch and do not adapt.
4. sha256 the three slice files against pristine — no stranded mutation from any earlier campaign.

## The implementer's task

Environment, driver rules and prohibitions are as in slice 2a's brief (worktree only; pinned biome 2.5.10; never the full suite; never `record.ts`; sha256 reverts, not `git diff --quiet`; a non-parsing mutant is `BROKEN — did not run`; a mutation that does not go red is the most valuable line in the report).

1. **Rebase** `feat/e2ee-rest-envelope` onto `<TAG>`.
2. **Resolve the one known conflict by keeping ONE declaration** of `e2eeContext?: E2eeContext` in `AppEnv["Variables"]` (`src/api/app.ts`). W1b and this branch both add it with different comments. Accepting both hunks compiles until it does not.
3. **Fill the seam** that 2a locked, in `e2ee-envelope.middleware.ts` at the `TODO(X-server 2b)` marker, and in the REST branch of `auth.middleware.ts`:
   - call `authenticateContext({ context, devicesRepo: deps.devicesRepo(), presented })` **after** the counter check and **before** `next()`;
   - `ok: false` → **seal the refusal with the still-live context**, write it, and destroy **only** when `reason === "device-revoked"`. A `credential-mismatch` must never destroy: `X-TB-Ctx` is a plaintext header, so a destroy reachable that way is a remote denial against any paired device;
   - `ok: true` → `c.set("principal", …)`, then `requiredCapability(path, method)` / `hasCapability` — **a 403 here is sealed too** — then `next()`;
   - `authMiddleware` skips credential *resolution* when a principal is already set, and **never** skips the capability check.
4. **Tests to add**: the real-chain positive control on the **device-credential path** (not `localNoAuth`); a sealed request carrying no `Authorization` authenticating from the context alone; `principal.deviceId === context.deviceId`; an `Authorization` naming another device → sealed 401, **context still resolvable afterwards**; the shared API key beside a context → the same; a device revoked mid-flight → sealed 403 **and** the context gone; **a null or throwing `devicesRepo` (`no-device-store`) → a sealed `503 { error: "Device registry is unavailable", code: "STORE_UNAVAILABLE" }`, context INTACT** — **503, never 403.** §9 makes `E2EE_DEVICE_REVOKED` a hard failure the client must never retry, and a registry we could not read says nothing about the pairing; a 403 would tell the phone its device was revoked because our disk faulted. Copy the status, message and code string from W's WS caller (`auth.middleware.ts:132-139`) — and note this is not a new invention: `devices.routes.ts:59` already answers a missing device registry with the byte-identical body, and `backup.routes.ts` uses the same code. Assert the exact string in the test; a read-only device refused a write with a sealed 403; and the call-order assertion below.
5. **Assert the helper's own hardening from the caller's side** (W confirmed both; they are cheap to assert and expensive to lose in a later refactor): the returned `principal.deviceId` comes from `args.context.deviceId` **by construction**, not from the device row — so assert `principal.deviceId === context.deviceId` even when the row carries a different `device_id`; and a `DeviceLookup` that **conforms but is hostile** — a `revoked_at` accessor that throws — must yield `no-device-store`, **not** an exception escaping into the middleware.
6. **The call-order assertion**: spy `sealResponse` and `contextRegistry().destroy`, assert the first is invoked before the second. Name and comment it as pinning **an order, not a failure mode** — at this tag `destroy()` is unmapping, so a held context seals identically either way; the order is defensive against invalidation landing (streamer #743). If #743 ships, a black-box test replaces this one.
7. **Re-run the ENTIRE campaign on the rebased bytes** — all 18, not only the new rungs. A mutation whose patch target moved in a rebase reports a pass it did not earn.

## Two type-level traps — copy, do not re-derive

- **`DevicePrincipal` is an INTERSECTION**: `type DevicePrincipal = Principal & { kind: "device"; deviceId: string }`. Do **not** write `Extract<Principal, { kind: "device" }>` — `Principal` is a single interface (`kind: "device" | "legacy"`, `deviceId?: string`), not a discriminated union of separate members, so `Extract` evaluates to `never` and the error surfaces far from its cause. Import the type from `context.ts`; do not restate it.
- The verdict type is `E2eeContextAuth` from `src/e2ee/context.ts`. Import it. A locally restated copy is a second source of truth for a frozen seam.

## Report

Diff stat and what to read; `tsc` / pinned-biome / targeted-vitest exit codes; the full 18-row mutation table with verbatim assertions; confirmation the conflict was resolved to one declaration; anything decided alone; anything touched outside the expected files.
