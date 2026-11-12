/**
 * Runs `src/main.ts` the way the action does, against the fixtures in
 * `test/fixtures` (real lockfiles written by `bun install --lockfile-only`).
 * Nothing here submits anything: every run is a dry run, or fails before.
 */

import type { Snapshot } from "../src/snapshot.ts";

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(import.meta.dir, "fixtures");

function run(env: Record<string, string>) {
  const temp = mkdtempSync(join(tmpdir(), "bun-dependency-submission-"));
  const output = join(temp, "output");
  const summary = join(temp, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const result = Bun.spawnSync(["bun", join(ROOT, "src/main.ts")], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: temp,
      GITHUB_WORKFLOW: "Dependencies",
      GITHUB_JOB: "submit",
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]),
  );
  const snapshot = outputs["snapshot-file"]
    ? (JSON.parse(readFileSync(outputs["snapshot-file"], "utf8")) as Snapshot)
    : undefined;
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    outputs,
    summary: readFileSync(summary, "utf8"),
    snapshot,
  };
}

describe("main", () => {
  it("builds a single repo's snapshot on a dry run", () => {
    const result = run({ GITHUB_WORKSPACE: join(FIXTURES, "single-repo"), DRY_RUN: "true" });
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toMatchObject({ manifests: "1", packages: "3" });
    expect(result.outputs["snapshot-id"]).toBeUndefined();
    const manifest = result.snapshot!.manifests["package.json"]!;
    expect(manifest.resolved["pkg:npm/debug@4.3.4"]).toMatchObject({
      relationship: "direct",
      scope: "runtime",
      dependencies: ["pkg:npm/ms@2.1.2"],
    });
    expect(manifest.resolved["pkg:npm/%40types/ms@0.7.34"]?.scope).toBe("development");
    expect(result.snapshot!.job.correlator).toBe("Dependencies submit bun.lock");
    expect(result.summary).toContain("| `package.json` | 3 | 2 |");
    expect(result.summary).toContain("dry run");
  });

  it("reports each workspace of a monorepo, with nested copies", () => {
    const result = run({ GITHUB_WORKSPACE: join(FIXTURES, "monorepo"), DRY_RUN: "true" });
    expect(result.exitCode).toBe(0);
    const { manifests } = result.snapshot!;
    expect(Object.keys(manifests).sort()).toEqual([
      "apps/web/package.json",
      "package.json",
      "packages/shared/package.json",
    ]);
    const web = manifests["apps/web/package.json"]!.resolved;
    // debug 2.6.9 gets its own ms 2.0.0, and web's direct ms is the hoisted 2.1.3.
    expect(web["pkg:npm/debug@2.6.9"]!.dependencies).toEqual(["pkg:npm/ms@2.0.0"]);
    expect(web["pkg:npm/ms@2.1.3"]!.relationship).toBe("direct");
    expect(web["pkg:npm/ms@2.0.0"]!.relationship).toBe("indirect");
    // The workspace dependency is shared's manifest, not part of web's.
    expect(web["pkg:npm/%40sindresorhus/is@4.6.0"]).toBeUndefined();
    expect(manifests["packages/shared/package.json"]!.resolved["pkg:npm/is-number@7.0.0"]?.scope).toBe(
      "development",
    );
  });

  it("reports a lockfile in a subfolder against the repository root", () => {
    const result = run({ GITHUB_WORKSPACE: FIXTURES, WORKING_DIRECTORY: "monorepo", DRY_RUN: "true" });
    expect(result.exitCode).toBe(0);
    expect(Object.keys(result.snapshot!.manifests)).toContain("monorepo/apps/web/package.json");
    expect(result.snapshot!.job.correlator).toBe("Dependencies submit monorepo/bun.lock");
  });

  it("takes a correlator and leaves dev-only packages out when asked", () => {
    const result = run({
      GITHUB_WORKSPACE: join(FIXTURES, "single-repo"),
      DRY_RUN: "true",
      CORRELATOR: "custom",
      EXCLUDE_DEV: "true",
    });
    expect(result.exitCode).toBe(0);
    expect(result.snapshot!.job.correlator).toBe("custom");
    expect(Object.keys(result.snapshot!.manifests["package.json"]!.resolved).sort()).toEqual([
      "pkg:npm/debug@4.3.4",
      "pkg:npm/ms@2.1.2",
    ]);
  });

  it("explains how to move off the binary lockfile", () => {
    const result = run({ GITHUB_WORKSPACE: join(FIXTURES, "legacy-binary"), DRY_RUN: "true" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("::error");
    expect(result.stdout).toContain("--save-text-lockfile");
  });

  it("fails when there is no lockfile", () => {
    const result = run({ GITHUB_WORKSPACE: FIXTURES, DRY_RUN: "true" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("No lockfile at bun.lock");
  });

  it("needs a repository and a token to submit", () => {
    const result = run({ GITHUB_WORKSPACE: join(FIXTURES, "single-repo") });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("dry-run");
  });
});
