/**
 * A nested git clone is a scope even when its marker files sit one level down
 * (Sisense fork, 2026-09-16). Measured on the ~/work index: a Python monorepo with
 * pyproject.toml under projects/* and a Java one with pom.xml under be/ were not
 * scopes, so their hits carried no [repo/] label and `matched in:` said "(root)".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverScopes, scopeOf } from "../src/graph/scopes.js";

function fx(layout: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "fork-scopes-"));
  for (const [p, content] of Object.entries(layout)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  return dir;
}

test("a nested clone with only deep marker files is still a scope, by its .git", () => {
  const d = fx({
    "backend/ai-services/.git": "gitdir: /elsewhere",
    "backend/ai-services/projects/llm-gw/pyproject.toml": "[project]\nname='llm-gw'",
    "backend/ai-services/projects/llm-gw/app.py": "def main():\n    pass\n",
    "backend/auth-service/package.json": "{}",
    "backend/auth-service/src/a.ts": "export const a = 1;",
  });
  try {
    const scopes = discoverScopes(d);
    assert.deepEqual(scopes.map((s) => s.prefix).sort(), ["backend/ai-services", "backend/auth-service"]);
    assert.equal(scopeOf("backend/ai-services/projects/llm-gw/app.py", scopes).label, "backend/ai-services");
    assert.ok(scopes.find((s) => s.prefix === "backend/ai-services")!.markers.includes(".git"));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
