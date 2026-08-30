import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { AgentSession, createSubagentTool, type AgentEvent } from "./agent.ts";
import { loadAgentsInstructions, renderAgentsInstructions } from "./instructions.ts";
import { OpenAIClient } from "./llm.ts";
import { connectMcpServers, loadMcpConfig } from "./mcp.ts";
import { BASE_PROMPT, PARENT_DELEGATION_PROMPT, SUBAGENT_PROMPT } from "./prompts.ts";
import { createSkillTool, discoverSkills, renderSkillCatalog } from "./skills.ts";
import { createLocalTools, readOnlyToolNames } from "./tools.ts";

type CliArguments = {
  cwd: string;
  mcpPath?: string;
  model?: string;
  prompt?: string;
};

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const root = await realpath(args.cwd);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const client = new OpenAIClient({
    apiKey,
    model: args.model ?? process.env.OPENAI_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL,
    timeoutMs: readPositiveInteger(process.env.TINY_AGENT_MODEL_TIMEOUT_MS, 120_000),
  });

  const instructionFiles = await loadAgentsInstructions({
    cwd: root,
    userPath: "~/.tiny-agent/AGENTS.md",
  });
  const skills = await discoverSkills(["~/.agents/skills", join(root, ".agents", "skills")]);
  for (const warning of skills.warnings) process.stderr.write(`[skill] ${warning}\n`);

  const mcpPath = resolve(args.mcpPath ?? join(root, "mcp.json"));
  const mcp = await connectMcpServers(await loadMcpConfig(mcpPath), { root, configPath: mcpPath });
  const localTools = createLocalTools();
  const sharedContext = [
    renderAgentsInstructions(instructionFiles),
    `# Working directory\n${root}`,
  ].filter(Boolean).join("\n\n");
  const workerPrompt = [BASE_PROMPT, SUBAGENT_PROMPT, sharedContext].join("\n\n");
  const workerTools = localTools.filter((tool) => readOnlyToolNames.has(tool.name));
  const compaction = {
    tokenLimit: readPositiveInteger(process.env.TINY_AGENT_COMPACT_TOKENS, 60_000),
    keepRecentBatches: readPositiveInteger(process.env.TINY_AGENT_KEEP_BATCHES, 6),
  };
  const parentTools = [...localTools, ...mcp.tools, createSkillTool(skills)];
  parentTools.push(createSubagentTool({
    client,
    tools: workerTools,
    systemPrompt: workerPrompt,
    root,
    maxSteps: readPositiveInteger(process.env.TINY_AGENT_SUBAGENT_STEPS, 15),
    compaction,
  }));

  const systemPrompt = [
    BASE_PROMPT,
    PARENT_DELEGATION_PROMPT,
    sharedContext,
    renderSkillCatalog(skills),
  ].filter(Boolean).join("\n\n");
  const session = new AgentSession({
    client,
    tools: parentTools,
    systemPrompt,
    root,
    maxSteps: readPositiveInteger(process.env.TINY_AGENT_MAX_STEPS, 30),
    compaction,
    onEvent: printEvent,
  });

  try {
    if (args.prompt) {
      process.stdout.write(`${await session.run(args.prompt)}\n`);
      return;
    }
    process.stdout.write(`tiny-agent · ${root}\nType /exit to quit.\n`);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (true) {
        const input = (await terminal.question("> ")).trim();
        if (!input) continue;
        if (input === "/exit" || input === "/quit") break;
        try {
          process.stdout.write(`${await session.run(input)}\n`);
        } catch (error) {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    } finally {
      terminal.close();
    }
  } finally {
    await mcp.close();
  }
}

function printEvent(event: AgentEvent): void {
  if (event.type === "tool_start") {
    process.stdout.write(`→ ${event.call.name} ${JSON.stringify(event.call.arguments)}\n`);
  } else if (event.type === "tool_end") {
    const output = event.output.length > 800 ? `${event.output.slice(0, 800)}…` : event.output;
    process.stdout.write(`← ${output}\n`);
  } else if (event.type === "compaction") {
    process.stdout.write(`↻ compacted ${event.compactedItems} items at ~${event.estimatedTokens} tokens\n`);
  }
}

function parseArguments(argv: string[]): CliArguments {
  let cwd = process.cwd();
  let mcpPath: string | undefined;
  let model: string | undefined;
  const prompt: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cwd") cwd = requireValue(argv, ++index, "--cwd");
    else if (argument === "--mcp") mcpPath = requireValue(argv, ++index, "--mcp");
    else if (argument === "--model") model = requireValue(argv, ++index, "--model");
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: npm start -- [--cwd PATH] [--mcp PATH] [--model MODEL] [PROMPT]\n");
      process.exit(0);
    } else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else prompt.push(argument);
  }
  return { cwd: resolve(cwd), mcpPath, model, prompt: prompt.length ? prompt.join(" ") : undefined };
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((error) => {
  process.stderr.write(`tiny-agent: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
