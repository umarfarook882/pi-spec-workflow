# pi-spec-workflow Documentation

This document provides a deep dive into the technical capabilities, configuration options, edge cases, and design philosophy of the `pi-spec-workflow` extension.

---

## 1. Configuration Settings

You can configure the extension by creating a `.pi/spec-workflow.json` file in your project root. If omitted, safe defaults are applied.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maxRetries` | `number` | `3` | Maximum number of times the AI can attempt to fix a failing test before triggering a spec failure. |
| `specsDir` | `string` | `"specs/"` | Directory where markdown spec files are stored. |
| `stateFile` | `string` | `".pi/spec-state.json"` | Path to the cross-session state tracker. |
| `rules` | `string[]` | *See below* | Custom system rules injected into the AI's prompt during `run_spec`. |
| `testTimeout` | `number` | `60000` | Maximum time (in ms) a test command can run before timing out. |
| `interactiveContext` | `boolean` | `true` | If true, prompts the user for context-loading strategies when files are massive. |
| `largeFileThreshold` | `number` | `1000` | Number of lines before a file triggers the interactive context prompt. |
| `protectedPaths` | `string[]` | `["specs/", "docs/"]` | Paths requiring explicit human approval (`request_file_unlock`) before the AI can edit them. |
| `interactiveTesting` | `boolean` | `true` | If true, prompts the user to approve dynamic test commands proposed by the AI. |
| `autoApproveDelayMs` | `number` | `30000` | Time (in ms) before a dynamic test command is automatically approved. Set to `0` for no auto-approval. |

---

## 2. Dynamic TDD & Verification (Human-in-the-Loop)

`pi-spec-workflow` bridges the gap between strict TDD (Test-Driven Development) and flexible BDD (Behavior-Driven Development).

### Static vs. Dynamic Testing
* **Static Testing:** If a spec file explicitly defines a `test_cmd` (e.g., `test_cmd: "npm run test:auth"`), the AI autonomously executes this exact command via `verify_spec`.
* **Dynamic Testing:** If a spec omits `test_cmd`, the AI must dynamically determine the right command to run (e.g., `cargo test auth_module`) and pass it to `verify_spec`. 

### The TUI Approval Gateway
Allowing an AI to run arbitrary bash commands can be risky. When the AI proposes a dynamic test command, the extension triggers an interactive TUI overlay:
1. The AI execution pauses safely.
2. You see: `Agent wants to verify spec with: <command>` and a countdown timer.
3. You can:
   * **Approve:** Run the command immediately.
   * **Edit:** Modify the command (e.g., add a `--watch=false` flag) and run it.
   * **Reject:** Force the AI to rethink its testing strategy.
4. If the `autoApproveDelayMs` countdown expires, the command is auto-approved to prevent the LLM API from timing out while keeping the loop mostly autonomous.

### The Ledger (`test-audit.log`)
Every test executed via `verify_spec` (static or dynamic) is permanently recorded in `.pi/test-audit.log`. This acts as an immutable ledger proving what was tested, the exit code, and whether it was approved by a human or auto-run.

---

## 3. The "Hard Firewall" (Context Bloat Protection)

Audit logs (`test-audit.log`, `git-audit.log`, etc.) grow rapidly. If the AI reads them, it can easily blow up its context window.

The extension employs a **Hard Firewall** via a `pi.on("tool_call")` hook:
* **Blocked `read`:** If the AI attempts to read any file ending in `-audit.log`, the tool instantly blocks the action.
* **Blocked `bash`:** If the AI attempts to use `cat`, `grep`, `tail`, `awk`, etc. on an audit log, it is blocked.
* **Self-Correcting UX:** The firewall returns a directive error message to steer the AI (e.g., *"❌ Blocked... To see why a test failed, read '.pi/last-test-failure.log' instead."*). The AI corrects itself without human intervention.

---

## 4. Context Management (Handling Massive Files)

When updating a massive legacy file, injecting the entire file causes severe token bloat and hallucination risks.

### How it Works
When `run_spec` executes, it evaluates every file in the `context` against `largeFileThreshold`. If exceeded:
1. **Headless Mode:** Safely applies format-aware fallbacks.
2. **Interactive Mode:** Pauses and asks the developer how to inject the file.

### Format Strategies
* **Code:** "Top & Bottom Split". Injects lines 1-250 and the last 750 lines.
* **Markdown:** "Table of Contents". Extracts only lines starting with `#`.
* **Configuration:** "Do Not Load". Forces the AI to use `bash grep` or `jq`.
* **Custom Prompt:** Developer provides an explicit instruction instead of the file.

---

## 5. Protected Paths & Approval Gates

`pi-spec-workflow` strictly gates the Source of Truth (`specs/`, `docs/`) to prevent "goalpost shifting" where the AI secretly rewrites a spec to make tests pass.

### The Unlock Workflow
1. The AI attempts to edit a protected file and is blocked.
2. The AI uses the `request_file_unlock` tool, providing a justification.
3. The developer is prompted via TUI to Approve, Edit the Justification, or Reject.
4. The decision is logged to `.pi/{parent_folder}-audit.log`.

---

## 6. Error Handling & Reversibility

### Safe Test Output (The Split)
When tests fail:
* The LLM context receives **only the last 50 lines** of the output (saving thousands of tokens).
* The **full uncut error log** is written to `.pi/last-test-failure.log`. The AI is told to grep this file if it needs more detail.
* **Cleanup:** When a spec successfully completes, `.pi/last-test-failure.log` is physically deleted to maintain a pristine workspace.

### Spec Failure (`spec_fail`)
If the AI exhausts its `maxRetries`:
1. Stages current workspace changes.
2. Generates a `.patch` file of the AI's failed experimental work.
3. Performs a `git reset --hard` to return the workspace to a pristine state.

---

## 7. Automated Architectural Decision Records (ADRs)

When the AI calls the `spec_complete` tool, it is required to provide an `architecture_decisions` array.
* **Token Protection:** Capped via JSON Schema (`maxItems: 3`, `maxLength: 200`) to force concise bullet points.
* It is silently appended to `.pi/code-audit.log`, generating a background record of the codebase's evolution without blocking the human.