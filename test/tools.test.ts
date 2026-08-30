import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalTools } from "../src/tools.ts";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tiny-agent-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function tool(name: string) {
  const found = createLocalTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

test("file tools list, read, edit, write, and search", async () => {
  await withWorkspace(async (root) => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "example.ts"), "const answer = 41;\n", "utf8");

    assert.equal(await tool("list_files").execute({ path: "." }, { root }), "src/");
    assert.equal(
      await tool("read_file").execute({ path: "src/example.ts" }, { root }),
      "const answer = 41;\n",
    );
    assert.equal(
      await tool("search_files").execute({ query: "answer", path: "src" }, { root }),
      "src/example.ts:1:const answer = 41;",
    );
    await tool("edit_file").execute(
      { path: "src/example.ts", old_text: "41", new_text: "42" },
      { root },
    );
    await tool("write_file").execute({ path: "notes.txt", content: "done\n" }, { root });

    assert.equal(await readFile(join(root, "src", "example.ts"), "utf8"), "const answer = 42;\n");
    assert.equal(await readFile(join(root, "notes.txt"), "utf8"), "done\n");
  });
});

test("file tools reject traversal and symlink escapes", async () => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "tiny-agent-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret", "utf8");
      await symlink(outside, join(root, "escape"));

      await assert.rejects(
        tool("read_file").execute({ path: "../secret.txt" }, { root }),
        /escapes the working directory/,
      );
      await assert.rejects(
        tool("read_file").execute({ path: "escape/secret.txt" }, { root }),
        /escapes the working directory/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("run executes in the requested workspace directory", async () => {
  await withWorkspace(async (root) => {
    const output = await tool("run").execute({ command: "pwd" }, { root });
    assert.match(output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(output, /Command exited with code 0/);
  });
});
