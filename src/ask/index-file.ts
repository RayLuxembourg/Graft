/**
 * Build-time sidecar for `graft ask` — `<outDir>/.cache/ask-index.json`.
 *
 * `ask`'s lexical pass tokenizes every symbol node's name/path/body on every
 * query; at 32k nodes that re-tokenization is ~45% of query time (profiled).
 * `graft build` writes this sidecar once, with the token→count bags per node
 * plus the corpus-wide document frequencies, so a query just reads counts
 * instead of re-splitting every node's text. It's a derived cache, not
 * checked-in graph data, so it lives under the gitignored `.cache/` dir
 * (see `CACHE_DIR` in `context/node-file.ts`) rather than `.graph/`.
 *
 * `tokenize`/`counts` live here (not duplicated in `ask.ts`) so build-time and
 * query-time text-splitting are provably the same function — the sidecar can
 * only be a correct cache of `ask.ts`'s own math if both sides call the same
 * code. `ask.ts` imports both back from here.
 *
 * Concept (markdown) docs are NOT part of this sidecar — there are only dozens
 * of them, they're still tokenized live at query time, and their doc-frequency
 * contribution is folded into the stored `df` at query time (see `ask.ts`),
 * which is why `df` here counts symbol/file nodes only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GraphV1 } from "../graph/types.js";
import { CACHE_DIR } from "../context/node-file.js";

/** Words too common/short to carry query intent — dropped before scoring. */
const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "is", "are", "how", "does", "do", "what",
  "where", "which", "that", "this", "it", "for", "on", "and", "or", "with",
  // "get" / "set" / "use" were stopwords upstream. They are also the first token of half
  // the identifiers in a codebase (useState, getUser, USE_LLM_GW), and dropping them cost
  // the exact match: `USE_LLM_GW` tied with `llm_gw_url`. idf already makes a common
  // token near-weightless, so they stay; only prose filler is dropped.
  "i", "we", "used", "using", "when", "why", "can",
  // Query-intent filler. Left in, a rare filler word scores like a rare identifier:
  // "made" put `ChangesMadeFnOverride` first for "where are Azure LLM calls made".
  "made", "make", "makes", "be", "by", "from", "into", "at", "as", "its", "their",
  "all", "any", "about", "who", "if", "so", "then", "there", "here", "via", "through",
  "should", "would", "could", "will", "did", "done", "each", "every", "some", "than",
  "actually", "really", "today", "currently", "live",
]);

/** Light suffix stemming so a natural-language plural or verb form meets its
 * identifier token: "tokens"→"token" (verifyAccessToken), "calls"→"call"
 * (call_litellm_azure), "builds"/"building"→"build", "triggered"→"trigger",
 * "verifies"/"verified"/"verifying"→"verify". Deliberately conservative — never
 * below 3 chars, never touches "ss"/"us"/"is" endings, no vowel rules — because a
 * false merge costs precision on every query while a missed merge costs recall on
 * one. Runs inside `tokenize`, so build and query sides always agree. */
export function stem(t: string): string {
  if (t.length <= 3 || /^[0-9]+$/.test(t)) return t;
  if (t.endsWith("ies") && t.length > 4) return t.slice(0, -3) + "y";
  if (t.endsWith("ied") && t.length > 4) return t.slice(0, -3) + "y";
  if (t.endsWith("ying") && t.length > 5) return t.slice(0, -4) + "y";
  if (t.endsWith("ing") && t.length > 5) return t.slice(0, -3);
  if (t.endsWith("ed") && t.length > 4 && !t.endsWith("eed")) return t.slice(0, -2);
  if (t.endsWith("es") && t.length > 4 && /(s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith("s") && t.length > 3 && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

/** Split prose + identifiers into lowercased subword tokens (camelCase, snake, kebab),
 * stemmed. The single source of truth for tokenization — shared by build-time
 * indexing (this file) and query-time fallback (`ask.ts`) so the sidecar is a
 * provably exact cache of the live path. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** NAME-field tokens: the subword tokens plus each adjacent pair joined.
 * camelCase splitting turns `AzureOpenAi` into azure · open · ai, so a query
 * saying "openai" never met the class; the joined pair (`openai`) restores that,
 * and doubles as a phrase signal — a query's own bigrams (`verifyaccess`,
 * `accesstoken`) match only a name that carries the words in that order. Name
 * fields are short, so the sidecar grows by a few percent; path and body bags
 * are unchanged. */
export function tokenizeName(text: string): string[] {
  const toks = tokenize(text);
  const out = toks.slice();
  for (let i = 0; i + 1 < toks.length; i++) out.push(toks[i] + toks[i + 1]);
  return out;
}

/** Term-frequency count map. */
export function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** One node's token bags, JSON-friendly (`Map` → sorted `[token, count][]`). */
export interface AskIndexDoc {
  id: string;
  name: [string, number][];
  path: [string, number][];
  body: [string, number][];
}

/** The build-time sidecar. `df`/`docCount` cover symbol+file nodes only (no
 * concepts — see module docstring); `avgBodyLen` is the BM25 corpus average. */
export interface AskIndex {
  version: 1;
  avgBodyLen: number;
  df: [string, number][];
  docCount: number;
  docs: AskIndexDoc[];
}

export const ASK_INDEX_FILE = "ask-index.json";

/** Absolute path to the ask sidecar for a context dir: `<dir>/.cache/ask-index.json`.
 * `.cache/` is the established uncommitted-cache location — this sidecar is a
 * derived, regenerate-anytime cache, not checked-in graph data. */
export function askIndexPath(outDir: string): string {
  return join(outDir, CACHE_DIR, ASK_INDEX_FILE);
}

function pairs(m: Map<string, number>): [string, number][] {
  return [...m.entries()];
}

/** Sum of a token→count bag's counts (a document's field length). */
function bagLen(p: [string, number][]): number {
  let s = 0;
  for (const [, c] of p) s += c;
  return s;
}

/**
 * Tokenize every node in `graph` (exactly as `ask.ts`'s lexical pass does) and
 * write the resulting bags + document frequencies to
 * `<outDir>/.cache/ask-index.json`. Returns the path written. Deterministic:
 * nodes are indexed in id order, so an unchanged graph produces a
 * byte-identical sidecar.
 */
export function writeAskIndex(outDir: string, graph: GraphV1): string {
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const docs: AskIndexDoc[] = [];
  const df = new Map<string, number>();

  for (const n of nodes) {
    const name = counts(tokenizeName(n.name));
    const path = counts(tokenize(n.path));
    const body = counts(
      tokenize(`${n.signature ?? ""} ${n.summary ?? ""} ${n.body_text ?? ""}`),
    );
    docs.push({ id: n.id, name: pairs(name), path: pairs(path), body: pairs(body) });

    const bag = new Set<string>([...name.keys(), ...path.keys(), ...body.keys()]);
    for (const t of bag) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const avgBodyLen = docs.length
    ? docs.reduce((a, d) => a + bagLen(d.body), 0) / docs.length
    : 0;

  const index: AskIndex = {
    version: 1,
    avgBodyLen,
    df: pairs(df),
    docCount: nodes.length,
    docs,
  };

  const outPath = askIndexPath(outDir);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(index) + "\n");
  return outPath;
}

/** Read the ask sidecar. Returns null on a missing file, unparseable JSON, an
 * unrecognized shape, an unknown `version`, or a `docCount` that doesn't match
 * the number of docs actually stored (a corrupted/truncated sidecar would
 * otherwise silently skew IDF) — any of which means the caller should fall
 * back to live tokenization, never crash or trust bad data. */
export function readAskIndex(outDir: string): AskIndex | null {
  const path = askIndexPath(outDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (
      !raw ||
      typeof raw !== "object" ||
      raw.version !== 1 ||
      typeof raw.docCount !== "number" ||
      typeof raw.avgBodyLen !== "number" ||
      !Array.isArray(raw.df) ||
      !Array.isArray(raw.docs) ||
      raw.docCount !== raw.docs.length
    ) {
      return null;
    }
    return raw as AskIndex;
  } catch {
    return null;
  }
}
