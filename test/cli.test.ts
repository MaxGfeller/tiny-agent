import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("the CLI completes a real HTTP tool loop end to end", async () => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-key");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests += 1;
    const hasToolOutput = body.input.some((item: { type?: string }) => item.type === "function_call_output");
    const output = hasToolOutput
      ? [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "README.md" }],
          },
        ]
      : [
          {
            type: "function_call",
            call_id: "list_1",
            name: "list_files",
            arguments: "{\"path\":\".\"}",
          },
        ];
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ status: "completed", output }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");

  const workspace = await mkdtemp(join(tmpdir(), "tiny-agent-cli-"));
  await mkdir(join(workspace, ".git"));
  await writeFile(join(workspace, "README.md"), "fixture", "utf8");
  try {
    const script = resolve("src/cli.ts");
    const result = await runProcess(
      process.execPath,
      [script, "--cwd", workspace, "List the files"],
      {
        ...process.env,
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_MODEL: "test-model",
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests, 2);
    assert.match(result.stdout, /→ list_files/);
    assert.match(result.stdout, /← \.git\/\nREADME\.md/);
    assert.match(result.stdout, /README\.md\n$/);
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
    await rm(workspace, { recursive: true, force: true });
  }
});

function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}
