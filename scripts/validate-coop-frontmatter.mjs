#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const REQUIRED_FIELDS = [
  "status",
  "priority",
  "created_by",
  "assignee",
  "created",
  "updated",
  "tags",
  "depends_on",
  "version",
];

async function walkMdFiles(dir) {
  let out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(await walkMdFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function checkTypes(frontmatter) {
  const errs = [];
  if (!Array.isArray(frontmatter.tags)) errs.push("tags must be an array");
  if (!Array.isArray(frontmatter.depends_on)) errs.push("depends_on must be an array");
  if (typeof frontmatter.version !== "number") errs.push("version must be a number");
  return errs;
}

function inferWorkerFromFileName(filePath) {
  const base = path.basename(filePath, ".md");
  const match = base.match(/worker[-_]?([1-9]\d*)/i);
  if (!match) return null;
  return `coop-worker-${match[1]}`;
}

function checkTaskIdAssigneeConsistency(filePath, frontmatter) {
  const expectedAssignee = inferWorkerFromFileName(filePath);
  if (!expectedAssignee) return null;

  const status = typeof frontmatter.status === "string" ? frontmatter.status.trim() : "";
  // Historical done/cancelled tasks may be legitimately reassigned for rebalancing.
  // Enforce strict filename/assignee consistency only for active queue items.
  if (!new Set(["open", "in_progress", "blocked"]).has(status)) return null;

  const actual = typeof frontmatter.assignee === "string" ? frontmatter.assignee.trim() : "";
  if (!actual) return `${path.basename(filePath)}: assignee is empty, expected ${expectedAssignee}`;
  if (actual !== expectedAssignee) {
    return `${path.basename(filePath)}: task-id/filename implies ${expectedAssignee} but assignee=${actual}`;
  }
  return null;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function resolveTasksDir(rootDir = process.cwd(), options = {}) {
  const candidates = [];

  if (options.tasksDir) {
    candidates.push(path.resolve(rootDir, options.tasksDir));
  }

  if (options.coopDir) {
    candidates.push(path.resolve(rootDir, options.coopDir, "cooperation", "tasks"));
  }

  if (process.env.AGENT_COOP_DIR) {
    candidates.push(path.resolve(process.env.AGENT_COOP_DIR, "cooperation", "tasks"));
  }

  candidates.push(path.join(rootDir, "cooperation", "tasks"));
  candidates.push(path.join(rootDir, ".agent-coop", "cooperation", "tasks"));

  const seen = new Set();
  const deduped = candidates.filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });

  for (const candidate of deduped) {
    if (await pathExists(candidate)) {
      return { tasksDir: candidate, checkedCandidates: deduped };
    }
  }

  return { tasksDir: deduped[0], checkedCandidates: deduped };
}

export async function validateCoopFrontmatter(rootDir = process.cwd(), options = {}) {
  const { strictZeroFiles = false } = options;
  const { tasksDir, checkedCandidates } = await resolveTasksDir(rootDir, options);
  const files = await walkMdFiles(tasksDir);
  const errors = [];

  if (strictZeroFiles && (await pathExists(tasksDir)) && files.length === 0) {
    errors.push(
      `No task markdown files found under ${path.relative(rootDir, tasksDir) || tasksDir} while strict-zero-files is enabled`,
    );
  }

  for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const match = raw.match(FRONTMATTER_RE);
    if (!match) {
      errors.push(`${path.relative(rootDir, file)}: missing frontmatter`);
      continue;
    }

    let frontmatter;
    try {
      frontmatter = parseYaml(match[1]) ?? {};
    } catch (err) {
      errors.push(`${path.relative(rootDir, file)}: invalid YAML (${err.message})`);
      continue;
    }

    const missing = REQUIRED_FIELDS.filter((k) => !(k in frontmatter));
    if (missing.length) {
      errors.push(`${path.relative(rootDir, file)}: missing required fields: ${missing.join(", ")}`);
    }

    for (const t of checkTypes(frontmatter)) {
      errors.push(`${path.relative(rootDir, file)}: ${t}`);
    }

    const consistencyError = checkTaskIdAssigneeConsistency(file, frontmatter);
    if (consistencyError) {
      errors.push(`${path.relative(rootDir, file)}: ${consistencyError}`);
    }
  }

  return {
    filesChecked: files.length,
    errors,
    tasksDir,
    checkedCandidates,
  };
}

function parseCliArgs(argv) {
  const options = { strictZeroFiles: false };
  let rootArg;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--strict-zero-files") {
      options.strictZeroFiles = true;
      continue;
    }
    if (arg === "--no-strict-zero-files") {
      options.strictZeroFiles = false;
      continue;
    }

    if (arg === "--coop-dir") {
      options.coopDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--coop-dir=")) {
      options.coopDir = arg.slice("--coop-dir=".length);
      continue;
    }

    if (arg === "--tasks-dir") {
      options.tasksDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith("--tasks-dir=")) {
      options.tasksDir = arg.slice("--tasks-dir=".length);
      continue;
    }

    if (!arg.startsWith("--") && rootArg === undefined) {
      rootArg = arg;
    }
  }

  return { rootArg, options };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { rootArg, options } = parseCliArgs(process.argv.slice(2));
  const rootDir = rootArg ? path.resolve(rootArg) : process.cwd();
  const result = await validateCoopFrontmatter(rootDir, options);

  if (result.errors.length) {
    console.error("❌ coop frontmatter validation failed");
    console.error(`   tasksDir: ${result.tasksDir}`);
    for (const err of result.errors) console.error(` - ${err}`);
    process.exit(1);
  }

  console.log(`✅ coop frontmatter validation passed (${result.filesChecked} file(s) checked)`);
  console.log(`   tasksDir: ${result.tasksDir}`);
}
