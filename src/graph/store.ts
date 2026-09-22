/**
 * SQLite store for the wiring graph and the ask sidecar (fork, 2026-09-22).
 *
 * `graft build` keeps writing `wiring.json` and `ask-index.json`; it now also
 * writes `<outDir>/.graph/graph.sqlite` with the same content in tables plus an
 * FTS5 inverted index over each node's token bags. Query paths read only the
 * rows they touch:
 *
 *   - `ask --in <prefix>`            → the scope's nodes + touching edges (scopeGraph)
 *   - `ask` unscoped                 → the best few thousand FTS5 candidates for the
 *                                      query's tokens, their file nodes, exact-name
 *                                      matches, and the edges into them (candidateCorpus)
 *   - `callers <symbol>`             → the symbol's neighbourhood by BFS over edges
 *   - `skeleton <file>`              → the file's nodes
 *
 * Before this, every CLI invocation parsed the whole workspace graph: 380 MB of
 * JSON, 4.1 GB of RSS and 8 s for an unscoped `ask` over 66 repos, 12 GB to
 * build. The JSON files stay as the fallback and for tools not converted yet.
 *
 * Uses Node's built-in `node:sqlite` (22.13+), so no native dependency.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { EdgeV1, GraphV1, NodeV1 } from "./types.js";
import { GRAPH_DIR } from "./write.js";
import type { AskIndex, AskIndexDoc } from "../ask/index-file.js";

// `node:sqlite` prints an ExperimentalWarning on first load. Swallow exactly that
// one — a warning on every graft call would land in every tool result — and keep
// every other warning on its way to stderr.
const priorWarningListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.name === "ExperimentalWarning" && /sqlite/i.test(w.message)) return;
  for (const l of priorWarningListeners) l(w);
});
const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DatabaseSync };

export const STORE_FILE = "graph.sqlite";

export function storePath(outDir: string): string {
  return join(outDir, GRAPH_DIR, STORE_FILE);
}

/** Cap on FTS5 candidates for an unscoped `ask`: the top hits by FTS5's own bm25
 * across name/path/body. graft's ranker re-scores them with its full heuristics; the
 * cap only bounds memory. 4,000 of 327k nodes was never observed to drop a top-8 hit. */
const CANDIDATE_LIMIT = 4000;
const IN_CHUNK = 500;
const FTS_TOKEN = /^[a-z0-9]+$/;

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function placeholders(n: number): string {
  return Array(n).fill("?").join(",");
}

/** Bag → the FTS5 document text: every token repeated by its count, so FTS5's
 * bm25 sees term frequency. Tokens FTS5's unicode61 tokenizer would split are
 * left out of the FTS text (they still live in the JSON bag graft scores with). */
function ftsText(bag: [string, number][]): string {
  const parts: string[] = [];
  for (const [t, c] of bag) {
    if (!FTS_TOKEN.test(t)) continue;
    for (let i = 0; i < Math.min(c, 8); i++) parts.push(t);
  }
  return parts.join(" ");
}

function stripBodyText(node: NodeV1): NodeV1 {
  if (node.body_text === undefined) return node;
  const { body_text: _body_text, ...rest } = node;
  return rest as NodeV1;
}

/**
 * Write the store from the in-memory build graph and the sidecar just built
 * from it. Atomic: written to a temp file and renamed over the old store.
 */
export function writeStore(graph: GraphV1, askIndex: AskIndex | null, outDir: string): string {
  const path = storePath(outDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  const db = new sqlite.DatabaseSync(tmp);
  try {
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = MEMORY;
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, lname TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX nodes_path ON nodes(path);
      CREATE INDEX nodes_lname ON nodes(lname);
      CREATE TABLE edges (source TEXT NOT NULL, relation TEXT NOT NULL, target TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX edges_source ON edges(source);
      CREATE INDEX edges_target ON edges(target);
      CREATE TABLE askdocs (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE askterms (term TEXT PRIMARY KEY, df INTEGER NOT NULL);
      CREATE VIRTUAL TABLE docfts USING fts5(id UNINDEXED, name, path, body, tokenize='unicode61');
    `);
    const meta = db.prepare("INSERT INTO meta (k, v) VALUES (?, ?)");
    const insNode = db.prepare("INSERT INTO nodes (id, name, lname, kind, path, data) VALUES (?, ?, ?, ?, ?, ?)");
    const insEdge = db.prepare("INSERT INTO edges (source, relation, target, data) VALUES (?, ?, ?, ?)");
    const insDoc = db.prepare("INSERT INTO askdocs (id, name, path, body) VALUES (?, ?, ?, ?)");
    const insTerm = db.prepare("INSERT INTO askterms (term, df) VALUES (?, ?)");
    const insFts = db.prepare("INSERT INTO docfts (id, name, path, body) VALUES (?, ?, ?, ?)");

    db.exec("BEGIN");
    meta.run("version", "1");
    meta.run("meta", JSON.stringify({ ...graph.meta, scopes: graph.meta.scopes ?? null }));
    for (const n of graph.nodes) {
      insNode.run(n.id, n.name, n.name.toLowerCase(), n.kind, n.path, JSON.stringify(stripBodyText(n)));
    }
    for (const e of graph.edges) insEdge.run(e.source, e.relation, e.target, JSON.stringify(e));
    if (askIndex) {
      meta.run("ask", JSON.stringify({ avgBodyLen: askIndex.avgBodyLen, docCount: askIndex.docCount }));
      for (const [t, df] of askIndex.df) insTerm.run(t, df);
      for (const d of askIndex.docs) {
        insDoc.run(d.id, JSON.stringify(d.name), JSON.stringify(d.path), JSON.stringify(d.body));
        insFts.run(d.id, ftsText(d.name), ftsText(d.path), ftsText(d.body));
      }
    }
    db.exec("COMMIT");
    db.exec("INSERT INTO docfts(docfts) VALUES ('optimize')");
    db.close();
    renameSync(tmp, path);
    return path;
  } catch (e) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(tmp, { force: true });
    throw e;
  }
}

interface NodeRow {
  data: string;
}
interface EdgeRow {
  data: string;
}
interface DocRow {
  id: string;
  name: string;
  path: string;
  body: string;
}

export class Store {
  private constructor(private readonly db: DatabaseSync, readonly path: string) {}

  static open(outDir: string): Store | null {
    const path = storePath(outDir);
    if (!existsSync(path)) return null;
    // A wiring.json newer than the store means something rewrote the graph after
    // the build (a crux checkpoint, a test, a hand edit): the store is stale, so
    // the JSON path answers until the next build writes both again.
    try {
      const wiring = join(outDir, GRAPH_DIR, "wiring.json");
      if (existsSync(wiring) && statSync(wiring).mtimeMs > statSync(path).mtimeMs) return null;
    } catch {
      /* fall through to opening the store */
    }
    try {
      const db = new sqlite.DatabaseSync(path, { readOnly: true });
      const v = db.prepare("SELECT v FROM meta WHERE k = 'version'").get() as { v: string } | undefined;
      if (v?.v !== "1") {
        db.close();
        return null;
      }
      return new Store(db, path);
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }

  meta(): GraphV1["meta"] {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = 'meta'").get() as { v: string };
    const m = JSON.parse(row.v);
    if (m.scopes === null) delete m.scopes;
    return m as GraphV1["meta"];
  }

  private askMeta(): { avgBodyLen: number; docCount: number } | null {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = 'ask'").get() as { v: string } | undefined;
    return row ? JSON.parse(row.v) : null;
  }

  private nodesByIds(ids: Iterable<string>): NodeV1[] {
    const out: NodeV1[] = [];
    for (const c of chunks([...ids], IN_CHUNK)) {
      const rows = this.db.prepare(`SELECT data FROM nodes WHERE id IN (${placeholders(c.length)})`).all(...c) as unknown as NodeRow[];
      for (const r of rows) out.push(JSON.parse(r.data));
    }
    return out;
  }

  private edgesTouching(ids: Iterable<string>, which: "both" | "in" | "out"): EdgeV1[] {
    const out: EdgeV1[] = [];
    const seen = new Set<string>();
    for (const c of chunks([...ids], IN_CHUNK)) {
      const ph = placeholders(c.length);
      const sql =
        which === "in"
          ? `SELECT data FROM edges WHERE target IN (${ph})`
          : which === "out"
            ? `SELECT data FROM edges WHERE source IN (${ph})`
            : `SELECT data FROM edges WHERE source IN (${ph}) UNION ALL SELECT data FROM edges WHERE target IN (${ph})`;
      const rows = this.db.prepare(sql).all(...(which === "both" ? [...c, ...c] : c)) as unknown as EdgeRow[];
      for (const r of rows) {
        if (seen.has(r.data)) continue;
        seen.add(r.data);
        out.push(JSON.parse(r.data));
      }
    }
    return out;
  }

  private docsByIds(ids: Iterable<string>): AskIndexDoc[] {
    const out: AskIndexDoc[] = [];
    for (const c of chunks([...ids], IN_CHUNK)) {
      const rows = this.db.prepare(`SELECT id, name, path, body FROM askdocs WHERE id IN (${placeholders(c.length)})`).all(...c) as unknown as DocRow[];
      for (const r of rows) out.push({ id: r.id, name: JSON.parse(r.name), path: JSON.parse(r.path), body: JSON.parse(r.body) });
    }
    return out;
  }

  /** Nodes + edges + the foreign endpoints those edges reach, as a graph. */
  private assemble(seed: NodeV1[], edges: EdgeV1[]): GraphV1 {
    const byId = new Map(seed.map((n) => [n.id, n]));
    const missing = new Set<string>();
    for (const e of edges) {
      if (!byId.has(e.source)) missing.add(e.source);
      if (!byId.has(e.target)) missing.add(e.target);
    }
    for (const n of this.nodesByIds(missing)) byId.set(n.id, n);
    const nodes = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { meta: { ...this.meta(), nodeCount: nodes.length, edgeCount: edges.length }, nodes, edges };
  }

  /** Every node under `prefix` (a normalized repo-relative path prefix), the edges
   * touching them, and the foreign endpoints — the same shape as a scope shard. */
  scopeGraph(prefix: string): GraphV1 {
    const p = prefix.replace(/\/+$/, "");
    const rows = this.db
      .prepare("SELECT data FROM nodes WHERE path = ? OR (path >= ? AND path < ?)")
      .all(p, `${p}/`, `${p}0`) as unknown as NodeRow[]; // '0' is the character after '/'
    const seed: NodeV1[] = rows.map((r) => JSON.parse(r.data));
    const edges = this.edgesTouching(seed.map((n) => n.id), "both");
    return this.assemble(seed, edges);
  }

  /** The sidecar slice for `graph`'s nodes. Under `--in` graft recomputes IDF from
   * the slice itself, so `df` is left empty; `docCount`/`avgBodyLen` are global. */
  askIndexFor(graph: GraphV1): AskIndex | null {
    const am = this.askMeta();
    if (!am) return null;
    const docs = this.docsByIds(graph.nodes.map((n) => n.id));
    return { version: 1, avgBodyLen: am.avgBodyLen, df: [], docCount: am.docCount, docs };
  }

  /**
   * The corpus an unscoped `ask` needs: the best {@link CANDIDATE_LIMIT} nodes by
   * FTS5 bm25 for the query's tokens, plus exact-name matches for the query's
   * words (structural mode's subjects), plus each candidate's file node, plus the
   * edges INTO all of those and the nodes at their far ends (so in-degree and
   * PageRank see the same neighbours the full graph would show). The sidecar
   * slice carries the GLOBAL `df` for every term in the candidates' bags, so IDF
   * is identical to the full-corpus computation.
   */
  candidateCorpus(terms: string[], subjectWords: string[]): { graph: GraphV1; askIndex: AskIndex | null } {
    const ids = new Set<string>();
    const ftsTerms = [...new Set(terms.filter((t) => FTS_TOKEN.test(t)))];
    if (ftsTerms.length) {
      const match = ftsTerms.map((t) => `"${t}"`).join(" OR ");
      const rows = this.db
        .prepare("SELECT id FROM docfts WHERE docfts MATCH ? ORDER BY rank LIMIT ?")
        .all(match, CANDIDATE_LIMIT) as { id: string }[];
      for (const r of rows) ids.add(r.id);
    }
    const words = [...new Set(subjectWords.map((w) => w.toLowerCase()).filter(Boolean))];
    for (const c of chunks(words, IN_CHUNK)) {
      const rows = this.db.prepare(`SELECT id FROM nodes WHERE lname IN (${placeholders(c.length)})`).all(...c) as { id: string }[];
      for (const r of rows) ids.add(r.id);
    }
    const seed = this.nodesByIds(ids);
    // each candidate's file node, so file-first ranking has the file to round-robin on
    const paths = [...new Set(seed.filter((n) => n.kind !== "file").map((n) => n.path))];
    for (const c of chunks(paths, IN_CHUNK)) {
      const rows = this.db
        .prepare(`SELECT data FROM nodes WHERE kind = 'file' AND path IN (${placeholders(c.length)})`)
        .all(...c) as unknown as NodeRow[];
      for (const r of rows) {
        const n = JSON.parse(r.data) as NodeV1;
        if (!ids.has(n.id)) {
          ids.add(n.id);
          seed.push(n);
        }
      }
    }
    // Both directions: graph-rank rescues a neighbour the query never named through
    // its connectivity, so the candidates' out-edges and their far ends must be here too.
    const edges = this.edgesTouching(ids, "both");
    const graph = this.assemble(seed, edges);

    const am = this.askMeta();
    let askIndex: AskIndex | null = null;
    if (am) {
      const docs = this.docsByIds(graph.nodes.map((n) => n.id));
      const termSet = new Set<string>();
      for (const d of docs) {
        for (const [t] of d.name) termSet.add(t);
        for (const [t] of d.path) termSet.add(t);
        for (const [t] of d.body) termSet.add(t);
      }
      for (const t of terms) termSet.add(t);
      const df: [string, number][] = [];
      for (const c of chunks([...termSet], IN_CHUNK)) {
        const rows = this.db.prepare(`SELECT term, df FROM askterms WHERE term IN (${placeholders(c.length)})`).all(...c) as { term: string; df: number }[];
        for (const r of rows) df.push([r.term, r.df]);
      }
      askIndex = { version: 1, avgBodyLen: am.avgBodyLen, df, docCount: am.docCount, docs };
    }
    return { graph, askIndex };
  }

  /** The nodes a `callers`/`callees` query can start from — same spellings
   * `resolveSymbol` accepts: exact name, `Type.method`'s last segment, a file path
   * or basename — then the edge neighbourhood `depth` hops away (Infinity = closure). */
  symbolNeighborhood(query: string, direction: "in" | "out", depth: number, inPrefix?: string): GraphV1 {
    const lq = query.toLowerCase();
    const last = lq.includes(".") ? lq.slice(lq.lastIndexOf(".") + 1) : lq;
    const startRows = this.db
      .prepare("SELECT data FROM nodes WHERE lname = ? OR lname = ? OR path = ? OR path LIKE ? OR id = ?")
      .all(lq, last, query, `%/${query}`, query) as unknown as NodeRow[];
    let seed: NodeV1[] = startRows.map((r) => JSON.parse(r.data));
    if (inPrefix) {
      const p = inPrefix.replace(/\/+$/, "");
      seed = seed.filter((n) => n.path === p || n.path.startsWith(`${p}/`));
    }
    const nodeIds = new Set(seed.map((n) => n.id));
    const edges: EdgeV1[] = [];
    const seenEdge = new Set<string>();
    let frontier = [...nodeIds];
    // files: a file-level start walks its members first, as impactOfFile does
    const memberIds = seed.filter((n) => n.kind === "file").length
      ? (this.db
          .prepare(`SELECT id FROM nodes WHERE path IN (${placeholders(seed.filter((n) => n.kind === "file").length)}) AND kind != 'file'`)
          .all(...seed.filter((n) => n.kind === "file").map((n) => n.path)) as { id: string }[]).map((r) => r.id)
      : [];
    for (const id of memberIds) if (!nodeIds.has(id)) { nodeIds.add(id); frontier.push(id); }
    let hops = 0;
    const maxHops = Number.isFinite(depth) ? Math.max(1, depth) : 64;
    while (frontier.length && hops < maxHops && nodeIds.size < 50000) {
      const step = this.edgesTouching(frontier, direction === "in" ? "in" : "out");
      const next: string[] = [];
      for (const e of step) {
        const key = `${e.source} ${e.relation} ${e.target}`;
        if (seenEdge.has(key)) continue;
        seenEdge.add(key);
        edges.push(e);
        const other = direction === "in" ? e.source : e.target;
        if (!nodeIds.has(other)) {
          nodeIds.add(other);
          next.push(other);
        }
      }
      frontier = next;
      hops++;
    }
    // `contains` edges of every node, so file-level grouping in the report resolves
    edges.push(...this.edgesTouching(nodeIds, "in").filter((e) => e.relation === "contains" && !seenEdge.has(`${e.source} ${e.relation} ${e.target}`)));
    const nodes = this.nodesByIds(nodeIds);
    return this.assemble(nodes, edges);
  }

  /**
   * Unscoped `grep` prefilter: the files whose indexed token bags (name, path,
   * body residual) contain EVERY given token. A literal like `fields/search`
   * tokenizes to `fields` + `search`; only files carrying both are then read
   * and regex-scanned, instead of all 47k. Bodies are capped at 5,000 chars per
   * symbol, so a literal deep in a very long function can be missed — the CLI
   * says how many files were scanned so a zero-hit result is never silent.
   */
  filesForTokens(tokens: string[]): string[] {
    const ts = [...new Set(tokens.filter((t) => FTS_TOKEN.test(t)))];
    if (!ts.length) return [];
    const match = ts.map((t) => `"${t}"`).join(" AND ");
    const rows = this.db
      .prepare("SELECT DISTINCT n.path AS path FROM docfts f JOIN nodes n ON n.id = f.id WHERE docfts MATCH ?")
      .all(match) as unknown as { path: string }[];
    return [...new Set(rows.map((r) => r.path))].sort();
  }

  /** The file nodes for `paths` plus every symbol in them — what `grepGraph` needs. */
  filesGraph(paths: string[]): GraphV1 {
    const nodes: NodeV1[] = [];
    for (const c of chunks(paths, IN_CHUNK)) {
      const rows = this.db.prepare(`SELECT data FROM nodes WHERE path IN (${placeholders(c.length)})`).all(...c) as unknown as NodeRow[];
      for (const r of rows) nodes.push(JSON.parse(r.data));
    }
    nodes.sort((a, b) => a.id.localeCompare(b.id));
    const edges = this.edgesTouching(nodes.map((n) => n.id), "in");
    return this.assemble(nodes, edges);
  }

  /** The nodes of one file, matched as an exact path then as a basename. */
  fileGraph(file: string): GraphV1 {
    let rows = this.db.prepare("SELECT data FROM nodes WHERE path = ?").all(file) as unknown as NodeRow[];
    if (!rows.length) rows = this.db.prepare("SELECT data FROM nodes WHERE path LIKE ?").all(`%/${file}`) as unknown as NodeRow[];
    const nodes: NodeV1[] = rows.map((r) => JSON.parse(r.data));
    return { meta: { ...this.meta(), nodeCount: nodes.length, edgeCount: 0 }, nodes, edges: [] };
  }
}

const storeCache = new Map<string, Store | null>();

/** Open (once per process) the store at `outDir`, or null when the build predates it. */
export function openStore(outDir: string): Store | null {
  if (!storeCache.has(outDir)) storeCache.set(outDir, Store.open(outDir));
  return storeCache.get(outDir)!;
}
