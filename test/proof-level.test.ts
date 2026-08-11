import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveProofLevel, compareProofLevel } from '../src/graph/proofLevel.js';
import { ContractGraph } from '../src/graph/ContractGraph.js';
import { GraphDiffEngine } from '../src/diff/GraphDiff.js';
import { ImpactEngine } from '../src/impact/ImpactEngine.js';
import type { FieldType } from '../src/types.js';

const meta = (accessedProperties: string[] = [], isDynamicAccess = false) => ({ confidence: 100, evidence: [], accessedProperties, isDynamicAccess });
const str: FieldType = { kind: 'primitive', name: 'string' };

// --- deriveProofLevel unit rules ------------------------------------------------

test('proofLevel: dynamic access is always UNKNOWN regardless of confidence', () => {
  assert.equal(deriveProofLevel({ isDynamic: true, confidence: 100, resolutionMethod: 'exact' }), 'UNKNOWN');
});

test('proofLevel: heuristic/fuzzy resolution can never reach STRONG or PROVEN, even at 100% confidence', () => {
  assert.equal(deriveProofLevel({ resolutionMethod: 'heuristic', confidence: 100 }), 'POTENTIAL');
  assert.equal(deriveProofLevel({ resolutionMethod: 'fuzzy', confidence: 100 }), 'POTENTIAL');
});

test('proofLevel: exact resolution with high confidence reaches PROVEN', () => {
  assert.equal(deriveProofLevel({ resolutionMethod: 'exact', confidence: 100 }), 'PROVEN');
});

test('proofLevel: exact resolution with low confidence is downgraded, never PROVEN', () => {
  assert.equal(deriveProofLevel({ resolutionMethod: 'exact', confidence: 30 }), 'POTENTIAL');
});

test('proofLevel: symbol/type resolution is capped at STRONG, never PROVEN, no matter the confidence', () => {
  assert.equal(deriveProofLevel({ resolutionMethod: 'symbol', confidence: 100 }), 'STRONG');
  assert.equal(deriveProofLevel({ resolutionMethod: 'type', confidence: 100 }), 'STRONG');
});

test('proofLevel: an inferred claim (e.g. a rename pairing) is capped at STRONG even with exact-type evidence', () => {
  assert.equal(deriveProofLevel({ resolutionMethod: 'exact', confidence: 100, isInferred: true }), 'STRONG');
});

test('proofLevel: unknown/absent resolution method never exceeds POTENTIAL', () => {
  assert.equal(deriveProofLevel({ confidence: 100 }), 'POTENTIAL');
});

test('proofLevel: strict ranking used by compareProofLevel is PROVEN > STRONG > POTENTIAL > UNKNOWN', () => {
  assert.ok(compareProofLevel('PROVEN', 'STRONG') > 0);
  assert.ok(compareProofLevel('STRONG', 'POTENTIAL') > 0);
  assert.ok(compareProofLevel('POTENTIAL', 'UNKNOWN') > 0);
  assert.equal(compareProofLevel('STRONG', 'STRONG'), 0);
});

// --- wiring into ImpactEngine ---------------------------------------------------

test('proofLevel: a dynamic-access consumer always gets UNKNOWN category AND UNKNOWN proofLevel', () => {
  const base = new ContractGraph(), current = new ContractGraph();
  base.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: { kind: 'object', fields: { email: { type: str, optional: false, nullable: false } } }, metadata: meta() });
  current.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: { kind: 'object', fields: { emailAddress: { type: str, optional: false, nullable: false } } }, metadata: meta() });
  current.addNode({ id: 'dyn', type: 'consumer', name: 'dyn', file: 'dyn.ts', metadata: meta([], true) });
  current.addEdge({ id: 'e', from: 'c', to: 'dyn', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const changes = GraphDiffEngine.compareGraphs(base, current);
  const report = ImpactEngine.evaluateImpact('main', 'worktree', changes, current);
  assert.equal(report.impacts[0]?.dependencyCategory, 'UNKNOWN');
  assert.equal(report.impacts[0]?.proofLevel, 'UNKNOWN');
});

test('proofLevel: a direct breaking consumer resolved via an exact edge reaches PROVEN', () => {
  const base = new ContractGraph(), current = new ContractGraph();
  base.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: { kind: 'object', fields: { email: { type: str, optional: false, nullable: false } } }, metadata: meta() });
  current.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: { kind: 'object', fields: { emailAddress: { type: str, optional: false, nullable: false } } }, metadata: meta() });
  current.addNode({ id: 'a', type: 'consumer', name: 'A', file: 'a.ts', metadata: meta(['email']) });
  current.addEdge({ id: 'e', from: 'c', to: 'a', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const changes = GraphDiffEngine.compareGraphs(base, current);
  const report = ImpactEngine.evaluateImpact('main', 'worktree', changes, current);
  assert.equal(report.impacts[0]?.severity, 'BREAKING');
  assert.equal(report.impacts[0]?.proofLevel, 'PROVEN');
});

test('proofLevel: a POTENTIAL dependency category never reports PROVEN or STRONG proofLevel, even off a 100%-confidence exact edge', () => {
  const base = new ContractGraph(), current = new ContractGraph();
  base.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: { kind: 'object', fields: { email: { type: str, optional: false, nullable: false } } }, metadata: meta() });
  current.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: { kind: 'object', fields: { emailAddress: { type: str, optional: false, nullable: false } } }, metadata: meta() });
  // consumer has NO known accessedProperties at all -> POTENTIAL category
  current.addNode({ id: 'a', type: 'consumer', name: 'A', file: 'a.ts', metadata: meta([]) });
  current.addEdge({ id: 'e', from: 'c', to: 'a', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const changes = GraphDiffEngine.compareGraphs(base, current);
  const report = ImpactEngine.evaluateImpact('main', 'worktree', changes, current);
  assert.equal(report.impacts[0]?.dependencyCategory, 'POTENTIAL');
  assert.notEqual(report.impacts[0]?.proofLevel, 'PROVEN');
  assert.notEqual(report.impacts[0]?.proofLevel, 'STRONG');
});

// --- wiring into rename detection ------------------------------------------------

test('proofLevel: a detected rename is never PROVEN, even with an exact type match and identical leaf name', () => {
  const base = new ContractGraph(), current = new ContractGraph();
  base.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: { kind: 'object', fields: { email: { type: str, optional: false, nullable: false } } }, metadata: meta() });
  current.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: { kind: 'object', fields: { emailAddress: { type: str, optional: false, nullable: false } } }, metadata: meta() });
  const [change] = GraphDiffEngine.compareGraphs(base, current);
  assert.equal(change?.renames.length, 1);
  assert.notEqual(change?.renames[0]?.proofLevel, 'PROVEN');
});
