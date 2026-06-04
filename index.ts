import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
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
    test_cmd?: string;
    verified?: boolean;
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
  let inMultilineString = false;
  let multilineValue: string[] = [];

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();

    if (inMultilineString) {
      if (line.startsWith("  ") || line.startsWith("\t") || trimmed === "") {
        multilineValue.push(trimmed);
        continue;
      } else {
        fm[currentKey] = multilineValue.join("\n").trim();
        inMultilineString = false;
        multilineValue = [];
      }
    }

    if (!trimmed || trimmed.startsWith("#")) continue;

    // Top-level key: value
    const kvMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (kvMatch && !line.startsWith("  ") && !line.startsWith("\t")) {
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();

      if (!value) {
        // Key with no inline value — next lines are list items
        fm[currentKey] = [];
      } else if (value === "|" || value === ">") {
        inMultilineString = true;
        multilineValue = [];
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

  if (inMultilineString && currentKey) {
    fm[currentKey] = multilineValue.join("\n").trim();
  }

  const arrayKeys = ["context", "test_ids", "creates", "tests"];
  for (const key of arrayKeys) {
    if (fm[key] !== undefined && !Array.isArray(fm[key])) {
      fm[key] = [fm[key]];
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
    const parsed = JSON.parse(raw);
    return { completed: {}, ...parsed };
  } catch {
    return { completed: {} };
  }
}

async function saveState(cwd: string, state: SpecState, config: ProjectConfig): Promise<void> {
  const statePath = path.join(cwd, config.stateFile);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function backupFiles(cwd: string, specId: string, files: string[]) {
  const snapshotDir = path.join(cwd, ".pi", "spec-snapshots", specId);
  await fs.mkdir(snapshotDir, { recursive: true });
  
  const manifest: Record<string, string | null> = {};
  const uniqueFiles = Array.from(new Set(files));
  
  for (let i = 0; i < uniqueFiles.length; i++) {
    const file = uniqueFiles[i];
    const srcPath = path.resolve(cwd, file);
    try {
      const content = await fs.readFile(srcPath, "utf8");
      const backupPath = path.join(snapshotDir, `${i}.txt`);
      await fs.writeFile(backupPath, content, "utf8");
      manifest[file] = `${i}.txt`;
    } catch {
      manifest[file] = null; // Did not exist
    }
  }
  
  await fs.writeFile(path.join(snapshotDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

async function restoreFiles(cwd: string, specId: string) {
  const snapshotDir = path.join(cwd, ".pi", "spec-snapshots", specId);
  const manifestPath = path.join(snapshotDir, "manifest.json");
  
  let manifest: Record<string, string | null>;
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    manifest = JSON.parse(raw);
  } catch {
    return false; // no backup found
  }
  
  for (const [file, backupName] of Object.entries(manifest)) {
    const targetPath = path.resolve(cwd, file);
    if (backupName === null) {
      await fs.rm(targetPath, { force: true }).catch(() => {});
    } else {
      try {
        const backupPath = path.join(snapshotDir, backupName);
        const content = await fs.readFile(backupPath, "utf8");
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content, "utf8");
      } catch (e) {
        // failed to restore
      }
    }
  }
  
  return true;
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
    parts.push(`3. **Run tests:** Call the \`verify_spec\` tool to run \`${fm.test_cmd}\`.`);
    parts.push(`4. If \`verify_spec\` **fails**: fix the code and call it again (max ${config.maxRetries} attempts).`);
    parts.push(`5. If \`verify_spec\` **passes**: call \`spec_complete\` with the passing test IDs.`);
    parts.push(`6. If tests fail after ${config.maxRetries} attempts: call \`spec_fail\` with the error.`);
  } else {
    parts.push(`3. Call \`verify_spec\` to confirm no tests are required, then call \`spec_complete\`.`);
  }

  parts.push("");
  parts.push("**Rules:** One file at a time. Read existing files before editing. No .unwrap() in Rust. Type hints in Python.");

  return parts.join("\n");
}

// ============================================================
// Extension
// ============================================================

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const config = await loadConfig(ctx.cwd);
    const state = await loadState(ctx.cwd, config);
    if (state.current) {
      ctx.ui.setWidget("spec-dashboard", (tui, theme) => ({
        render: () => [
          `🚀 Active Spec: ${theme.fg("accent", state.current!.id)} | Attempt: ${state.current!.attempts + 1}`
        ],
        invalidate: () => {}
      }), { placement: "aboveEditor" });
    }
  });

  pi.registerTool({
    name: "list_specs",
    label: "List Specs",
    description: "Scan the specs directory for markdown files, parse their frontmatter, and return a prioritized list of pending and completed specs sorted by phase.",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = await loadConfig(ctx.cwd);
      const state = await loadState(ctx.cwd, config);
      
      const specsDir = path.resolve(ctx.cwd, config.specsDir);
      let files: string[];
      try {
        files = await fs.readdir(specsDir, { recursive: true });
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `❌ Failed to read specs directory (${config.specsDir}): ${err.message}` }],
          details: {},
          isError: true,
        };
      }

      const mdFiles = files.filter(f => f.endsWith(".md"));
      const specs: Array<{ file: string, fm: SpecFrontmatter }> = [];

      for (const file of mdFiles) {
        try {
          const fullPath = path.join(specsDir, file);
          const stat = await fs.stat(fullPath);
          if (!stat.isFile()) continue;

          const content = await fs.readFile(fullPath, "utf8");
          const { frontmatter } = parseFrontmatter(content);
          if (frontmatter.id) {
            specs.push({ file: path.join(config.specsDir, file), fm: frontmatter });
          }
        } catch (e) {
          // ignore files that fail to parse
        }
      }

      // Sort by phase (ascending), then ID
      specs.sort((a, b) => {
        const phaseA = a.fm.phase ?? 9999;
        const phaseB = b.fm.phase ?? 9999;
        if (phaseA !== phaseB) return phaseA - phaseB;
        return a.fm.id.localeCompare(b.fm.id);
      });

      const pending: string[] = [];
      const completed: string[] = [];

      for (const { file, fm } of specs) {
        const isCompleted = !!state.completed[fm.id];
        const phaseStr = fm.phase !== undefined ? `[Phase ${fm.phase}]` : `[No Phase]`;
        const line = `- **${fm.id}** ${phaseStr} ${fm.name} (File: \`${file}\`)`;
        
        if (isCompleted) {
          completed.push(line);
        } else {
          pending.push(line);
        }
      }

      const lines = ["## Spec Discovery", ""];
      if (pending.length > 0) {
        lines.push("### Pending Specs", ...pending, "");
      } else {
        lines.push("### Pending Specs", "No pending specs found.", "");
      }

      if (completed.length > 0) {
        lines.push("### Completed Specs", ...completed, "");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    }
  });

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

      if (!fm.id) {
        return {
          content: [{ type: "text", text: `❌ Spec must have an 'id' field in the frontmatter.` }],
          details: {},
          isError: true,
        };
      }

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
      
      if (prevAttempts === 0) {
        const filesToBackup = [...(fm.context || []), ...(fm.creates || []), ...(fm.tests || [])];
        await backupFiles(ctx.cwd, fm.id, filesToBackup);
      }

      state.current = {
        id: fm.id,
        attempts: prevAttempts,
        started: new Date().toISOString(),
        test_cmd: fm.test_cmd,
        verified: !fm.test_cmd,
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
      ctx.ui.setWidget("spec-dashboard", (tui, theme) => ({
        render: () => [
          `🚀 Active Spec: ${theme.fg("accent", state.current!.id)} | Attempt: ${state.current!.attempts + 1}`
        ],
        invalidate: () => {}
      }), { placement: "aboveEditor" });

      return {
        content: [{ type: "text", text: resultText }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "verify_spec",
    label: "Verify Spec",
    description: "Run the spec's test_cmd to verify your implementation. You must call this and get a passing result before calling spec_complete.",
    parameters: Type.Object({}),
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

      if (!state.current.test_cmd) {
        state.current.verified = true;
        await saveState(ctx.cwd, state, config);
        return {
          content: [{ type: "text", text: "✅ No test_cmd defined for this spec. You may now call spec_complete." }],
          details: {},
        };
      }

      ctx.ui.setStatus("spec", `Testing: ${state.current.id}`);
      
      const bash = createLocalBashOperations();
      
      // To intercept output live, we can just execute and await, optionally streaming.
      // But for simplicity, we just execute and wait for the result.
      const result = await bash.execute(state.current.test_cmd, { cwd: ctx.cwd }, signal);
      
      ctx.ui.setStatus("spec", `Running: ${state.current.id}`);

      if (result.exitCode === 0) {
        state.current.verified = true;
        await saveState(ctx.cwd, state, config);
        return {
          content: [{ type: "text", text: `✅ Tests passed!\n\nSTDOUT:\n${result.stdout}\n\nYou may now call spec_complete.` }],
          details: {},
        };
      } else {
        return {
          content: [{ type: "text", text: `❌ Tests failed (exit code ${result.exitCode}). Fix the code and try verify_spec again.\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "spec_complete",
    label: "Spec Complete",
    description: "Mark the current spec as completed. Call this after all tests pass. Persists state for cross-session tracking.",
    parameters: Type.Object({
      test_ids: Type.Optional(Type.Array(Type.String(), { description: "Test IDs that are now passing (or empty for specs without tests)" })),
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

      if (!state.current.verified) {
        return {
          content: [{ type: "text", text: `❌ You must call verify_spec successfully before calling spec_complete.\nIf there is no test_cmd, call verify_spec anyway to confirm.` }],
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
      ctx.ui.setWidget("spec-dashboard", undefined);

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
      ctx.ui.setWidget("spec-dashboard", undefined);

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
        for (const [id, info] of completed.sort((a, b) => a[0].localeCompare(b[0]))) {
          lines.push(
            `✅ ${id} — tests: ${(info.test_ids || []).join(",")} (${info.timestamp.split("T")[0]}, ${info.attempts} attempt${info.attempts > 1 ? "s" : ""})`
          );
        }
        lines.push("");
      }

      if (failed.length > 0) {
        lines.push("### Failed Specs");
        for (const [id, info] of failed.sort((a, b) => a[0].localeCompare(b[0]))) {
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
        
        const restored = await restoreFiles(ctx.cwd, params.id);
        const restoreMsg = restored ? " Files were restored to their original state." : "";
        
        ctx.ui.notify(`Spec ${params.id} reset`, "info");
        
        return {
          content: [{ type: "text", text: `🔄 Spec ${params.id} reset.${restoreMsg} Run it again with run_spec.` }],
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
