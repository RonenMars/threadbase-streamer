# Runbook template

Copy this to `docs/runbooks/YYYY-MM-DD-<slug>.md` and fill it in. Delete any section that genuinely does not apply — an empty heading is worse than no heading.

A runbook is **not** a postmortem. A postmortem records what happened at a point in time and should stop changing once written; a runbook is an executable procedure with a lifetime, edited every time reality moves. Keep them in separate files, and have the runbook link back to the postmortem for the *why* rather than restating it.

## What makes these useful (the rules the sections below encode)

1. **State what failure looks like, not just what to do.** A step that says "resolve the conflict" is worthless next to one that says "this merge is clean and silently drops the freeze — open the method and check."
2. **Anything already decided goes at the top.** Exclusions, closures and "do not merge this" belong in one table, not scattered across the body.
3. **Order by risk, not by identifier.** Group the mechanical work together and the dangerous work together; say which must go first and why.
4. **Point at existing analysis, do not restate it.** Link the postmortem section that documents each conflict. Restating invites the two copies to drift.
5. **Record the traps that produce green signals.** Those are the only ones a careful operator still walks into.
6. **Say who should run it.** Match the operator to the failure mode of each phase, not to the apparent difficulty.

---

# <Title> — <one line on what this gets you>

**Source:** link to the postmortem/analysis this derives from. Note the naming used for cross-references.
**Status:** live procedure — edit it as the work proceeds.

<One paragraph: what the preceding work established, what this document does that the preceding work did not, and the single most important thing to know before starting.>

## Who should run this

<Only split by phase if the phases genuinely differ in failure mode. If uniform, say so in a sentence.>

| Phase | Character of the work | Recommended |
|---|---|---|
| | | |

<Explain the split in terms of what failure looks like, not command difficulty. Name any model that should not be used, and why.>

**Operating constraints:**

- <Context/session boundaries — where exhaustion mid-step would corrupt state.>
- <Serialisation requirements — what must never run in parallel, and what breaks if it does.>
- <Verification discipline specific to this task.>

## Before starting — decide these once

| Item | Decision |
|---|---|
| | **Excluded / Close / Land.** Reason, plus anything worth salvaging first. |

That leaves **N items**.

## Pre-flight

<A concrete command that sweeps for blockers, plus how to read its output: which states are normal and handled later, and which are genuine blockers. Record any tooling quirk that makes the output lie — lazy computation, caching, needing a second run.>

Found this way, <date>: <list what the sweep actually caught, so the next reader knows it earns its keep.>

## The per-item loop

<Numbered, one item at a time. Include the verification gate and what to do when it is red. Flag any step that cannot be satisfied for a subset of items, and what to substitute.>

## Order

<Grouped by risk. For each group: which items, why they are grouped, which must go first. Name the specific conflicts each will hit and link the analysis.>

## Known traps

<One subsection per trap that produces a *green* signal. For each: the mechanism, why it is invisible, and the exact check to run afterwards. This is the highest-value section — a trap that announces itself does not need a runbook.>

## Moving target

<Anything that invalidates preparation done in advance: an auto-updating dependency, a branch that advances, an external service. Say how far ahead preparation stays valid.>

## Content that exists nowhere else

<Work that lives only in the intermediate artefact and will have to be re-derived. Before listing something here, verify the source fails on it alone — otherwise it belongs at the source and listing it here sends the next operator into a red build with no diagnosis.>

## Definition of done

<An observable end state, not "all items processed". Ideally one that makes leftovers self-evident.>
