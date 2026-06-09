import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
    commit_sha?: string;
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
  rules?: string[];         // custom TDD rules
  testTimeout?: number;     // timeout in ms for test_cmd
  tokenLimits?: {           // thresholds for token weight warnings
    medium: number;         // default 250
    heavy: number;          // default 750
  };
  interactiveContext?: boolean; // Show UI prompts for large files (default true)
  largeFileThreshold?: number;  // Lines threshold for interactive prompts (default 1000)
  protectedPaths?: string[];    // Paths requiring unlock for markdown edits
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_CONFIG: ProjectConfig = {
  maxRetries: 3,
  specsDir: "specs/",
  stateFile: ".pi/spec-state.json",
  rules: [
    "Complete one file at a time.",
    "Read existing files before editing to understand context."
  ],
  testTimeout: 60000,
  tokenLimits: {
    medium: 250,
    heavy: 750
  },
  interactiveContext: true,
  largeFileThreshold: 1000,
  protectedPaths: ["specs/", "docs/"]
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

  function parseInlineArray(inner: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuote: string | null = null;
    for (let i = 0; i < inner.length; i++) {
      const char = inner[i];
      if ((char === '"' || char === "'") && (i === 0 || inner[i - 1] !== '\\')) {
        if (inQuote === char) inQuote = null;
        else if (!inQuote) inQuote = char;
        current += char;
      } else if (char === ',' && !inQuote) {
        result.push(current.trim().replace(/^["']|["']$/g, ""));
        current = "";
      } else {
        current += char;
      }
    }
    if (current.trim()) {
      result.push(current.trim().replace(/^["']|["']$/g, ""));
    }
    return result;
  }

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
      } else if (/^[|>][+-]?\d*$/.test(value)) {
        inMultilineString = true;
        multilineValue = [];
      } else if (value.startsWith("[") && value.endsWith("]")) {
        // Inline array: [a, b, c]
        const inner = value.slice(1, -1).trim();
        fm[currentKey] = inner ? parseInlineArray(inner) : [];
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
      let val: any = listMatch[1].trim();
      if ((val.startsWith("{") && val.endsWith("}")) || (val.startsWith("'") && val.endsWith("'"))) {
        let cleanVal = val.replace(/^'|'$/g, "");
        if (cleanVal.startsWith("{") && cleanVal.endsWith("}")) {
          try { val = JSON.parse(cleanVal); } catch (e) { val = listMatch[1].trim().replace(/^["']|["']$/g, ""); }
        } else {
          val = listMatch[1].trim().replace(/^["']|["']$/g, "");
        }
      } else {
        val = val.replace(/^["']|["']$/g, "");
      }
      fm[currentKey].push(val);
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

async function appendAuditLog(cwd: string, filename: string, text: string) {
  try {
    const piDir = path.resolve(cwd, ".pi");
    await fs.mkdir(piDir, { recursive: true });
    await fs.appendFile(path.resolve(piDir, filename), text + "\n---\n");
  } catch (e) {}
}

async function logContextAudit(cwd: string, text: string) {
  await appendAuditLog(cwd, "context-audit.log", text);
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

async function resolveContext(ctx: ExtensionContext, config: ProjectConfig, specId: string, files: any[]): Promise<string> {
  const sections: string[] = [];
  const threshold = config.largeFileThreshold || 1000;

  for (const item of files) {
    const filePath = typeof item === "string" ? item : item.file;
    const customInstruction = typeof item === "object" ? item.prompt || item.strategy : null;

    if (!filePath) continue;

    const result = await loadFile(ctx.cwd, filePath);
    if (!result.found) {
      sections.push(result.content);
      continue;
    }

    const ext = filePath.split(".").pop()?.toLowerCase() || "text";
    const lines = result.content.split("\n");
    let finalContent = result.content;

    if (lines.length > threshold) {
      let category = "generic";
      if (["ts", "js", "py", "go", "java", "c", "cpp", "rs", "php", "rb", "jsx", "tsx"].includes(ext)) category = "code";
      else if (["json", "yaml", "yml", "xml", "csv", "toml", "ini", "lock"].includes(ext)) category = "config";
      else if (["md", "mdx", "txt"].includes(ext)) category = "markdown";

      let strategy = "";
      let instructionText = customInstruction;

      if (customInstruction) {
        strategy = "custom";
      } else if (config.interactiveContext !== false && ctx.hasUI) {
        let options: {label: string, value: string}[] = [];
        if (category === "markdown") {
          options = [
            { label: "Extract Table of Contents (Recommended)", value: "toc" },
            { label: "Custom Prompt", value: "custom" },
            { label: "Do Not Load (Agent Must Read)", value: "ignore" },
            { label: "Load Full File", value: "full" }
          ];
        } else if (category === "code") {
          options = [
            { label: "Load Top & Bottom (Recommended)", value: "top_bottom" },
            { label: "Custom Prompt", value: "custom" },
            { label: "Do Not Load (Agent Must Read)", value: "ignore" },
            { label: "Load Full File", value: "full" }
          ];
        } else if (category === "config") {
          options = [
            { label: "Do Not Load (Recommended)", value: "ignore" },
            { label: "Custom Prompt", value: "custom" },
            { label: "Load Full File", value: "full" }
          ];
        } else {
          options = [
            { label: "Truncate to Last 2,000 Lines (Recommended)", value: "truncate" },
            { label: "Custom Prompt", value: "custom" },
            { label: "Do Not Load (Agent Must Read)", value: "ignore" },
            { label: "Load Full File", value: "full" }
          ];
        }

        const promptDesc = `File ${filePath} is very large (${lines.length} lines).\nHow should the agent handle it?\n\nOptions:\n${options.map((o, i) => `${i+1}. ${o.label}`).join("\n")}`;
        
        const choice = await ctx.ui.select(
          `Large Context File: ${filePath}`,
          options.map(o => o.value),
          { description: promptDesc } as any
        );

        strategy = choice || options[0].value;
        if (strategy === "custom") {
          instructionText = await ctx.ui.input("Custom Prompt for File", "e.g., Focus only on the verifyToken function");
        }
      } else {
        // Auto fallback
        strategy = category === "markdown" ? "toc" : category === "code" ? "top_bottom" : category === "config" ? "ignore" : "truncate";
      }

      // Apply Strategy
      if (strategy === "toc") {
        const toc = lines.filter(l => l.trim().startsWith("#")).join("\n");
        finalContent = `[File too large. Showing Outline only. Use 'read' tool to read specific sections.]\n\n${toc}`;
      } else if (strategy === "top_bottom") {
        const top = lines.slice(0, 250).join("\n");
        const bottom = lines.slice(-750).join("\n");
        finalContent = `${top}\n\n[...TRUNCATED ${lines.length - 1000} MIDDLE LINES. USE 'read' TOOL IF NEEDED...]\n\n${bottom}`;
      } else if (strategy === "ignore") {
        finalContent = `[File size too large to inject directly. Use your 'read' or 'bash grep' tools to inspect this file.]`;
      } else if (strategy === "truncate") {
        finalContent = `[...TRUNCATED FIRST PORTION...]\n${lines.slice(-2000).join("\n")}`;
      } else if (strategy === "custom") {
        finalContent = `[File Not Loaded Directly. Developer Instructions: ${instructionText || "Read manually"}]`;
      }

      await logContextAudit(ctx.cwd, `[${new Date().toISOString()}] [run_spec] SPEC: ${specId}\nFILE: ${filePath}\nTYPE: ${category}\nSIZE: ${lines.length} lines (Threshold: ${threshold})\nACTION: ${strategy}\nRESULT: ${strategy === "custom" ? instructionText : "Applied " + strategy}`);
    }

    sections.push(`### File: \`${filePath}\`\n\`\`\`${ext}\n${finalContent}\n\`\`\``);
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
    parts.push(`5. If \`verify_spec\` **passes**: call \`git_commit\` to commit your changes (include spec ID in message), then call \`spec_complete\` with the passing test IDs.`);
    parts.push(`6. If tests fail after ${config.maxRetries} attempts: call \`spec_fail\` with the error.`);
  } else {
    parts.push(`3. Call \`verify_spec\` to confirm no tests are required, then call \`git_commit\`, and finally call \`spec_complete\`.`);
  }

  const rules = [...(config.rules && config.rules.length > 0 
    ? config.rules 
    : ["Complete one file at a time.", "Read existing files before editing."])];

  const protectedList = (config.protectedPaths || ["specs/", "docs/"]).join(", ");
  rules.push(`You MUST use 'request_file_unlock' before editing .md files in: ${protectedList}.`);

  parts.push("");
  parts.push("**Rules:** " + rules.join(" "));

  return parts.join("\n");
}

// ============================================================
// Extension
// ============================================================

type LocalBash = ReturnType<typeof createLocalBashOperations>;

async function executeGitWithAudit(
  ctx: ExtensionContext, bash: LocalBash, specId: string, cmd: string, 
  promptTitle: string, promptMsg: string, signal: AbortSignal | undefined
): Promise<string | null> {
  let isGit = false;
  try {
    const res = await bash.exec("git rev-parse --is-inside-work-tree", ctx.cwd, { onData: () => {}, signal });
    isGit = res.exitCode === 0;
  } catch (e) { return null; }
  
  if (!isGit) return null;

  // Ask for confirmation or edit
  const actionStr = await ctx.ui.select(promptTitle, [
    "approve",
    "edit",
    "reject"
  ], { description: promptMsg + `\n\nCommand: ${cmd}` } as any);

  if (!actionStr || actionStr === "reject") {
    let auditLog = `[${new Date().toISOString()}] SPEC: ${specId}\nCMD: ${cmd}\nSTATUS: REJECTED\n---\n`;
    try {
      const piDir = path.resolve(ctx.cwd, ".pi");
      await fs.mkdir(piDir, { recursive: true });
      await fs.appendFile(path.resolve(piDir, "git-audit.log"), auditLog);
    } catch (e) {}
    return null;
  }

  let finalCmd = cmd;
  if (actionStr === "edit") {
    const editedCmd = await ctx.ui.input("Edit Git Command", finalCmd);
    if (!editedCmd) {
      let auditLog = `[${new Date().toISOString()}] SPEC: ${specId}\nCMD: ${cmd}\nSTATUS: REJECTED (Empty Edit)\n---\n`;
      try {
        const piDir = path.resolve(ctx.cwd, ".pi");
        await fs.appendFile(path.resolve(piDir, "git-audit.log"), auditLog);
      } catch (e) {}
      return null;
    }
    finalCmd = editedCmd;
  }

  let auditLog = `[${new Date().toISOString()}] SPEC: ${specId}\nCMD: ${finalCmd}\nSTATUS: APPROVED${actionStr === "edit" ? " (EDITED)" : ""}\n`;
  let output = "";

  try {
    await bash.exec(finalCmd, ctx.cwd, {
      onData: (d: any) => { output += d.toString(); },
      signal
    });
    auditLog += `OUTPUT:\n${output}\n`;
    ctx.ui.notify(`Git action successful`, "info");
  } catch (e: any) {
    auditLog += `ERROR: ${e.message}\n`;
    ctx.ui.notify(`Git action failed`, "error");
  }

  try {
    const piDir = path.resolve(ctx.cwd, ".pi");
    await fs.mkdir(piDir, { recursive: true });
    await fs.appendFile(path.resolve(piDir, "git-audit.log"), auditLog + "---\n");
  } catch (e) {}

  return output;
}

// Helper to log non-interactive, read-only or background git operations to the audit log
async function logGitAction(ctx: ExtensionContext, specId: string, cmd: string, output: string, error?: string) {
  try {
    let auditLog = `[${new Date().toISOString()}] SPEC: ${specId}\nCMD: ${cmd}\nSTATUS: BACKGROUND_TASK\nOUTPUT:\n${output}\n`;
    if (error) auditLog += `ERROR: ${error}\n`;
    
    const piDir = path.resolve(ctx.cwd, ".pi");
    await fs.mkdir(piDir, { recursive: true });
    await fs.appendFile(path.resolve(piDir, "git-audit.log"), auditLog + "---\n");
  } catch (e) {}
}

export default function (pi: ExtensionAPI) {
  const unlockedFiles = new Set<string>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "bash") return undefined;

    const config = await loadConfig(ctx.cwd);
    const protectedPaths = config.protectedPaths || ["specs/", "docs/"];

    if (event.toolName === "edit" || event.toolName === "write") {
      const input = event.input as any;
      if (!input.path) return undefined;
      const filePath = input.path as string;
      
      const isProtected = protectedPaths.some(p => filePath.startsWith(p));
      const isMarkdown = filePath.toLowerCase().endsWith(".md") || filePath.toLowerCase().endsWith(".mdx");

      if (isProtected && isMarkdown && !unlockedFiles.has(filePath)) {
        return { block: true, reason: "❌ Blocked. You MUST use 'request_file_unlock' first to modify protected documentation." };
      }
    } else if (event.toolName === "bash") {
      const input = event.input as any;
      if (!input.command) return undefined;
      const cmd = input.command as string;
      
      const targetsProtectedMd = protectedPaths.some(p => cmd.includes(p)) && (cmd.includes(".md") || cmd.includes(".mdx"));
      if (targetsProtectedMd) {
        const isModifying = /\b(rm|mv|cp|sed|echo|cat|tee|>|>>)\b/.test(cmd);
        if (isModifying) {
          return { block: true, reason: "❌ Blocked. You MUST use 'request_file_unlock' and then 'edit' or 'write' to modify protected documentation. Bash modifications are blocked." };
        }
      }
    }
    return undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    const config = await loadConfig(ctx.cwd);
    const state = await loadState(ctx.cwd, config);
    if (state.current) {
      ctx.ui.setWidget("spec-dashboard", (tui, theme) => ({
        render: () => {
          if (!state.current) return ["🚀 Spec Workflow: Idle"];
          return [`🚀 Active Spec: ${theme.fg("accent", state.current.id)} | Attempt: ${state.current.attempts + 1}`];
        },
        invalidate: () => {}
      }), { placement: "aboveEditor" });
    }
  });

  pi.registerCommand("commit", {
    description: "Commit the current git changes",
    handler: async (args, ctx) => {
      const bash = createLocalBashOperations();
      const config = await loadConfig(ctx.cwd);
      const state = await loadState(ctx.cwd, config);
      const specId = state.current?.id;

      let statusOut = "";
      try {
        await bash.exec("git status --porcelain", ctx.cwd, { onData: (d) => statusOut += d.toString() });
      } catch (e) {}

      if (!statusOut.trim()) {
        ctx.ui.notify("No changes to commit", "info");
        return;
      }

      ctx.ui.setEditorText(`Generate a semantic commit message for the current git diff. ${specId ? `The scope MUST be ${specId} (e.g. feat(${specId}): ...)` : "Do not include a scope."}\nCall the git_commit tool with the message.`);
      ctx.ui.notify("Draft prompt placed in editor. Press Enter to generate commit.", "info");
    }
  });

  pi.registerCommand("patch", {
    description: "Save current changes to a patch file",
    handler: async (args, ctx) => {
      const bash = createLocalBashOperations();
      let statusOut = "";
      try {
        await bash.exec("git status --porcelain", ctx.cwd, { onData: (d) => statusOut += d.toString() });
      } catch (e) {}

      if (!statusOut.trim()) {
        ctx.ui.notify("No changes to patch", "info");
        return;
      }

      ctx.ui.setEditorText(`Look at the current git diff and call the git_patch tool to stash my work. Generate a descriptive filename.`);
      ctx.ui.notify("Draft prompt placed in editor. Press Enter to generate patch.", "info");
    }
  });

  pi.registerTool({
    name: "request_file_unlock",
    label: "Request File Unlock",
    description: "Use this tool to provide a justification and request permission to edit files in protected directories (e.g., specs, docs). You must wait for user approval before calling `edit` or `write`.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the markdown file to unlock" }),
      justification: Type.String({ description: "Why do you need to edit this file?" })
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) {
        return { content: [{ type: "text", text: "❌ Blocked: Protected files cannot be edited in non-interactive mode." }], details: {}, isError: true };
      }

      const choice = await ctx.ui.select(
        `🛑 Agent wants to unlock protected file: ${params.file}\nAI Justification: ${params.justification}`,
        ["Approve", "Edit Justification", "Reject"]
      );

      const folder = params.file.split('/')[0] || "root";
      const logFilename = `${folder}-audit.log`;

      if (choice === "Reject" || !choice) {
        await appendAuditLog(ctx.cwd, logFilename, `[${new Date().toISOString()}] [request_file_unlock]\nFILE: ${params.file}\nAI JUSTIFICATION: "${params.justification}"\nUSER ACTION: Rejected`);
        return { content: [{ type: "text", text: "❌ Request Rejected by User. Do not attempt to edit this file." }], details: {}, isError: true };
      }

      let finalJustification = params.justification;
      let actionStr = "Approved";
      if (choice === "Edit Justification") {
        const edited = await ctx.ui.input("Edit Justification", params.justification);
        if (edited) {
          finalJustification = edited;
          actionStr = "Approved (Edited Justification)";
        }
      }

      unlockedFiles.add(params.file);

      const logContent = `[${new Date().toISOString()}] [request_file_unlock]\nFILE: ${params.file}\nAI JUSTIFICATION: "${params.justification}"\nUSER ACTION: ${actionStr}\nFINAL JUSTIFICATION: "${finalJustification}"`;
      await appendAuditLog(ctx.cwd, logFilename, logContent);

      return {
        content: [{ type: "text", text: `✅ File unlocked. You may now proceed with your 'edit' or 'write' tool call.` }],
        details: {}
      };
    }
  });

  pi.registerTool({
    name: "create_spec",
    label: "Create Spec",
    description: "Scaffold a new spec file. Distills requirements into concise acceptance criteria to minimize token usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Unique Spec ID (e.g. 'auth-01')" }),
      name: Type.String({ description: "Short human-readable name" }),
      requirements: Type.String({ description: "The concise requirements or acceptance criteria (Markdown body). Do not include large code blocks; reference them in context files instead." }),
      phase: Type.Optional(Type.Number({ description: "Execution phase (lower runs first)" })),
      context: Type.Optional(Type.Array(Type.String(), { description: "Existing files to load as context" })),
      test_ids: Type.Optional(Type.Array(Type.String(), { description: "Test IDs to implement" })),
      test_cmd: Type.Optional(Type.String({ description: "Command to verify the spec" })),
      creates: Type.Optional(Type.Array(Type.String(), { description: "Files this spec is expected to create" })),
      tests: Type.Optional(Type.Array(Type.String(), { description: "Test files to modify/create" }))
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = await loadConfig(ctx.cwd);
      const specsDir = path.resolve(ctx.cwd, config.specsDir);
      
      await fs.mkdir(specsDir, { recursive: true });
      
      const filePath = path.join(specsDir, `${params.id}.md`);
      
      const fm: string[] = ["---"];
      fm.push(`id: ${params.id}`);
      fm.push(`name: "${params.name.replace(/"/g, '\\"')}"`);
      if (params.phase !== undefined) fm.push(`phase: ${params.phase}`);
      
      const formatArray = (key: string, arr?: string[]) => {
        if (arr && arr.length > 0) {
          fm.push(`${key}:`);
          arr.forEach(item => fm.push(`  - "${item.replace(/"/g, '\\"')}"`));
        }
      };
      
      formatArray("context", params.context);
      formatArray("test_ids", params.test_ids);
      
      if (params.test_cmd) {
        if (params.test_cmd.includes("\n")) {
          fm.push(`test_cmd: |-`);
          params.test_cmd.split("\n").forEach(line => fm.push(`  ${line}`));
        } else {
          fm.push(`test_cmd: "${params.test_cmd.replace(/"/g, '\\"')}"`);
        }
      }
      
      formatArray("creates", params.creates);
      formatArray("tests", params.tests);
      fm.push("---");
      fm.push("");
      fm.push(params.requirements);
      fm.push("");
      
      const content = fm.join("\n");
      await fs.writeFile(filePath, content, "utf8");
      
      let contextWarning = "";
      if (params.context && params.context.length > 0) {
        const threshold = config.largeFileThreshold || 1000;
        const largeFiles = [];
        for (const file of params.context) {
          try {
            const fileContent = await fs.readFile(path.resolve(ctx.cwd, typeof file === "string" ? file : (file as any).file), "utf8");
            const lines = fileContent.split("\n").length;
            if (lines > threshold) largeFiles.push({ file: typeof file === "string" ? file : (file as any).file, lines });
          } catch(e) {}
        }
        
        if (largeFiles.length > 0) {
          contextWarning = `\n\n⚠️ **Context Warning:** The following files exceed the size threshold (${threshold} lines):\n`;
          for (const lf of largeFiles) {
            contextWarning += `- \`${lf.file}\` (${lf.lines} lines)\n`;
            await logContextAudit(ctx.cwd, `[${new Date().toISOString()}] [create_spec] SPEC: ${params.id}\nFILE: ${lf.file}\nSIZE: ${lf.lines} lines (Threshold: ${threshold})\nACTION: Warned user`);
          }
          contextWarning += `\n**How to solve this:**\n1. **Pre-configure now:** Open \`${path.relative(ctx.cwd, filePath)}\` and change the file string to an inline JSON object (e.g., \`- '{"file": "...", "prompt": "..."}'\`).\n2. **Resolve later:** Do nothing now. When you execute \`run_spec\`, the CLI will pause and offer you interactive options based on the file type (if interactiveContext is enabled).\n\n*(This warning has been recorded in \`.pi/context-audit.log\`)*`;
        }
      }

      const tokens = Math.ceil(params.requirements.length / 4);
      let weightStr = "";
      const limitMedium = config.tokenLimits?.medium || 250;
      const limitHeavy = config.tokenLimits?.heavy || 750;
      
      if (tokens < limitMedium) weightStr = `🟢 Light (~${tokens} tokens)`;
      else if (tokens <= limitHeavy) weightStr = `🟡 Medium (~${tokens} tokens)`;
      else weightStr = `🔴 Heavy (~${tokens} tokens). Consider moving code blocks to context files!`;
      
      return {
        content: [{ type: "text", text: `✅ Spec created at \`${path.relative(ctx.cwd, filePath)}\`\n\n**Token Weight:** ${weightStr}${contextWarning}` }],
        details: {},
      };
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
      const specs: Array<{ file: string, fm: SpecFrontmatter, weight: string }> = [];
      const invalidSpecs: Array<{ file: string, error: string }> = [];

      for (const file of mdFiles) {
        try {
          const fullPath = path.join(specsDir, file);
          const stat = await fs.stat(fullPath);
          if (!stat.isFile()) continue;

          const content = await fs.readFile(fullPath, "utf8");
          const { frontmatter, body } = parseFrontmatter(content);
          if (frontmatter.id) {
            const tokens = Math.ceil(body.length / 4);
            let weightStr = "";
            const limitMedium = config.tokenLimits?.medium || 250;
            const limitHeavy = config.tokenLimits?.heavy || 750;
            
            if (tokens < limitMedium) weightStr = `🟢 ~${tokens}t`;
            else if (tokens <= limitHeavy) weightStr = `🟡 ~${tokens}t`;
            else weightStr = `🔴 ~${tokens}t`;
            specs.push({ file: path.join(config.specsDir, file), fm: frontmatter, weight: weightStr });
          } else {
            invalidSpecs.push({ file: path.join(config.specsDir, file), error: "Missing 'id' field in frontmatter" });
          }
        } catch (e: any) {
          invalidSpecs.push({ file: path.join(config.specsDir, file), error: e.message });
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

      for (const { file, fm, weight } of specs) {
        const isCompleted = !!state.completed[fm.id];
        const phaseStr = fm.phase !== undefined ? `[Phase ${fm.phase}]` : `[No Phase]`;
        const line = `- **${fm.id}** ${phaseStr} ${fm.name} (${weight}) (File: \`${file}\`)`;
        
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

      if (invalidSpecs.length > 0) {
        lines.push("### ⚠️ Invalid Specs", "These files failed to parse and are ignored:", "");
        for (const inv of invalidSpecs) {
          lines.push(`- \`${inv.file}\`: ${inv.error}`);
        }
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    }
  });

  pi.registerTool({
    name: "git_commit",
    label: "Git Commit",
    description: "Commit the current git changes. Use this after verifying your spec implementation to checkpoint your work.",
    parameters: Type.Object({
      message: Type.String({ description: "Semantic commit message describing the changes. MUST include active Spec ID if applicable (e.g. 'feat(api-01): add auth')" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = await loadConfig(ctx.cwd);
      const state = await loadState(ctx.cwd, config);
      const specId = state.current?.id || "manual-commit";
      const bash = createLocalBashOperations();
      
      let statusOut = "";
      try {
        await bash.exec("git status --porcelain", ctx.cwd, { onData: (d) => statusOut += d.toString(), signal });
      } catch (e) {}

      if (!statusOut.trim()) {
        return { content: [{ type: "text", text: "No changes to commit." }], details: {} };
      }

      const cmd = `git add . && git commit -m ${JSON.stringify(params.message)}`;
      const output = await executeGitWithAudit(
        ctx, bash, specId, cmd,
        "Git Commit", `Agent proposes commit:\nMessage: ${params.message}`, signal
      );

      let outputToReturn = "";
      if (output !== null) {
        outputToReturn = output.length > 2000 
          ? "[...TRUNCATED...]\n" + output.slice(-2000) 
          : output;
        return { content: [{ type: "text", text: `Changes committed successfully.\n${outputToReturn}` }], details: {} };
      } else {
        return { content: [{ type: "text", text: "Commit rejected by user." }], details: {}, isError: true };
      }
    }
  });

  pi.registerTool({
    name: "git_patch",
    label: "Git Patch",
    description: "Save current changes to a patch file. Use this to stash progress or save an experimental attempt.",
    parameters: Type.Object({
      filename: Type.String({ description: "Short descriptive filename for the patch (without .patch extension). Include Spec ID if applicable." }),
      reset_after: Type.Boolean({ description: "Whether to hard reset the workspace after saving the patch" })
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const config = await loadConfig(ctx.cwd);
      const state = await loadState(ctx.cwd, config);
      const specId = state.current?.id || "manual-patch";
      const bash = createLocalBashOperations();
      
      const filename = `${params.filename}.patch`;
      const patchPath = path.join(".pi", "patches", filename);
      
      let statusOut = "";
      try {
        await bash.exec("git status --porcelain", ctx.cwd, { onData: (d) => statusOut += d.toString(), signal });
      } catch (e) {}

      if (!statusOut.trim()) {
        return { content: [{ type: "text", text: "No changes to patch." }], details: {} };
      }

      const cmd = params.reset_after 
        ? `git add . && git diff --staged > ${patchPath} && git reset --hard && git clean -fd`
        : `git add . && git diff --staged > ${patchPath} && git reset`;

      const output = await executeGitWithAudit(
        ctx, bash, specId, cmd,
        "Git Patch", `Agent proposes creating patch: ${patchPath}\nReset after: ${params.reset_after ? "Yes" : "No"}`, signal
      );

      let outputToReturn = "";
      if (output !== null) {
        outputToReturn = output.length > 2000 
          ? "[...TRUNCATED...]\n" + output.slice(-2000) 
          : output;
        return { content: [{ type: "text", text: `Patch saved to ${patchPath}\n\n${outputToReturn}` }], details: {} };
      } else {
        return { content: [{ type: "text", text: "Patch creation rejected by user." }], details: {}, isError: true };
      }
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
        resolvedContext = await resolveContext(ctx, config, fm.id, fm.context);
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
        render: () => {
          if (!state.current) return ["🚀 Spec Workflow: Idle"];
          return [`🚀 Active Spec: ${theme.fg("accent", state.current.id)} | Attempt: ${state.current.attempts + 1}`];
        },
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
      let output = "";
      
      let exitCode: number | null = null;
      try {
        const result = await bash.exec(state.current.test_cmd, ctx.cwd, {
          onData: (data) => { output += data.toString(); },
          signal,
          timeout: config.testTimeout || 60000
        });
        exitCode = result.exitCode;
      } catch (e: any) {
        output += `\nError executing command: ${e.message}`;
      }
      
      ctx.ui.setStatus("spec", `Running: ${state.current.id}`);

      if (exitCode === 0) {
        state.current.verified = true;
        await saveState(ctx.cwd, state, config);
        
        const lines = output.split("\n");
        const truncatedSuccess = lines.length > 15 
          ? "[...TRUNCATED...]\n" + lines.slice(-15).join("\n") 
          : output;

        return {
          content: [{ type: "text", text: `✅ Tests passed!\n\nOUTPUT (Last 15 lines):\n${truncatedSuccess}\n\nYou may now call spec_complete.` }],
          details: {},
        };
      } else {
        const errorLogPath = path.join(".pi", "last-test-failure.log");
        try {
          await fs.mkdir(path.resolve(ctx.cwd, ".pi"), { recursive: true });
          await fs.writeFile(path.resolve(ctx.cwd, errorLogPath), output, "utf8");
        } catch (e) {
          // ignore write errors
        }

        const lines = output.split("\n");
        const truncatedOutput = lines.length > 50 
          ? "[...TRUNCATED...]\n" + lines.slice(-50).join("\n") 
          : output;

        return {
          content: [{ 
            type: "text", 
            text: `❌ Tests failed (exit code ${exitCode}).\n\n` +
                  `The full test output has been saved to \`${errorLogPath}\`.\n` +
                  `If the snippet below isn't enough, use your tools (like \`read\` or \`bash grep\`) to inspect the log file.\n\n` +
                  `OUTPUT (Last 50 lines):\n${truncatedOutput}\n\n` +
                  `Fix the code and try verify_spec again.` 
          }],
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
      architecture_decisions: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { 
        maxItems: 3, 
        description: "Max 3 bullet points. Max 200 chars each. Explain only high-level architectural choices." 
      }))
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

      const bash = createLocalBashOperations();
      
      let isDirty = false;
      try {
        let statusOut = "";
        const sRes = await bash.exec("git status --porcelain", ctx.cwd, {
          onData: (d) => { statusOut += d.toString(); }, signal
        });
        isDirty = sRes.exitCode === 0 && statusOut.trim().length > 0;
      } catch (e) {}

      let commitSha: string | undefined;
      if (isDirty) {
        const cmd = `git add . && git commit -m "spec: complete ${specId}"`;
        await executeGitWithAudit(
          ctx, bash, specId, cmd, 
          "Git Commit", `Spec ${specId} has uncommitted changes.\nCommit the code?`, signal
        );
      }

      let commitShaVal: string | undefined;
      try {
        let shaOut = "";
        await bash.exec("git rev-parse HEAD", ctx.cwd, { onData: (d) => shaOut += d.toString(), signal });
        commitShaVal = shaOut.trim();
      } catch(e) {}

      state.completed[specId] = {
        timestamp: new Date().toISOString(),
        test_ids: params.test_ids || [],
        attempts: state.current.attempts + 1,
        commit_sha: commitShaVal
      };
      if (state.failed && state.failed[specId]) {
        delete state.failed[specId];
      }
      state.current = undefined;
      await saveState(ctx.cwd, state, config);

      if (params.architecture_decisions && params.architecture_decisions.length > 0) {
        const decisions = params.architecture_decisions.map(d => `- ${d}`).join("\n");
        const logContent = `[${new Date().toISOString()}] [spec_complete] SPEC: ${specId}\nARCHITECTURAL DECISIONS:\n${decisions}`;
        await appendAuditLog(ctx.cwd, "code-audit.log", logContent);
      }

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

      // ============================================================
      // Git Feature: Create patch file before reset
      // ============================================================
      const bash = createLocalBashOperations();
      
      let isDirty = false;
      try {
        let statusOut = "";
        const sRes = await bash.exec("git status --porcelain", ctx.cwd, {
          onData: (d) => { statusOut += d.toString(); }, signal
        });
        isDirty = sRes.exitCode === 0 && statusOut.trim().length > 0;
      } catch (e) {}

      let patchFile = "";
      if (isDirty) {
        let patchData = "";
        let errorData = "";
        try {
          const piPatchesDir = path.resolve(ctx.cwd, ".pi", "patches");
          await fs.mkdir(piPatchesDir, { recursive: true });
          
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          patchFile = path.join(".pi", "patches", `${specId}-failed-${timestamp}.patch`);
          
          // Stage everything (to capture untracked files)
          await bash.exec("git add .", ctx.cwd, { onData: () => {}, signal });
          
          // Generate patch
          await bash.exec("git diff --staged", ctx.cwd, {
            onData: (d) => { patchData += d.toString(); }, signal
          });
          
          // Unstage to leave workspace exactly as we found it
          await bash.exec("git reset", ctx.cwd, { onData: () => {}, signal });
          
          if (patchData.trim()) {
            await fs.writeFile(path.resolve(ctx.cwd, patchFile), patchData);
            await logGitAction(ctx, specId, `git diff --staged > ${patchFile}`, patchData);
          } else {
            patchFile = ""; // Diff was empty
          }
        } catch (e: any) {
          errorData = e.message;
          patchFile = ""; // Gracefully fail if patch generation errors
          await logGitAction(ctx, specId, `Generate Patch`, patchData, errorData);
        }
      }

      const cmd = "git reset --hard && git clean -fd";
      const patchMsg = patchFile ? `\n\nA patch of the failed changes was saved to:\n${patchFile}` : "";
      
      await executeGitWithAudit(
        ctx, bash, specId, cmd,
        "Git Reset", `Spec ${specId} failed. Discard uncommitted AI changes?${patchMsg}`, signal
      );
      // ============================================================

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
      const completedInfo = state.completed[params.id];

      const bash = createLocalBashOperations();
      if (completedInfo?.commit_sha) {
        let isHead = false;
        try {
          let headSha = "";
          await bash.exec("git rev-parse HEAD", ctx.cwd, { onData: (d) => headSha += d.toString(), signal });
          isHead = headSha.trim() === completedInfo.commit_sha;
        } catch(e) {}

        const cmd = isHead 
          ? "git reset --hard HEAD~1 && git clean -fd" 
          : `git revert ${completedInfo.commit_sha} --no-edit`;
        
        const actionStr = isHead ? "Hard Reset (removes commit)" : "Revert (creates undo commit)";
        
        await executeGitWithAudit(
          ctx, bash, params.id, cmd,
          "Git Rollback", `Resetting spec ${params.id}.\nDo you want to ${actionStr}?`, signal
        );
      }

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
