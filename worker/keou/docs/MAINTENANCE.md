# Maintenance and releases

Create new videos through projects and assets. Do not edit engine code merely to switch topics.

For a verified bug fix:

1. Preserve the last delivered media and the current release record.
2. Make the smallest concrete repair and add a test for the failure when meaningful.
3. Run the unit tests and the relevant real-browser layout checks.
4. Render a real control film when rendering, speech or audio behavior changed. Inspect the actual result.
5. Record changed files, why, validation evidence and limits.
6. Update release.json only after review and update package version and manifest. Never bypass source integrity to hide untested modifications.

A publisher can regenerate package hashes with `python scripts/package-manifest.py --write`; this describes bytes, not software quality. `--verify` checks the existing manifest. Runtime artifacts and user config are excluded.

Before redistributing, use a clean release copy with no user projects, keys, caches, dependencies or run logs. Test extraction into a different directory, including a path containing spaces. Keep third-party notices and font license with the distribution. Existing user projects stay with the user's previous installed copy until the upgrade has been verified.
