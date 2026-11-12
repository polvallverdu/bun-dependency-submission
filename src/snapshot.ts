/**
 * Builds a GitHub dependency submission snapshot from a `bun.lock`.
 *
 * GitHub's dependency graph doesn't read `bun.lock`, so on its own it only
 * sees the ranges in each `package.json`. It can't tell which version is
 * installed, never sees transitive dependencies, and keeps a Dependabot alert
 * open while a range's lowest version is vulnerable, even when the lockfile
 * (or a `resolutions` pin) already installs a fixed one.
 *
 * This writes one manifest per workspace `package.json`, with the versions
 * Bun resolves for it. A dependency on another workspace isn't followed: that
 * workspace is reported in its own manifest.
 *
 * https://docs.github.com/en/rest/dependency-graph/dependency-submission
 */

import { posix } from "node:path";

type DependencyMap = Record<string, string>;

export interface LockWorkspace {
  name?: string;
  dependencies?: DependencyMap;
  devDependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
}

export interface LockPackageInfo {
  dependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
  optionalPeers?: string[];
}

/**
 * `[name@version, registry, info, integrity]` for registry packages. Other
 * sources (workspaces, git, tarballs, links, folders) have other shapes, so
 * nothing past the first item is relied on without checking it.
 */
export type LockPackage = [string, ...unknown[]];

export interface BunLock {
  lockfileVersion: number;
  workspaces: Record<string, LockWorkspace>;
  packages: Record<string, LockPackage>;
}

export type Scope = "runtime" | "development";

export interface ResolvedDependency {
  package_url: string;
  relationship: "direct" | "indirect";
  scope: Scope;
  dependencies: string[];
}

export interface Manifest {
  name: string;
  file: { source_location: string };
  resolved: Record<string, ResolvedDependency>;
}

export interface Snapshot {
  version: 0;
  sha: string;
  ref: string;
  job: { correlator: string; id: string; html_url?: string };
  detector: { name: string; version: string; url: string };
  scanned: string;
  manifests: Record<string, Manifest>;
}

export interface SnapshotOptions {
  sha: string;
  ref: string;
  correlator: string;
  jobId: string;
  jobUrl?: string;
  scanned: string;
  detector: Snapshot["detector"];
  /** Folder of the lockfile, relative to the repository root ("" for the root). */
  lockfileDir?: string;
  /** Leave out what only `devDependencies` reach. */
  excludeDev?: boolean;
}

/** Splits a lockfile key (`a/@scope/b/c`) into package names (`a`, `@scope/b`, `c`). */
export function keyNames(key: string): string[] {
  const parts = key.split("/");
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (part.startsWith("@") && i + 1 < parts.length) {
      names.push(`${part}/${parts[++i]}`);
    } else {
      names.push(part);
    }
  }
  return names;
}

/**
 * The lockfile key a dependency of `from` resolves to, the way Bun installs it:
 * the closest nested copy (`from/dep`, then each parent's), else the hoisted one.
 */
export function resolveKey(
  packages: BunLock["packages"],
  from: string[],
  dependency: string,
): string | undefined {
  for (let depth = from.length; depth >= 0; depth--) {
    const key = [...from.slice(0, depth), dependency].join("/");
    if (key in packages) return key;
  }
  return undefined;
}

/**
 * The npm package URL of a lockfile entry's `name@version`, or undefined for
 * workspaces and sources that aren't the registry (git, tarballs, links, folders).
 */
export function packageUrl(spec: string): string | undefined {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return undefined;
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (!/^\d+\.\d+\.\d+/.test(version)) return undefined;
  const path = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${path}@${encodeURIComponent(version)}`;
}

/**
 * A package's edges. Optional peers are left out: the lockfile lists them
 * whenever any workspace installs them, but they're only used where the
 * consumer depends on them itself, which its own edges already say.
 */
function packageDependencies(info: LockPackageInfo | undefined): string[] {
  const optionalPeers = new Set(info?.optionalPeers);
  return [
    ...Object.keys(info?.dependencies ?? {}),
    ...Object.keys(info?.optionalDependencies ?? {}),
    ...Object.keys(info?.peerDependencies ?? {}).filter((name) => !optionalPeers.has(name)),
  ];
}

function packageInfo(entry: LockPackage): LockPackageInfo | undefined {
  const info = entry[2];
  return info && typeof info === "object" && !Array.isArray(info)
    ? (info as LockPackageInfo)
    : undefined;
}

function workspaceManifest(
  lock: BunLock,
  path: string,
  workspace: LockWorkspace,
  options: SnapshotOptions,
): Manifest {
  const { packages } = lock;
  const source = posix.join(options.lockfileDir ?? "", path, "package.json");
  const resolved: Record<string, ResolvedDependency> = {};

  // A workspace's own nested copies sit under its package name.
  const workspaceKey = workspace.name && workspace.name in packages ? [workspace.name] : [];

  /** The registry entry a key points at, or undefined for workspaces and other sources. */
  const entry = (key: string) => {
    const lockEntry = packages[key] as LockPackage;
    const url = packageUrl(lockEntry[0]);
    return url ? { url, info: packageInfo(lockEntry) } : undefined;
  };

  const childKeys = (key: string) =>
    packageDependencies(entry(key)?.info)
      .map((name) => resolveKey(packages, keyNames(key), name))
      .filter((child): child is string => child !== undefined && entry(child) !== undefined);

  const visit = (roots: string[], scope: Scope) => {
    const queue = roots.filter((key) => entry(key) !== undefined);
    const seen = new Set<string>();
    for (const key of queue) {
      const url = entry(key)!.url;
      const existing = resolved[url];
      if (existing) existing.relationship = "direct";
      else resolved[url] = { package_url: url, relationship: "direct", scope, dependencies: [] };
    }
    while (queue.length > 0) {
      const key = queue.shift()!;
      if (seen.has(key)) continue;
      seen.add(key);
      const node = resolved[entry(key)!.url]!;
      for (const child of childKeys(key)) {
        const childUrl = entry(child)!.url;
        if (!node.dependencies.includes(childUrl)) node.dependencies.push(childUrl);
        resolved[childUrl] ??= {
          package_url: childUrl,
          relationship: "indirect",
          scope,
          dependencies: [],
        };
        queue.push(child);
      }
    }
  };

  const rootKeys = (deps: DependencyMap | undefined) =>
    Object.keys(deps ?? {})
      .map((name) => resolveKey(packages, workspaceKey, name))
      .filter((key): key is string => key !== undefined);

  // Runtime first, so a package reached both ways is reported as runtime.
  visit(
    [
      ...rootKeys(workspace.dependencies),
      ...rootKeys(workspace.optionalDependencies),
      ...rootKeys(workspace.peerDependencies),
    ],
    "runtime",
  );
  if (!options.excludeDev) visit(rootKeys(workspace.devDependencies), "development");

  for (const node of Object.values(resolved)) node.dependencies.sort();
  return { name: source, file: { source_location: source }, resolved };
}

export function buildSnapshot(lock: BunLock, options: SnapshotOptions): Snapshot {
  const manifests: Record<string, Manifest> = {};
  for (const [path, workspace] of Object.entries(lock.workspaces)) {
    const manifest = workspaceManifest(lock, path, workspace, options);
    if (Object.keys(manifest.resolved).length > 0) manifests[manifest.name] = manifest;
  }
  return {
    version: 0,
    sha: options.sha,
    ref: options.ref,
    job: {
      correlator: options.correlator,
      id: options.jobId,
      ...(options.jobUrl ? { html_url: options.jobUrl } : {}),
    },
    detector: options.detector,
    scanned: options.scanned,
    manifests,
  };
}
