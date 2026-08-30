import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession, createSubagentTool } from "../src/agent.ts";
import { COMPACTION_PROMPT } from "../src/prompts.ts";
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

test("AgentSession compacts complete old batches into a rolling summary", async () => {
  const normalRequests: Parameters<ModelClient["complete"]>[0][] = [];
  const client: ModelClient = {
    async complete(request) {
      if (request.instructions === COMPACTION_PROMPT) {
        assert.match(String((request.input[0] as { content: string }).content), /first task/);
        return { output: [{ type: "message" }], text: "The first task is complete.", toolCalls: [] };
      }
      normalRequests.push(request);
      const answer = normalRequests.length === 1 ? "First answer with enough text to cross the budget" : "Second answer";
      return {
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }],
        text: answer,
        toolCalls: [],
      };
    },
  };
  const session = new AgentSession({
    client,
    tools: [],
    systemPrompt: "test",
    root: process.cwd(),
    compaction: { tokenLimit: 1, keepRecentBatches: 1 },
  });

  await session.run("first task");
  await session.run("second task");

  assert.equal(normalRequests.length, 2);
  assert.deepEqual(normalRequests[1].input, [{ role: "user", content: "second task" }]);
  assert.match(normalRequests[1].instructions, /# Earlier session summary\nThe first task is complete\./);
  assert.equal(session.history.filter((entry) => entry.compacted).length, 2);
});

test("spawn_subagent runs an isolated loop without recursive delegation", async () => {
  const requests: Parameters<ModelClient["complete"]>[0][] = [];
  const client: ModelClient = {
    async complete(request) {
      requests.push(request);
      if (requests.length === 1) {
        return {
          output: [{ type: "function_call", call_id: "read_1", name: "inspect", arguments: "{}" }],
          text: "",
          toolCalls: [{ id: "read_1", name: "inspect", arguments: {} }],
        };
      }
      return { output: [{ type: "message" }], text: "Finding with evidence", toolCalls: [] };
    },
  };
  const inspect: AgentTool = {
    name: "inspect",
    description: "Inspect",
    parameters: { type: "object" },
    async execute() {
      return "evidence";
    },
  };
  const subagent = createSubagentTool({
    client,
    tools: [inspect],
    systemPrompt: "bounded worker",
    root: process.cwd(),
  });

  assert.equal(
    await subagent.execute({ task: "Find the risk" }, { root: process.cwd() }),
    "Finding with evidence",
  );
  assert.deepEqual(requests[0].input, [{ role: "user", content: "Find the risk" }]);
  assert.deepEqual(requests[1].input.at(-1), {
    type: "function_call_output",
    call_id: "read_1",
    output: "evidence",
  });
  assert.equal(requests[0].tools?.some((tool) => tool.name === "spawn_subagent"), false);
});
