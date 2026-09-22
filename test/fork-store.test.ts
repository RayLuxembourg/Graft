/**
 * SQLite store (fork, 2026-09-22): a query reads only the rows it touches, and
 * answers exactly what the JSON graph answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { ask, skeleton } from "../src/ask/ask.js";
import { openStore, storePath, Store } from "../src/graph/store.js";
import { loadGraphCached } from "../src/graph/load.js";
import { resolveSymbol, edgeWalk } from "../src/graph/traverse.js";

const filler = (p: string) => Array.from({ length: 8 }, (_, i) => `export function ${p}Helper${i}(x: number) { return x + ${i}; }\n`).join("");

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-fork-store-"));
  for (const repo of ["frontend/web", "backend/api"]) {
    mkdirSync(join(dir, repo, "src"), { recursive: true });
    writeFileSync(join(dir, repo, "package.json"), "{}");
  }
  writeFileSync(join(dir, "frontend/web/src/export.ts"), "export function saveFileFromStream(r: string) { return r; }\nexport function verifyAccessToken(t: string) { return t + 'k'; }\n" + filler("web"));
  writeFileSync(
    join(dir, "backend/api/src/consumer.ts"),
    'import { saveFileFromStream } from "../../../frontend/web/src/export.js";\nexport function download(r: string) { return saveFileFromStream(r); }\nexport function downloadAll(rs: string[]) { return rs.map((r) => download(r)); }\n' + filler("api"),
  );
  return dir;
}

test("build writes the store; scoped, unscoped, callers and skeleton answer from it", async () => {
  const dir = fixture();
  try {
    await buildGraph(dir);
    const outDir = join(dir, "graft");
    assert.ok(existsSync(storePath(outDir)), "graph.sqlite missing");
    const store = openStore(outDir)!;
    assert.ok(store instanceof Store);

    // scoped subgraph: in-scope nodes, the edge in from backend/api, and that caller node
    const web = store.scopeGraph("frontend/web/");
    assert.ok(web.nodes.some((n) => n.name === "saveFileFromStream"));
    assert.ok(web.nodes.some((n) => n.name === "download"), "foreign caller kept");
    assert.ok(!web.nodes.some((n) => n.name === "apiHelper2"));
    assert.equal(loadGraphCached(outDir, "frontend/web/")!.nodes.length, web.nodes.length);

    // unscoped ask: candidates only, same top hit as the full graph would give
    const r = ask(dir, "verifyAccessToken", { limit: 3 });
    assert.equal(r.hits[0]?.title.split(" ")[0], "verifyAccessToken", r.hits.map((h) => h.title).join(" | "));
    const r2 = ask(dir, "verify access token", { limit: 3 });
    assert.equal(r2.hits[0]?.title.split(" ")[0], "verifyAccessToken", r2.hits.map((h) => h.title).join(" | "));

    // callers neighbourhood: two hops
    const g = store.symbolNeighborhood("saveFileFromStream", "in", 2);
    const node = resolveSymbol(g, "saveFileFromStream")[0];
    const hits = edgeWalk(g, node, "in", 2);
    const names = hits.map((h) => h.node.name);
    assert.ok(names.includes("download"), names.join(" | "));
    assert.ok(names.includes("downloadAll"), names.join(" | "));

    // skeleton reads one file's rows
    const sk = skeleton(dir, "frontend/web/src/export.ts");
    assert.deepEqual(sk.entries.map((e) => e.name).slice(0, 2), ["saveFileFromStream", "verifyAccessToken"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without the store, the JSON path still answers (old builds keep working)", async () => {
  const dir = fixture();
  try {
    await buildGraph(dir);
    const outDir = join(dir, "graft");
    renameSync(storePath(outDir), storePath(outDir) + ".off");
    const r = ask(dir, "verifyAccessToken", { limit: 3 });
    assert.equal(r.hits[0]?.title.split(" ")[0], "verifyAccessToken");
    const sk = skeleton(dir, "frontend/web/src/export.ts");
    assert.ok(sk.entries.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
