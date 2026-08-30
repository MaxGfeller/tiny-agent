import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AgentTool } from "./types.ts";

export type Skill = {
  name: string;
  description: string;
  directory: string;
  path: string;
};

export type SkillRegistry = {
  skills: Map<string, Skill>;
  warnings: string[];
};

export async function discoverSkills(roots: string[]): Promise<SkillRegistry> {
  const skills = new Map<string, Skill>();
  const warnings: string[] = [];

  for (const unresolvedRoot of roots) {
    const root = resolveHome(unresolvedRoot);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) continue;
      warnings.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, "SKILL.md");
      try {
        const source = await readFile(path, "utf8");
        const metadata = parseFrontmatter(source);
        validateSkill(metadata, entry.name);
        skills.set(metadata.name, {
          name: metadata.name,
          description: metadata.description,
          directory: join(root, entry.name),
          path,
        });
      } catch (error) {
        if (!isMissingFileError(error)) {
          warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  return { skills, warnings };
}

export function renderSkillCatalog(registry: SkillRegistry): string {
  if (registry.skills.size === 0) return "";
  const entries = [...registry.skills.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`);
  return [
    "# Available agent skills",
    "Use read_skill when a task matches a skill description. Load the skill before following its procedure.",
    ...entries,
  ].join("\n");
}

export function createSkillTool(registry: SkillRegistry): AgentTool {
  return {
    name: "read_skill",
    description: "Load the full SKILL.md instructions for a validated available skill",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    async execute(input) {
      const name = input.name;
      if (typeof name !== "string" || !name) throw new Error("name must be a non-empty string");
      const skill = registry.skills.get(name);
      if (!skill) throw new Error(`Unknown skill: ${name}`);
      return `Skill directory: ${skill.directory}\n\n${await readFile(skill.path, "utf8")}`;
    },
  };
}

function parseFrontmatter(source: string): { name: string; description: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error("missing YAML frontmatter");
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) throw new Error("unterminated YAML frontmatter");
  const lines = normalized.slice(4, end).split("\n");
  const values = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue === ">" || rawValue === "|") {
      const parts: string[] = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        index += 1;
        parts.push(lines[index].trim());
      }
      values.set(key, rawValue === ">" ? parts.join(" ") : parts.join("\n"));
    } else {
      values.set(key, unquote(rawValue.trim()));
    }
  }

  return { name: values.get("name") ?? "", description: values.get("description") ?? "" };
}

function validateSkill(metadata: { name: string; description: string }, directoryName: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) || metadata.name.length > 64) {
    throw new Error("invalid skill name");
  }
  if (metadata.name !== basename(directoryName)) throw new Error("skill name must match its directory");
  if (!metadata.description || metadata.description.length > 1024) {
    throw new Error("skill description must contain 1-1024 characters");
  }
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function resolveHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) return join(process.env.HOME ?? "~", path.slice(2));
  return resolve(path);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
