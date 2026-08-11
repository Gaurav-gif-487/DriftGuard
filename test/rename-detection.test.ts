import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractGraph } from '../src/graph/ContractGraph.js';
import { GraphDiffEngine } from '../src/diff/GraphDiff.js';
import type { FieldType } from '../src/types.js';

const meta = () => ({ confidence: 100, evidence: [] });
const str: FieldType = { kind: 'primitive', name: 'string' };
const num: FieldType = { kind: 'primitive', name: 'number' };

function graphWith(fields: Record<string, { type: FieldType; optional?: boolean; nullable?: boolean }>) {
  const g = new ContractGraph();
  const shapeFields: Record<string, { type: FieldType; optional: boolean; nullable: boolean }> = {};
  for (const [k, v] of Object.entries(fields)) shapeFields[k] = { type: v.type, optional: v.optional ?? false, nullable: v.nullable ?? false };
  g.addNode({ id: 'c', type: 'contract', name: 'User', file: 'types.ts', shape: { kind: 'object', fields: shapeFields }, metadata: meta() });
  return g;
}

test('rename: field renamed with identical type is detected as a rename with high confidence', () => {
  const base = graphWith({ email: { type: str } });
  const current = graphWith({ emailAddress: { type: str } });
  const [change] = GraphDiffEngine.compareGraphs(base, current);
  // raw fieldChanges must still show both the removal and the addition (backward compatible)
  assert.deepEqual(change?.fieldChanges.map(f => f.kind).sort(), ['added', 'removed']);
  assert.equal(change?.renames.length, 1);
  assert.equal(change?.renames[0]?.oldPath, 'root.email');
  assert.equal(change?.renames[0]?.newPath, 'root.emailAddress');
  assert.ok((change?.renames[0]?.confidence ?? 0) >= 60);
});

test('rename: remove+add with incompatible types is NEVER labeled a rename', () => {
  const base = graphWith({ email: { type: str } });
  const current = graphWith({ emailAddress: { type: num } });
  const [change] = GraphDiffEngine.compareGraphs(base, current);
  assert.equal(change?.renames.length, 0);
  assert.deepEqual(change?.fieldChanges.map(f => f.kind).sort(), ['added', 'removed']);
});

test('rename: unrelated add and remove of unlike names/types across different fields does not produce a rename for the non-matching pair', () => {
  // email (string) removed, id (string) stays, phoneNumber (string) added, plus an unrelated `count` (number) removed with no compatible add.
  const base = graphWith({ email: { type: str }, count: { type: num } });
  const current = graphWith({ phoneNumber: { type: str } });
  const [change] = GraphDiffEngine.compareGraphs(base, current);
  // `count` (number) has no type-compatible added field, so it must remain unpaired.
  assert.equal(change?.renames.length, 1);
  assert.equal(change?.renames[0]?.oldPath, 'root.email');
  assert.equal(change?.renames[0]?.newPath, 'root.phoneNumber');
  const removedPaths = change?.fieldChanges.filter(f => f.kind === 'removed').map(f => f.path);
  assert.ok(removedPaths?.includes('root.count'));
});

test('rename: when two same-typed fields could pair either way, the pairing with better name similarity wins deterministically', () => {
  // baseline: firstName, lastName (both string)
  // current: firstNm, lastNm (both string) -- firstName should pair with firstNm, not lastNm
  const base = graphWith({ firstName: { type: str }, lastName: { type: str } });
  const current = graphWith({ firstNm: { type: str }, lastNm: { type: str } });
  const [change] = GraphDiffEngine.compareGraphs(base, current);
  assert.equal(change?.renames.length, 2);
  const byOld = new Map(change?.renames.map(r => [r.oldPath, r.newPath]));
  assert.equal(byOld.get('root.firstName'), 'root.firstNm');
  assert.equal(byOld.get('root.lastName'), 'root.lastNm');
});

test('rename: nested object field renames are detected within their own parent scope, not cross-matched to top-level fields', () => {
  const nestedBase: FieldType = { kind: 'object', fields: { addr: { type: str, optional: false, nullable: false } } };
  const nestedCurrent: FieldType = { kind: 'object', fields: { address: { type: str, optional: false, nullable: false } } };
  const base = graphWith({ email: { type: str }, location: { type: nestedBase } });
  const current = graphWith({ email: { type: str }, location: { type: nestedCurrent } });
  const [change] = GraphDiffEngine.compareGraphs(base, current);
  assert.equal(change?.renames.length, 1);
  assert.equal(change?.renames[0]?.oldPath, 'root.location.addr');
  assert.equal(change?.renames[0]?.newPath, 'root.location.address');
});

test('rename: pure additions and pure removals (no counterpart) produce zero renames', () => {
  const base = graphWith({ email: { type: str } });
  const current = graphWith({ email: { type: str }, phone: { type: str } });
  const [change] = GraphDiffEngine.compareGraphs(base, current);
  assert.equal(change?.renames.length, 0);
  assert.equal(change?.fieldChanges.length, 1);
  assert.equal(change?.fieldChanges[0]?.kind, 'added');
});
