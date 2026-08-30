import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";

export type InstructionFile = {
  path: string;
  content: string;
};

export async function loadAgentsInstructions(options: {
  cwd: string;
  userPath?: string;
}): Promise<InstructionFile[]> {
  const cwd = await realpath(options.cwd);
  const repositoryRoot = await findRepositoryRoot(cwd);
  const candidates: string[] = [];

  if (options.userPath) candidates.push(resolveHome(options.userPath));
  for (const directory of directoriesFromRoot(repositoryRoot, cwd)) {
    candidates.push(join(directory, "AGENTS.md"));
  }

  const instructions: InstructionFile[] = [];
  for (const path of candidates) {
    if (!(await exists(path))) continue;
    instructions.push({ path, content: await readFile(path, "utf8") });
  }
  return instructions;
}

export function renderAgentsInstructions(files: InstructionFile[]): string {
  if (files.length === 0) return "";
  return [
    "# AGENTS.md instructions",
    "Apply these instructions in order. Later, more specific files take precedence on conflicts.",
    ...files.map((file) => `## ${file.path}\n${file.content.trim()}`),
  ].join("\n\n");
}

export async function findRepositoryRoot(cwd: string): Promise<string> {
  let directory = resolve(cwd);
  const filesystemRoot = parse(directory).root;
  while (true) {
    if (await exists(join(directory, ".git"))) return directory;
    if (directory === filesystemRoot) return resolve(cwd);
    directory = dirname(directory);
  }
}

function directoriesFromRoot(root: string, cwd: string): string[] {
  const suffix = relative(root, cwd);
  if (!suffix) return [root];
  const directories = [root];
  let current = root;
  for (const segment of suffix.split(/[\\/]/)) {
    current = join(current, segment);
    directories.push(current);
  }
  return directories;
}

function resolveHome(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) return join(process.env.HOME ?? "~", path.slice(2));
  return resolve(path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

