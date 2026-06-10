# pi-spec-workflow

**A unified, spec-driven Development and AI Governance extension for the Pi Coding Agent.**

`pi-spec-workflow` orchestrates Test-Driven Development (TDD) directly within the Pi agent. It manages complex context loading, enforces strict architectural governance, automates Git checkpointing, and provides robust Developer Experience (DX) guardrails to prevent LLM context bloating and hallucinations.

## Features

* **Automated TDD/BDD Orchestration:** Guides the AI through reading specs, writing tests, implementing code, dynamic verification, and committing changes.
* **Smart Context Loading:** Intelligently handles massive legacy files to prevent token bloat without losing critical context.
* **"Source of Truth" Governance:** Protects critical documentation (`specs/`, `docs/`) and audit logs from arbitrary AI access using hard firewalls and human-in-the-loop approval gates.
* **Architectural Decision Records (ADRs):** Automatically generates a background audit log of *why* the AI made specific design choices during implementation.
* **Safety & Reversibility:** Snapshots files before execution, auto-generates `.patch` files on failure, and audits all git commands interactively.

---

## Installation

Add the extension to your project's `pi` configuration:

```json
{
  "extensions": [
    "./path/to/pi-spec-workflow/index.ts"
  ]
}
```

## Configuration

You can configure the extension by creating a `.pi/spec-workflow.json` file in your project root.

```json
{
  "maxRetries": 3,
  "specsDir": "specs/",
  "stateFile": ".pi/spec-state.json",
  "testTimeout": 60000,
  "interactiveContext": true,
  "largeFileThreshold": 1000,
  "protectedPaths": ["specs/", "docs/"],
  "interactiveTesting": true,
  "autoApproveDelayMs": 30000,
  "rules": [
    "Complete one file at a time.",
    "Read existing files before editing to understand context."
  ]
}
```

## The Workflow

### 1. Create a Spec
Use the `create_spec` tool (or the TUI) to scaffold a new feature.
* Defines the requirements, test commands, and necessary `context` files.
* **DX Feature:** If you request a context file larger than your `largeFileThreshold`, the CLI will proactively warn you about token costs.

### 2. Run the Spec
Use the `run_spec` tool to execute the spec. 
* **Smart Loading:** If `interactiveContext` is true, the CLI will pause for massive files and ask how you want to load them (e.g., Top/Bottom split for code, Table of Contents for Markdown, or a Custom Prompt).

### 3. Verify & Complete
The AI writes the code and calls `verify_spec` to run the test suite.
* **Dynamic Testing:** If a spec omits a predefined test command, the AI proposes a bash command dynamically. The CLI pauses via a non-blocking TUI overlay, allowing you to **Approve, Edit, or Reject** the command (auto-approving after 30s to prevent API timeouts).
* **Context Protection:** Test logs are strictly truncated. Failures are capped at 50 lines (with the full error saved to `.pi/last-test-failure.log` for debugging). Successes are capped at 15 lines.
* **Completion:** Once passing, the AI calls `spec_complete`. It automatically summarizes its design decisions to `.pi/code-audit.log`, and the temporary failure log is physically deleted to keep the workspace clean.

---

## AI Governance & Auditing

`pi-spec-workflow` treats your project's architecture and context window with extreme care.

### Protected Paths & The Hard Firewall
By default, the `specs/` and `docs/` folders are protected from unauthorized *edits*, and all `.pi/*-audit.log` files are protected from being *read*.
1. **Edits:** If the AI wants to edit a Markdown file in a protected path, its `edit` tool is blocked. It must use the `request_file_unlock` tool and provide a justification. The CLI prompts the developer to Approve, Edit, or Reject.
2. **Reads (The Firewall):** If the AI attempts to read or `bash grep` an audit log, it is instantly hard-blocked. The AI receives a context-aware error message steering it back to the correct diagnostic files, preventing massive token window bloat.

### Audit Ledgers
The extension maintains permanent compliance ledgers in the `.pi/` directory:
* **`.pi/test-audit.log`**: Records every test command executed, the exit code, and whether a human approved it.
* **`.pi/git-audit.log`**: Records all background Git commits, resets, and patch generations.
* **`.pi/code-audit.log`**: Automatically captures Architectural Decision Records (ADRs) when specs complete.

---

## Commands
* `/commit`: Drafts an intelligent, semantic commit message for the current diff based on the active spec.
* `/patch`: Stashes the current uncommitted changes into a safe `.pi/patches/` file.