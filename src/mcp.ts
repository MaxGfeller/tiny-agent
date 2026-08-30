import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AgentTool, JsonObject, JsonSchema } from "./types.ts";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const REQUEST_TIMEOUT_MS = 30_000;

type JsonRpcId = number | string;

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type JsonRpcServerRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
};

export type McpServerConfig =
  | {
      command: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  | {
      url: string;
      headers?: Record<string, string>;
    };

export type McpConfig = {
  mcpServers: Record<string, McpServerConfig>;
};

export type McpBundle = {
  tools: AgentTool[];
  close: () => Promise<void>;
};

interface RpcTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

export async function loadMcpConfig(path: string): Promise<McpConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return { mcpServers: {} };
    throw error;
  }
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (servers === undefined) return { mcpServers: {} };
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error(`${path}: mcpServers must be an object`);
  }
  return { mcpServers: servers as Record<string, McpServerConfig> };
}

export async function connectMcpServers(
  config: McpConfig,
  options: { root: string; configPath: string },
): Promise<McpBundle> {
  const connections: McpConnection[] = [];
  try {
    for (const [name, rawConfig] of Object.entries(config.mcpServers)) {
      validateServerName(name);
      const serverConfig = expandServerConfig(rawConfig);
      const transport = createTransport(name, serverConfig, options);
      const connection = new McpConnection(name, transport);
      await connection.initialize();
      connections.push(connection);
    }
    const tools = (await Promise.all(connections.map((connection) => connection.agentTools()))).flat();
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.name)) throw new Error(`Duplicate MCP tool name after namespacing: ${tool.name}`);
      names.add(tool.name);
    }
    return {
      tools,
      async close() {
        await Promise.allSettled(connections.map((connection) => connection.close()));
      },
    };
  } catch (error) {
    await Promise.allSettled(connections.map((connection) => connection.close()));
    throw error;
  }
}

class McpConnection {
  private readonly name: string;
  private readonly transport: RpcTransport;

  constructor(name: string, transport: RpcTransport) {
    this.name = name;
    this.transport = transport;
  }

  async initialize(): Promise<void> {
    await this.transport.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "tiny-agent", version: "0.1.0" },
    });
    await this.transport.notify("notifications/initialized");
  }

  async agentTools(): Promise<AgentTool[]> {
    const definitions: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.transport.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: McpToolDefinition[];
        nextCursor?: string;
      };
      if (!Array.isArray(result.tools)) throw new Error(`MCP server ${this.name} returned an invalid tools/list result`);
      definitions.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);

    return definitions.map((definition) => ({
      name: namespaceToolName(this.name, definition.name),
      description: definition.description ?? `Call ${definition.name} on MCP server ${this.name}`,
      parameters: definition.inputSchema ?? { type: "object", properties: {} },
      execute: async (input) => normalizeToolResult(
        await this.transport.request("tools/call", { name: definition.name, arguments: input }),
      ),
    }));
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}

class StdioTransport implements RpcTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(name: string, config: Extract<McpServerConfig, { command: string }>, cwd: string) {
    this.child = spawn(config.command, config.args ?? [], {
      cwd,
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.receive(line));
    this.child.stderr.on("data", (chunk) => process.stderr.write(`[mcp:${name}] ${chunk}`));
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      this.failAll(new Error(`MCP server ${name} exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`));
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.killed) return;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: JsonRpcResponse | JsonRpcServerRequest;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.failAll(new Error(`MCP server returned invalid JSON on stdout: ${line.slice(0, 200)}`));
      return;
    }
    if ("method" in message) {
      this.write(serverRequestReply(message));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(rpcError(message.error));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class HttpTransport implements RpcTransport {
  private readonly headers: Record<string, string>;
  private nextId = 1;
  private protocolInitialized = false;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private sessionId?: string;
  private readonly url: string;

  constructor(config: Extract<McpServerConfig, { url: string }>) {
    this.url = config.url;
    this.headers = config.headers ?? {};
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const response = await this.post({ jsonrpc: "2.0", id, method, params: params ?? {} });
    if (method === "initialize") {
      this.sessionId = response.headers.get("mcp-session-id") ?? undefined;
      this.protocolInitialized = true;
    }
    for (const item of response.messages) {
      if ("method" in item && "id" in item) {
        await this.post(serverRequestReply(item as JsonRpcServerRequest));
      }
    }
    const message = response.messages.find((item) => "id" in item && item.id === id) as JsonRpcResponse | undefined;
    if (!message) throw new Error(`MCP HTTP response did not include request id ${id}`);
    if (message.error) throw rpcError(message.error);
    if (method === "initialize" && typeof (message.result as { protocolVersion?: unknown })?.protocolVersion === "string") {
      this.protocolVersion = (message.result as { protocolVersion: string }).protocolVersion;
    }
    return message.result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await fetch(this.url, { method: "DELETE", headers: this.requestHeaders() }).catch(() => undefined);
  }

  private async post(message: unknown): Promise<{
    messages: Array<JsonRpcResponse | Record<string, unknown>>;
    headers: Headers;
  }> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.requestHeaders(),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    if (response.status === 202) return { messages: [], headers: response.headers };
    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const parsed = contentType.includes("text/event-stream")
      ? parseSseMessages(body)
      : parseJsonRpcMessages(body);
    return { messages: parsed, headers: response.headers };
  }

  private requestHeaders(): Record<string, string> {
    return {
      ...this.headers,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(this.sessionId ? { "MCP-Session-Id": this.sessionId } : {}),
      ...(this.protocolInitialized ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
    };
  }
}

function createTransport(
  name: string,
  config: McpServerConfig,
  options: { root: string; configPath: string },
): RpcTransport {
  if ("command" in config) {
    if (typeof config.command !== "string" || !config.command) throw new Error(`MCP server ${name} needs a command`);
    const cwd = config.cwd
      ? resolveInside(options.root, config.cwd)
      : dirname(resolve(options.configPath));
    return new StdioTransport(name, config, cwd);
  }
  if ("url" in config && typeof config.url === "string" && config.url) return new HttpTransport(config);
  throw new Error(`MCP server ${name} must configure command or url`);
}

function expandServerConfig(config: McpServerConfig): McpServerConfig {
  if (typeof config !== "object" || config === null) throw new Error("MCP server config must be an object");
  if ("command" in config) {
    return {
      command: expandEnvironment(config.command),
      args: config.args?.map(expandEnvironment),
      cwd: config.cwd ? expandEnvironment(config.cwd) : undefined,
      env: config.env
        ? Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, expandEnvironment(value)]))
        : undefined,
    };
  }
  return {
    url: expandEnvironment(config.url),
    headers: config.headers
      ? Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, expandEnvironment(value)]))
      : undefined,
  };
}

function expandEnvironment(value: string): string {
  if (typeof value !== "string") throw new Error("MCP configuration strings must be strings");
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const replacement = process.env[name];
    if (replacement === undefined) throw new Error(`MCP configuration references missing environment variable ${name}`);
    return replacement;
  });
}

function normalizeToolResult(result: unknown): string {
  if (typeof result !== "object" || result === null) return JSON.stringify(result);
  const value = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const parts: string[] = [];
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block) {
        parts.push(String(block.text));
      } else {
        parts.push(JSON.stringify(block));
      }
    }
  }
  if (value.structuredContent !== undefined) parts.push(JSON.stringify(value.structuredContent));
  const output = parts.join("\n") || JSON.stringify(result);
  return value.isError ? `MCP tool error: ${output}` : output;
}

function namespaceToolName(server: string, tool: string): string {
  const normalized = `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return normalized.slice(0, 64);
}

function parseJsonRpcMessages(body: string): Array<JsonRpcResponse | Record<string, unknown>> {
  const parsed: unknown = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : [parsed as JsonRpcResponse];
}

function parseSseMessages(body: string): Array<JsonRpcResponse | Record<string, unknown>> {
  const messages: Array<JsonRpcResponse | Record<string, unknown>> = [];
  let data: string[] = [];
  for (const line of `${body}\n`.split(/\r?\n/)) {
    if (line === "") {
      if (data.length > 0) {
        const payload = data.join("\n");
        if (payload) messages.push(...parseJsonRpcMessages(payload));
      }
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  return messages;
}

function rpcError(error: { code: number; message: string; data?: unknown }): Error {
  return new Error(`MCP ${error.code}: ${error.message}${error.data === undefined ? "" : ` (${JSON.stringify(error.data)})`}`);
}

function serverRequestReply(request: JsonRpcServerRequest): JsonRpcResponse {
  return request.method === "ping"
    ? { jsonrpc: "2.0", id: request.id, result: {} }
    : {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `Client method not supported: ${request.method}` },
      };
}

function resolveInside(root: string, path: string): string {
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const suffix = target.slice(resolve(root).length);
  if (target !== resolve(root) && !suffix.startsWith("/") && !suffix.startsWith("\\")) {
    throw new Error(`MCP cwd escapes the working directory: ${target}`);
  }
  return target;
}

function validateServerName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`Invalid MCP server name: ${name}`);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
