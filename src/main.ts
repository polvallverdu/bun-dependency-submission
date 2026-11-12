/**
 * The action's entry point. Configured through environment variables (set by
 * `action.yml`), so it also runs outside GitHub Actions:
 *
 *   DRY_RUN=true bun src/main.ts
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import { parseLockfile } from "./lockfile.ts";
import { buildSnapshot } from "./snapshot.ts";
import { DETECTOR } from "./version.ts";

const env = process.env;
const truthy = (value: string | undefined) => /^(1|true|yes)$/i.test(value?.trim() ?? "");

function fail(message: string): never {
  console.log(`::error title=Bun dependency submission::${message.replaceAll("\n", "%0A")}`);
  process.exit(1);
}

function setOutput(name: string, value: string) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const workspaceRoot = resolve(env.GITHUB_WORKSPACE ?? process.cwd());
const workingDirectory = resolve(workspaceRoot, env.WORKING_DIRECTORY || ".");
const lockfilePath = resolve(workingDirectory, env.LOCKFILE || "bun.lock");
const lockfileName = relative(workspaceRoot, lockfilePath).split(sep).join("/");

if (lockfilePath.endsWith(".lockb") || !existsSync(lockfilePath)) {
  const binary = lockfilePath.replace(/\.lock$/, ".lockb");
  if (existsSync(binary) || lockfilePath.endsWith(".lockb")) {
    fail(
      `${lockfileName} is Bun's old binary lockfile, which this action can't read. ` +
        "Switch to the text lockfile (Bun 1.2+ writes it by default) with " +
        "`bun install --save-text-lockfile`, commit bun.lock and delete bun.lockb.",
    );
  }
  fail(`No lockfile at ${lockfileName}. Set \`lockfile\` or \`working-directory\`.`);
}

let lock;
try {
  lock = parseLockfile(readFileSync(lockfilePath, "utf8"));
} catch (error) {
  fail(`Couldn't read ${lockfileName}: ${(error as Error).message}`);
}

const lockfileDir = relative(workspaceRoot, workingDirectory).split(sep).join("/");
const snapshot = buildSnapshot(lock, {
  sha: env.GITHUB_SHA ?? "0".repeat(40),
  ref: env.GITHUB_REF ?? "refs/heads/main",
  // GitHub replaces a snapshot when a later one has the same correlator, so
  // each lockfile gets its own unless the user names one.
  correlator:
    env.CORRELATOR?.trim() ||
    `${env.GITHUB_WORKFLOW ?? "local"} ${env.GITHUB_JOB ?? "submit"} ${lockfileName}`,
  jobId: env.GITHUB_RUN_ID ?? "local",
  jobUrl:
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined,
  scanned: new Date().toISOString(),
  detector: DETECTOR,
  lockfileDir: lockfileDir === "" ? undefined : lockfileDir,
  excludeDev: truthy(env.EXCLUDE_DEV),
});

const manifests = Object.values(snapshot.manifests);
const packages = new Set(manifests.flatMap((manifest) => Object.keys(manifest.resolved)));
if (manifests.length === 0) {
  fail(`${lockfileName} has no registry dependencies to submit.`);
}

const snapshotFile = join(env.RUNNER_TEMP ?? tmpdir(), "bun-dependency-snapshot.json");
writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));
setOutput("snapshot-file", snapshotFile);
setOutput("manifests", String(manifests.length));
setOutput("packages", String(packages.size));

const rows = manifests.map((manifest) => {
  const nodes = Object.values(manifest.resolved);
  const direct = nodes.filter((node) => node.relationship === "direct").length;
  console.log(`${manifest.name}: ${nodes.length} packages (${direct} direct)`);
  return `| \`${manifest.name}\` | ${nodes.length} | ${direct} |`;
});

const dryRun = truthy(env.DRY_RUN);
let result = "dry run: nothing was submitted";

if (!dryRun) {
  const token = env.TOKEN || env.GITHUB_TOKEN;
  if (!token || !env.GITHUB_REPOSITORY) {
    fail("A token and GITHUB_REPOSITORY are needed to submit. Set `dry-run: true` to only build the snapshot.");
  }
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/dependency-graph/snapshots`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": `${DETECTOR.name}/${DETECTOR.version}`,
    },
    body: JSON.stringify(snapshot),
  });
  const body = await response.text();
  if (!response.ok) {
    const hint =
      response.status === 403 || response.status === 401
        ? " The token needs `contents: write`: add `permissions: contents: write` to the job."
        : response.status === 404
          ? " Check that the dependency graph is enabled (Settings → Code security)."
          : "";
    fail(`GitHub refused the snapshot (${response.status}).${hint}\n${body}`);
  }
  const parsed = JSON.parse(body) as { id?: number; result?: string; message?: string };
  setOutput("snapshot-id", String(parsed.id ?? ""));
  result = `${parsed.result ?? "submitted"}: ${parsed.message ?? ""}`.trim();
  console.log(`Submitted snapshot ${parsed.id ?? ""} (${result})`);
} else {
  console.log(`Dry run: wrote the snapshot to ${snapshotFile} and submitted nothing.`);
}

if (env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    [
      `### Bun dependency submission`,
      "",
      `\`${lockfileName}\`: ${packages.size} packages in ${manifests.length} manifests (${result}).`,
      "",
      "| Manifest | Packages | Direct |",
      "| --- | ---: | ---: |",
      ...rows,
      "",
    ].join("\n"),
  );
}
