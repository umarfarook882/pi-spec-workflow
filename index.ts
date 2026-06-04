import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * pi-spec-workflow — Unified spec-driven development extension for Pi
 *
 * Merges selective context loading (spec-runner) with automated TDD
 * orchestration (context-workflow) into a single extension.
 */

// ============================================================
// Types
// ============================================================

interface SpecFrontmatter {
  id: string;
  name: string;
  phase?: number;
  context?: string[];       // flat list of file paths to load
  test_ids?: string[];
  test_cmd?: string;        // e.g. "cargo test test_yaml"
  creates?: string[];
  tests?: string[];         // test file paths
}

interface SpecState {
  completed: Record<string, {
    timestamp: string;
    test_ids: string[];
    attempts: number;
  }>;
  failed?: Record<string, {
    timestamp: string;
    attempts: number;
    last_reason: string;
  }>;
  current?: {
    id: string;
    attempts: number;
    started: string;
  };
}

interface ProjectConfig {
  maxRetries: number;       // default 3
  specsDir: string;         // default "specs/"
  stateFile: string;        // default ".pi/spec-state.json"
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_CONFIG: ProjectConfig = {
  maxRetries: 3,
  specsDir: "specs/",
  stateFile: ".pi/spec-state.json",
};

// ============================================================
// Helpers
// ============================================================

/**
 * Parse YAML frontmatter from --- delimited block.
 * Lightweight parser — no js-yaml dependency.
 */
function parseFrontmatter(content: string): {
  frontmatter: SpecFrontmatter;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    throw new Error(
      "Spec missing YAML frontmatter. Expected --- delimited block at start of file."
    );
  }

  const yaml = match[1];
  const body = (match[2] || "").trim();
  const fm: Record<string, any> = {};

  let currentKey = "";

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Top-level key: value
    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (kvMatch && !line.startsWith("  ") && !line.startsWith("\t")) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();

      if (!value) {
        // Key with no inline value — next lines are list items
        fm[currentKey] = [];
      } else if (value.startsWith("[") && value.endsWith("]")) {
        // Inline array: [a, b, c]
        const inner = value.slice(1, -1).trim();
        fm[currentKey] = inner
          ? inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
          : [];
      } else if (value === "true" || value === "false") {
        fm[currentKey] = value === "true";
      } else if (/^\d+$/.test(value)) {
        fm[currentKey] = parseInt(value, 10);
      } else {
        fm[currentKey] = value.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    // List item: - value
    const listMatch = trimmed.match(/^-\s+(.+)$/);
    if (listMatch && currentKey && Array.isArray(fm[currentKey])) {
      fm[currentKey].push(listMatch[1].trim().replace(/^["']|["']$/g, ""));
    }
  }

  return { frontmatter: fm as SpecFrontmatter, body };
}

async function loadFile(cwd: string, filePath: string): Promise<{ path: string; content: string; found: boolean }> {
  try {
    const content = await fs.readFile(path.resolve(cwd, filePath), "utf8");
    return { path: filePath, content, found: true };
  } catch {
    return {
      path: filePath,
      content: `<!-- File not found: ${filePath} — may not exist yet -->`,
      found: false,
    };
  }
}

async function resolveContext(cwd: string, files: string[]): Promise<string> {
  const sections: string[] = [];

  for (const filePath of files) {
    const result = await loadFile(cwd, filePath);
    if (result.found) {
      const isSource = /\.(rs|py|ts|js|go|java|c|cpp|h|toml|yaml|yml|json)$/.test(filePath);
      const lang = filePath.split(".").pop() || "text";

      if (isSource) {
        sections.push(`### Source: \`${filePath}\`\n\`\`\`${lang}\n${result.content}\n\`\`\``);
      } else {
        sections.push(`### Context: \`${filePath}\`\n${result.content}`);
      }
    } else {
      sections.push(result.content);
    }
  }

  return sections.join("\n\n---\n\n");
}

async function loadConfig(cwd: string): Promise<ProjectConfig> {
  try {
    const raw = await fs.readFile(path.join(cwd, ".pi/spec-workflow.json"), "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function loadState(cwd: string, config: ProjectConfig): Promise<SpecState> {
  try {
    const raw = await fs.readFile(path.join(cwd, config.stateFile), "utf8");
    return JSON.parse(raw);
  } catch {
    return { completed: {} };
  }
}

async function saveState(cwd: string, state: SpecState, config: ProjectConfig): Promise<void> {
  const statePath = path.join(cwd, config.stateFile);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

function buildInstructions(fm: SpecFrontmatter, config: ProjectConfig): string {
  const parts: string[] = [];

  parts.push("## Workflow Instructions");
  parts.push("");
  parts.push("Follow this sequence:");
  parts.push("");

  if (fm.test_ids && fm.test_ids.length > 0) {
    parts.push(
      `1. **Write tests first** for test IDs: ${fm.test_ids.join(", ")}. ` +
      `Each test function must have its test ID in a comment.`
    );
    parts.push(`2. **Implement** the minimum code to pass all tests.`);
  } else {
    parts.push(`1. **Implement** the requirements described above.`);
  }

  if (fm.test_cmd) {
    parts.push(`3. **Run tests:** \`${fm.test_cmd}\``);
    parts.push(`4. If tests **fail**: fix and retry (max ${config.maxRetries} attempts).`);
    parts.push(`5. If tests **pass**: call \`spec_complete\` with the passing test IDs.`);
    parts.push(`6. If tests fail after ${config.maxRetries} attempts: call \`spec_fail\` with the error.`);
  } else {
    parts.push(`3. Verify the acceptance criteria, then call \`spec_complete\`.`);
  }

  parts.push("");
  parts.push("**Rules:** One file at a time. Read existing files before editing. No .unwrap() in Rust. Type hints in Python.");

  return parts.join("\n");
}

// ============================================================
// Extension
// ============================================================

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "run_spec",
    label: "Run Spec",
    description: "Load and run a spec file. Parses frontmatter, loads only the declared context files, presents requirements with TDD instructions. The model then implements, tests, and calls spec_complete or spec_fail.",
    parameters: Type.Object({
      spec: Type.String({ description: "Path to the spec .md file" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = await loadConfig(ctx.cwd);
      const state = await loadState(ctx.cwd, config);

      let specContent: string;
      try {
        specContent = await fs.readFile(path.resolve(ctx.cwd, params.spec), "utf8");
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `❌ Failed to read spec file: ${params.spec}\nError: ${err.message}` }],
          details: {},
          isError: true,
        };
      }

      let parsed;
      try {
        parsed = parseFrontmatter(specContent);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `❌ Failed to parse spec frontmatter: ${err.message}` }],
          details: {},
          isError: true,
        };
      }
      
      const { frontmatter: fm, body } = parsed;

      if (state.completed[fm.id]) {
        const c = state.completed[fm.id];
        return {
          content: [{
            type: "text",
            text: [
              `## ⚠️ Spec ${fm.id} (${fm.name}) already completed`,
              `Completed: ${c.timestamp} | Tests: ${c.test_ids.join(", ")} | Attempts: ${c.attempts}`,
              "",
              "To re-run, call `spec_reset` first.",
              "",
              "---",
              "",
              body,
            ].join("\n")
          }],
          details: {},
        };
      }

      const prevAttempts = state.failed?.[fm.id]?.attempts || 0;
      
      state.current = {
        id: fm.id,
        attempts: prevAttempts,
        started: new Date().toISOString(),
      };
      await saveState(ctx.cwd, state, config);

      let resolvedContext = "";
      if (fm.context && fm.context.length > 0) {
        resolvedContext = await resolveContext(ctx.cwd, fm.context);
      }

      const header = [
        `## Spec: ${fm.id} — ${fm.name}` + (fm.phase ? ` (Phase ${fm.phase})` : ""),
        "",
        fm.test_ids && fm.test_ids.length > 0 ? `**Test IDs:** ${fm.test_ids.join(", ")}` : "",
        fm.creates && fm.creates.length > 0 ? `**Creates:** ${fm.creates.join(", ")}` : "",
        fm.tests && fm.tests.length > 0 ? `**Test files:** ${fm.tests.join(", ")}` : "",
        fm.test_cmd ? `**Test command:** \`${fm.test_cmd}\`` : "",
      ].filter(Boolean).join("\n");

      const instructions = buildInstructions(fm, config);

      const resultText = [
        header,
        "",
        "---",
        "",
        resolvedContext ? "## Loaded Context\n\n" + resolvedContext : "",
        resolvedContext ? "\n---" : "",
        "",
        "## Requirements",
        "",
        body,
        "",
        "---",
        "",
        instructions,
      ].filter(Boolean).join("\n");

      ctx.ui.setStatus("spec", `Running: ${fm.id}`);

      return {
        content: [{ type: "text", text: resultText }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "spec_complete",
    label: "Spec Complete",
    description: "Mark the current spec as completed. Call this after all tests pass. Persists state for cross-session tracking.",
    parameters: Type.Object({
      test_ids: Type.Array(Type.String(), { description: "Test IDs that are now passing (or empty for specs without tests)" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = await loadConfig(ctx.cwd);
      const state = await loadState(ctx.cwd, config);

      if (!state.current) {
        return {
          content: [{ type: "text", text: "❌ No spec currently running. Use run_spec first." }],
          details: {},
          isError: true,
        };
      }

      const specId = state.current.id;
      state.completed[specId] = {
        timestamp: new Date().toISOString(),
        test_ids: params.test_ids || [],
        attempts: state.current.attempts + 1,
      };
      if (state.failed && state.failed[specId]) {
        delete state.failed[specId];
      }
      state.current = undefined;
      await saveState(ctx.cwd, state, config);

      const total = Object.keys(state.completed).length;
      
      ctx.ui.notify(`✅ Spec ${specId} completed!`, "info");
      ctx.ui.setStatus("spec", "Idle");

      return {
        content: [{ type: "text", text: `✅ Spec ${specId} completed (${(params.test_ids || []).join(", ")}). Total completed: ${total}.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "spec_fail",
    label: "Spec Fail",
    description: "Mark the current spec as failed after max retries. Records the failure reason for debugging.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the spec failed (error message, test output)" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = await loadConfig(ctx.cwd);
      const state = await loadState(ctx.cwd, config);

      if (!state.current) {
        return {
          content: [{ type: "text", text: "❌ No spec currently running." }],
          details: {},
          isError: true,
        };
      }

      const specId = state.current.id;
      if (!state.failed) state.failed = {};
      state.failed[specId] = {
        timestamp: new Date().toISOString(),
        attempts: state.current.attempts + 1,
        last_reason: params.reason
      };
      state.current = undefined;
      await saveState(ctx.cwd, state, config);

      ctx.ui.notify(`❌ Spec ${specId} failed`, "error");
      ctx.ui.setStatus("spec", "Idle");

      return {
        content: [{ type: "text", text: `❌ Spec ${specId} failed: ${params.reason}\nFix the issue, then run the spec again.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "spec_status",
    label: "Spec Status",
    description: "Show progress across all specs. Lists completed specs with test IDs and timestamps, plus the currently running spec if any.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = await loadConfig(ctx.cwd);
      const state = await loadState(ctx.cwd, config);

      const completed = Object.entries(state.completed);
      const failed = Object.entries(state.failed || {});
      const lines = [
        "## Spec Workflow Progress",
        "",
        `Completed: ${completed.length}`,
        `Failed: ${failed.length}`,
        `Current: ${state.current ? `${state.current.id} (attempt ${state.current.attempts + 1})` : "none"}`,
        "",
      ];

      if (completed.length > 0) {
        lines.push("### Completed Specs");
        for (const [id, info] of completed.sort()) {
          lines.push(
            `✅ ${id} — tests: ${info.test_ids.join(",")} (${info.timestamp.split("T")[0]}, ${info.attempts} attempt${info.attempts > 1 ? "s" : ""})`
          );
        }
        lines.push("");
      }

      if (failed.length > 0) {
        lines.push("### Failed Specs");
        for (const [id, info] of failed.sort()) {
          lines.push(
            `❌ ${id} — ${info.last_reason} (${info.timestamp.split("T")[0]}, ${info.attempts} attempt${info.attempts > 1 ? "s" : ""})`
          );
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "spec_reset",
    label: "Spec Reset",
    description: "Reset a completed spec so it can be re-run. Use when implementation needs to be redone.",
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID to reset" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = await loadConfig(ctx.cwd);
      const state = await loadState(ctx.cwd, config);

      let reset = false;

      if (state.completed[params.id]) {
        delete state.completed[params.id];
        reset = true;
      }

      if (state.failed && state.failed[params.id]) {
        delete state.failed[params.id];
        reset = true;
      }

      if (reset) {
        await saveState(ctx.cwd, state, config);
        
        ctx.ui.notify(`Spec ${params.id} reset`, "info");
        
        return {
          content: [{ type: "text", text: `🔄 Spec ${params.id} reset. Run it again with run_spec.` }],
          details: {},
        };
      }

      return {
        content: [{ type: "text", text: `Spec ${params.id} was not completed or failed. Nothing to reset.` }],
        details: {},
        isError: true,
      };
    },
  });
}
