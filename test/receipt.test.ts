import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildContractGraph } from '../src/graph/GraphBuilder.js';
import { GraphDiffEngine } from '../src/diff/GraphDiff.js';
import { ImpactEngine } from '../src/impact/ImpactEngine.js';
import { buildReceipt } from '../src/receipt/ReceiptEngine.js';

/**
 * Builds a small real (on-disk) client+server fixture pair: a server route
 * that returns `email` (baseline) or `emailAddress` (current, i.e. after an
 * AI agent renamed the field), and a client call-site that directly accesses
 * `res.email`. This is deliberately routed through the real parsers/graph
 * builder rather than synthetic ContractGraph objects, because the receipt's
 * repair-verification step rebuilds a graph from real files on disk.
 */
function writeFixture(root: string, serverField: 'email' | 'emailAddress'): { clientDir: string; serverDir: string } {
  const clientDir = path.join(root, 'client');
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(path.join(clientDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(serverDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(clientDir, 'src', 'userClient.ts'),
    `import axios from "axios";
export async function getUser() {
  const res = await axios.get("/api/v1/users");
  return res.email;
}
`,
  );
  fs.writeFileSync(
    path.join(serverDir, 'src', 'users.ts'),
    `import express from "express";
const router = express.Router();
router.get("/api/v1/users", (req, res) => {
  res.json({ id: 1, name: "Ada", ${serverField}: "ada@example.com" });
});
export default router;
`,
  );
  return { clientDir, serverDir };
}

async function makeReport(baseDir: string, currentDir: string) {
  const base = writeFixture(baseDir, 'email');
  const current = writeFixture(currentDir, 'emailAddress');
  const baselineGraph = await buildContractGraph(base.clientDir, base.serverDir, { threshold: 0.6 });
  const currentGraph = await buildContractGraph(current.clientDir, current.serverDir, { threshold: 0.6 });
  const changes = GraphDiffEngine.compareGraphs(baselineGraph, currentGraph);
  const report = ImpactEngine.evaluateImpact('base', 'WORKTREE', changes, currentGraph, { baselineGraph });
  return { baselineGraph, currentGraph, changes, report, currentClientDir: current.clientDir, currentServerDir: current.serverDir };
}

test('receipt: without an intent, verdict is FAIL when breaking impacts exist', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-base-'));
  const currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-current-'));
  try {
    const { baselineGraph, currentGraph, changes, report, currentClientDir, currentServerDir } = await makeReport(baseDir, currentDir);
    assert.equal(report.summary.breaking, 1);
    const receipt = await buildReceipt({
      baseIdentity: 'base', currentIdentity: 'WORKTREE', clientDir: currentClientDir, serverDir: currentServerDir,
      currentGraph, baselineGraph, changes, report, threshold: 0.6,
    });
    assert.equal(receipt.verdict, 'FAIL');
    assert.equal(receipt.intent, null);
    assert.equal(receipt.repairVerification, null);
    assert.ok(receipt.limitations.some((l) => l.includes('No structured change intent')));
    assert.equal(receipt.schemaVersion, 3);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(currentDir, { recursive: true, force: true });
  }
});

test('receipt: with a matching --rename intent, a real repair round-trip is verified and the verdict is PROVEN', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-base-'));
  const currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-current-'));
  try {
    const { baselineGraph, currentGraph, changes, report, currentClientDir, currentServerDir } = await makeReport(baseDir, currentDir);
    const contractId = changes[0]!.contractId;
    const receipt = await buildReceipt({
      baseIdentity: 'base', currentIdentity: 'WORKTREE', clientDir: currentClientDir, serverDir: currentServerDir,
      currentGraph, baselineGraph, changes, report, threshold: 0.6,
      intent: { kind: 'rename-field', contractId, fromPath: 'email', toPath: 'emailAddress' },
    });
    assert.equal(receipt.verdict, 'PROVEN');
    assert.equal(receipt.verification?.status, 'INCOMPLETE'); // pre-repair: the rename hadn't been fixed in the consumer yet
    assert.ok(receipt.repairVerification);
    assert.equal(receipt.repairVerification!.verifiedGraph, true);
    assert.equal(receipt.repairVerification!.stillBreakingConsumers.length, 0);
    assert.equal(receipt.repairVerification!.newBreakingConsumers.length, 0);
    assert.equal(receipt.repairVerification!.fixedConsumers.length, 1);
    assert.equal(receipt.repairs.some((r) => r.status === 'PATCHED'), true);

    // The receipt must never mutate the real working tree while generating itself.
    const originalClientSource = fs.readFileSync(path.join(currentClientDir, 'src', 'userClient.ts'), 'utf8');
    assert.match(originalClientSource, /res\.email/);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(currentDir, { recursive: true, force: true });
  }
});

test('receipt: a --rename intent that does not match the observed diff is UNVERIFIED and FAILs', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-base-'));
  const currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-current-'));
  try {
    const { baselineGraph, currentGraph, changes, report, currentClientDir, currentServerDir } = await makeReport(baseDir, currentDir);
    const receipt = await buildReceipt({
      baseIdentity: 'base', currentIdentity: 'WORKTREE', clientDir: currentClientDir, serverDir: currentServerDir,
      currentGraph, baselineGraph, changes, report, threshold: 0.6,
      intent: { kind: 'rename-field', contractId: 'contract:GET:/api/v1/does-not-exist', fromPath: 'email', toPath: 'emailAddress' },
    });
    assert.equal(receipt.verification?.status, 'UNVERIFIED');
    assert.equal(receipt.verdict, 'FAIL');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(currentDir, { recursive: true, force: true });
  }
});

test('receipt: an unsupported add-field intent reports a limitation instead of PROVEN', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-base-'));
  const currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-current-'));
  try {
    const { baselineGraph, currentGraph, changes, report, currentClientDir, currentServerDir } = await makeReport(baseDir, currentDir);
    const contractId = changes[0]!.contractId;
    const receipt = await buildReceipt({
      baseIdentity: 'base', currentIdentity: 'WORKTREE', clientDir: currentClientDir, serverDir: currentServerDir,
      currentGraph, baselineGraph, changes, report, threshold: 0.6,
      intent: { kind: 'add-field', contractId, toPath: 'phone' },
    });
    assert.notEqual(receipt.verdict, 'PROVEN');
    assert.equal(receipt.repairVerification, null);
    assert.ok(receipt.limitations.some((l) => l.includes('only implemented for rename-field')));
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(currentDir, { recursive: true, force: true });
  }
});

test('receipt: schemaVersion 3 and generatedAt is the only non-deterministic field — two receipts built back to back agree on everything else', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-base-'));
  const currentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-current-'));
  try {
    const { baselineGraph, currentGraph, changes, report, currentClientDir, currentServerDir } = await makeReport(baseDir, currentDir);
    const build = () => buildReceipt({ baseIdentity: 'base', currentIdentity: 'WORKTREE', clientDir: currentClientDir, serverDir: currentServerDir, currentGraph, baselineGraph, changes, report, threshold: 0.6 });
    const r1 = await build();
    const r2 = await build();
    const strip = (r: Awaited<ReturnType<typeof build>>) => { const { generatedAt, ...rest } = r; return rest; };
    assert.deepEqual(strip(r1), strip(r2));
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(currentDir, { recursive: true, force: true });
  }
});
