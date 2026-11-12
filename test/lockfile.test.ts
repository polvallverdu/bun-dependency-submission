import { describe, expect, it } from "bun:test";

import { parseLockfile } from "../src/lockfile.ts";

describe("parseLockfile", () => {
  it("allows trailing commas", () => {
    const lock = parseLockfile(`{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "a", "dependencies": { "b": "1.0.0", }, }, },
      "packages": { "b": ["b@1.0.0", "", {}, "sha512-x"], },
    }`);
    expect(lock.workspaces[""]?.dependencies).toEqual({ b: "1.0.0" });
    expect(lock.packages.b?.[0]).toBe("b@1.0.0");
  });

  it("keeps commas and brackets inside strings", () => {
    const lock = parseLockfile(`{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "a, ]} \\"quoted\\"" } },
      "packages": {},
    }`);
    expect(lock.workspaces[""]?.name).toBe('a, ]} "quoted"');
  });

  it("reads the lockfile versions Bun writes", () => {
    for (const lockfileVersion of [0, 1, 2, 3]) {
      expect(
        parseLockfile(JSON.stringify({ lockfileVersion, workspaces: {}, packages: {} })).lockfileVersion,
      ).toBe(lockfileVersion);
    }
  });

  it("refuses files that aren't a bun.lock", () => {
    expect(() => parseLockfile(`{ "name": "package.json" }`)).toThrow("doesn't look like a bun.lock");
    expect(() => parseLockfile(`{ "workspaces": {}, "packages": {} }`)).toThrow("lockfileVersion");
  });
});
