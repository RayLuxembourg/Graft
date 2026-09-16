/**
 * Inline refresh has a ceiling (Sisense fork, 2026-09-16). A large drift used to be
 * re-parsed inside the query — 217s measured twice on a 36k-file index — so above
 * GRAFT_INLINE_REFRESH_MAX (default 25 files) a query answers from the graph as-is and
 * says how far behind it is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "fork-refresh-"));
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "package.json"), "{}");
  writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
  return d;
}
function addFiles(d: string, n: number): void {
  for (let i = 0; i < n; i++) writeFileSync(join(d, "src", `gen${i}.ts`), `export const g${i} = ${i};\n`);
}

test("a small drift still refreshes inline", async () => {
  const d = repo();
  try {
    await buildGraph(d);
    addFiles(d, 3);
    const r = await ensureFreshGraph(d);
    assert.equal(r.refreshed, true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("a drift above the ceiling answers as-is and names the gap", async () => {
  const d = repo();
  const prev = process.env.GRAFT_INLINE_REFRESH_MAX;
  try {
    await buildGraph(d);
    addFiles(d, 40);
    const r = await ensureFreshGraph(d);
    assert.equal(r.refreshed, false);
    assert.match(r.note ?? "", /40 files behind .*graft build/);
    // the ceiling is a knob
    process.env.GRAFT_INLINE_REFRESH_MAX = "100";
    const r2 = await ensureFreshGraph(d);
    assert.equal(r2.refreshed, true);
  } finally {
    if (prev === undefined) delete process.env.GRAFT_INLINE_REFRESH_MAX; else process.env.GRAFT_INLINE_REFRESH_MAX = prev;
    rmSync(d, { recursive: true, force: true });
  }
});
