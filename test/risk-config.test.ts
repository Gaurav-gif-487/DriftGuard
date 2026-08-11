import test from 'node:test';
import assert from 'node:assert/strict';
import { RiskEngine } from '../src/risk/RiskEngine.js';
import { ConfigLoader } from '../src/config.js';
import { parseGraphQLSchema } from '../src/graphql-parser.js';

test('risk engine calculates configured critical production exposure', () => {
  const report = new RiskEngine({
    baseWeightBreaking: 20,
    publicApiBonus: 25,
    criticalityMultipliers: { TIER_0_CRITICAL: 2, TIER_1_HIGH: 1.4, TIER_2_MEDIUM: 1, TIER_3_LOW: .5 },
    thresholds: { critical: 70, high: 45, medium: 20 },
  }).calculateRisk([
    { consumerNode: { id:'c', type:'consumer', name:'web', file:'web.ts', metadata:{confidence:100,evidence:[]} }, targetContractId:'contract', dependencyCategory:'DIRECT', severity:'BREAKING', reason:"Consumer accesses changed field 'email'.", fieldLevelMatch:true, changedPaths:['email'], evidence:[], confidence:100, proofLevel:'PROVEN' },
  ], { serviceName:'Payments', criticality:'TIER_0_CRITICAL', isPublicApi:true, environment:'production' });
  assert.equal(report.level, 'CRITICAL');
  assert.equal(report.score, 70);
  assert.match(report.explanation, /Payments/);
});

test('config loader is data-driven and does not require a config file', () => {
  const loaded = ConfigLoader.load(process.cwd());
  assert.equal(loaded.file, null);
  assert.deepEqual(loaded.services, {});
});

test('graphql parser maps GraphQL nullability and lists into canonical fields', () => {
  const schema = parseGraphQLSchema('type User { id: ID! tags: [String!]! active: Boolean }', 'User');
  assert.equal(schema.fields.id?.optional, false);
  assert.equal(schema.fields.tags?.type.kind, 'array');
  assert.equal(schema.fields.active?.nullable, true);
  assert.equal(schema.fields.active?.optional, false);
});
