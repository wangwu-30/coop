#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";

const RUNTIME_FORBIDDEN_PREFIXES = [".agent-coop/", "coop-min/state/"];
const RUNTIME_FORBIDDEN_FILES = new Set(["next-round.json", ".next-round.json"]);

function getTrackedFiles() {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(path.sep).join("/"));
}

function isForbidden(file) {
  if (RUNTIME_FORBIDDEN_FILES.has(file)) return true;
  return RUNTIME_FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function detectRuntimeBoundaryViolations(files) {
  return files.filter(isForbidden);
}

function main() {
  const files = getTrackedFiles();
  const violations = detectRuntimeBoundaryViolations(files);

  if (violations.length > 0) {
    console.error("❌ runtime boundary check failed");
    console.error("The following runtime artifacts are tracked and must be removed from Git:");
    for (const v of violations) console.error(` - ${v}`);
    console.error("\nMove samples to examples/ and keep runtime state under ignored paths.");
    process.exit(1);
  }

  console.log("✅ runtime boundary check passed (no tracked runtime artifacts)");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
