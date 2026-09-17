/**
 * Where "here" is when a query names no directory. An agent session — or a plain
 * shell — started in a subdirectory of an indexed repo should still find the
 * graph, so the implicit root is the nearest ANCESTOR holding a graft index:
 * either a repo's own wiring graph (`graft/.graph/wiring.json`) or a workspace
 * parent's children index (`graft/workspace.json`). Nothing indexed anywhere
 * above → the start dir itself, so `graft build` in a fresh repo still means
 * "here" and no command silently retargets a sibling tree.
 *
 * Only the IMPLICIT case walks. An explicit `[dir]` argument is taken at face
 * value, and a `--dir` override short-circuits entirely: `contextDirFor` returns
 * an override verbatim and ignores the root it is handed, so every ancestor
 * would report the same context dir and the walk would answer "level 0" for a
 * dir that isn't the repo.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { wiringPath } from "./write.js";
import { workspacePath } from "./workspace.js";

/** True when `dir` is a graft root of either shape — a built repo or a workspace parent. */
export function hasGraftIndex(dir: string): boolean {
  return existsSync(wiringPath(contextDirFor(dir))) || existsSync(workspacePath(dir));
}

export interface RootResolution {
  /** Absolute dir to run the command against. */
  root: string;
  /** Directory levels walked up; 0 when the start dir was already the root (the common case). */
  levels: number;
}

/** The nearest ancestor of `start` (inclusive) that holds a graft index, else `start`. */
export function nearestGraftRoot(start: string, override?: string): RootResolution {
  const from = resolve(start);
  if (override) return { root: from, levels: 0 };
  let dir = from;
  for (let levels = 0; ; levels++) {
    if (hasGraftIndex(dir)) return { root: escalateToWorkspaceParent(dir), levels };
    const up = dirname(dir);
    if (up === dir) return { root: from, levels: 0 }; // hit the filesystem root, nothing indexed
    dir = up;
  }
}

/**
 * Workspace centralization: when the nearest graft index belongs to a repo whose PARENT
 * federates a workspace (holds `graft/workspace.json`), resolve to the parent instead.
 * The parent's federation includes this repo's own graph, so an implicit query from
 * inside any child sees the whole workspace by default; `--in <repo>/` narrows back
 * to one repo. An explicit `[dir]` never lands here (the walk only runs implicitly).
 */
function escalateToWorkspaceParent(found: string): string {
  let dir = found;
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return dir;
    if (existsSync(workspacePath(parent))) {
      dir = parent;
      continue;
    }
    return dir;
  }
}
