# tiny-agent

tiny-agent is a dependency-free TypeScript coding agent built to accompany the “Build your own Claude Code” talk. It uses the OpenAI Responses API directly and keeps the implementation small enough to read on stage.

It includes a persistent conversation and tool loop, contained filesystem tools, shell execution, rolling context compaction, isolated subagents, scoped `AGENTS.md` instructions, stdio and Streamable HTTP MCP clients, and progressively disclosed Agent Skills.

## Run

Requires Node.js 22.18 or newer and an OpenAI API key. There is nothing to install.

```bash
export OPENAI_API_KEY="..."
npm start
```

Run one prompt and exit:

```bash
npm start -- "Inspect this repository and explain how you work."
```

The default model is `gpt-5.4-mini`. Override it with `OPENAI_MODEL` or `--model`.

## Customize

- Project instructions load from `AGENTS.md` files between the Git root and the working directory; user instructions load from `~/.tiny-agent/AGENTS.md`.
- Skills load from `~/.agents/skills` and `.agents/skills`. Only metadata enters the base prompt; `read_skill` loads the full instructions on demand.
- Copy `mcp.example.json` to `mcp.json` to enable MCP servers. Remote tools are namespaced as `server__tool`.
- `TINY_AGENT_COMPACT_TOKENS`, `TINY_AGENT_KEEP_BATCHES`, `TINY_AGENT_MAX_STEPS`, and `TINY_AGENT_SUBAGENT_STEPS` tune the loop limits.

## Test

```bash
npm test
```

