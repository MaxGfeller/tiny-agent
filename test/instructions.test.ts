import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgentsInstructions, renderAgentsInstructions } from "../src/instructions.ts";

test("AGENTS.md files load from user scope through the closest project scope", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "tiny-agent-instructions-"));
  try {
    const repository = join(sandbox, "repository");
    const nested = join(repository, "src", "feature");
    const userFile = join(sandbox, "user-AGENTS.md");
    await mkdir(join(repository, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(userFile, "user rules", "utf8");
    await writeFile(join(repository, "AGENTS.md"), "root rules", "utf8");
    await writeFile(join(repository, "src", "AGENTS.md"), "source rules", "utf8");
    await writeFile(join(nested, "AGENTS.md"), "feature rules", "utf8");

    const files = await loadAgentsInstructions({ cwd: nested, userPath: userFile });

    assert.deepEqual(files.map((file) => file.content), [
      "user rules",
      "root rules",
      "source rules",
      "feature rules",
    ]);
    assert.match(renderAgentsInstructions(files), /Later, more specific files take precedence/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

