import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "notifications/initialized") return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        {
          name: "echo",
          description: "Echo a value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    respond(message.id, { content: [{ type: "text", text: `stdio:${message.params.arguments.value}` }] });
  }
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

