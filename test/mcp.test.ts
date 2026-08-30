import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connectMcpServers, loadMcpConfig } from "../src/mcp.ts";

test("stdio MCP tools are discovered, namespaced, and callable", async () => {
  const root = await mkdtemp(join(tmpdir(), "tiny-agent-mcp-stdio-"));
  const fixture = new URL("./fixtures/mcp-server.mjs", import.meta.url).pathname;
  try {
    const bundle = await connectMcpServers(
      {
        mcpServers: {
          fixture: { command: process.execPath, args: [fixture] },
        },
      },
      { root, configPath: join(root, "mcp.json") },
    );
    try {
      assert.deepEqual(bundle.tools.map((tool) => tool.name), ["fixture__echo"]);
      assert.equal(
        await bundle.tools[0].execute({ value: "hello" }, { root }),
        "stdio:hello",
      );
    } finally {
      await bundle.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Streamable HTTP MCP uses sessions and protocol headers", async () => {
  const seenProtocolHeaders: Array<string | undefined> = [];
  let deleted = false;
  const server = createServer(async (request, response) => {
    if (request.method === "DELETE") {
      deleted = true;
      response.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seenProtocolHeaders.push(request.headers["mcp-protocol-version"]);
    if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }

    let result: unknown;
    if (message.method === "initialize") {
      response.setHeader("MCP-Session-Id", "session-1");
      result = {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "http-fixture", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      assert.equal(request.headers["mcp-session-id"], "session-1");
      result = {
        tools: [
          {
            name: "echo.http",
            inputSchema: { type: "object", properties: { value: { type: "string" } } },
          },
        ],
      };
    } else {
      result = { content: [{ type: "text", text: `http:${message.params.arguments.value}` }] };
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");

  const root = await mkdtemp(join(tmpdir(), "tiny-agent-mcp-http-"));
  try {
    const bundle = await connectMcpServers(
      { mcpServers: { remote: { url: `http://127.0.0.1:${address.port}/mcp` } } },
      { root, configPath: join(root, "mcp.json") },
    );
    assert.equal(bundle.tools[0].name, "remote__echo_http");
    assert.equal(await bundle.tools[0].execute({ value: "hello" }, { root }), "http:hello");
    await bundle.close();

    assert.equal(seenProtocolHeaders[0], undefined);
    assert.equal(seenProtocolHeaders[1], "2025-11-25");
    assert.equal(deleted, true);
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP config expands environment references without storing secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "tiny-agent-mcp-config-"));
  const path = join(root, "mcp.json");
  const original = process.env.TINY_AGENT_TEST_TOKEN;
  process.env.TINY_AGENT_TEST_TOKEN = "secret-value";
  try {
    await writeFile(
      path,
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "http://127.0.0.1:1/mcp",
            headers: { Authorization: "Bearer ${TINY_AGENT_TEST_TOKEN}" },
          },
        },
      }),
      "utf8",
    );
    const config = await loadMcpConfig(path);
    assert.equal(config.mcpServers.remote.headers?.Authorization, "Bearer ${TINY_AGENT_TEST_TOKEN}");
  } finally {
    if (original === undefined) delete process.env.TINY_AGENT_TEST_TOKEN;
    else process.env.TINY_AGENT_TEST_TOKEN = original;
    await rm(root, { recursive: true, force: true });
  }
});
