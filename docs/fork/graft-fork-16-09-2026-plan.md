# graft fork — close the run-7 gaps (plan, 2026-09-16)

Fork: github.com/RayLuxembourg/Graft (from @nanonets/graft 0.18.0). Benchmark run 7 measured
graft against the sisense-knowledge MCP on five questions; graft won on tokens, time and
correctness but lost Q1 (a switch that lives in an env var / Helm value / doc) and never ranked
several real symbols first until six `dist/` patches were applied by hand. This plan moves those
patches into source, adds the languages `~/work` actually contains, and lets `ask` see docs and
config.

## Milestones

1. **Port the six dist patches into `src/`** (markers a–f in `~/brain/workstation/graft-patches/apply.py`).
   - `src/ask/index-file.ts`: `stem()`, extra stopwords, `tokenizeName()` (adjacent-pair compounds).
   - `src/ask/ask.ts`: generated-path penalty, example-path penalty, per-line char cap, binary path
     bag, name-match boost, query-side synonyms on the NAME score, query bigrams, repo-name → `--in`,
     `MAX_SPAN_LINES` 40.
   - `src/graph/scopes.ts`: `.git` as a scope marker.
   - Tests: `test/ask-index.test.ts` (stem/tokenizeName), `test/ask.test.ts` (ranking cases from
     the benchmark: `verifyAccessToken` beats a path-token collision; `AzureOpenAi` found by
     "openai"; storybook chunk and `examples/` de-ranked; repo name in query narrows).
2. **Languages present in `~/work` that graft skips** (counts from 2026-09-16):
   groovy 1,057 (Jenkins shared libs) · sql 2,300 · sh 265 · tf 98 · proto 63. Add generic-tier
   rows + `.scm` queries: `groovy`, `bash`, `sql`, `hcl` (.tf/.hcl), `proto`. Grammars are in
   `tree-sitter-wasm` already.
3. **Docs and config as searchable nodes** (the Q1 gap): `markdown` (.md, 4,236 files) and `yaml`
   (.yaml/.yml, 1,772) as generic-tier languages with queries that turn headings and top-level
   mapping keys into symbols; the file node keeps the residual. `USE_LLM_GW` in a values.yaml or an
   INFRA.md then scores in `ask` like any identifier. JSON is left out (16k files, mostly
   lockfiles/fixtures).
4. **Freshness without the 217s stall**: `ensureFreshGraph` refreshes inline only when the drift is
   small (≤ `GRAFT_INLINE_REFRESH_MAX`, default 25 files); above that it answers from the graph as-is
   and prints a one-line staleness warning naming the count and the `graft build` command.
5. **Ship**: version `0.18.0-sisense.1`, CHANGELOG, `npm run build && npm test`, install globally from
   the fork, rebuild `~/work` index, rerun the run-7 graft arm once (try 6) — Q1 must reach
   `USE_LLM_GW`; Q2–Q5 must not regress; tool tokens must stay ≤ 20k.

## Steps

- [ ] 1a port index-file.ts (+ tests)
- [ ] 1b port ask.ts (+ tests)
- [ ] 1c port scopes.ts (+ test)
- [ ] 2 GENERIC_LANGS rows + queries: groovy, bash, sql, hcl, proto
- [ ] 3 GENERIC_LANGS rows + queries: markdown, yaml
- [ ] 4 drift threshold in refresh.ts (+ test)
- [ ] 5 version/CHANGELOG, build, test, global install, index rebuild, try 6, brief update
- [ ] 6 brain: sync_repos.sh drops apply.py (source now carries the patches); notes updated

## Decisions

- Generic tier (wasm + `.scm`) for every new language rather than a hand-written depth extractor:
  one row + one query file each, and the walker fallback yields symbols even where the query is
  thin. Depth extractors are for languages whose call graph we need edges for; none of these are.
- JSON excluded from the text tier: volume without signal.
- The inline-refresh threshold is a behaviour change from upstream ("retrieval honest") — made
  explicit with the warning line and an env override, because a 217s stall on a shared machine
  is worse than a flagged stale answer.
