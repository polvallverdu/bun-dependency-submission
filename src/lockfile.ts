import type { BunLock } from "./snapshot.ts";

/** The newest `lockfileVersion` this has been tested with (Bun 1.4 writes 2 or 3). */
export const KNOWN_LOCKFILE_VERSION = 3;

/**
 * Parses `bun.lock`: JSON that allows trailing commas. Done by hand rather
 * than with Bun's `jsonc` import so it works with any Bun (or Node) version.
 */
export function parseLockfile(text: string): BunLock {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (inString) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next] as string)) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    out += char;
  }

  const lock = JSON.parse(out) as Partial<BunLock>;
  if (typeof lock !== "object" || lock === null || !lock.workspaces || !lock.packages) {
    throw new Error("This doesn't look like a bun.lock: it has no `workspaces` or `packages`.");
  }
  if (typeof lock.lockfileVersion !== "number") {
    throw new Error("This doesn't look like a bun.lock: it has no `lockfileVersion`.");
  }
  if (lock.lockfileVersion > KNOWN_LOCKFILE_VERSION) {
    // What this reads (workspaces, and `name@version` first in each package
    // entry) has stayed the same across versions, so try rather than refuse.
    console.log(
      `::warning title=Bun dependency submission::bun.lock lockfileVersion ${lock.lockfileVersion} ` +
        `is newer than this action knows (${KNOWN_LOCKFILE_VERSION}). Check the snapshot, ` +
        "and open an issue if anything is missing.",
    );
  }
  return lock as BunLock;
}
