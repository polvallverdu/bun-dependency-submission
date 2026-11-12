<div align="center">

# 🥟 Bun Dependency Submission

**Show GitHub what your [`bun.lock`](https://bun.com/docs/install/lockfile) really installs, so Dependabot alerts are right.**

[![Test](https://github.com/polvallverdu/bun-dependency-submission/actions/workflows/test.yml/badge.svg)](https://github.com/polvallverdu/bun-dependency-submission/actions/workflows/test.yml)
[![Marketplace](https://img.shields.io/badge/marketplace-bun--dependency--submission-blue?logo=github)](https://github.com/marketplace/actions/bun-dependency-submission)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

</div>

GitHub's dependency graph doesn't read `bun.lock`. All it sees is the ranges in your
`package.json` files, so Dependabot:

- **can't tell what's installed.** Alerts say *"The currently installed version can't be determined"*.
- **never sees transitive dependencies.** A vulnerable package three levels down never gets an alert.
- **keeps alerts open after you fix them.** A range like `^1.2.0` stays flagged while `1.2.0` is
  vulnerable, even when your lockfile, or a `resolutions` pin, already installs `1.2.9`.

This action reads `bun.lock` and sends GitHub the exact versions Bun installs, through the
[dependency submission API](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/using-the-dependency-submission-api).
Dependabot alerts then follow what's actually installed, transitive dependencies included.

```yaml
- uses: polvallverdu/bun-dependency-submission@v1
```

---

## Contents

- [Quick start](#quick-start)
- [Usage](#usage)
  - [Monorepo with workspaces](#monorepo-with-workspaces)
  - [Lockfile in a subfolder](#lockfile-in-a-subfolder)
  - [Several lockfiles](#several-lockfiles)
  - [Runtime dependencies only](#runtime-dependencies-only)
  - [Check the snapshot without submitting it](#check-the-snapshot-without-submitting-it)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [What gets submitted](#what-gets-submitted)
- [FAQ](#faq)
- [Let your coding agent set it up](#let-your-coding-agent-set-it-up)

## Quick start

```yaml
# .github/workflows/dependency-submission.yml
name: Dependency submission

on:
  push:
    branches: [main]
    paths:
      - bun.lock
      - "**/package.json"
  workflow_dispatch:

permissions:
  contents: write # the dependency submission API needs it

jobs:
  submit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: polvallverdu/bun-dependency-submission@v1
```

That's all: **no `bun install` needed**. The action reads `bun.lock` directly, and installs Bun
itself if the job doesn't already have it. A run takes a few seconds, even for a large monorepo.

Run it on pushes to your default branch: that's the branch Dependabot alerts are based on. The
`paths` filter skips pushes that don't change dependencies; `workflow_dispatch` lets you run it by
hand the first time.

## Usage

### Monorepo with workspaces

Nothing to configure. Each workspace's `package.json` becomes its own manifest in the dependency
graph, with the versions Bun resolves for that workspace:

```text
.
├── bun.lock
├── package.json          → manifest "package.json"
├── apps/web/package.json → manifest "apps/web/package.json"
└── packages/db/package.json → manifest "packages/db/package.json"
```

So an alert points at the workspace that pulls the vulnerable package in. When `apps/web` depends
on `packages/db`, `packages/db`'s dependencies are reported under its own manifest, not repeated
under `apps/web`.

### Lockfile in a subfolder

```yaml
- uses: polvallverdu/bun-dependency-submission@v1
  with:
    working-directory: frontend
```

Manifest paths are still reported from the repository root (`frontend/package.json`), so they
link to the right files.

### Several lockfiles

One step per lockfile. Each gets its own snapshot automatically (the default `correlator`
includes the lockfile path), so they don't replace each other:

```yaml
- uses: polvallverdu/bun-dependency-submission@v1
  with:
    working-directory: app
- uses: polvallverdu/bun-dependency-submission@v1
  with:
    working-directory: docs
```

### Runtime dependencies only

Packages reached only through `devDependencies` are submitted with the `development` scope,
which you can filter on in the dependency graph and in Dependabot alert rules. To leave them out
entirely:

```yaml
- uses: polvallverdu/bun-dependency-submission@v1
  with:
    exclude-dev: true
```

### Check the snapshot without submitting it

```yaml
- id: deps
  uses: polvallverdu/bun-dependency-submission@v1
  with:
    dry-run: true

- run: jq '.manifests | keys' "${{ steps.deps.outputs.snapshot-file }}"
```

A dry run needs no `contents: write`, so it's safe on pull requests, including ones from forks.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `lockfile` | `bun.lock` | Path to the text lockfile, relative to `working-directory`. |
| `working-directory` | `.` | Folder the lockfile is in, relative to the repository root. |
| `token` | `${{ github.token }}` | Token used to submit. Needs `contents: write`. |
| `dry-run` | `false` | Build the snapshot and write it to a file, but don't submit it. |
| `exclude-dev` | `false` | Leave out packages that only `devDependencies` reach. |
| `correlator` | workflow, job and lockfile path | Groups snapshots: a new snapshot replaces the last one with the same correlator. |
| `bun-version` | `latest` | Bun to install when the job doesn't already have Bun on its `PATH`. |

## Outputs

| Output | Description |
| --- | --- |
| `snapshot-id` | The id GitHub gave the snapshot. Empty on a dry run. |
| `snapshot-file` | Path to the snapshot JSON that was built. |
| `manifests` | Number of manifests (workspace `package.json` files) in the snapshot. |
| `packages` | Number of distinct packages (name and version) in the snapshot. |

The job summary shows a table of manifests with their package counts.

## What gets submitted

For each workspace, every package Bun installs for it, with:

- **the exact version**, as a [package URL](https://github.com/package-url/purl-spec) (`pkg:npm/%40scope/name@1.2.3`),
- **direct or indirect**: listed in that `package.json`, or pulled in by another package,
- **runtime or development**: reached through `dependencies` / `optionalDependencies` / `peerDependencies`, or only through `devDependencies`,
- **its own dependencies**, so GitHub can show the path from your `package.json` to a vulnerable package.

Packages are resolved the way Bun installs them: a nested copy (`debug/ms`) before the hoisted
one, so two versions of the same package are both reported, each where it's used.

Left out, because they aren't on the npm registry: workspace packages (each has its own manifest),
and dependencies from git, tarball URLs, `file:` and `link:`. Optional peer dependencies are only
reported where the workspace depends on them itself. npm aliases (`"x": "npm:real@1.0.0"`) are
reported under the real package name.

## FAQ

<details>
<summary><b>Does it modify my repo?</b></summary>

No. It reads `bun.lock` and sends a snapshot to GitHub. Nothing is installed, committed or pushed.
</details>

<details>
<summary><b>What about <code>bun.lockb</code>?</b></summary>

The old binary lockfile isn't supported. Bun 1.2 and later write the text `bun.lock` by default;
run `bun install --save-text-lockfile`, commit `bun.lock` and delete `bun.lockb`. The action
fails with this hint if it only finds `bun.lockb`.
</details>

<details>
<summary><b>Will my existing Dependabot alerts close?</b></summary>

Alerts on the submitted packages follow the submitted versions. GitHub keeps reading the
`package.json` ranges too, though, so an alert raised only because a range's lowest version is
vulnerable may stay open until the range moves past it. Raise the range, or dismiss the alert as
*"fix already applied"* once the snapshot shows the fixed version.
</details>

<details>
<summary><b>Why <code>contents: write</code>?</b></summary>

It's the permission the dependency submission API asks for. The action doesn't write to your
repository's contents. Use `dry-run: true` where you can't grant it.
</details>

<details>
<summary><b>Does it work on macOS and Windows runners?</b></summary>

It's tested on `ubuntu-latest` and `macos-latest`. It runs under Bun on Windows too, but that isn't tested.
</details>

## Let your coding agent set it up

This repo includes an [agent skill](skills/setup-bun-dependency-submission/SKILL.md) that teaches
Claude Code (and other agents that support `SKILL.md`) how to add this action to a repo: it finds
your lockfiles, writes the workflow, and checks the snapshot with a dry run.

```bash
# with the skills CLI
npx skills add polvallverdu/bun-dependency-submission

# or copy it into a project by hand
mkdir -p .claude/skills && cp -R skills/setup-bun-dependency-submission .claude/skills/
```

Then ask: *"submit our bun.lock to GitHub's dependency graph"*.

## Development

```bash
bun install
bun test            # unit tests and dry runs against test/fixtures
bun run typecheck
bun run dry-run     # build a snapshot of this repo's own bun.lock
```

The fixtures in [`test/fixtures`](test/fixtures) are real lockfiles written by
`bun install --lockfile-only`: a single repo, a workspace monorepo with the same package at two
versions, and a repo that still has `bun.lockb`. CI also runs the action end to end, and on
`main` submits this repo's own `bun.lock` for real.

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how the tests work and how
releases are made.

## License

[MIT](LICENSE)
