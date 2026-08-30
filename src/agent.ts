import type {
  AgentTool,
  ConversationItem,
  FunctionCallOutput,
  ModelClient,
  StoredItem,
  ToolCall,
} from "./types.ts";

export type AgentEvent =
  | { type: "model"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; output: string };

export type AgentSessionOptions = {
  client: ModelClient;
  tools: AgentTool[];
  systemPrompt: string;
  root: string;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
};

export class AgentSession {
  readonly history: StoredItem[] = [];
  protected readonly client: ModelClient;
  protected readonly maxSteps: number;
  protected readonly onEvent?: (event: AgentEvent) => void;
  protected readonly root: string;
  protected systemPrompt: string;
  protected tools: AgentTool[];

  constructor(options: AgentSessionOptions) {
    this.client = options.client;
    this.tools = options.tools;
    this.systemPrompt = options.systemPrompt;
    this.root = options.root;
    this.maxSteps = options.maxSteps ?? 30;
    this.onEvent = options.onEvent;
  }

  async run(input: string, signal?: AbortSignal): Promise<string> {
    this.history.push({ item: { role: "user", content: input } });

    for (let step = 0; step < this.maxSteps; step += 1) {
      signal?.throwIfAborted();
      const result = await this.client.complete({
        instructions: this.systemPrompt,
        input: this.activeHistory(),
        tools: this.tools,
        signal,
      });
      this.history.push(...result.output.map((item) => ({ item })));
      this.onEvent?.({ type: "model", text: result.text });

      if (result.toolCalls.length === 0) {
        if (!result.text) throw new Error("The model returned neither text nor tool calls");
        return result.text;
      }

      const outputs = await executeToolCalls(result.toolCalls, this.tools, this.root, signal, this.onEvent);
      this.history.push(...outputs.map((item) => ({ item })));
    }

    throw new Error(`Agent stopped after ${this.maxSteps} model steps`);
  }

  protected activeHistory(): ConversationItem[] {
    return this.history.filter((entry) => !entry.compacted).map((entry) => entry.item);
  }
}

export async function executeToolCalls(
  calls: ToolCall[],
  tools: AgentTool[],
  root: string,
  signal?: AbortSignal,
  onEvent?: (event: AgentEvent) => void,
): Promise<FunctionCallOutput[]> {
  return Promise.all(
    calls.map(async (call) => {
      onEvent?.({ type: "tool_start", call });
      const tool = tools.find((candidate) => candidate.name === call.name);
      let output: string;
      if (!tool) {
        output = `Error: unknown tool ${call.name}`;
      } else {
        try {
          output = await tool.execute(call.arguments, { root, signal });
        } catch (error) {
          output = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      onEvent?.({ type: "tool_end", call, output });
      return { type: "function_call_output", call_id: call.id, output };
    }),
  );
}
