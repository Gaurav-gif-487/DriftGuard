import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractGraph } from '../src/graph/ContractGraph.js';
import { GraphDiffEngine } from '../src/diff/GraphDiff.js';
import { ImpactEngine } from '../src/impact/ImpactEngine.js';
import { AgentVerifier } from '../src/agent/AgentVerifier.js';
import { RepairEngine } from '../src/repair/RepairEngine.js';
import { buildAgentSummary } from '../src/agent/NextActions.js';

const meta = (accessedProperties: string[] = []) => ({ confidence: 100, evidence: [], accessedProperties });

function renameScenario() {
  const b = new ContractGraph(), c = new ContractGraph();
  b.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: { kind: 'object', fields: { email: { type: { kind: 'primitive', name: 'string' }, optional: false, nullable: false } } }, metadata: meta() });
  c.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: { kind: 'object', fields: { emailAddress: { type: { kind: 'primitive', name: 'string' }, optional: false, nullable: false } } }, metadata: meta() });
  c.addNode({ id: 'consumer:a', type: 'consumer', name: 'A', file: 'a.ts', location: { line: 5, column: 1 }, metadata: meta(['email']) });
  c.addEdge({ id: 'e', from: 'c', to: 'consumer:a', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const changes = GraphDiffEngine.compareGraphs(b, c);
  const report = ImpactEngine.evaluateImpact('main', 'worktree', changes, c);
  return { report, contractId: changes[0]!.contractId };
}

test('nextActions: no intent, breaking impacts -> FAIL verdict with a repair suggestion and file hints', () => {
  const { report } = renameScenario();
  const summary = buildAgentSummary({ report });
  assert.equal(summary.verdict, 'FAIL');
  assert.equal(summary.breaking, 1);
  assert.equal(summary.repairAvailable, false);
  assert.ok(summary.nextActions.some((a) => a.includes('--rename=Contract.old->new')));
  assert.ok(summary.nextActions.some((a) => a.includes('a.ts:5')));
});

test('nextActions: no intent, everything clean -> PASS verdict with "no further action"', () => {
  const g = new ContractGraph();
  const report = ImpactEngine.evaluateImpact('main', 'worktree', [], g);
  const summary = buildAgentSummary({ report });
  assert.equal(summary.verdict, 'PASS');
  assert.deepEqual(summary.nextActions, ['No further action required.']);
});

test('nextActions: agent-check INCOMPLETE with a rename intent -> suggests the literal fix --apply command with the exact --rename value', () => {
  const { report, contractId } = renameScenario();
  const intent = { kind: 'rename-field' as const, contractId, fromPath: 'email', toPath: 'emailAddress' };
  const verification = AgentVerifier.verifyIntent(intent, report);
  assert.equal(verification.status, 'INCOMPLETE');
  const summary = buildAgentSummary({ report, intent, verification, renameFlagText: `${contractId}.email->emailAddress` });
  assert.equal(summary.verdict, 'INCOMPLETE');
  assert.equal(summary.repairAvailable, true);
  assert.ok(summary.nextActions.some((a) => a.includes(`fix --rename=${contractId}.email->emailAddress --apply`)));
});

test('nextActions: agent-check UNVERIFIED -> tells the caller the intent does not match the diff, never suggests a repair', () => {
  const { report } = renameScenario();
  const intent = { kind: 'rename-field' as const, contractId: 'does-not-exist', fromPath: 'a', toPath: 'b' };
  const verification = AgentVerifier.verifyIntent(intent, report);
  const summary = buildAgentSummary({ report, intent, verification });
  assert.equal(summary.verdict, 'UNVERIFIED');
  assert.equal(summary.repairAvailable, false);
  assert.ok(summary.nextActions.some((a) => a.includes('does not match the observed contract diff')));
});

test('nextActions: agent-check COMPLETE -> "no further action"', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', metadata: meta() });
  const report = ImpactEngine.evaluateImpact('main', 'worktree', [{ contractId: 'c', kind: 'modified', nodeName: 'User', file: 'types.ts', fieldChanges: [{ path: 'root.email', kind: 'removed' }, { path: 'root.emailAddress', kind: 'added' }], renames: [], confidence: 100, evidence: [] }], g);
  const intent = { kind: 'rename-field' as const, contractId: 'c', fromPath: 'email', toPath: 'emailAddress' };
  const verification = AgentVerifier.verifyIntent(intent, report);
  assert.equal(verification.status, 'COMPLETE');
  const summary = buildAgentSummary({ report, intent, verification });
  assert.equal(summary.verdict, 'COMPLETE');
  assert.deepEqual(summary.nextActions, ['No further action required — all consumers verified compatible.']);
});

test('nextActions: unsupported repair intents do not suggest `fix`', () => {
  const { report, contractId } = renameScenario();
  const intent = { kind: 'add-field' as const, contractId, toPath: 'phone' };
  const verification = AgentVerifier.verifyIntent(intent, report);
  const summary = buildAgentSummary({ report, intent, verification });
  if (summary.verdict === 'INCOMPLETE') {
    assert.ok(!summary.nextActions.some((a) => a.includes('driftguard fix')));
    assert.ok(summary.nextActions.some((a) => a.includes("not yet implemented for 'add-field'")));
  }
  assert.equal(summary.repairAvailable, false);
});

test('nextActions: fix dry-run with patches -> suggests receipt-then-apply, does not claim anything was written', () => {
  const { report, contractId } = renameScenario();
  const intent = { kind: 'rename-field' as const, contractId, fromPath: 'email', toPath: 'emailAddress' };
  const files: Record<string, string> = { 'a.ts': 'const x = user.email;' };
  const g = new ContractGraph();
  g.addNode({ id: contractId, type: 'contract', name: 'User', file: 'types.ts', metadata: meta() });
  g.addNode({ id: 'consumer:a', type: 'consumer', name: 'A', file: 'a.ts', metadata: meta() });
  g.addEdge({ id: 'e', from: contractId, to: 'consumer:a', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const repair = RepairEngine.executeSafeRenameRepair(intent, report, g, (p) => files[p]!, undefined, true);
  const summary = buildAgentSummary({ report, intent, repair, renameFlagText: `${contractId}.email->emailAddress` });
  assert.equal(summary.verdict, 'DRY_RUN');
  assert.equal(summary.repairAvailable, true);
  assert.ok(summary.nextActions.some((a) => a.includes('driftguard receipt') && a.includes('--apply')));
  assert.ok(!summary.nextActions.some((a) => a.toLowerCase().includes('applied')));
});

test('nextActions: fix applied -> tells the caller to verify with receipt, not just declare success', () => {
  const { report, contractId } = renameScenario();
  const intent = { kind: 'rename-field' as const, contractId, fromPath: 'email', toPath: 'emailAddress' };
  const repair = { applied: true, dryRun: false, patches: [{ filePath: 'a.ts', originalContent: 'x', patchedContent: 'y' }], skipped: [] };
  const summary = buildAgentSummary({ report, intent, repair, renameFlagText: `${contractId}.email->emailAddress` });
  assert.equal(summary.verdict, 'APPLIED');
  assert.ok(summary.nextActions.some((a) => a.includes('driftguard receipt')));
});

test('nextActions: fix with nothing to repair -> NO_REPAIR_AVAILABLE, repairAvailable false', () => {
  const { report, contractId } = renameScenario();
  const intent = { kind: 'rename-field' as const, contractId, fromPath: 'email', toPath: 'emailAddress' };
  const repair = { applied: false, dryRun: true, patches: [], skipped: ['a.ts: no proven AST property access for \'email\''] };
  const summary = buildAgentSummary({ report, intent, repair });
  assert.equal(summary.verdict, 'NO_REPAIR_AVAILABLE');
  assert.equal(summary.repairAvailable, false);
  assert.ok(summary.nextActions.some((a) => a.includes('manual fix required')));
});
