import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "../src/agent.ts";
import type { AgentTool, ModelClient } from "../src/types.ts";

test("AgentSession executes a tool call and continues to a final answer", async () => {
  const requests: Parameters<ModelClient["complete"]>[0][] = [];
  const client: ModelClient = {
    async complete(request) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          output: [
            {
              type: "function_call",
              call_id: "call_1",
              name: "echo",
              arguments: "{\"value\":\"hello\"}",
            },
          ],
          text: "",
          toolCalls: [{ id: "call_1", name: "echo", arguments: { value: "hello" } }],
        };
      }
      return {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done" }],
          },
        ],
        text: "Done",
        toolCalls: [],
      };
    },
  };
  const tool: AgentTool = {
    name: "echo",
    description: "Echo text",
    parameters: { type: "object" },
    async execute(input) {
      return `echo:${input.value}`;
    },
  };

  const session = new AgentSession({ client, tools: [tool], systemPrompt: "test", root: process.cwd() });
  const result = await session.run("Use echo");

  assert.equal(result, "Done");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].input.at(-1), {
    type: "function_call_output",
    call_id: "call_1",
    output: "echo:hello",
  });
});

test("AgentSession returns tool errors to the model", async () => {
  let requestNumber = 0;
  const client: ModelClient = {
    async complete(request) {
      requestNumber += 1;
      if (requestNumber === 1) {
        return {
          output: [{ type: "function_call", call_id: "bad", name: "missing", arguments: "{}" }],
          text: "",
          toolCalls: [{ id: "bad", name: "missing", arguments: {} }],
        };
      }
      assert.match(String((request.input.at(-1) as { output: string }).output), /unknown tool/);
      return { output: [{ type: "message" }], text: "Recovered", toolCalls: [] };
    },
  };

  const session = new AgentSession({ client, tools: [], systemPrompt: "test", root: process.cwd() });
  assert.equal(await session.run("Try it"), "Recovered");
});

