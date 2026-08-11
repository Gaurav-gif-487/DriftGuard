import test from "node:test";
import assert from "node:assert";
import { buildSarifReport, buildMarkdownComment, buildImpactMarkdownComment } from "../src/sarif.js";
import type { DriftReport } from "../src/types.js";
import { ContractGraph } from "../src/graph/ContractGraph.js";
import { GraphDiffEngine } from "../src/diff/GraphDiff.js";
import { ImpactEngine } from "../src/impact/ImpactEngine.js";

function makeReport(): DriftReport {
  return {
    match: {
      client: {
        id: "c1",
        method: "GET",
        route: { raw: "/api/v1/users/:id", segments: [] },
        dynamic: false,
        expectedSchema: null,
        framework: "axios",
        location: { file: "/repo/frontend/src/api/userClient.ts", line: 12, column: 5 },
      },
      server: {
        id: "s1",
        method: "GET",
        route: { raw: "/api/v1/users/:id", segments: [] },
        responseSchema: null,
        framework: "express",
        location: { file: "/repo/backend/src/routes/users.ts", line: 4, column: 1 },
      },
      confidence: 1.0,
      strategy: "exact",
    },
    violations: [
      {
        kind: "missing-field",
        severity: "error",
        path: "email",
        message: "Required field 'email' is missing from the server response.",
      },
    ],
  };
}

test("sarif: emits a schema-conformant top-level structure", () => {
  const report = buildSarifReport([makeReport()]) as any;
  assert.equal(report.version, "2.1.0");
  assert.equal(report.$schema.includes("sarif-schema-2.1.0"), true);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].tool.driver.name, "driftguard");
});

test("sarif: one result per violation, with a physical location relative to baseDir", () => {
  const report = buildSarifReport([makeReport()], { baseDir: "/repo" }) as any;
  const results = report.runs[0].results;
  assert.equal(results.length, 1);
  assert.equal(results[0].ruleId, "missing-field");
  assert.equal(results[0].level, "error");
  assert.equal(results[0].locations[0].physicalLocation.artifactLocation.uri, "frontend/src/api/userClient.ts");
  assert.equal(results[0].locations[0].physicalLocation.region.startLine, 12);
});

test("sarif: regression — a leading slash is not merely stripped, the uri is actually relative to baseDir (GitHub code scanning resolves uris against the repo checkout root)", () => {
  const report = buildSarifReport([makeReport()], { baseDir: "/some/other/checkout/root" }) as any;
  const uri = report.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
  // Before the fix this was "repo/frontend/src/api/userClient.ts" (leading
  // slash merely stripped from the absolute path) regardless of baseDir —
  // a URI that doesn't correspond to any real file relative to a checkout
  // rooted elsewhere. It must now correctly walk back out via "..".
  assert.equal(uri, "../../../../repo/frontend/src/api/userClient.ts");
});

test("sarif: rules array is de-duplicated across repeated violation kinds", () => {
  const r1 = makeReport();
  const r2 = makeReport();
  r2.violations = [{ kind: "missing-field", severity: "error", path: "id", message: "x" }];
  const report = buildSarifReport([r1, r2]) as any;
  const ruleIds = report.runs[0].tool.driver.rules.map((r: any) => r.id);
  assert.deepEqual(ruleIds, ["missing-field"]);
  assert.equal(report.runs[0].results.length, 2);
});

test("sarif: reports with zero violations produce zero results", () => {
  const clean: DriftReport = { match: makeReport().match, violations: [] };
  const report = buildSarifReport([clean]) as any;
  assert.equal(report.runs[0].results.length, 0);
  assert.equal(report.runs[0].tool.driver.rules.length, 0);
});

test("sarif: unresolved-route findings default to 'note' severity in rule metadata", () => {
  const unresolvedReport: DriftReport = {
    match: null,
    unresolvedClient: makeReport().match!.client,
    violations: [
      {
        kind: "unresolved-route",
        severity: "note",
        path: "",
        message: "Could not resolve.",
      },
    ],
  };
  const report = buildSarifReport([unresolvedReport]) as any;
  assert.equal(report.runs[0].results[0].level, "note");
  assert.equal(report.runs[0].tool.driver.rules[0].defaultConfiguration.level, "note");
});

test("markdown: clean run renders a success summary with no violation sections", () => {
  const clean: DriftReport = { match: makeReport().match, violations: [] };
  const out = buildMarkdownComment([clean], { durationMs: 12.3 });
  assert.match(out, /no breaking API driftguard detected/);
  assert.doesNotMatch(out, /<details>/);
  assert.match(out, /12\.3ms/);
});

test("markdown: violations render as collapsible sections with severity counts", () => {
  const out = buildMarkdownComment([makeReport()], { durationMs: 34.7 });
  assert.match(out, /1 error\(s\) · 0 warning\(s\) · 0 note\(s\)/);
  assert.match(out, /<details>/);
  assert.match(out, /missing-field/);
  assert.match(out, /GET \/api\/v1\/users\/:id/);
  assert.match(out, /34\.7ms/);
});

test("markdown: unresolved routes without a match still render a header", () => {
  const unresolvedReport: DriftReport = {
    match: null,
    unresolvedClient: makeReport().match!.client,
    violations: [
      { kind: "unresolved-route", severity: "note", path: "", message: "Could not resolve." },
    ],
  };
  const out = buildMarkdownComment([unresolvedReport]);
  assert.match(out, /GET \/api\/v1\/users\/:id/);
  assert.match(out, /unresolved-route/);
});

const meta = (accessedProperties: string[] = []) => ({ confidence: 100, evidence: [], accessedProperties });

/** A rename (email -> emailAddress) with one BREAKING consumer still on the old field. */
function breakingImpactReport() {
  const b = new ContractGraph(), c = new ContractGraph();
  b.addNode({ id: "contract:User", type: "contract", name: "User", file: "types.ts", shape: { kind: "object", fields: { email: { type: { kind: "primitive", name: "string" }, optional: false, nullable: false } } }, metadata: meta() });
  c.addNode({ id: "contract:User", type: "contract", name: "User", file: "types.ts", shape: { kind: "object", fields: { emailAddress: { type: { kind: "primitive", name: "string" }, optional: false, nullable: false } } }, metadata: meta() });
  c.addNode({ id: "consumer:a", type: "consumer", name: "A", file: "client/a.ts", location: { line: 7, column: 1 }, metadata: meta(["email"]) });
  c.addEdge({ id: "e1", from: "contract:User", to: "consumer:a", relation: "consumes", confidence: 100, evidence: [], resolutionMethod: "exact" });
  const changes = GraphDiffEngine.compareGraphs(b, c);
  return ImpactEngine.evaluateImpact("main", "worktree", changes, c);
}

test("impact markdown: surfaces proofLevel per impact line", () => {
  const out = buildImpactMarkdownComment(breakingImpactReport(), { baseDir: "/repo" });
  assert.match(out, /\(proof: (PROVEN|LIKELY|POTENTIAL|UNKNOWN)\)/);
});

test("impact markdown: renders a verdict and next-actions section for a breaking report", () => {
  const out = buildImpactMarkdownComment(breakingImpactReport(), { baseDir: "/repo" });
  assert.match(out, /\*\*Verdict:\*\* FAIL/);
  assert.match(out, /<summary>Next actions<\/summary>/);
  assert.match(out, /--rename=Contract\.old->new or --widen-optional=Contract\.field/);
  assert.match(out, /client\/a\.ts:7/);
});

test("impact markdown: a clean report still shows the verdict block with 'No further action required'", () => {
  const g = new ContractGraph();
  const report = ImpactEngine.evaluateImpact("main", "worktree", [], g);
  const out = buildImpactMarkdownComment(report, { baseDir: "/repo" });
  assert.match(out, /\*\*Verdict:\*\* PASS/);
  assert.match(out, /No further action required\./);
});
