import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIClient } from "../src/llm.ts";

test("OpenAIClient sends Responses API function tools and parses output", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const client = new OpenAIClient({
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Checking" }],
            },
            {
              type: "function_call",
              call_id: "call_1",
              name: "read_file",
              arguments: "{\"path\":\"README.md\"}",
            },
          ],
          usage: { total_tokens: 42 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await client.complete({
    instructions: "Be useful",
    input: [{ role: "user", content: "Inspect this" }],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" },
        async execute() {
          return "unused";
        },
      },
    ],
  });

  assert.equal(requestBody?.model, "test-model");
  assert.equal(requestBody?.store, false);
  assert.equal((requestBody?.tools as Array<{ name: string }>)[0].name, "read_file");
  assert.equal(result.text, "Checking");
  assert.deepEqual(result.toolCalls, [
    { id: "call_1", name: "read_file", arguments: { path: "README.md" } },
  ]);
});

test("OpenAIClient includes API error details", async () => {
  const client = new OpenAIClient({
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }),
  });

  await assert.rejects(
    client.complete({ instructions: "test", input: [{ role: "user", content: "hi" }] }),
    /OpenAI API 400: bad request/,
  );
});

