/**
 * Per-scope shards (fork, 2026-09-22): a scoped query loads one scope's graph
 * and sidecar instead of the whole workspace's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { ask } from "../src/ask/ask.js";
import { loadGraphCached, loadAskIndexCached } from "../src/graph/load.js";
import { shardFor, shardWiringPath, shardAskIndexPath, shardIndexPath } from "../src/graph/shards.js";
import { wiringPath } from "../src/graph/write.js";
import { grepGraph } from "../src/search/grep.js";

const filler = (p: string) => Array.from({ length: 8 }, (_, i) => `export function ${p}Helper${i}(x: number) { return x + ${i}; }\n`).join("");

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-fork-shards-"));
  for (const repo of ["frontend/web", "backend/api"]) {
    mkdirSync(join(dir, repo, "src"), { recursive: true });
    writeFileSync(join(dir, repo, "package.json"), "{}");
  }
  writeFileSync(join(dir, "frontend/web/src/export.ts"), "export function saveFileFromStream(r: string) { return r; }\n" + filler("web"));
  writeFileSync(
    join(dir, "backend/api/src/consumer.ts"),
    'import { saveFileFromStream } from "../../../frontend/web/src/export.js";\nexport function download(r: string) { return saveFileFromStream(r); }\n' + filler("api"),
  );
  return dir;
}

test("build writes one shard per scope; a scoped load reads the shard, an unscoped load the full graph", async () => {
  const dir = fixture();
  try {
    await buildGraph(dir);
    const outDir = join(dir, "graft");
    assert.ok(existsSync(shardIndexPath(outDir)), "shard index missing");
    const web = shardFor(outDir, "frontend/web/");
    assert.ok(web && web.prefix === "frontend/web", `shardFor → ${JSON.stringify(web)}`);
    assert.ok(existsSync(shardWiringPath(outDir, web!.slug)));
    assert.ok(existsSync(shardAskIndexPath(outDir, web!.slug)));
    assert.equal(shardFor(outDir, undefined), null);
    assert.equal(shardFor(outDir, "nowhere/"), null);

    const full = loadGraphCached(outDir)!;
    const shard = loadGraphCached(outDir, "frontend/web/src")!;
    assert.ok(shard.nodes.length < full.nodes.length, "shard should be smaller than the full graph");
    assert.ok(statSync(shardWiringPath(outDir, web!.slug)).size < statSync(wiringPath(outDir)).size);
    // every in-scope node is present, and the foreign caller reached by an edge too
    assert.ok(shard.nodes.some((n) => n.name === "saveFileFromStream"));
    assert.ok(shard.nodes.some((n) => n.name === "download"), "foreign caller node kept for cross-scope callers");
    assert.ok(!shard.nodes.some((n) => n.name === "apiHelper3"), "unrelated foreign nodes are not in the shard");

    const idx = loadAskIndexCached(outDir, "frontend/web/")!;
    assert.equal(idx.docCount, idx.docs.length);
    assert.ok(idx.docs.every((d) => shard.nodes.some((n) => n.id === d.id)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ask, grep and callers answer from the shard with the same hits", async () => {
  const dir = fixture();
  try {
    await buildGraph(dir);
    const outDir = join(dir, "graft");
    const r = ask(dir, "saveFileFromStream", { in: "frontend/web/", limit: 3 });
    assert.equal(r.hits[0]?.title.split(" ")[0], "saveFileFromStream", r.hits.map((h) => h.title).join(" | "));
    for (const h of r.hits) assert.ok(h.pointer.startsWith("frontend/web/"), h.pointer);

    const shard = loadGraphCached(outDir, "backend/api/")!;
    const g = grepGraph(shard, dir, "saveFileFromStream", { in: "backend/api/" });
    // the import line (module level) and the call inside `download`
    assert.equal(g.totalHits, 2);
    assert.ok(g.groups.every((grp) => grp.path === "backend/api/src/consumer.ts"));
    // the cross-scope edge survives in the callee's shard
    const webShard = loadGraphCached(outDir, "frontend/web/")!;
    const target = webShard.nodes.find((n) => n.name === "saveFileFromStream")!;
    assert.ok(webShard.edges.some((e) => e.target === target.id && e.relation === "calls"), "calls edge from backend/api kept");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
