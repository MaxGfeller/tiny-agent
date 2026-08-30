import type {
  AgentTool,
  JsonObject,
  ModelClient,
  ModelResult,
  ResponseOutputItem,
  ToolCall,
} from "./types.ts";

type OpenAIClientOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type ApiResponse = {
  error?: { message?: string } | null;
  output?: ResponseOutputItem[];
  status?: string;
  usage?: ModelResult["usage"];
};

export class OpenAIClient implements ModelClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAIClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gpt-5.4-mini";
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static fromEnvironment(): OpenAIClient {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required");

    return new OpenAIClient({
      apiKey,
      model: process.env.OPENAI_MODEL,
      baseUrl: process.env.OPENAI_BASE_URL,
      timeoutMs: readPositiveInteger(process.env.TINY_AGENT_MODEL_TIMEOUT_MS, 120_000),
    });
  }

  async complete(request: Parameters<ModelClient["complete"]>[0]): Promise<ModelResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;
    const body = {
      model: this.model,
      instructions: request.instructions,
      input: request.input,
      tools: request.tools?.map(asApiTool) ?? [],
      tool_choice: request.tools?.length ? "auto" : "none",
      parallel_tool_calls: true,
      store: false,
    };

    const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    const text = await response.text();
    const payload = parseApiResponse(text);
    if (!response.ok) {
      throw new Error(`OpenAI API ${response.status}: ${payload.error?.message ?? text}`);
    }
    if (payload.error) throw new Error(`OpenAI API: ${payload.error.message ?? "unknown error"}`);
    if (payload.status && payload.status !== "completed") {
      throw new Error(`OpenAI response ended with status ${payload.status}`);
    }

    const output = payload.output ?? [];
    return {
      output,
      text: extractText(output),
      toolCalls: extractToolCalls(output),
      usage: payload.usage,
    };
  }
}

function asApiTool(tool: AgentTool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

function extractText(output: ResponseOutputItem[]): string {
  const chunks: string[] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "output_text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n");
}

function extractToolCalls(output: ResponseOutputItem[]): ToolCall[] {
  return output
    .filter((item) => item.type === "function_call")
    .map((item) => {
      if (typeof item.call_id !== "string" || typeof item.name !== "string") {
        throw new Error("OpenAI returned an invalid function call");
      }
      return {
        id: item.call_id,
        name: item.name,
        arguments: parseArguments(item.arguments),
      };
    });
}

function parseArguments(value: unknown): JsonObject {
  if (typeof value !== "string") throw new Error("Tool arguments were not a JSON string");
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return parsed as JsonObject;
}

function parseApiResponse(text: string): ApiResponse {
  try {
    return JSON.parse(text) as ApiResponse;
  } catch {
    throw new Error(`OpenAI API returned invalid JSON: ${text.slice(0, 500)}`);
  }
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

