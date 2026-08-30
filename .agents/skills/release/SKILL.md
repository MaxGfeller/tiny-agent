---
name: release
description: Prepare and validate versioned releases. Use when changing a package version, updating a changelog, or checking release readiness.
---

# Release

1. Run `node .agents/skills/release/scripts/check-release.mjs <version>` before editing.
2. Make the package version and changelog entry agree with the requested version.
3. Run `npm test` and the release checker again.
4. Report the version and validation results.

