# pi-spec-workflow Documentation

This document provides a deep dive into the technical capabilities, edge cases, and design philosophy of the `pi-spec-workflow` extension.

---

## 1. Context Management (Handling Massive Files)

When the AI is tasked with updating a massive legacy file (e.g., a 5,000-line controller), injecting the entire file into the LLM context window causes severe token bloat, increased latency, and hallucination risks.

`pi-spec-workflow` solves this via **Format-Aware Context Loading**.

### How it Works
When `run_spec` executes, it evaluates every file in the spec's `context` array against the `largeFileThreshold` (default: 1000 lines).

If a file exceeds the threshold:
1. **Headless Mode (`ctx.hasUI === false`):** Safely applies format-aware fallbacks.
2. **Interactive Mode:** The CLI pauses and asks the developer how to inject the file, offering choices based on the file extension.

### Format Strategies
* **Code (`.ts`, `.py`, `.go`, etc.):** 
  * *Fallback:* "Top & Bottom Split". Injects lines 1-250 (imports/interfaces) and the last 750 lines. The middle is replaced with a truncation warning.
* **Markdown (`.md`, `.mdx`):** 
  * *Fallback:* "Table of Contents". Extracts only lines starting with `#`. The AI sees the document outline and must use the `read` tool to fetch specific sections.
* **Configuration (`.json`, `.yaml`):**
  * *Fallback:* "Do Not Load". Truncating JSON breaks syntax. A stub is injected forcing the AI to use `bash grep` or `jq` to explore the file.
* **Custom Prompt (Interactive Only):**
  * The developer can provide an explicit instruction (e.g., "Only read the verifyToken function"). The file is excluded, and the instruction is injected instead.

All loading decisions are recorded in `.pi/context-audit.log`.

---

## 2. Protected Paths & Approval Gates

Documentation decay and "goalpost shifting" occur when an AI secretly rewrites a feature spec because it cannot make the code pass the test.

`pi-spec-workflow` strictly gates the Source of Truth.

### The Interceptor
A core `pi.on("tool_call")` interceptor watches all `edit`, `write`, and `bash` commands. If the AI targets a `.md` or `.mdx` file inside any folder listed in `protectedPaths` (default: `specs/`, `docs/`), the tool call is blocked.

### The Unlock Workflow
1. The AI is instructed via System Guidelines to use the `request_file_unlock` tool.
2. The AI provides the `file` path and a `justification` for the edit.
3. The developer is prompted via TUI to Approve, Edit the Justification, or Reject.
4. The decision is logged to `.pi/{parent_folder}-audit.log`.
5. A concise `✅ File unlocked` string is returned to the LLM (preventing human edits to the justification from bloating the LLM context).

---

## 3. Automated Architectural Decision Records (ADRs)

Code changes fast, but the "Why" is rarely documented.

When the AI calls the `spec_complete` tool at the end of the TDD lifecycle, it is required to provide an `architecture_decisions` array.

**Token Protection:** This array is strictly capped via JSON Schema (`maxItems: 3`, `maxLength: 200`). This ensures the AI generates concise, high-level bullet points rather than verbose essays.

The extension silently intercepts this array and appends it to `.pi/code-audit.log`:
```log
[2026-06-09T10:30:00Z] [spec_complete] SPEC: auth-01
ARCHITECTURAL DECISIONS:
- Used a Factory pattern for database connection to support test mocking.
- Chose Map over Array for user caching to guarantee O(1) lookup speed.
```

---

## 4. Error Handling & Reversibility

`pi-spec-workflow` is designed to be completely safe and non-destructive.

### Context Preservation on Test Failure
When the AI calls `verify_spec` and the tests fail:
* The LLM context receives **only the last 50 lines** of the test output (to prevent massive stack traces from blowing up the context window).
* The **full error log** is saved to `.pi/last-test-failure.log`.
* The AI is explicitly instructed to use `read` or `bash grep` on that file if the 50-line snippet is insufficient.

### Spec Failure (`spec_fail`)
If the AI exhausts its maximum retries (`maxRetries`: 3) and fails the spec:
1. The extension stages all current workspace changes.
2. It generates a `.patch` file of the AI's failed experimental work.
3. It performs a `git reset --hard` to return the workspace to a pristine state.
4. The developer is notified of the patch location, ensuring no ideas are lost while keeping the repo clean.

### Spec Reset (`spec_reset`)
If a completed spec needs to be re-run:
1. The extension checks if the spec's completion commit is still the `HEAD`. 
2. If yes, it does a hard reset; if no, it creates a clean `git revert` commit.
3. It restores any unmodified context files from the hidden `.pi/spec-snapshots/` directory, completely resetting the exact file states from before the spec was first run.