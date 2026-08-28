# Threadbase Cross-Repo Refactor: Workspace Directives

You are operating from a neutral workspace directory managing two distinct repositories: @tb-streamer and @tb-mobile. 

## 1. Directory Routing & Mechanics
*   **Repo-Specific Rules:** For instructions on how to build, test, or lint code, you MUST read and follow the CLAUDE.md located at @tb-streamer/CLAUDE.md and @tb-mobile/CLAUDE.md.
*   **Context Switching:** Always verify your current working directory before executing shell commands. Do not run mobile tests in the streamer repo, and vice versa.

## 2. Project Scope & Boundary
**Goal:** Implement safe, scoped interactive prompts across streamer and mobile with a transport-neutral contract.
**Strict NO-GO:** Do not attempt a structured transport rewrite. PTY remains the default transport.
**Constraint:** Never combine a PTY and structured control client for the same session. Do not migrate active sessions between transports.

## 3. Phase 1 Execution: Safety Stabilization
You must completely resolve the following safety defects before writing any code for the prompt contract or transport:
*   **Input Arbitration:** Implement semantic input arbitration. Reject text inputs while an actionable prompt is open; preserve the composer draft.
*   **Content-Free Logging:** The current renderedTail fix is insufficient. Replace all content-bearing default PTY/input logs with metadata-only logging. Ensure digestBytes does not leak plaintext secrets.
*   **Gate Identity:** Fix Codex permission answers using a server-owned instance token.
*   **Fail-Closed Prompts:** Do not build a keystroke synthesizer for unsupported multi-select/free-text prompts. Return a typed incomplete_answer and guarantee zero bytes are written.
*   **Event Scoping:** Scope all open/update/cancel prompt lifecycle events strictly to session subscribers.

## 4. Architectural Guardrails
*   **No "While We're Here" Changes:** Do not clean up unrelated technical debt, refactor status models, or touch /queue and /plan-response endpoints unless explicitly instructed.
*   **UI Honesty (Mobile):** Do not synthesize terminal text from structured events. If working on UI, assume a dedicated "structured activity view" is required.
*   **Client Compatibility:** Never break released mobile clients. Dual legacy events and explicit capability negotiation are mandatory.

## 5. Testing & Verification Methodology
For every core change, you must follow the empirical verification rule:
*   **Real Objects:** Execute against the real production path, not just typed declarations.
*   **Causality Check:** Use positive controls to prove your harness works, and negative controls to prove causality.
*   **Falsifiability:** A test that cannot fail proves nothing. Temporarily mutate load-bearing safeguards to ensure the test catches the failure.

## 6. Stop-Work Triggers
Pause execution and ask for human input immediately if:
*   Session identity forks unexpectedly.
*   Prompt or answer content leaks into logs or unrelated clients.
*   You encounter undocumented provider capability flags.

## 7. Reference Architecture
For full detailed findings, edge cases, phase exit criteria, and security analyses, consult the master document located at @threadbase-cross-repo-refactor.md
