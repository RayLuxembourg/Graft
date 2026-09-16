/**
 * Ranking regressions from the 2026-09-16 graft-vs-MCP benchmark (run 7). Each case
 * is a query that stock 0.18.0 got wrong against the ~/work index, reduced to the
 * smallest fixture that reproduces it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { ask, isGeneratedPath, isExamplePath } from "../src/ask/ask.js";
import { stem, tokenize, tokenizeName } from "../src/ask/index-file.js";

test("stem: plurals and verb forms meet their identifier token, conservatively", () => {
  assert.deepEqual(
    ["tokens", "calls", "builds", "building", "triggered", "verifies", "verified", "verifying", "classes"].map(stem),
    ["token", "call", "build", "build", "trigger", "verify", "verify", "verify", "class"],
  );
  // never below 3 chars, never the ss/us/is endings, digits untouched
  assert.deepEqual(["is", "css", "status", "analysis", "2024", "seed"].map(stem), ["is", "css", "status", "analysis", "2024", "seed"]);
});

test("tokenize: query filler is dropped, tokens are stemmed", () => {
  assert.deepEqual(tokenize("where are Azure LLM calls made"), ["azure", "llm", "call"]);
  assert.deepEqual(tokenize("how does auth-service verify tokens"), ["auth", "service", "verify", "token"]);
});

test("tokenizeName: adjacent pairs join, so a camelCase compound is findable by its natural spelling", () => {
  assert.deepEqual(tokenizeName("AzureOpenAi"), ["azure", "open", "ai", "azureopen", "openai"]);
  assert.deepEqual(tokenizeName("verifyAccessToken"), ["verify", "access", "token", "verifyaccess", "accesstoken"]);
  assert.deepEqual(tokenizeName("main"), ["main"]);
});

test("isGeneratedPath / isExamplePath: bundler output and example code, nothing else", () => {
  for (const p of [
    "packages/ui/storybook-static/sb-manager/chunk-XE6LDGTE.js",
    "public/vendor/lib.min.js",
    "dist-web/chunk-5QAFKPS7.js",
    "app/.next/static/x.js",
  ]) assert.ok(isGeneratedPath(p), `${p} is generated`);
  for (const p of ["src/chunks/chunkLoader.ts", "src/minify.ts", "src/sb-managerial.ts"]) assert.ok(!isGeneratedPath(p), `${p} is source`);
  for (const p of ["llm-gw/examples/compare_responses.py", "packages/sdk-ui/src/__demo__/page.tsx", "tests/fixtures/a.ts"])
    assert.ok(isExamplePath(p), `${p} is example code`);
  for (const p of ["src/example_service.ts", "src/demo.ts", "src/sample.py"]) assert.ok(!isExamplePath(p), `${p} is source`);
});

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-fork-rank-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

test("an exact full-name match outranks a repeated path token in another package", async () => {
  // Stock: `webAccessTokens/tokenConfiguration/` scored "token"×3 at ×2 path weight and
  // beat `verifyAccessToken` even for the query `verifyAccessToken`.
  const dir = fixture({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/vnext/package.json": "{}",
    "packages/vnext/src/webAccessTokens/tokenConfiguration/tokenConfiguration.service.js":
      "export const isWebAccessTokenRequest = (headers = {}) => { return 'x' in headers; };\n" +
      "export const createTokenConfiguration = async (token) => { return token; };\n",
    "packages/auth/package.json": "{}",
    "packages/auth/src/services/sign/sign.service.ts":
      "export class SignService {\n  async verifyAccessToken(token: string): Promise<string> {\n    const key = 'k';\n    return token + key;\n  }\n  async mintToken(payload: string): Promise<string> { return payload; }\n}\n",
  });
  try {
    await buildGraph(dir);
    for (const q of ["verifyAccessToken", "verify access token", "how are access tokens verified"]) {
      const r = await ask(dir, q, { limit: 5 });
      assert.equal(r.hits[0]?.title.split(" ")[0], "verifyAccessToken", `query "${q}" → ${r.hits.map((h) => h.title).join(" | ")}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a camelCase compound is found by its natural spelling, and example code ranks below production code", async () => {
  const dir = fixture({
    "package.json": "{}",
    "src/llm_factory_types.py": "class AzureOpenAi:\n    def __init__(self, chat_id):\n        self.client = None\n\n    def complete(self, prompt):\n        return prompt\n",
    "examples/compare_responses.py": "class Comparator:\n    def call_azure_openai(self, messages):\n        return messages\n",
  });
  try {
    await buildGraph(dir);
    const r = await ask(dir, "azure openai client", { limit: 5 });
    assert.equal(r.hits[0]?.title.split(" ")[0], "AzureOpenAi", r.hits.map((h) => h.title).join(" | "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a scope name in the query narrows to that scope and leaves the query", async () => {
  // Two sibling repos under one root, each with its own marker — the multi-scope shape
  // graph-scopes.test.ts pins ("frontend/backend markers under one git root").
  // Each scope needs enough symbols to survive build.ts's min-substance guard.
  const filler = (p: string) => Array.from({ length: 8 }, (_, i) => `export function ${p}Helper${i}(x: number) { return x + ${i}; }\n`).join("");
  const dir = fixture({
    "auth-service/package.json": "{}",
    "auth-service/src/sign.ts": "export function verifyAccessToken(token: string) { return token; }\n" + filler("sign"),
    "api-gateway/package.json": "{}",
    "api-gateway/src/verify.ts": "export function verifyAuthServiceToken(token: string) { return token; }\nexport function authServiceTokenCheck(t: string) { return t; }\n" + filler("gw"),
  });
  try {
    await buildGraph(dir);
    const r = await ask(dir, "how does auth-service verify tokens", { limit: 5 });
    assert.ok(r.hits.length > 0);
    for (const h of r.hits) assert.ok(h.pointer.startsWith("auth-service/"), `hit outside the named scope: ${h.pointer}`);
    assert.equal(r.hits[0]?.title.split(" ")[0], "verifyAccessToken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
