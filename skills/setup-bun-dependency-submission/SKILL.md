---
name: setup-bun-dependency-submission
description: Add a GitHub Actions workflow that submits the dependencies in a repo's bun.lock to GitHub's dependency graph, using polvallverdu/bun-dependency-submission, so Dependabot alerts follow the versions Bun really installs (transitive ones included). Use when a Bun repo's Dependabot alerts say the installed version can't be determined, miss transitive dependencies, or stay open after a lockfile or `resolutions` fix, or when the user wants their bun.lock in the dependency graph.
---

# Set up Bun Dependency Submission

[`polvallverdu/bun-dependency-submission`](https://github.com/polvallverdu/bun-dependency-submission)
reads `bun.lock` and submits the exact versions Bun installs to GitHub's dependency submission
API, one manifest per workspace `package.json`. GitHub doesn't read `bun.lock` itself, so without
it Dependabot only sees `package.json` ranges. It needs no `bun install`: only the repo checked
out, and `contents: write`.

## 1. Inspect the repo

1. **Lockfiles.** Find every Bun lockfile, skipping `node_modules`:
   ```bash
   git ls-files | grep -E '(^|/)bun\.lockb?$'
   ```
   - Only `bun.lockb` (binary): the action can't read it. Tell the user to run
     `bun install --save-text-lockfile`, commit `bun.lock` and delete `bun.lockb` (Bun 1.2+), and
     stop until they have.
   - None: this isn't a Bun repo. Stop and say so.
2. **Default branch.** `git symbolic-ref refs/remotes/origin/HEAD` (or ask). Dependabot alerts are
   based on it, so that's where the workflow submits.
3. **Existing workflows.** Look in `.github/workflows/`. If a workflow already submits
   dependencies (`dependency-graph/snapshots`, `dependency-submission`), replace it rather than add
   a second one: a different correlator would leave both snapshots in the graph.

## 2. Write the workflow

Pin the action to `@v1`. One step per lockfile; set `working-directory` to the lockfile's folder
for any that isn't at the root.

```yaml
# .github/workflows/dependency-submission.yml
name: Dependency submission

on:
  push:
    branches: [main] # the default branch
    paths:
      - "**/bun.lock"
      - "**/package.json"
      - .github/workflows/dependency-submission.yml
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: true

jobs:
  submit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: polvallverdu/bun-dependency-submission@v1
```

Notes:
- Don't add `bun install` or `setup-bun`: the action reads the lockfile directly and installs Bun
  only if the job lacks it.
- Keep `contents: write` on this workflow (or job) only. The action doesn't write to the
  repository, but the submission API requires that permission.
- Don't run it on `pull_request` without `dry-run: true`: fork PRs get a read-only token.
- If the user only wants runtime dependencies in the graph, add `exclude-dev: true`.

## 3. Verify

Do a dry run of the same snapshot locally before finishing. From the action's repository (clone
it, or use `npx degit polvallverdu/bun-dependency-submission /tmp/bds`):

```bash
GITHUB_WORKSPACE="$PWD" DRY_RUN=true bun /tmp/bds/src/main.ts
```

Run it from the repo root, adding `WORKING_DIRECTORY=<folder>` for a lockfile that isn't at the
root. It prints each manifest with its package count and writes the snapshot to
`bun-dependency-snapshot.json` in the temp folder. Check that every workspace you expect is
listed. A workspace with no registry dependencies has no manifest, which is expected.

## 4. Report back

Tell the user:
- which workflow you created or replaced, and which lockfiles it submits,
- that it runs on pushes to the default branch that change dependencies, and they can run it now
  from the Actions tab (`workflow_dispatch`) instead of waiting,
- that transitive dependencies will now appear in the dependency graph, so the Dependabot alert
  count may go up at first,
- that alerts raised only by a `package.json` range's lowest version may stay open until the range
  moves, or until they dismiss them as "fix already applied".

## Inputs reference

| Input | Default | Meaning |
| --- | --- | --- |
| `lockfile` | `bun.lock` | Lockfile path, relative to `working-directory`. |
| `working-directory` | `.` | Folder the lockfile is in, relative to the repo root. |
| `token` | `${{ github.token }}` | Needs `contents: write`. |
| `dry-run` | `false` | Build the snapshot without submitting it. |
| `exclude-dev` | `false` | Leave out packages only `devDependencies` reach. |
| `correlator` | workflow, job and lockfile path | A new snapshot replaces the last one with the same correlator. |
| `bun-version` | `latest` | Bun to install when the job has none. |

Outputs: `snapshot-id` (empty on a dry run), `snapshot-file`, `manifests`, `packages`.
