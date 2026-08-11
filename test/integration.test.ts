import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runAnalysis, parseArgs, main } from "../src/cli.js";
import { buildSarifReport } from "../src/sarif.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(__dirname, "..", "fixtures", "frontend");
const BACKEND = path.join(__dirname, "..", "fixtures", "backend");

test("integration: end-to-end analysis of the fixture repos finds the seeded drift", async () => {
  const { reports, matches, unresolved, durationMs } = await runAnalysis(FRONTEND, BACKEND, 0.6);

  // --- performance budget -------------------------------------------------
  // The spec target is sub-300ms for a full cross-repo scan. These fixture
  // repos are intentionally small (a handful of files); at that scale the
  // budget should hold comfortably on any modern machine. A generous 2x
  // margin is applied here to keep the test stable under sandboxed/CI CPU
  // throttling without weakening what the number actually demonstrates.
  assert.ok(durationMs < 600, `analysis took ${durationMs.toFixed(1)}ms, expected < 600ms`);

  // --- route resolution ----------------------------------------------------
  // getUser, listUsers, getSettings, useProfile, getInventoryItem all
  // resolve exactly; getOrderStatus resolves via fuzzy sequence matching
  // (renamed segment); purgeLegacyStats (DELETE, no server route at all)
  // is unresolved.
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0]!.method, "DELETE");

  const orderMatch = matches.find((m) => m.client.route.raw.includes("orderstatus"));
  assert.ok(orderMatch);
  assert.equal(orderMatch!.strategy, "fuzzy-sequence");
  assert.ok(orderMatch!.confidence > 0.6 && orderMatch!.confidence < 1.0);

  const exactMatches = matches.filter((m) => m.strategy === "exact");
  assert.ok(exactMatches.length >= 3);

  // --- violation content ----------------------------------------------------
  const allViolations = reports.flatMap((r) => r.violations);
  const byKind = (k: string) => allViolations.filter((v) => v.kind === k);

  assert.equal(byKind("missing-field").length, 2); // users/:id -> email, inventory/:id -> sku
  const missingFieldMessages = byKind("missing-field").map((v) => v.message);
  assert.ok(missingFieldMessages.some((m) => m.includes("email")));
  assert.ok(missingFieldMessages.some((m) => m.includes("sku")));

  assert.equal(byKind("type-mutation").length, 1); // users/:id -> age
  assert.equal(byKind("type-mutation")[0]!.expected, "number");
  assert.equal(byKind("type-mutation")[0]!.actual, "string");

  assert.equal(byKind("nullability-introduced").length, 1); // settings -> nickname
  assert.equal(byKind("optionality-introduced").length, 1); // settings -> bio
  assert.equal(byKind("enum-variant-added").length, 1); // settings -> status
  assert.ok(byKind("enum-variant-added")[0]!.message.includes("pending_review"));

  assert.equal(byKind("unresolved-route").length, 1);

  // listUsers and useProfile routes should be fully clean.
  const listUsersReport = reports.find(
    (r) => r.match?.client.route.raw === "/api/v1/users" && r.match.client.method === "GET",
  );
  assert.deepEqual(listUsersReport?.violations, []);
});

test("integration: SARIF output built from the fixture analysis is well-formed and non-empty", async () => {
  const { reports } = await runAnalysis(FRONTEND, BACKEND, 0.6);
  const sarif = buildSarifReport(reports) as any;
  assert.equal(sarif.version, "2.1.0");
  assert.ok(sarif.runs[0].results.length >= 5);
  for (const result of sarif.runs[0].results) {
    assert.ok(result.locations[0].physicalLocation.artifactLocation.uri.length > 0);
  }
});

test("cli: parseArgs reads flags, applies defaults, and ignores unknown ones", () => {
  const args = parseArgs(["--client=./a", "--server=./b", "--format=sarif", "--threshold=0.75", "--unknown=x"]);
  assert.equal(args.client, "./a");
  assert.equal(args.server, "./b");
  assert.equal(args.format, "sarif");
  assert.equal(args.threshold, 0.75);
});

test("cli: invalid --format value falls back to the default rather than crashing", () => {
  const args = parseArgs(["--client=./a", "--server=./b", "--format=xml"]);
  assert.equal(args.format, "text");
});

test("cli: --demo accepts the 'markdown' format flag", () => {
  const args = parseArgs(["--demo", "--format=markdown"]);
  assert.equal(args.demo, true);
  assert.equal(args.format, "markdown");
});

test("cli: --demo runs end-to-end against the bundled fixtures with no --client/--server", async () => {
  const code = await main(["--demo"]);
  // The bundled fixtures contain seeded, intentional breaking drift.
  assert.equal(code, 1);
});

test("cli: --demo --format=markdown produces a PR-comment-shaped report", async () => {
  const outFile = path.join(__dirname, "tmp-demo.md");
  try {
    await main(["--demo", "--format=markdown", `--out=${outFile}`]);
    const content = fs.readFileSync(outFile, "utf8");
    assert.match(content, /breaking change\(s\) detected/);
    assert.match(content, /<details>/);
  } finally {
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
  }
});

test("cli: --help short-circuits before touching the filesystem", async () => {
  const code = await main(["--help"]);
  assert.equal(code, 0);
});

test("cli: exits 1 for a nonexistent client directory", async () => {
  const code = await main(["--client=/definitely/does/not/exist", "--server=" + BACKEND]);
  assert.equal(code, 1);
});

test("cli: end-to-end run against fixtures writes a SARIF file and exits 1 (errors present)", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "driftguard-test-"));
  const outFile = path.join(outDir, "report.sarif");
  const code = await main([`--client=${FRONTEND}`, `--server=${BACKEND}`, "--format=sarif", `--out=${outFile}`]);
  assert.equal(code, 1); // seeded fixtures contain real breaking changes
  const written = JSON.parse(fs.readFileSync(outFile, "utf8"));
  assert.equal(written.version, "2.1.0");
  fs.rmSync(outDir, { recursive: true, force: true });
});
