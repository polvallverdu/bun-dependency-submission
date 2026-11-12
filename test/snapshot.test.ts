import type { BunLock } from "../src/snapshot.ts";

import { describe, expect, it } from "bun:test";

import { buildSnapshot, keyNames, packageUrl, resolveKey } from "../src/snapshot.ts";

const OPTIONS = {
  sha: "abc123",
  ref: "refs/heads/main",
  correlator: "Dependencies submit bun.lock",
  jobId: "42",
  scanned: "2026-11-10T00:00:00.000Z",
  detector: { name: "test", version: "0.0.0", url: "https://example.com" },
};

// Every edge case in one hand-written lockfile.
const LOCK: BunLock = {
  lockfileVersion: 1,
  workspaces: {
    "": { name: "root", devDependencies: { tool: "^1.0.0", plugin: "^1.0.0" } },
    "apps/web": {
      name: "@acme/web",
      dependencies: {
        "@acme/shared": "workspace:*",
        satori: "^0.33.5",
        "git-dep": "github:a/b",
        alias: "npm:real-name@^1.0.0",
      },
      devDependencies: { tool: "^1.0.0", fflate: "^0.7.4" },
    },
    "packages/shared": {
      name: "@acme/shared",
      dependencies: { "@scope/lib": "^2.0.0" },
    },
    "packages/empty": { name: "@acme/empty" },
  },
  packages: {
    "@acme/shared": ["@acme/shared@workspace:packages/shared"],
    "@acme/web": ["@acme/web@workspace:apps/web"],
    "@acme/empty": ["@acme/empty@workspace:packages/empty"],
    satori: [
      "satori@0.33.5",
      "",
      {
        dependencies: { fflate: "0.7.3", "@scope/lib": "^2.0.0" },
        peerDependencies: { react: "^19.0.0", plugin: "^1.0.0" },
        optionalPeers: ["plugin"],
      },
      "sha512-a",
    ],
    react: ["react@19.2.0", "", {}, "sha512-g"],
    plugin: ["plugin@1.0.0", "", {}, "sha512-h"],
    "satori/fflate": ["fflate@0.7.3", "", {}, "sha512-b"],
    fflate: ["fflate@0.7.4", "", {}, "sha512-c"],
    "@scope/lib": ["@scope/lib@2.1.0", "", { dependencies: { tool: "^1.0.0" } }, "sha512-d"],
    "@scope/lib/tool": ["tool@1.0.0+build", "", {}, "sha512-e"],
    tool: ["tool@1.2.0", "", {}, "sha512-f"],
    "git-dep": ["git-dep@github:a/b#0123abc", {}, "a-b-0123abc"],
    alias: ["real-name@1.4.0", "", {}, "sha512-i"],
  },
};

describe("keyNames", () => {
  it("keeps scoped names whole", () => {
    expect(keyNames("a/@scope/b/c")).toEqual(["a", "@scope/b", "c"]);
    expect(keyNames("@scope/b")).toEqual(["@scope/b"]);
  });
});

describe("resolveKey", () => {
  it("prefers the closest nested copy, then the hoisted one", () => {
    expect(resolveKey(LOCK.packages, ["@scope/lib"], "tool")).toBe("@scope/lib/tool");
    expect(resolveKey(LOCK.packages, ["satori"], "tool")).toBe("tool");
    expect(resolveKey(LOCK.packages, ["satori"], "missing")).toBeUndefined();
  });
});

describe("packageUrl", () => {
  it("encodes scoped names and versions", () => {
    expect(packageUrl("satori@0.33.5")).toBe("pkg:npm/satori@0.33.5");
    expect(packageUrl("@scope/lib@2.1.0-beta.1")).toBe("pkg:npm/%40scope/lib@2.1.0-beta.1");
    expect(packageUrl("tool@1.0.0+build")).toBe("pkg:npm/tool@1.0.0%2Bbuild");
  });

  it("skips workspaces and sources that aren't the registry", () => {
    expect(packageUrl("@acme/web@workspace:apps/web")).toBeUndefined();
    expect(packageUrl("git-dep@github:a/b#0123abc")).toBeUndefined();
    expect(packageUrl("tarball@https://example.com/t.tgz")).toBeUndefined();
    expect(packageUrl("local@file:../local")).toBeUndefined();
    expect(packageUrl("linked@link:linked")).toBeUndefined();
  });
});

describe("buildSnapshot", () => {
  const snapshot = buildSnapshot(LOCK, OPTIONS);
  const web = snapshot.manifests["apps/web/package.json"]!.resolved;
  const root = snapshot.manifests["package.json"]!.resolved;

  it("fills in the run's metadata", () => {
    expect(snapshot).toMatchObject({
      version: 0,
      sha: "abc123",
      ref: "refs/heads/main",
      job: { correlator: "Dependencies submit bun.lock", id: "42" },
      detector: OPTIONS.detector,
      scanned: "2026-11-10T00:00:00.000Z",
    });
  });

  it("writes one manifest per workspace with dependencies", () => {
    expect(Object.keys(snapshot.manifests).sort()).toEqual([
      "apps/web/package.json",
      "package.json",
      "packages/shared/package.json",
    ]);
    expect(snapshot.manifests["package.json"]!.file.source_location).toBe("package.json");
  });

  it("prefixes manifest paths with the lockfile's folder", () => {
    const nested = buildSnapshot(LOCK, { ...OPTIONS, lockfileDir: "frontend" });
    expect(Object.keys(nested.manifests).sort()).toEqual([
      "frontend/apps/web/package.json",
      "frontend/package.json",
      "frontend/packages/shared/package.json",
    ]);
  });

  it("resolves the nested copy Bun installs before the hoisted one", () => {
    expect(web["pkg:npm/satori@0.33.5"]!.dependencies).toEqual([
      "pkg:npm/%40scope/lib@2.1.0",
      "pkg:npm/fflate@0.7.3",
      "pkg:npm/react@19.2.0",
    ]);
    expect(web["pkg:npm/%40scope/lib@2.1.0"]!.dependencies).toEqual(["pkg:npm/tool@1.0.0%2Bbuild"]);
  });

  it("follows required peers but not optional ones another workspace installs", () => {
    expect(web["pkg:npm/react@19.2.0"]!.scope).toBe("runtime");
    expect(web["pkg:npm/plugin@1.0.0"]).toBeUndefined();
    expect(root["pkg:npm/plugin@1.0.0"]).toMatchObject({ relationship: "direct", scope: "development" });
  });

  it("reports a version reached both directly and transitively once, as direct", () => {
    expect(web["pkg:npm/fflate@0.7.4"]).toMatchObject({ relationship: "direct", scope: "development" });
    expect(web["pkg:npm/fflate@0.7.3"]).toMatchObject({ relationship: "indirect", scope: "runtime" });
  });

  it("marks what only dev dependencies reach as development", () => {
    expect(web["pkg:npm/satori@0.33.5"]!.scope).toBe("runtime");
    expect(web["pkg:npm/tool@1.0.0%2Bbuild"]!.scope).toBe("runtime");
    expect(web["pkg:npm/tool@1.2.0"]).toMatchObject({ relationship: "direct", scope: "development" });
  });

  it("reports an npm alias under the real package name", () => {
    expect(web["pkg:npm/real-name@1.4.0"]).toMatchObject({ relationship: "direct", scope: "runtime" });
  });

  it("leaves other workspaces and sources that aren't the registry out", () => {
    expect(Object.keys(web).some((url) => url.includes("acme"))).toBe(false);
    expect(Object.keys(web).some((url) => url.includes("git-dep"))).toBe(false);
    expect(Object.keys(snapshot.manifests["packages/shared/package.json"]!.resolved)).toEqual([
      "pkg:npm/%40scope/lib@2.1.0",
      "pkg:npm/tool@1.0.0%2Bbuild",
    ]);
  });

  it("drops what only dev dependencies reach with excludeDev", () => {
    const runtime = buildSnapshot(LOCK, { ...OPTIONS, excludeDev: true });
    const runtimeWeb = runtime.manifests["apps/web/package.json"]!.resolved;
    expect(runtimeWeb["pkg:npm/fflate@0.7.4"]).toBeUndefined();
    expect(runtimeWeb["pkg:npm/tool@1.2.0"]).toBeUndefined();
    expect(runtimeWeb["pkg:npm/satori@0.33.5"]).toBeDefined();
    // The root only has dev dependencies, so it has nothing left to report.
    expect(runtime.manifests["package.json"]).toBeUndefined();
  });
});
