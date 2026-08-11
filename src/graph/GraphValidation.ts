import type { ContractEdge, ContractEdgeRelation, ContractNode, ContractNodeType, Evidence } from './types.js';

export type GraphValidationCode =
  | 'ORPHAN_EDGE_REFERENCE'
  | 'DUPLICATE_NODE_ID'
  | 'DUPLICATE_EDGE_ID'
  | 'DUPLICATE_RELATION'
  | 'INVALID_CONFIDENCE'
  | 'INVALID_EVIDENCE'
  | 'INCONSISTENT_ADJACENCY'
  | 'IMPOSSIBLE_RELATION';

export interface GraphValidationIssue {
  severity: 'error' | 'warning';
  code: GraphValidationCode;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: GraphValidationIssue[];
  warnings: GraphValidationIssue[];
}

/**
 * Relation type constraints, expressed as (from-node-type, to-node-type) pairs.
 * Deliberately conservative: only the two relations the graph builder actually
 * produces today (`produces`, `consumes`) are checked. `defines`/`references`/
 * `aliases` are not yet given a concrete type contract by the builder, so we do
 * not invent one here — flagging those would be guessing, not proving.
 */
const RELATION_CONSTRAINTS: Partial<Record<ContractEdgeRelation, { from: ContractNodeType; to: ContractNodeType }>> = {
  produces: { from: 'producer', to: 'contract' },
  consumes: { from: 'contract', to: 'consumer' },
};

function isConfidenceValid(c: number): boolean {
  return Number.isFinite(c) && c >= 0 && c <= 100;
}

function validateEvidenceList(evidence: Evidence[] | undefined, ownerNodeId: string | undefined, ownerEdgeId: string | undefined, errors: GraphValidationIssue[]): void {
  for (const e of evidence ?? []) {
    if (!e.file || !e.description) {
      errors.push({ severity: 'error', code: 'INVALID_EVIDENCE', message: `Evidence is missing required file/description (kind=${e.kind}).`, nodeId: ownerNodeId, edgeId: ownerEdgeId });
    }
    if (!isConfidenceValid(e.confidence)) {
      errors.push({ severity: 'error', code: 'INVALID_EVIDENCE', message: `Evidence confidence ${e.confidence} is out of the valid 0-100 range.`, nodeId: ownerNodeId, edgeId: ownerEdgeId });
    }
  }
}

/**
 * Structural validation over the graph's *current* state: orphan references,
 * duplicate IDs accumulated during construction, out-of-range confidence,
 * malformed evidence, adjacency-index consistency, and relation/node-type
 * mismatches. This never infers correctness it can't prove — anything not
 * covered by an explicit check below is left unvalidated rather than guessed at.
 */
export function validateGraph(input: {
  nodes: ContractNode[];
  edges: ContractEdge[];
  outgoing: Map<string, Set<string>>;
  incoming: Map<string, Set<string>>;
  duplicateNodeIds: string[];
  duplicateEdgeIds: string[];
}): GraphValidationResult {
  const errors: GraphValidationIssue[] = [];
  const warnings: GraphValidationIssue[] = [];
  const nodesById = new Map(input.nodes.map(n => [n.id, n]));
  const edgesById = new Map(input.edges.map(e => [e.id, e]));

  for (const id of input.duplicateNodeIds) {
    warnings.push({ severity: 'warning', code: 'DUPLICATE_NODE_ID', message: `Node id '${id}' was added more than once; the later addition silently replaced the earlier one.`, nodeId: id });
  }
  for (const id of input.duplicateEdgeIds) {
    warnings.push({ severity: 'warning', code: 'DUPLICATE_EDGE_ID', message: `Edge id '${id}' was added more than once; the later addition silently replaced the earlier one.`, edgeId: id });
  }

  // Duplicate (from, to, relation) triples: not necessarily wrong (e.g. two
  // distinct evidence sources for the same dependency could legitimately be
  // merged elsewhere), but worth surfacing since it usually indicates the
  // same fact was recorded twice under different edge IDs.
  const relationSeen = new Map<string, string>();
  for (const e of input.edges) {
    const key = `${e.from}|${e.to}|${e.relation}`;
    const prior = relationSeen.get(key);
    if (prior) {
      warnings.push({ severity: 'warning', code: 'DUPLICATE_RELATION', message: `Edges '${prior}' and '${e.id}' both express ${e.relation}: ${e.from} -> ${e.to}.`, edgeId: e.id });
    } else {
      relationSeen.set(key, e.id);
    }
  }

  for (const n of input.nodes) {
    if (!isConfidenceValid(n.metadata.confidence)) {
      errors.push({ severity: 'error', code: 'INVALID_CONFIDENCE', message: `Node '${n.id}' confidence ${n.metadata.confidence} is out of the valid 0-100 range.`, nodeId: n.id });
    }
    validateEvidenceList(n.metadata.evidence, n.id, undefined, errors);
  }

  for (const e of input.edges) {
    if (!nodesById.has(e.from) || !nodesById.has(e.to)) {
      errors.push({ severity: 'error', code: 'ORPHAN_EDGE_REFERENCE', message: `Edge '${e.id}' references a node that does not exist in the graph (${e.from} -> ${e.to}).`, edgeId: e.id });
      continue;
    }
    if (!isConfidenceValid(e.confidence)) {
      errors.push({ severity: 'error', code: 'INVALID_CONFIDENCE', message: `Edge '${e.id}' confidence ${e.confidence} is out of the valid 0-100 range.`, edgeId: e.id });
    }
    validateEvidenceList(e.evidence, undefined, e.id, errors);

    const constraint = RELATION_CONSTRAINTS[e.relation];
    if (constraint) {
      const fromNode = nodesById.get(e.from);
      const toNode = nodesById.get(e.to);
      if (fromNode && fromNode.type !== constraint.from) {
        errors.push({ severity: 'error', code: 'IMPOSSIBLE_RELATION', message: `Edge '${e.id}' is '${e.relation}' but its source node '${e.from}' has type '${fromNode.type}', expected '${constraint.from}'.`, edgeId: e.id, nodeId: e.from });
      }
      if (toNode && toNode.type !== constraint.to) {
        errors.push({ severity: 'error', code: 'IMPOSSIBLE_RELATION', message: `Edge '${e.id}' is '${e.relation}' but its target node '${e.to}' has type '${toNode.type}', expected '${constraint.to}'.`, edgeId: e.id, nodeId: e.to });
      }
    }
  }

  // Adjacency-index consistency: every edge must be reachable from both its
  // endpoints' index sets, and every indexed id must resolve to a real edge.
  // With the current insertion-only API this should always hold; this check
  // exists as a safety net against future mutation paths (e.g. node/edge
  // removal) silently leaving the index out of sync with the edge map.
  for (const e of input.edges) {
    if (!(input.outgoing.get(e.from)?.has(e.id))) {
      errors.push({ severity: 'error', code: 'INCONSISTENT_ADJACENCY', message: `Edge '${e.id}' is missing from the outgoing index of '${e.from}'.`, edgeId: e.id, nodeId: e.from });
    }
    if (!(input.incoming.get(e.to)?.has(e.id))) {
      errors.push({ severity: 'error', code: 'INCONSISTENT_ADJACENCY', message: `Edge '${e.id}' is missing from the incoming index of '${e.to}'.`, edgeId: e.id, nodeId: e.to });
    }
  }
  for (const [nodeId, ids] of input.outgoing) {
    for (const eid of ids) if (!edgesById.has(eid)) errors.push({ severity: 'error', code: 'INCONSISTENT_ADJACENCY', message: `Outgoing index for '${nodeId}' references nonexistent edge '${eid}'.`, edgeId: eid, nodeId });
  }
  for (const [nodeId, ids] of input.incoming) {
    for (const eid of ids) if (!edgesById.has(eid)) errors.push({ severity: 'error', code: 'INCONSISTENT_ADJACENCY', message: `Incoming index for '${nodeId}' references nonexistent edge '${eid}'.`, edgeId: eid, nodeId });
  }

  return { valid: errors.length === 0, errors, warnings };
}
