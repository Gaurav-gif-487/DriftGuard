import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildContractGraph } from '../src/graph/GraphBuilder.js';
import { GraphDiffEngine } from '../src/diff/GraphDiff.js';
import { ImpactEngine } from '../src/impact/ImpactEngine.js';
import { AgentVerifier } from '../src/agent/AgentVerifier.js';
import { RepairEngine } from '../src/repair/RepairEngine.js';
import { buildReceipt } from '../src/receipt/ReceiptEngine.js';

/**
 * Covers required-to-optional repair in addition to field rename repair.
 * The repair inserts optional chaining at proven property accesses.
 *
 * Unsupported changes remain unrepairable because they do not have a
 * generally safe, semantics-preserving source transformation.
 *
 * Fixtures are parsed through the real pipeline because RepairEngine operates
 * on source text and AST locations.
 */
function writeFixture(root: string, serverFieldOptional: boolean): { clientDir: string; serverDir: string } {
  const clientDir = path.join(root, 'client');
  const serverDir = path.join(root, 'server');
  fs.mkdirSync(clientDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(
    path.join(clientDir, 'client.ts'),
    `import axios from "axios";
export async function getUser() {
  const res = await axios.get("/api/v1/users");
  return res.age.toFixed(0);
}
`,
  );
  fs.writeFileSync(
    path.join(serverDir, 'users.ts'),
    `import express from "express";
const router = express.Router();
interface User { id: number; age${serverFieldOptional ? '?' : ''}: number; }
router.get("/api/v1/users", (req, res): User => {
  res.json({ id: 1${serverFieldOptional ? '' : ', age: 34'} });
});
export default router;
`,
  );
  return { clientDir, serverDir };
}

async function buildScenario(serverFieldOptional: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-widen-'));
  const base = writeFixture(path.join(root, 'base'), false);
  const current = writeFixture(path.join(root, 'current'), serverFieldOptional);
  const baseGraph = await buildContractGraph(base.clientDir, base.serverDir);
  const currentGraph = await buildContractGraph(current.clientDir, current.serverDir);
  const changes = GraphDiffEngine.compareGraphs(baseGraph, currentGraph);
  const report = ImpactEngine.evaluateImpact('base', 'current', changes, currentGraph, { baselineGraph: baseGraph });
  return { root, base, current, baseGraph, currentGraph, changes, report };
}

const contractId = 'contract:GET:/api/v1/users';

test('AgentVerifier: widen-optionality intent matches a real optionality-changed diff (required -> optional)', async () => {
  const { root, report } = await buildScenario(true);
  try {
    const intent = { kind: 'widen-optionality' as const, contractId, fromPath: 'age', toPath: 'age' };
    const result = AgentVerifier.verifyIntent(intent, report);
    assert.equal(result.status, 'INCOMPLETE'); // still breaking until repaired
    assert.ok(result.evidence.some((e) => e.includes("widened from required to optional")));
    assert.equal(result.details.remainingConsumers, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AgentVerifier: widen-optionality intent is UNVERIFIED style mismatch when the field did not actually widen', async () => {
  const { root, report } = await buildScenario(false); // no change at all: current === base
  try {
    const intent = { kind: 'widen-optionality' as const, contractId, fromPath: 'age', toPath: 'age' };
    const result = AgentVerifier.verifyIntent(intent, report);
    assert.equal(result.status, 'UNVERIFIED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AgentVerifier: widen-optionality intent flags a mismatch when the diff exists but is not actually a required->optional widening', async () => {
  // Build a scenario where age changes type (number -> string) instead of optionality.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-widen-mismatch-'));
  try {
    const write = (dir: string, type: string) => {
      fs.mkdirSync(path.join(dir, 'client'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'client', 'client.ts'), `export async function getUser() { const res = await fetch("/api/v1/users").then(r=>r.json()); return res.age; }\n`);
      fs.writeFileSync(
        path.join(dir, 'server', 'users.ts'),
        `import express from "express";\nconst router = express.Router();\ninterface User { id: number; age: ${type}; }\nrouter.get("/api/v1/users", (req, res): User => { res.json({ id: 1, age: ${type === 'string' ? '"34"' : '34'} }); });\nexport default router;\n`,
      );
    };
    write(path.join(root, 'base'), 'number');
    write(path.join(root, 'current'), 'string');
    const baseGraph = await buildContractGraph(path.join(root, 'base', 'client'), path.join(root, 'base', 'server'));
    const currentGraph = await buildContractGraph(path.join(root, 'current', 'client'), path.join(root, 'current', 'server'));
    const changes = GraphDiffEngine.compareGraphs(baseGraph, currentGraph);
    const report = ImpactEngine.evaluateImpact('base', 'current', changes, currentGraph, { baselineGraph: baseGraph });
    const intent = { kind: 'widen-optionality' as const, contractId, fromPath: 'age', toPath: 'age' };
    const result = AgentVerifier.verifyIntent(intent, report);
    assert.ok(result.evidence.some((e) => e.startsWith('Intent does not match')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RepairEngine.executeSafeOptionalChainingRepair: patches a real proven property access, dry-run does not touch disk', async () => {
  const { root, current, report, currentGraph } = await buildScenario(true);
  try {
    const intent = { kind: 'widen-optionality' as const, contractId, fromPath: 'age', toPath: 'age' };
    const clientFile = path.join(current.clientDir, 'client.ts');
    const before = fs.readFileSync(clientFile, 'utf8');
    const result = RepairEngine.executeSafeOptionalChainingRepair(
      intent,
      report,
      currentGraph,
      (p) => fs.readFileSync(p, 'utf8'),
      (p, c) => fs.writeFileSync(p, c, 'utf8'),
      true, // dry-run
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.applied, false);
    assert.equal(result.patches.length, 1);
    assert.equal(result.patches[0]!.filePath, clientFile);
    assert.ok(result.patches[0]!.patchedContent.includes('res.age?.toFixed(0)'));
    assert.equal(fs.readFileSync(clientFile, 'utf8'), before, 'dry-run must not touch disk');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RepairEngine.executeSafeOptionalChainingRepair: --apply actually writes the patch and re-analysis reports zero remaining breaking impacts', async () => {
  const { root, current, base, report, currentGraph } = await buildScenario(true);
  try {
    const intent = { kind: 'widen-optionality' as const, contractId, fromPath: 'age', toPath: 'age' };
    const applied = RepairEngine.executeSafeOptionalChainingRepair(
      intent,
      report,
      currentGraph,
      (p) => fs.readFileSync(p, 'utf8'),
      (p, c) => fs.writeFileSync(p, c, 'utf8'),
      false, // apply
    );
    assert.equal(applied.applied, true);
    const patchedSource = fs.readFileSync(path.join(current.clientDir, 'client.ts'), 'utf8');
    assert.ok(patchedSource.includes('res.age?.toFixed(0)'));

    // Rebuild the graph from the patched files and re-run diff+impact to
    // confirm the repair actually resolves the breaking impact -- this is
    // the same round-trip verification style used by ReceiptEngine, done
    // directly here to pin the repair's correctness independent of the
    // receipt machinery.
    const baseGraph = await buildContractGraph(base.clientDir, base.serverDir);
    const repairedGraph = await buildContractGraph(current.clientDir, current.serverDir);
    const changes = GraphDiffEngine.compareGraphs(baseGraph, repairedGraph);
    const reanalyzed = ImpactEngine.evaluateImpact('base', 'current', changes, repairedGraph, { baselineGraph: baseGraph });
    const breaking = reanalyzed.impacts.filter((i) => i.targetContractId === contractId && i.severity === 'BREAKING');
    assert.deepEqual(breaking, [], 'optional chaining repair should resolve the breaking impact on re-analysis');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RepairEngine.executeSafeOptionalChainingRepair: throws for a non-widen-optionality intent (mirrors executeSafeRenameRepair guard)', async () => {
  const { root, report, currentGraph } = await buildScenario(true);
  try {
    const intent = { kind: 'rename-field' as const, contractId, fromPath: 'age', toPath: 'age2' };
    assert.throws(() => RepairEngine.executeSafeOptionalChainingRepair(intent, report, currentGraph, () => '', undefined, true));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('receipt: widen-optionality intent produces a PROVEN verdict end-to-end through the real receipt round-trip', async () => {
  const { root, base, current, baseGraph, currentGraph, changes, report } = await buildScenario(true);
  try {
    const intent = { kind: 'widen-optionality' as const, contractId, fromPath: 'age', toPath: 'age' };
    const receipt = await buildReceipt({
      baseIdentity: 'base',
      currentIdentity: 'current',
      clientDir: current.clientDir,
      serverDir: current.serverDir,
      currentGraph,
      baselineGraph: baseGraph,
      changes,
      report,
      intent,
      threshold: 0.6,
    });
    assert.equal(receipt.verdict, 'PROVEN');
    assert.equal(receipt.repairVerification?.attempted, 1);
    assert.equal(receipt.repairVerification?.verifiedGraph, true);
    assert.deepEqual(receipt.repairVerification?.newBreakingConsumers, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('RepairEngine.executeSafeOptionalChainingRepair: skips a consumer access already using optional chaining (no-op)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-widen-already-optional-'));
  try {
    const clientDir = path.join(root, 'client');
    const serverDir = path.join(root, 'server');
    fs.mkdirSync(clientDir, { recursive: true });
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(clientDir, 'client.ts'),
      `export async function getUser() { const res = await fetch("/api/v1/users").then(r=>r.json()); return res.age?.toFixed(0); }\n`,
    );
    fs.writeFileSync(
      path.join(serverDir, 'users.ts'),
      `import express from "express";\nconst router = express.Router();\ninterface User { id: number; age?: number; }\nrouter.get("/api/v1/users", (req, res): User => { res.json({ id: 1 }); });\nexport default router;\n`,
    );
    const graph = await buildContractGraph(clientDir, serverDir);
    // Build a minimal synthetic "report" with one BREAKING impact pointing
    // at this file with proven field-level match, to isolate the transform
    // itself (the property access is already optional-chained in source,
    // regardless of how the impact was classified).
    const report = {
      baseIdentity: 'b',
      currentIdentity: 'c',
      timestamp: new Date().toISOString(),
      changes: [],
      impacts: [
        {
          consumerNode: graph.getNode('consumer:ts-client-1') ?? { id: 'x', type: 'consumer' as const, name: 'x', file: path.join(clientDir, 'client.ts'), metadata: { confidence: 100, evidence: [] } },
          targetContractId: contractId,
          dependencyCategory: 'DIRECT' as const,
          severity: 'BREAKING' as const,
          reason: 'test',
          fieldLevelMatch: true,
          changedPaths: ['age'],
          evidence: [],
          confidence: 100,
          proofLevel: 'PROVEN' as const,
          path: { contractId, consumerId: 'x', kind: 'DIRECT' as const, hops: [], length: 0, proofLevel: 'PROVEN' as const, explanation: '' },
        },
      ],
      risk: { score: 0, factors: { confirmedBreaking: 0, potentialBreaking: 0, highCriticalityConsumers: 0, totalConsumers: 0, unresolvedUnknowns: 0 } },
      summary: { totalChanges: 0, breaking: 1, warning: 0, safe: 0, unknown: 0, impactScore: 0 },
    };
    const intent = { kind: 'widen-optionality' as const, contractId, fromPath: 'age', toPath: 'age' };
    const result = RepairEngine.executeSafeOptionalChainingRepair(intent, report, graph, (p) => fs.readFileSync(p, 'utf8'), undefined, true);
    assert.equal(result.patches.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.ok(result.skipped[0]!.includes('already optional-chained'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
