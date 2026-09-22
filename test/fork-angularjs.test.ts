/**
 * AngularJS-era JavaScript shapes (benchmark run 10 on PrismWebClient): the API of
 * a `mod.service('x', [deps, function () { this.foo = function () {} }])` file
 * lives in member assignments and a registrar call, not in declarations, so
 * `skeleton` and `callers` saw nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractFile } from "../src/graph/extract.js";
import { buildGraph } from "../src/graph/build.js";
import { loadGraphCached } from "../src/graph/load.js";

const SERVICE = `mod.service('$command', [
    '$injector',
    function ($injector) {
        this.create = function (name, initargs) {
            return $injector.instantiate(name, initargs);
        };
        this.execute = function (name, initargs, commandargs) {
            var command = this.create(name, initargs);
            return command.execute(commandargs);
        };
    },
]);
`;

test("member-assigned functions and the registrar call become symbols", () => {
  const r = extractFile("src/base.module/services/$command.js", SERVICE, "typescript");
  const names = r.nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.name}`).sort();
  assert.deepEqual(names, ["method:create", "method:execute", "module:$command"]);
  const create = r.nodes.find((n) => n.name === "create")!;
  assert.equal(create.span, "L4-L6");
  assert.ok(create.id.endsWith("#$command.create"), create.id);
  const exec = r.nodes.find((n) => n.name === "execute")!;
  assert.equal(exec.span, "L7-L10");
});

test("`me.x = function` and `Ctor.prototype.x = function` are methods; plain value assignments are not", () => {
  const src = "var me = this;\nme.unmergeMembers = function (a, b) {\n  return a;\n};\nme.count = 3;\nFoo.prototype.run = () => 1;\n";
  const r = extractFile("svc.js", src, "typescript");
  assert.deepEqual(
    r.nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.name}:${n.span}`).sort(),
    ["method:run:L6-L6", "method:unmergeMembers:L2-L4"],
  );
});

test("a call on a member-assigned method resolves to an edge, so `callers` can answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-fork-ng-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "src/svc.js"), "mod.service('jaqlSvc', [function () {\n  var me = this;\n  me.unmergeMembers = function (a, b) {\n    return a;\n  };\n}]);\n");
    writeFileSync(join(dir, "src/model.js"), "mod.factory('filterItem', [function (jaqlSvc) {\n  return {\n    unmergeWith(item) {\n      return jaqlSvc.unmergeMembers(this.jaql, item);\n    },\n  };\n}]);\n");
    // a factory-inner plain function, exported through the returned object and called as a member
    writeFileSync(join(dir, "src/export.js"), "mod.factory('exportFactory', [function () {\n  function saveFileFromStream(response, name) {\n    return name;\n  }\n  return { saveFileFromStream };\n}]);\n");
    writeFileSync(join(dir, "src/ctrl.js"), "mod.controller('tablePreview', [function (exportFactory) {\n  this.download = function (response) {\n    return exportFactory.saveFileFromStream(response, 'x.pdf');\n  };\n}]);\n");
    await buildGraph(dir);
    const g = loadGraphCached(join(dir, "graft"))!;
    const target = g.nodes.find((n) => n.name === "unmergeMembers")!;
    assert.ok(target, "unmergeMembers node missing");
    const callers = g.edges.filter((e) => e.target === target.id && e.relation !== "contains").map((e) => e.source);
    assert.ok(callers.some((id) => id.endsWith("unmergeWith")), `callers: ${callers.join(" | ")}`);
    const fn = g.nodes.find((n) => n.name === "saveFileFromStream")!;
    const fnCallers = g.edges.filter((e) => e.target === fn.id && e.relation !== "contains").map((e) => e.source);
    assert.ok(fnCallers.some((id) => id.endsWith("download")), `saveFileFromStream callers: ${fnCallers.join(" | ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
