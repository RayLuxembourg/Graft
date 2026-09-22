/**
 * Per-scope shards of the wiring graph and the ask sidecar (fork, 2026-09-22).
 *
 * A workspace index over 66 repos is a 398 MB `wiring.json` plus a 229 MB
 * `ask-index.json`, and every CLI invocation parsed both before doing anything:
 * 5–7 s per `graft ask --in frontend/PrismWebClient/` on a query whose answer
 * lives in one repo. `graft build` now also writes, for every scope (nested
 * repo / workspace package) it discovered, a shard holding that scope's nodes,
 * the edges touching them, the foreign nodes those edges reach (so cross-repo
 * callers still show), and the matching slice of the ask sidecar with its own
 * document frequencies. A query given `--in <prefix>` (or `skeleton <file>`)
 * loads the shard whose scope contains the prefix and never opens the full
 * graph. The full files are untouched; unscoped queries use them as before.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphV1, NodeV1, ScopeV1 } from "./types.js";
import { GRAPH_DIR } from "./write.js";
import { CACHE_DIR } from "../context/node-file.js";
import type { AskIndex, AskIndexDoc } from "../ask/index-file.js";

export const SHARDS_DIR = "scopes";
const SHARD_INDEX_FILE = "index.json";

interface ShardIndex {
  version: 1;
  /** Sorted by prefix length desc, so the first containing scope is the nearest. */
  scopes: { prefix: string; slug: string }[];
}

/** Filesystem-safe name for a scope prefix: `frontend/PrismWebClient` → `frontend__PrismWebClient`. */
export function shardSlug(prefix: string): string {
  return prefix.replace(/[^A-Za-z0-9._-]+/g, "__");
}

export function shardIndexPath(outDir: string): string {
  return join(outDir, GRAPH_DIR, SHARDS_DIR, SHARD_INDEX_FILE);
}

export function shardWiringPath(outDir: string, slug: string): string {
  return join(outDir, GRAPH_DIR, SHARDS_DIR, `${slug}.wiring.json`);
}

export function shardAskIndexPath(outDir: string, slug: string): string {
  return join(outDir, CACHE_DIR, SHARDS_DIR, `${slug}.ask-index.json`);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value) + "\n");
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* nothing more to do */
    }
    throw e;
  }
}

function stripBodyText(node: NodeV1): NodeV1 {
  if (node.body_text === undefined) return node;
  const { body_text: _body_text, ...rest } = node;
  return rest as NodeV1;
}

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** The ask-sidecar slice for one shard: the docs of the shard's nodes, with
 * document frequencies and the BM25 average recomputed over that slice so IDF
 * describes the corpus a scoped query actually ranks against. */
function sliceAskIndex(full: AskIndex, ids: Set<string>): AskIndex {
  const docs: AskIndexDoc[] = full.docs.filter((d) => ids.has(d.id));
  const df = new Map<string, number>();
  let bodyLen = 0;
  for (const d of docs) {
    const bag = new Set<string>();
    for (const [t] of d.name) bag.add(t);
    for (const [t] of d.path) bag.add(t);
    for (const [t, c] of d.body) {
      bag.add(t);
      bodyLen += c;
    }
    for (const t of bag) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return {
    version: 1,
    avgBodyLen: docs.length ? bodyLen / docs.length : 0,
    df: [...df.entries()],
    docCount: docs.length,
    docs,
  };
}

/**
 * Write one shard per non-root scope of `graph`, plus the shard index. `graph`
 * must be the in-memory build graph (nodes may still carry `body_text`; it is
 * stripped here exactly as `writeGraph` does). `askIndex` is the full sidecar
 * just built from the same graph. Returns the number of shards written.
 */
export function writeShards(graph: GraphV1, askIndex: AskIndex | null, outDir: string): number {
  const scopes = (graph.meta.scopes ?? []).filter((s) => s.prefix !== "");
  const root: ScopeV1 = { prefix: "", label: "", markers: [] };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const index: ShardIndex = { version: 1, scopes: [] };

  for (const scope of scopes) {
    const ids = new Set<string>();
    for (const n of graph.nodes) if (underPrefix(n.path, scope.prefix)) ids.add(n.id);
    if (ids.size === 0) continue;

    const edges = graph.edges.filter((e) => ids.has(e.source) || ids.has(e.target));
    const foreign = new Set<string>();
    for (const e of edges) {
      if (!ids.has(e.source)) foreign.add(e.source);
      if (!ids.has(e.target)) foreign.add(e.target);
    }
    const nodes: NodeV1[] = [];
    for (const id of ids) nodes.push(stripBodyText(byId.get(id)!));
    for (const id of foreign) {
      const n = byId.get(id);
      if (n) nodes.push(stripBodyText(n));
    }
    nodes.sort((a, b) => a.id.localeCompare(b.id));

    const shard: GraphV1 = {
      meta: {
        ...graph.meta,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        scopes: [scope, root],
      },
      nodes,
      edges,
    };
    const slug = shardSlug(scope.prefix);
    writeJsonAtomic(shardWiringPath(outDir, slug), shard);
    if (askIndex) writeJsonAtomic(shardAskIndexPath(outDir, slug), sliceAskIndex(askIndex, ids));
    index.scopes.push({ prefix: scope.prefix, slug });
  }

  index.scopes.sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix));
  writeJsonAtomic(shardIndexPath(outDir), index);
  return index.scopes.length;
}

const shardIndexCache = new Map<string, ShardIndex | null>();

function readShardIndex(outDir: string): ShardIndex | null {
  if (shardIndexCache.has(outDir)) return shardIndexCache.get(outDir)!;
  const path = shardIndexPath(outDir);
  let value: ShardIndex | null = null;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (raw && raw.version === 1 && Array.isArray(raw.scopes)) value = raw as ShardIndex;
    } catch {
      value = null;
    }
  }
  shardIndexCache.set(outDir, value);
  return value;
}

/**
 * The shard that answers a query scoped to `prefix` (a normalized repo-relative
 * path prefix, or a file path): the nearest scope whose prefix contains it, when
 * that shard's wiring file exists. Null means "use the full graph".
 */
export function shardFor(outDir: string, prefix: string | undefined): { slug: string; prefix: string } | null {
  if (!prefix) return null;
  const index = readShardIndex(outDir);
  if (!index) return null;
  const p = prefix.replace(/\/+$/, "");
  for (const s of index.scopes) {
    if (underPrefix(p, s.prefix) && existsSync(shardWiringPath(outDir, s.slug))) return s;
  }
  return null;
}
