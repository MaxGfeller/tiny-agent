export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type JsonSchema = Record<string, unknown>;

export type UserMessage = {
  role: "user";
  content: string;
};

export type FunctionCallOutput = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

// Response output items are intentionally open-ended. Reasoning models can return
// provider-defined items that must be replayed verbatim on the next request.
export type ResponseOutputItem = {
  type: string;
  [key: string]: unknown;
};

export type ConversationItem = UserMessage | FunctionCallOutput | ResponseOutputItem;

export type StoredItem = {
  item: ConversationItem;
  batch?: number;
  compacted?: true;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: JsonObject;
};

export type ToolExecutionContext = {
  root: string;
  signal?: AbortSignal;
};

export type AgentTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (input: JsonObject, context: ToolExecutionContext) => Promise<string>;
};

export type ModelResult = {
  output: ResponseOutputItem[];
  text: string;
  toolCalls: ToolCall[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
};

export type ModelClient = {
  complete: (request: {
    instructions: string;
    input: ConversationItem[];
    tools?: AgentTool[];
    signal?: AbortSignal;
  }) => Promise<ModelResult>;
};
