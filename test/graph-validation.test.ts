import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractGraph } from '../src/graph/ContractGraph.js';
import { buildContractGraph } from '../src/graph/GraphBuilder.js';

const meta = (confidence = 100, evidence: any[] = []) => ({ confidence, evidence });

test('graph-validation: a well-formed graph reports zero errors and zero warnings', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'p', type: 'producer', name: 'p', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'c', type: 'contract', name: 'c', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'consumer:x', type: 'consumer', name: 'x', file: 'b.ts', metadata: meta() });
  g.addEdge({ id: 'e1', from: 'p', to: 'c', relation: 'produces', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  g.addEdge({ id: 'e2', from: 'c', to: 'consumer:x', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const result = g.validate();
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('graph-validation: re-adding the same node id is not rejected (last-write-wins, unchanged behavior) but is flagged as a DUPLICATE_NODE_ID warning', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'first', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'c', type: 'contract', name: 'second', file: 'a.ts', metadata: meta() });
  assert.equal(g.getNode('c')?.name, 'second'); // behavior preserved
  const result = g.validate();
  assert.equal(result.valid, true); // warning, not an error
  assert.equal(result.warnings.some(w => w.code === 'DUPLICATE_NODE_ID' && w.nodeId === 'c'), true);
});

test('graph-validation: re-adding the same edge id is flagged as a DUPLICATE_EDGE_ID warning', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'p', type: 'producer', name: 'p', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'c', type: 'contract', name: 'c', file: 'a.ts', metadata: meta() });
  g.addEdge({ id: 'e1', from: 'p', to: 'c', relation: 'produces', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  g.addEdge({ id: 'e1', from: 'p', to: 'c', relation: 'produces', confidence: 50, evidence: [], resolutionMethod: 'exact' });
  const result = g.validate();
  assert.equal(result.warnings.some(w => w.code === 'DUPLICATE_EDGE_ID' && w.edgeId === 'e1'), true);
});

test('graph-validation: out-of-range node/edge confidence is an error', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'p', type: 'producer', name: 'p', file: 'a.ts', metadata: meta(150) });
  g.addNode({ id: 'c', type: 'contract', name: 'c', file: 'a.ts', metadata: meta(-5) });
  g.addEdge({ id: 'e1', from: 'p', to: 'c', relation: 'produces', confidence: 999, evidence: [], resolutionMethod: 'exact' });
  const result = g.validate();
  assert.equal(result.valid, false);
  const codes = result.errors.map(e => e.code);
  assert.ok(codes.filter(c => c === 'INVALID_CONFIDENCE').length >= 3);
});

test('graph-validation: evidence missing description/file is an error', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'c', file: 'a.ts', metadata: meta(100, [{ kind: 'ast', file: '', description: '', confidence: 100 }]) });
  const result = g.validate();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'INVALID_EVIDENCE'));
});

test('graph-validation: a "produces" edge whose source node is not a producer is an IMPOSSIBLE_RELATION error', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'consumer:x', type: 'consumer', name: 'x', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'c', type: 'contract', name: 'c', file: 'a.ts', metadata: meta() });
  g.addEdge({ id: 'e1', from: 'consumer:x', to: 'c', relation: 'produces', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const result = g.validate();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'IMPOSSIBLE_RELATION' && e.edgeId === 'e1'));
});

test('graph-validation: a "consumes" edge whose target node is not a consumer is an IMPOSSIBLE_RELATION error', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'c', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'p2', type: 'producer', name: 'p2', file: 'a.ts', metadata: meta() });
  g.addEdge({ id: 'e1', from: 'c', to: 'p2', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  const result = g.validate();
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.code === 'IMPOSSIBLE_RELATION'));
});

test('graph-validation: two distinct edges expressing the same (from,to,relation) triple produce a DUPLICATE_RELATION warning, not an error', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'c', file: 'a.ts', metadata: meta() });
  g.addNode({ id: 'consumer:x', type: 'consumer', name: 'x', file: 'a.ts', metadata: meta() });
  g.addEdge({ id: 'e1', from: 'c', to: 'consumer:x', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' });
  g.addEdge({ id: 'e2', from: 'c', to: 'consumer:x', relation: 'consumes', confidence: 80, evidence: [], resolutionMethod: 'fuzzy' });
  const result = g.validate();
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some(w => w.code === 'DUPLICATE_RELATION'));
});

test('graph-validation: attempting to add an edge referencing a nonexistent node still throws at insertion time (unchanged pre-existing behavior)', () => {
  const g = new ContractGraph();
  g.addNode({ id: 'c', type: 'contract', name: 'c', file: 'a.ts', metadata: meta() });
  assert.throws(() => g.addEdge({ id: 'e1', from: 'c', to: 'does-not-exist', relation: 'consumes', confidence: 100, evidence: [], resolutionMethod: 'exact' }));
});

// Regression test: validate() caught a real, previously-undetected bug where the
// TS, Python, and Go server/client parsers each maintained their own independent
// module-level id counter, so a polyglot repo (this fixture mixes TS + Python + Go
// backends) could produce colliding node/edge IDs across languages (e.g. two
// unrelated handlers both getting id 'server-1'), silently overwriting one
// handler's graph node with another's. Fixed by namespacing id prefixes per
// parser (ts-server/py-server/go-server, ts-client/py-client/go-client). This
// test pins the fix so the collision can't silently return.
test('graph-validation: a real polyglot-repo graph (TS + Python + Go fixtures) reports zero duplicate-id warnings', async () => {
  const g = await buildContractGraph('fixtures/frontend', 'fixtures/backend');
  const result = g.validate();
  assert.equal(result.valid, true);
  assert.deepEqual(result.warnings.filter(w => w.code === 'DUPLICATE_NODE_ID' || w.code === 'DUPLICATE_EDGE_ID'), []);
});
