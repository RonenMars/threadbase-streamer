# Codex previews and titles are the injected AGENTS.md turn

**Status: scanner half shipped in `@threadbase-sh/scanner@0.16.1` (threadbase-scanner#83); streamer half is optional cleanup.** Written 2026-09-10 against scanner 0.16.0 and streamer 1.89.3, amended the same day once the release landed.

## Symptom

Almost every Codex conversation in the mobile list shows the same preview:

```
# AGENTS.md instructions for /Users/ronenmars/dev/ai-tools/tb-mobile
```

and the same shape of title — the project path (`dev/ai-tools/tb-mobile`) rather than anything about the conversation. Claude conversations in the same list show a real opening line. Measured on one machine, 2026-09-10: **380 of 611** cached Codex conversations (62%) have a preview beginning `# AGENTS.md` or containing `<INSTRUCTIONS>`.

A third symptom comes from the same cause and is visible in one screenshot: the list card reads **130 msgs** while Conversation Info reads **MESSAGE COUNT 129**. The list serves the scanner's raw count; the detail path applies the streamer's `isCodexInjectedContext` filter and drops one.

## Mechanism

Codex prepends its AGENTS.md instructions as the **first `user` turn** of the rollout — 17 342 characters in `01a08650-bb28-78a1-91e8-fb57362fb7db`, whose line 5 is `role: "user"` and begins `# AGENTS.md instructions for …`.

`reduceCodexEntry` (`tb-scanner`, `src/providers/codex-cli.ts`) already discards boilerplate, but only by role:

```ts
// developer/system/tool roles carry sandbox boilerplate — not user-visible turns.
if (role !== "user" && role !== "assistant") return;
```

The injected blob is labelled `user`, so it passes that guard and is treated as a real turn. It then becomes, in order: `acc.firstUser` (hence `firstMessage`), the first entry in `previewParts` (hence `preview` and `contentSnippet`), and `+1` on `messageCount`.

The comment is right about the category and wrong about how to detect it: this *is* sandbox boilerplate that is not a user-visible turn, and role alone cannot tell.

### The empty title is the same cause, one step removed

`finalizeCodexMeta` sets `sessionName: ""` unconditionally — Codex rollouts carry no `slug`, and unlike the Claude reducer there is no first-message fallback. The Claude path does:

```ts
sessionName: state.sessionName || deriveSessionNameFromFirstMessage(state.firstMessage)
```

That fallback was never added for Codex, and adding it today would make things *worse*, because `firstMessage` is the injected blob — every Codex title would become `# AGENTS.md instructions for …`. With the blob skipped, `firstUser` becomes the real opening turn and the same fallback produces a meaningful title.

So one fix unlocks both a useful preview and a useful title. They are not independent problems.

## The streamer already has the heuristic

`src/utils/codexConversationLine.ts` exports `isCodexInjectedContext(text)`, which matches this exact blob (verified). It is applied on two paths only:

- `api/handlers/conversations.handlers.ts` — filtering the rendered transcript
- `services/conversations/classification.ts` — deciding `has_messages`

Neither touches the cached list preview, which comes from scanner meta via `upsertFromScannerMeta`. That is the whole gap: the streamer knows what this text is and never gets a chance to say so before the preview is stored.

Its current patterns, in two groups:

| Group | Patterns | Owner |
|---|---|---|
| Codex-generic | `# AGENTS.md` prefix, `<INSTRUCTIONS>`, `<permissions instructions>` prefix, `Filesystem sandboxing defines` | belongs in the scanner |
| Streamer-injected | `limit the options to at most 3`, `You are working within the project boundary:`, `Do not read, write, or execute commands that access files or directories outside this boundary` | stays in the streamer |

The second group exists because Codex has no `--system-prompt` flag, so the streamer passes prompts as argv and they land as `role: user` in the rollout. The scanner has no business knowing about those.

## Proposed change

### Scanner (`tb-scanner`)

1. Export `isCodexInjectedContext(text: string): boolean` covering the **Codex-generic** group only.
2. In `reduceCodexEntry`, skip such a turn exactly as the role guard skips `developer`: no `messageCount`, no `previewParts`, no `snippetParts`, no `firstUser`/`lastUser`. Skipping only the preview would leave `messageCount` inconsistent with the streamer's detail count, which is the 130-vs-129 defect.
3. In `finalizeCodexMeta`, mirror the Claude path: `sessionName: deriveSessionNameFromFirstMessage(acc.firstUser)`.
4. Bump `SCHEMA_VERSION` 6 → 7 with a cursor reset, following the v5 → v6 block. Preview, title and count are all folded out of the JSONL into persisted reducer state, so existing rows keep their current values until reparsed.

### Streamer (`tb-streamer`), after the scanner publishes

5. Raise the dependency. The fix released as **0.16.1**, a *patch*, so the `^0.16.0` range needed no widening — but the **lockfile still had to be committed**, because `npm ci` installs the lockfile exactly and never re-resolves a range. Landed in #843.
6. Have `isCodexInjectedContext` delegate the generic group to the scanner's export and keep only the streamer-injected patterns, so the two copies cannot drift. This is cleanup, not delivery — the fix reaches users without it.

## Position-bounded, not content-only — the one arguable call

The streamer's filter matches **anywhere** in a conversation. For the scanner, restrict the skip to **leading** turns — while no user-visible turn has yet been recorded — and stop testing once the first real turn arrives.

The reason is blast radius. A human who pastes AGENTS.md content mid-conversation to discuss it would otherwise have that turn silently uncounted, and `messageCount` is a number people compare against what they see. Codex injects only at the head, so bounding costs nothing real and removes the whole class.

This does leave the two filters with different semantics, deliberately: the scanner's answers *what counts as a turn*, the streamer's answers *what to render*. Hiding a pasted instruction dump from a rendered transcript is defensible; not counting it is not.

## Consequences

- **`messageCount` drops by one** on affected conversations. This *removes* the existing list-vs-detail discrepancy rather than creating one, but it is wire-visible: released tb-mobile builds will show a count one lower than before for old conversations.
- **Existing rows do not change until reparsed.** Hence the schema bump; without it, 380 conversations keep their current preview indefinitely, because nothing appends to a finished rollout.
- **Titles change** for Codex conversations from the project path to their opening line. This is the intended improvement, and it is the most visible change of the three.
- **Claude conversations are untouched** — different reducer, different code path.

## Tests

Scanner:

1. A rollout whose first `user` turn is an `# AGENTS.md` blob followed by a real turn → `preview`, `firstMessage` and `sessionName` all come from the real turn; `messageCount` counts one user turn, not two.
2. The same for an `<INSTRUCTIONS>` body and for a `<permissions instructions>` prefix.
3. A rollout with **no** injected turn → unchanged in every field (regression guard).
4. A rollout where a **later** user turn contains `<INSTRUCTIONS>` → counted and previewable, proving the position bound.
5. A rollout that is *only* an injected turn → `messageCount: 0`, so `finalizeCodexMeta` returns a conversation with no user-visible turns rather than one phantom turn.
6. v6 → v7 migration: columns preserved, cursor reset.

Every negative assertion needs a positive control that has been seen to fail; a filter test that passes against the unfixed code is testing nothing.

Streamer, if and when the heuristic is de-duplicated:

7. `isCodexInjectedContext` still returns true for all seven current patterns once the generic group is delegated.

## Rollout order

1. Scanner change — shipped as **0.16.1**, a *patch*, not the minor this spec first assumed.
2. Commit the updated lockfile (#843). A patch inside the range still does not travel on its own: `npm ci` installs what the lockfile pins and never re-resolves, so without this step every machine keeps 0.16.0 while `package.json` looks satisfied. The declared range needed no widening; the lockfile did.
3. `npm ci` then redeploy on each machine.
4. **Force a refresh of existing rows — this does not happen by itself.** The v7 migration governs the *scanner's own* persistent index, which the streamer does not use: the streamer runs non-persistent scans and hands the scanner a stat cache built from `conversation_meta.scanner_meta_json` (`scanner-manager.ts`, `getScannerStatCache`). That cached meta **is** the skip token, so an unchanged rollout is replayed from cache — stale preview included — and a finished rollout never changes again. Clearing the token for the affected rows is what makes the fix land:

   ```sql
   UPDATE conversation_meta SET scanner_meta_json = NULL WHERE file_path LIKE '%/.codex/%';
   ```

   then restart. Measured on one machine: 379 stale previews → 1 in about 40 seconds, with visibility, subagent and empty-history counts identical before and after. The single survivor is a rollout containing *only* the injected turn, which now yields no meta at all, so its old row is never overwritten — harmless, because `has_messages = 0` keeps it out of every list.
5. Streamer de-duplication of the heuristic, whenever convenient. Optional.

The dependency-bump-as-its-own-change discipline from [09](09-scanner-subagent-identity.md) still applies whenever a scanner change lands as a **minor**, because then the range must be edited and a behaviour shift has to be bisectable. A patch inside the existing range is a different case: nothing is edited, so there is no bump commit to isolate.
