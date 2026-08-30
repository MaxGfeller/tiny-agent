import { spawn } from "node:child_process";
import {
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentTool, JsonObject } from "./types.ts";

const PATH_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};

const IGNORED_DIRECTORIES = new Set([".git", "dist", "node_modules"]);

export function createLocalTools(): AgentTool[] {
  return [listFilesTool, readFileTool, searchFilesTool, writeFileTool, editFileTool, runTool];
}

export const readOnlyToolNames = new Set(["list_files", "read_file", "search_files"]);

const listFilesTool: AgentTool = {
  name: "list_files",
  description: "List files and directories at a path inside the working directory",
  parameters: PATH_SCHEMA,
  async execute(input, context) {
    const path = await resolveForRead(context.root, requiredString(input, "path"));
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .join("\n");
  },
};

const readFileTool: AgentTool = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the working directory",
  parameters: PATH_SCHEMA,
  async execute(input, context) {
    const path = await resolveForRead(context.root, requiredString(input, "path"));
    return readFile(path, "utf8");
  },
};

const searchFilesTool: AgentTool = {
  name: "search_files",
  description: "Search text files recursively inside the working directory",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      path: { type: "string", description: "Directory to search; defaults to ." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const query = requiredString(input, "query");
    const root = await realpath(context.root);
    const start = await resolveForRead(context.root, optionalString(input, "path") ?? ".");
    const matches: string[] = [];
    await searchDirectory(start, root, query, matches, context.signal);
    return matches.length ? matches.join("\n") : "No matches";
  },
};

const writeFileTool: AgentTool = {
  name: "write_file",
  description: "Create or overwrite a UTF-8 file inside the working directory; its parent must exist",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const path = await resolveForWrite(context.root, requiredString(input, "path"));
    const root = await realpath(context.root);
    const content = requiredString(input, "content", true);
    await writeFile(path, content, "utf8");
    return `Wrote ${Buffer.byteLength(content)} bytes to ${relative(root, path)}`;
  },
};

const editFileTool: AgentTool = {
  name: "edit_file",
  description: "Replace one exact text occurrence in a UTF-8 file inside the working directory",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" },
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const path = await resolveForRead(context.root, requiredString(input, "path"));
    const root = await realpath(context.root);
    const oldText = requiredString(input, "old_text");
    const newText = requiredString(input, "new_text", true);
    const content = await readFile(path, "utf8");
    const first = content.indexOf(oldText);
    if (first < 0) throw new Error("old_text was not found");
    if (content.indexOf(oldText, first + oldText.length) >= 0) {
      throw new Error("old_text is not unique; include more surrounding text");
    }
    await writeFile(path, `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`, "utf8");
    return `Edited ${relative(root, path)}`;
  },
};

const runTool: AgentTool = {
  name: "run",
  description: "Run a shell command from a directory inside the working directory",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string", description: "Working directory; defaults to ." },
      timeout_ms: { type: "number", description: "Timeout up to 120000 milliseconds" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async execute(input, context) {
    const command = requiredString(input, "command");
    const cwd = await resolveForRead(context.root, optionalString(input, "cwd") ?? ".");
    if (!(await stat(cwd)).isDirectory()) throw new Error("cwd is not a directory");
    const requestedTimeout = optionalNumber(input, "timeout_ms") ?? 120_000;
    const timeoutMs = Math.max(1, Math.min(120_000, requestedTimeout));
    return runCommand(command, cwd, timeoutMs, context.signal);
  },
};

async function searchDirectory(
  directory: string,
  root: string,
  query: string,
  matches: string[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (matches.length >= 100) return;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (matches.length >= 100) return;
    if (IGNORED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await searchDirectory(path, root, query, matches, signal);
      continue;
    }
    if (!entry.isFile() || (await stat(path)).size > 1_000_000) continue;
    const content = await readFile(path);
    if (content.includes(0)) continue;
    const lines = content.toString("utf8").split("\n");
    for (let index = 0; index < lines.length && matches.length < 100; index += 1) {
      if (lines[index].includes(query)) {
        matches.push(`${relative(root, path)}:${index + 1}:${lines[index]}`);
      }
    }
  }
}

async function resolveForRead(root: string, input: string): Promise<string> {
  const rootReal = await realpath(root);
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  assertInside(resolve(root), candidate);
  const targetReal = await realpath(candidate);
  assertInside(rootReal, targetReal);
  return targetReal;
}

async function resolveForWrite(root: string, input: string): Promise<string> {
  const rootReal = await realpath(root);
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  assertInside(resolve(root), candidate);
  const parentReal = await realpath(dirname(candidate));
  assertInside(rootReal, parentReal);
  const target = join(parentReal, basename(candidate));
  try {
    const targetReal = await realpath(candidate);
    assertInside(rootReal, targetReal);
    return targetReal;
  } catch (error) {
    if (isMissingFileError(error)) return target;
    throw error;
  }
}

function assertInside(root: string, target: string): void {
  const path = relative(root, target);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error(`Path escapes the working directory: ${target}`);
}

function requiredString(input: JsonObject, key: string, allowEmpty = false): string {
  const value = input[key];
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${key} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function optionalString(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function optionalNumber(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length < 100_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.once("close", (code, terminationSignal) => {
      clearTimeout(timer);
      const status = timedOut
        ? `Command timed out after ${timeoutMs}ms`
        : `Command exited with code ${code ?? "null"}${terminationSignal ? ` (${terminationSignal})` : ""}`;
      resolvePromise(`${output.slice(0, 100_000)}${output.length >= 100_000 ? "\n[output truncated]" : ""}\n${status}`.trim());
    });
  });
}
