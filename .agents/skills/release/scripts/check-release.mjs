import { readFile } from "node:fs/promises";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  process.stderr.write("Usage: node check-release.mjs <semver>\n");
  process.exitCode = 2;
} else {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const changelog = await readFile("CHANGELOG.md", "utf8");
  const problems = [];
  if (packageJson.version !== version) problems.push(`package.json has version ${packageJson.version}`);
  if (!changelog.includes(`## ${version}`)) problems.push(`CHANGELOG.md has no ${version} heading`);
  if (packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0) problems.push("runtime dependencies are not allowed");

  if (problems.length > 0) {
    process.stderr.write(`${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Release ${version} is consistent.\n`);
  }
}
