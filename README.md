# pi-spec-workflow

**A unified, spec-driven Development and AI Governance extension for the Pi Coding Agent.**

`pi-spec-workflow` orchestrates Test-Driven Development (TDD) directly within the Pi agent. It manages complex context loading, enforces strict architectural governance, automates Git checkpointing, and provides robust Developer Experience (DX) guardrails to prevent LLM context bloating and hallucinations.

## Features

* **Automated TDD Orchestration:** Automatically guides the AI through reading specs, writing tests, implementing code, running verification, and committing changes.
* **Smart Context Loading:** Intelligently handles massive legacy files to prevent token bloat without losing critical context.
* **"Source of Truth" Governance:** Protects critical documentation (`specs/`, `docs/`) from arbitrary AI modification using a human-in-the-loop approval gate.
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
* **Context Protection:** Test logs are strictly truncated. Failures are capped at 50 lines (with the full error saved to `.pi/last-test-failure.log`). Successes are capped at 15 lines.
* **Completion:** Once passing, the AI calls `spec_complete`. It automatically summarizes its design decisions and logs them to `.pi/code-audit.log`.

---

## AI Governance & Auditing

`pi-spec-workflow` treats your project's architecture with extreme care.

### Protected Paths
By default, the `specs/` and `docs/` folders are protected. If the AI wants to edit a Markdown file in these folders, its `edit` tool is blocked.
1. The AI must use the `request_file_unlock` tool and provide a justification.
2. The CLI pauses and asks the developer to **Approve**, **Edit the Justification**, or **Reject**.
3. All decisions are permanently logged to `.pi/{folder}-audit.log`.

### Automated ADRs
When a spec finishes successfully, the AI generates a concise summary (max 3 bullets, 200 chars each) of its architectural choices. This is silently appended to `.pi/code-audit.log`, creating a perfect historical record of the codebase evolution.

### Git Auditing
All background `git commit`, `git reset`, and `git patch` commands triggered by the AI are intercepted. The CLI prompts the developer to Approve or Edit the command, and the result is stored in `.pi/git-audit.log`.

---

## Commands
* `/commit`: Drafts an intelligent, semantic commit message for the current diff based on the active spec.
* `/patch`: Stashes the current uncommitted changes into a safe `.pi/patches/` file.