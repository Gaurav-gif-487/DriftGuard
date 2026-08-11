import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractGraph } from '../src/graph/ContractGraph.js';
import { GraphDiffEngine } from '../src/diff/GraphDiff.js';
import { ImpactEngine } from '../src/impact/ImpactEngine.js';

const meta = (confidence = 100, extra: any = {}) => ({ confidence, evidence: [], ...extra });

test('path-traversal: a single strong consumes edge is DIRECT', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'User', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'consumer:x', type: 'consumer', name: 'x', file: 'b.ts', metadata: meta() });
  g.addEdge({ id: 'e1', from: 'c', to: 'consumer:x', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const path = g.explainPath('c', 'consumer:x');
  assert.equal(path.kind, 'DIRECT');
  assert.equal(path.length, 1);
  assert.equal(path.proofLevel, 'PROVEN');
  assert.equal(path.explanation, 'User -> x');
});

test('path-traversal: a weakly-resolved single hop is never labeled DIRECT (reachability alone does not imply DIRECT)', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'User', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'consumer:x', type: 'consumer', name: 'x', file: 'b.ts', metadata: meta() });
  g.addEdge({ id: 'e1', from: 'c', to: 'consumer:x', relation: 'consumes', confidence: 55, evidence: [], resolutionMethod: 'fuzzy' });
  const path = g.explainPath('c', 'consumer:x');
  assert.notEqual(path.kind, 'DIRECT');
  assert.equal(path.kind, 'POTENTIAL');
});

test('path-traversal: a multi-hop chain through symbol/alias nodes with strong edges is TRANSITIVE', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'User', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'sym', type: 'symbol', name: 'UserSymbol', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'alias', type: 'symbol', name: 'UserAlias', file: 'b.ts', metadata: meta() });
  g.addNode({ id: 'consumer:x', type: 'consumer', name: 'x', file: 'c.ts', metadata: meta() });
  g.addEdge({ id: 'e1', from: 'c', to: 'sym', relation: 'defines', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  g.addEdge({ id: 'e2', from: 'sym', to: 'alias', relation: 'aliases', confidence: 90, evidence: [], resolutionMethod: 'symbol' });
  g.addEdge({ id: 'e3', from: 'alias', to: 'consumer:x', relation: 'consumes', confidence: 90, evidence: [], resolutionMethod: 'symbol' });
  const path = g.explainPath('c', 'consumer:x');
  assert.equal(path.kind, 'TRANSITIVE');
  assert.equal(path.length, 3);
  assert.equal(path.explanation, 'User -> UserSymbol -> UserAlias -> x');
});

test('path-traversal: a chain containing a fuzzy/heuristic hop downgrades the whole path to POTENTIAL, even if other hops are strong', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'User', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'sym', type: 'symbol', name: 'UserSymbol', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'consumer:x', type: 'consumer', name: 'x', file: 'c.ts', metadata: meta() });
  g.addEdge({ id: 'e1', from: 'c', to: 'sym', relation: 'defines', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  g.addEdge({ id: 'e2', from: 'sym', to: 'consumer:x', relation: 'consumes', confidence: 60, evidence: [], resolutionMethod: 'heuristic' });
  const path = g.explainPath('c', 'consumer:x');
  assert.equal(path.kind, 'POTENTIAL');
});

test('path-traversal: no path between contract and consumer is UNKNOWN with an empty hop chain', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'User', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'consumer:x', type: 'consumer', name: 'x', file: 'b.ts', metadata: meta() });
  const path = g.explainPath('c', 'consumer:x');
  assert.equal(path.kind, 'UNKNOWN');
  assert.deepEqual(path.hops, []);
  assert.equal(path.length, 0);
});

test('path-traversal: cycle-safe — a graph with a cycle in the middle of the chain still terminates and finds the shortest path', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'User', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'sym', type: 'symbol', name: 'Sym', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'consumer:x', type: 'consumer', name: 'x', file: 'c.ts', metadata: meta() });
  g.addEdge({ id: 'e1', from: 'c', to: 'sym', relation: 'defines', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  // cycle: sym references back to the contract node
  g.addEdge({ id: 'e2', from: 'sym', to: 'c', relation: 'references', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  g.addEdge({ id: 'e3', from: 'sym', to: 'consumer:x', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const start = Date.now();
  const path = g.explainPath('c', 'consumer:x');
  assert.ok(Date.now() - start < 1000, 'traversal must terminate quickly despite the cycle');
  assert.equal(path.kind, 'TRANSITIVE');
  assert.equal(path.length, 2);
});

test('path-traversal: BFS picks the shortest of two available paths (direct edge over a longer symbol chain)', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'User', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'sym', type: 'symbol', name: 'Sym', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'consumer:x', type: 'consumer', name: 'x', file: 'c.ts', metadata: meta() });
  g.addEdge({ id: 'direct', from: 'c', to: 'consumer:x', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  g.addEdge({ id: 'e1', from: 'c', to: 'sym', relation: 'defines', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  g.addEdge({ id: 'e2', from: 'sym', to: 'consumer:x', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const path = g.explainPath('c', 'consumer:x');
  assert.equal(path.length, 1);
  assert.equal(path.kind, 'DIRECT');
});

test('path-traversal: is wired onto every AffectedConsumerImpact produced by ImpactEngine', () => {
  const base = new ContractGraph(), current = new ContractGraph();
  const shape = (field: string) => ({ kind: 'object' as const, fields: { [field]: { type: { kind: 'primitive' as const, name: 'string' }, optional: false, nullable: false } } });
  base.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: shape('email'), metadata: meta() });
  current.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: shape('emailAddress'), metadata: meta() });
  current.addNode({ id: 'consumer:a', type: 'consumer', name: 'A', file: 'a.ts', metadata: meta(100, { accessedProperties: ['email'] }) });
  current.addEdge({ id: 'e', from: 'c', to: 'consumer:a', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const changes = GraphDiffEngine.compareGraphs(base, current);
  const report = ImpactEngine.evaluateImpact('main', 'worktree', changes, current);
  assert.equal(report.impacts.length, 1);
  const impact = report.impacts[0]!;
  assert.equal(impact.path.kind, 'DIRECT');
  assert.equal(impact.path.hops.length, 1);
  assert.equal(impact.path.hops[0]!.edgeId, 'e');
});

test('path-traversal: a removed contract still resolves the path from the baseline graph (the edge no longer exists in current)', () => {
  const base = new ContractGraph(), current = new ContractGraph();
  base.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', metadata: meta() });
  base.addNode({ id: 'consumer:a', type: 'consumer', name: 'A', file: 'a.ts', metadata: meta() });
  base.addEdge({ id: 'e', from: 'c', to: 'consumer:a', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const changes = [{ contractId: 'c', kind: 'removed' as const, nodeName: 'User', file: 'types.ts', fieldChanges: [], renames: [], confidence: 100, evidence: [] }];
  const report = ImpactEngine.evaluateImpact('main', 'worktree', changes, current, { baselineGraph: base });
  assert.equal(report.impacts.length, 1);
  assert.equal(report.impacts[0]!.path.kind, 'DIRECT');
});
