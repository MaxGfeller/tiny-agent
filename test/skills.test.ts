import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSkillTool, discoverSkills, renderSkillCatalog } from "../src/skills.ts";

async function writeSkill(root: string, name: string, description: string, body: string): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

test("skills use metadata in the catalog and disclose full instructions through a tool", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "tiny-agent-skills-"));
  try {
    const userRoot = join(sandbox, "user");
    const projectRoot = join(sandbox, "project");
    await writeSkill(userRoot, "release", "Old user release procedure.", "Old instructions");
    await writeSkill(projectRoot, "release", "Prepare versioned project releases.", "Run the release checks first.");

    const registry = await discoverSkills([userRoot, projectRoot]);
    const catalog = renderSkillCatalog(registry);

    assert.match(catalog, /release: Prepare versioned project releases/);
    assert.doesNotMatch(catalog, /Run the release checks first/);
    const fullSkill = await createSkillTool(registry).execute({ name: "release" }, { root: sandbox });
    assert.match(fullSkill, /Run the release checks first/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("invalid skills are excluded with a warning", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "tiny-agent-skills-invalid-"));
  try {
    await writeSkill(sandbox, "bad-name", "Description", "Body");
    await writeFile(
      join(sandbox, "bad-name", "SKILL.md"),
      "---\nname: Different\ndescription: Broken\n---\n",
      "utf8",
    );

    const registry = await discoverSkills([sandbox]);
    assert.equal(registry.skills.size, 0);
    assert.equal(registry.warnings.length, 1);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
