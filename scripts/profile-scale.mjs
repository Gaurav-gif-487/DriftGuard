#!/usr/bin/env node
// Run with: npm run profile
// Measures parser and route-matching scaling across progressively larger
// synthetic client/server repository pairs.

import { rmSync } from "node:fs";
import { runAnalysis } from "../src/cli.ts";
import { buildRepoPair } from "./lib/synthetic-repo.mjs";

async function measure(fileCount) {
  const { root, clientDir, serverDir, endpointPairs } = buildRepoPair(fileCount);
  try {
    const { durationMs, matches } = await runAnalysis(clientDir, serverDir, 0.6);
    return { fileCount, endpointPairs, durationMs, matched: matches.length };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const sizes = [1000, 4000, 8000, 10000];
console.log("| Files | Endpoint pairs | Internal duration | Matched |");
console.log("|---|---|---|---|");
for (const size of sizes) {
  const r = await measure(size);
  console.log(
    `| ${r.fileCount.toLocaleString()} | ${r.endpointPairs.toLocaleString()} | ${r.durationMs.toFixed(0)} ms | ${r.matched.toLocaleString()} |`,
  );
}
