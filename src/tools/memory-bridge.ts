import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getCoopDir, loadConfig } from "../config.js";

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export async function writeTaskCompletionMemory(input: {
  taskId: string;
  title: string;
  assignee: string | null;
  summary?: string;
  tags: string[];
}): Promise<void> {
  const coopDir = getCoopDir();
  const config = await loadConfig(coopDir);
  if (!config.memoryBridge.enabled) return;

  const now = new Date().toISOString();
  const memoryDir = config.memoryBridge.dir
    ? path.resolve(coopDir, config.memoryBridge.dir)
    : path.join(coopDir, "memory");

  await fs.mkdir(memoryDir, { recursive: true });

  const file = path.join(
    memoryDir,
    `${now.slice(0, 10)}-${slugify(input.title)}-${Date.now()}.md`,
  );

  const content = [
    "---",
    `type: coop_completion`,
    `created: ${now}`,
    `task_id: ${input.taskId}`,
    `assignee: ${input.assignee ?? "unknown"}`,
    `tags: [${input.tags.map((t) => JSON.stringify(t)).join(", ")}]`,
    "---",
    `# ${input.title}`,
    "",
    input.summary?.trim() || "Task completed.",
    "",
  ].join("\n");

  await fs.writeFile(file, content, "utf-8");
}

export async function recommendAgentsFromMemory(input: {
  title: string;
  tags?: string[];
  limit?: number;
}): Promise<string[]> {
  const coopDir = getCoopDir();
  const config = await loadConfig(coopDir);
  const candidates = new Map<string, number>();

  for (const agent of config.agents) {
    candidates.set(agent, 1); // base weight
  }

  if (!config.memoryBridge.enabled) {
    return config.agents.slice(0, input.limit ?? 3);
  }

  const memoryDir = config.memoryBridge.dir
    ? path.resolve(coopDir, config.memoryBridge.dir)
    : path.join(coopDir, "memory");

  let files: string[] = [];
  try {
    files = await fs.readdir(memoryDir);
  } catch {
    return config.agents.slice(0, input.limit ?? 3);
  }

  const tags = (input.tags ?? []).map((t) => t.toLowerCase());
  const title = input.title.toLowerCase();

  for (const f of files.filter((x) => x.endsWith(".md")).slice(-100)) {
    const full = path.join(memoryDir, f);
    try {
      const raw = (await fs.readFile(full, "utf-8")).toLowerCase();
      const score = [title, ...tags].reduce((acc, token) => {
        if (!token) return acc;
        return raw.includes(token) ? acc + 1 : acc;
      }, 0);
      if (score <= 0) continue;

      for (const agent of config.agents) {
        if (raw.includes(`assignee: ${agent.toLowerCase()}`)) {
          candidates.set(agent, (candidates.get(agent) ?? 0) + score * 2);
        }
      }
    } catch {
      // ignore malformed file
    }
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, input.limit ?? 3)
    .map(([agent]) => agent);
}
