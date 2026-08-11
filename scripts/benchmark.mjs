#!/usr/bin/env node
// Run with: npm run benchmark
// Measures graph construction, diffing, and impact evaluation across
// progressively larger synthetic repositories and the bundled fixtures.

import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildRepoPair } from "./lib/synthetic-repo.mjs";
import { buildContractGraph } from "../src/graph/GraphBuilder.ts";
import { GraphDiffEngine } from "../src/diff/GraphDiff.ts";
import { ImpactEngine } from "../src/impact/ImpactEngine.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");

const ITERATIONS = 5;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function timeAsync(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  const end = process.hrtime.bigint();
  return { result, ms: Number(end - start) / 1_000_000 };
}

function timeSync(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const end = process.hrtime.bigint();
  return { result, ms: Number(end - start) / 1_000_000 };
}

/**
 * Runs one full stage-by-stage benchmark pass for a given base/current
 * client+server dir pair (build base graph, build current graph, diff,
 * evaluate impact), repeated ITERATIONS times, reporting per-stage medians.
 */
async function benchmarkPair(label, base, current) {
  const buildMs = [];
  const diffMs = [];
  const impactMs = [];
  let lastImpactCount = 0;
  let lastChangeCount = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const baseBuild = await timeAsync(() => buildContractGraph(base.clientDir, base.serverDir));
    const currentBuild = await timeAsync(() => buildContractGraph(current.clientDir, current.serverDir));
    buildMs.push(baseBuild.ms + currentBuild.ms);

    const diffResult = timeSync(() => GraphDiffEngine.compareGraphs(baseBuild.result, currentBuild.result));
    diffMs.push(diffResult.ms);
    lastChangeCount = diffResult.result.length;

    const impactResult = timeSync(() =>
      ImpactEngine.evaluateImpact("base", "current", diffResult.result, currentBuild.result, {
        baselineGraph: baseBuild.result,
      }),
    );
    impactMs.push(impactResult.ms);
    lastImpactCount = impactResult.result.impacts.length;
  }

  return {
    label,
    graphBuildMs: median(buildMs),
    diffMs: median(diffMs),
    impactMs: median(impactMs),
    totalMs: median(buildMs) + median(diffMs) + median(impactMs),
    changes: lastChangeCount,
    impacts: lastImpactCount,
  };
}

async function benchmarkSyntheticSize(fileCount) {
  const base = buildRepoPair(fileCount, { mutate: false });
  const current = buildRepoPair(fileCount, { mutate: true });
  try {
    return await benchmarkPair(`${fileCount.toLocaleString()} files (synthetic)`, base, current);
  } finally {
    rmSync(base.root, { recursive: true, force: true });
    rmSync(current.root, { recursive: true, force: true });
  }
}

async function benchmarkRealFixtures() {
  const clientDir = path.join(packageRoot, "fixtures", "frontend");
  const serverDir = path.join(packageRoot, "fixtures", "backend");
  if (!existsSync(clientDir) || !existsSync(serverDir)) {
    return null; // bundled fixtures not present in this checkout; skip rather than fail
  }
  // No separate "before" fixture tree exists, so the real-repo data point
  // measures graph-build cost twice (the dominant cost at small scale) and
  // diffs the graph against itself (0 changes, 0 impacts) -- this still
  // exercises every stage's real code path against real parsed AST/route
  // data, just without a meaningful change set. The synthetic sizes below
  // are what exercise diff/impact under a non-trivial change set.
  return benchmarkPair("real fixtures/ (frontend+backend)", { clientDir, serverDir }, { clientDir, serverDir });
}

function printTable(rows) {
  console.log("\n| Scenario | Graph build | Diff | Impact | Total | Changes | Impacts |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.label} | ${r.graphBuildMs.toFixed(1)} ms | ${r.diffMs.toFixed(2)} ms | ${r.impactMs.toFixed(2)} ms | ${r.totalMs.toFixed(1)} ms | ${r.changes} | ${r.impacts} |`,
    );
  }
}

function loadBaseline(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function compareToBaseline(rows, baseline) {
  const REGRESSION_THRESHOLD = 1.25; // flag >25% slower than baseline
  const byLabel = new Map(baseline.map((r) => [r.label, r]));
  const regressions = [];
  for (const r of rows) {
    const prev = byLabel.get(r.label);
    if (!prev) continue;
    if (prev.totalMs > 0 && r.totalMs / prev.totalMs > REGRESSION_THRESHOLD) {
      regressions.push({ label: r.label, before: prev.totalMs, after: r.totalMs });
    }
  }
  return regressions;
}

async function main() {
  const args = process.argv.slice(2);
  const shouldSaveBaseline = args.includes("--save-baseline");
  const shouldCompare = args.includes("--compare");
  const baselineFile = path.join(packageRoot, "scripts", "benchmark-baseline.json");

  const rows = [];
  const real = await benchmarkRealFixtures();
  if (real) rows.push(real);
  for (const size of [200, 1000, 4000]) {
    rows.push(await benchmarkSyntheticSize(size));
  }

  printTable(rows);

  if (shouldSaveBaseline) {
    writeFileSync(baselineFile, JSON.stringify(rows, null, 2) + "\n");
    console.log(`\nSaved baseline to ${path.relative(packageRoot, baselineFile)}`);
  }

  if (shouldCompare) {
    const baseline = loadBaseline(baselineFile);
    if (!baseline) {
      console.log("\nNo baseline found to compare against. Run with --save-baseline first.");
    } else {
      const regressions = compareToBaseline(rows, baseline);
      if (regressions.length === 0) {
        console.log("\nNo regressions >25% vs saved baseline.");
      } else {
        console.log("\nRegressions vs saved baseline (>25% slower):");
        for (const r of regressions) {
          console.log(`  ${r.label}: ${r.before.toFixed(1)} ms -> ${r.after.toFixed(1)} ms`);
        }
        process.exitCode = 1;
      }
    }
  }
}

await main();
