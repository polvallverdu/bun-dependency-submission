# Contributing

Thanks for helping! Bug reports, lockfiles the action reads wrong, and fixes for setups that
aren't handled yet are all welcome.

## How the project is laid out

| Path | What it is |
| --- | --- |
| `action.yml` | Action metadata: inputs, outputs, and composite steps that set up Bun if needed and run `src/main.ts`. |
| `src/main.ts` | Entry point. Reads its configuration from env vars, so it runs fine outside GitHub Actions. |
| `src/lockfile.ts` | Parses `bun.lock` (JSON with trailing commas). |
| `src/snapshot.ts` | Builds the snapshot: one manifest per workspace, resolved the way Bun installs. |
| `src/version.ts` | The detector name and version reported to GitHub. |
| `test/*.test.ts` | Unit tests (`bun test`), plus runs of `src/main.ts` against the fixtures. |
| `test/fixtures/` | `single-repo`, `monorepo` (workspaces, one package at two versions) and `legacy-binary` (`bun.lockb` only). |
| `.github/workflows/test.yml` | Unit tests on Linux and macOS, the action end to end against the fixtures, and a real submission of this repo's `bun.lock` on `main`. |
| `skills/` | Agent skill that teaches coding agents how to set the action up. |

## Running the tests

```bash
bun install
bun test
bun run typecheck
```

To add a fixture, create its `package.json` files under `test/fixtures/<name>` and write the
lockfile with `bun install --lockfile-only` in that folder. Commit `bun.lock`, not `node_modules`.

## Making a change

1. Fork the repo and create a branch from `main`.
2. If you're fixing a bug, first add a test that reproduces it and fails. A lockfile excerpt in
   `test/snapshot.test.ts` is usually enough; add a fixture when the shape needs a real lockfile.
3. Make the change in `src/` and/or `action.yml`.
4. If inputs, outputs or behavior changed, update `README.md`, `action.yml` and
   `skills/setup-bun-dependency-submission/SKILL.md`.
5. Open a pull request. CI has to pass before it can be merged, and PRs are squash-merged.

Keep the action a **composite action with no build step and no runtime dependencies**. Users
should be able to read exactly what runs with their token.

## Releasing (maintainers)

Versions follow [semver](https://semver.org). Users pin to the major tag (`@v1`), so anything
that can make a working setup fail, or change what it submits, without a change on their side is
a breaking change: renaming inputs, changing defaults, or new failure conditions that aren't
clearly bugs.

1. Make sure `main` is green.
2. Bump `version` in `src/version.ts` to the new version, in its own PR.
3. On GitHub, go to **Releases → Draft a new release**, create a new tag `vX.Y.Z` on `main`, and
   click **Generate release notes**.
4. Keep **Publish this Action to the GitHub Marketplace** ticked, and publish.
5. The `Release` workflow then moves the major tag (`v1`) to the new release automatically.

Exact version tags (`vX.Y.Z`) can't be moved or deleted (a tag ruleset plus immutable releases),
so `@v1.0.0` always points to the same code. Only the major tag (`v1`) moves.

## Code of conduct

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md).
