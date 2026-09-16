// Print the named node types a tree-sitter-wasm grammar produces for a sample file —
// used to write a queries/<lang>.scm without guessing node names.
//   node scripts/probe-grammar.mjs <wasm-name> <sample-file> [maxDepth]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const [wasm, file, depthArg] = process.argv.slice(2);
const maxDepth = Number(depthArg ?? 3);
const ts = await import("web-tree-sitter");
await ts.Parser.init();
const bytes = readFileSync(require.resolve(`tree-sitter-wasm/${wasm}/tree-sitter-${wasm}.wasm`));
const lang = await ts.Language.load(bytes);
const parser = new ts.Parser(); parser.setLanguage(lang);
const src = readFileSync(file, "utf8");
const tree = parser.parse(src);
const seen = new Map();
const visit = (n, d) => {
  if (d > maxDepth) return;
  const fields = [];
  for (let i = 0; i < n.childCount; i++) { const f = n.fieldNameForChild(i); if (f) fields.push(`${f}:${n.child(i).type}`); }
  const key = `${"  ".repeat(d)}${n.type}${fields.length ? "  [" + [...new Set(fields)].join(" ") + "]" : ""}`;
  seen.set(key, (seen.get(key) ?? 0) + 1);
  for (let i = 0; i < n.namedChildCount; i++) visit(n.namedChild(i), d + 1);
};
visit(tree.rootNode, 0);
for (const [k, v] of seen) console.log(String(v).padStart(4), k);
