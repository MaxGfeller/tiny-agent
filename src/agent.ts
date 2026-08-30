import type {
  AgentTool,
  ConversationItem,
  FunctionCallOutput,
  ModelClient,
  StoredItem,
  ToolCall,
} from "./types.ts";
import { COMPACTION_PROMPT } from "./prompts.ts";

export type AgentEvent =
  | { type: "model"; text: string }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; output: string }
  | { type: "compaction"; compactedItems: number; estimatedTokens: number };

export type CompactionOptions = {
  tokenLimit: number;
  keepRecentBatches?: number;
};

export type AgentSessionOptions = {
  client: ModelClient;
  tools: AgentTool[];
  systemPrompt: string;
  root: string;
  maxSteps?: number;
  compaction?: CompactionOptions;
  onEvent?: (event: AgentEvent) => void;
};

export class AgentSession {
  readonly history: StoredItem[] = [];
  protected readonly client: ModelClient;
  protected readonly compaction?: CompactionOptions;
  protected readonly maxSteps: number;
  protected readonly onEvent?: (event: AgentEvent) => void;
  protected readonly root: string;
  protected systemPrompt: string;
  protected summary = "";
  protected tools: AgentTool[];
  private nextBatch = 1;

  constructor(options: AgentSessionOptions) {
    this.client = options.client;
    this.compaction = options.compaction;
    this.tools = options.tools;
    this.systemPrompt = options.systemPrompt;
    this.root = options.root;
    this.maxSteps = options.maxSteps ?? 30;
    this.onEvent = options.onEvent;
  }

  async run(input: string, signal?: AbortSignal): Promise<string> {
    let batch = this.nextBatch;
    this.nextBatch += 1;
    this.history.push({ item: { role: "user", content: input }, batch });

    for (let step = 0; step < this.maxSteps; step += 1) {
      signal?.throwIfAborted();
      await this.compactIfNeeded(signal);
      const result = await this.client.complete({
        instructions: this.currentSystemPrompt(),
        input: this.activeHistory(),
        tools: this.tools,
        signal,
      });
      this.history.push(...result.output.map((item) => ({ item, batch })));
      this.onEvent?.({ type: "model", text: result.text });

      if (result.toolCalls.length === 0) {
        if (!result.text) throw new Error("The model returned neither text nor tool calls");
        return result.text;
      }

      const outputs = await executeToolCalls(result.toolCalls, this.tools, this.root, signal, this.onEvent);
      this.history.push(...outputs.map((item) => ({ item, batch })));
      batch = this.nextBatch;
      this.nextBatch += 1;
    }

    throw new Error(`Agent stopped after ${this.maxSteps} model steps`);
  }

  protected activeHistory(): ConversationItem[] {
    return this.history.filter((entry) => !entry.compacted).map((entry) => entry.item);
  }

  private currentSystemPrompt(): string {
    return this.summary
      ? `${this.systemPrompt}\n\n# Earlier session summary\n${this.summary}`
      : this.systemPrompt;
  }

  private async compactIfNeeded(signal?: AbortSignal): Promise<void> {
    if (!this.compaction) return;
    const activeEntries = this.history.filter((entry) => !entry.compacted);
    const estimatedTokens = estimateTokens({
      instructions: this.currentSystemPrompt(),
      tools: this.tools,
      input: activeEntries.map((entry) => entry.item),
    });
    if (estimatedTokens < this.compaction.tokenLimit) return;

    const batches = [...new Set(activeEntries.map((entry) => entry.batch ?? 0))];
    const keep = Math.max(1, this.compaction.keepRecentBatches ?? 6);
    if (batches.length <= keep) return;
    const oldBatches = new Set(batches.slice(0, -keep));
    const old = activeEntries.filter((entry) => oldBatches.has(entry.batch ?? 0));
    if (old.length === 0) return;

    const result = await this.client.complete({
      instructions: COMPACTION_PROMPT,
      input: [
        {
          role: "user",
          content: `Previous summary:\n${this.summary || "(none)"}\n\nMessages to compact:\n${JSON.stringify(old.map((entry) => entry.item), null, 2)}`,
        },
      ],
      signal,
    });
    if (!result.text) throw new Error("Compaction returned no summary text");
    this.summary = result.text;
    for (const entry of old) entry.compacted = true;
    this.onEvent?.({ type: "compaction", compactedItems: old.length, estimatedTokens });
  }
}

export function createSubagentTool(options: {
  client: ModelClient;
  tools: AgentTool[];
  systemPrompt: string;
  root: string;
  maxSteps?: number;
  compaction?: CompactionOptions;
}): AgentTool {
  const workerTools = [...options.tools];
  return {
    name: "spawn_subagent",
    description: "Delegate one bounded, independent, context-heavy investigation to a fresh agent context",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "One precise assignment with the context needed to complete it" },
      },
      required: ["task"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const task = input.task;
      if (typeof task !== "string" || !task) throw new Error("task must be a non-empty string");
      const worker = new AgentSession({
        client: options.client,
        tools: workerTools,
        systemPrompt: options.systemPrompt,
        root: options.root,
        maxSteps: options.maxSteps ?? 15,
        compaction: options.compaction,
      });
      return worker.run(task, context.signal);
    },
  };
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
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
