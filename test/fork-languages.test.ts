/**
 * The languages the Sisense fork added to the generic tier (2026-09-16): Jenkins
 * groovy, shell, SQL, Terraform, protobuf, and the two config/doc formats — YAML and
 * Markdown — whose keys and headings become symbols so `ask` can reach a switch that
 * lives in a values.yaml or a doc.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { warmGenericGrammars, extractGeneric, genericLangOf } from "../src/graph/generic.js";
import { skippedFile } from "../src/ingest/fs.js";
import { extractFile } from "../src/graph/extract.js";

test("python module-level UPPER_SNAKE assignments are constant symbols; locals and lowercase are not", () => {
  const src = 'import os\nUSE_LLM_GW = os.environ.get("USE_LLM_GW", "False")\nlogger = get_logger()\n\ndef f():\n    LOCAL_X = 1\n    return LOCAL_X\n';
  const r = extractFile("ai_services/llm_factory.py", src, "python");
  const names = r.nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.name}`).sort();
  assert.deepEqual(names, ["constant:USE_LLM_GW", "function:f"]);
  const c = r.nodes.find((n) => n.name === "USE_LLM_GW")!;
  assert.equal(c.span, "L2-L2");
  assert.ok(c.body_text?.includes("environ"));
});

test("lockfiles and build artefacts are never walked", () => {
  for (const f of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "poetry.lock", "go.sum", "Chart.lock", "app.min.js", "bundle.js.map", "CHANGELOG.md", "CHANGELOG-v2.md", "RELEASE_NOTES.md"])
    assert.ok(skippedFile(f), `${f} should be skipped`);
  for (const f of ["values.yaml", "package.json", "lock.ts", "minutes.md", "map.ts"]) assert.ok(!skippedFile(f), `${f} is source`);
});

test("yaml symbols stop at the second level of keys", async () => {
  await warmGenericGrammars(["yaml"]);
  const r = extractGeneric("values.yaml", "a:\n  b:\n    c: 1\n  d: 2\ne: 3\n", "yaml");
  assert.deepEqual(r.nodes.filter((n) => n.kind !== "file").map((n) => n.name).sort(), ["a", "b", "d", "e"]);
});

const LANGS = ["groovy", "bash", "sql", "hcl", "proto", "markdown", "yaml", "json"];

test("every added extension routes to its generic language", () => {
  const cases: Record<string, string> = {
    "vars/GlobalVars.groovy": "groovy", "build.gradle": "groovy", "ci/run.sh": "bash",
    "db/schema.sql": "sql", "infra/main.tf": "hcl", "api/v1.proto": "proto",
    "docs/INFRA.md": "markdown", "charts/values.yaml": "yaml", ".gitlab-ci.yml": "yaml",
    "libs/sdk-assistant/package.json": "json",
  };
  assert.equal(genericLangOf("fixtures/data.json"), null, "general JSON stays out of the index");
  assert.equal(genericLangOf("package-lock.json"), null);
  for (const [p, lang] of Object.entries(cases)) assert.equal(genericLangOf(p)?.name, lang, p);
});

test("the grammars load and each query yields the declarations a code question would name", async () => {
  await warmGenericGrammars(LANGS);
  const names = (rel: string, src: string, lang: string) =>
    extractGeneric(rel, src, lang).nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.name}`);

  assert.deepEqual(
    names("vars/release.groovy", "def deployService(String name) {\n  sh \"helm upgrade ${name}\"\n}\nclass GlobalVars {\n  static String region = 'us'\n}\n", "groovy").sort(),
    ["class:GlobalVars", "method:deployService", "variable:region"],
  );
  assert.deepEqual(
    names("ci/run.sh", "#!/bin/bash\nREGION=us-east-1\nsync_repo() {\n  git fetch\n}\nsync_repo\n", "bash").sort(),
    ["function:sync_repo", "variable:REGION"],
  );
  const sql = names("db/schema.sql", "CREATE TABLE builds (\n  id INT,\n  status VARCHAR(10)\n);\n", "sql");
  assert.ok(sql.includes("class:builds"), sql.join(" | "));
  assert.ok(sql.includes("variable:status"), sql.join(" | "));
  const tf = names("infra/main.tf", 'resource "aws_sns_topic" "alerts" {\n  name = "cloudops-alerts"\n}\n', "hcl");
  assert.ok(tf.includes("module:resource"), tf.join(" | "));
  assert.ok(tf.includes("variable:name"), tf.join(" | "));
  const md = names("docs/INFRA.md", "# LLM backends\n\nllm-gw is the primary backend.\n\n## USE_LLM_GW=false\n\nDirect Azure.\n", "markdown");
  assert.ok(md.includes("module:LLM backends"), md.join(" | "));
  assert.ok(md.includes("module:USE_LLM_GW=false"), md.join(" | "));
  const yml = names("charts/values.yaml", "replicas: 2\nuse_llm_gw: true\nenv:\n  LLM_GATEWAY_URL: http://llm-gw:15106\n", "yaml");
  assert.deepEqual(yml.sort(), ["variable:LLM_GATEWAY_URL", "variable:env", "variable:replicas", "variable:use_llm_gw"]);
  // the body of a yaml key node carries its value, so `ask` matches on the value too
  const pair = extractGeneric("charts/values.yaml", "use_llm_gw: true\n", "yaml").nodes.find((n) => n.name === "use_llm_gw");
  assert.ok(pair?.body_text?.includes("true"));
  // package.json: top-level keys and every dependency name are symbols
  const pkg = names("libs/sdk-assistant/package.json", '{\n  "name": "@sisense/sdk-assistant",\n  "dependencies": {\n    "@sisense/sdk-ai-core": "workspace:*",\n    "react": "^18"\n  }\n}\n', "json");
  assert.deepEqual(pkg.sort(), ["variable:@sisense/sdk-ai-core", "variable:dependencies", "variable:name", "variable:react"]);
  // proto ships no query yet: the node-kind walker still yields the message
  const proto = names("api/v1.proto", 'syntax = "proto3";\nmessage StartBuildRequest {\n  string data_source_id = 1;\n}\n', "proto");
  assert.ok(proto.length >= 1, "proto walker produced no symbols");
});
