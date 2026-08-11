import type { ContractEdge, ContractEdgeRelation, ContractNode, ProofLevel, ResolutionMethod } from './types.js';
import { compareProofLevel, deriveProofLevel } from './proofLevel.js';

/**
 * A single traversed edge in a dependency path, carrying the same provenance
 * that backed the edge in the graph. Nothing here is invented — every hop is
 * a real edge that was added to the graph via `ContractGraph.addEdge`.
 */
export interface DependencyPathHop {
  edgeId: string;
  from: string;
  to: string;
  fromType: string;
  toType: string;
  relation: ContractEdgeRelation;
  resolutionMethod: ResolutionMethod;
  confidence: number;
}

/**
 * How a consumer became dependent on a contract, expressed as an explicit
 * chain of graph edges rather than a single classification word. This answers
 * the spec requirement: "How exactly did this consumer become dependent on
 * this contract?"
 *
 *   DIRECT      a single `consumes` edge, contract -> consumer, backed by
 *               strong-or-better evidence.
 *   TRANSITIVE  a multi-hop chain (e.g. contract -> symbol -> alias ->
 *               consumer) where every hop is backed by strong-or-better
 *               evidence (no fuzzy/heuristic links in the chain).
 *   POTENTIAL   a path exists, but at least one hop is only weakly resolved
 *               (fuzzy/heuristic) or the chain's proof level caps at POTENTIAL.
 *   UNKNOWN     no path could be found, or resolving it would require dynamic
 *               evidence that cannot be statically proven.
 *
 * The golden rule from the spec applies here too: reachability alone never
 * implies DIRECT. A single hop with weak evidence is POTENTIAL or UNKNOWN,
 * never DIRECT, no matter how short the path is.
 */
export type DependencyPathKind = 'DIRECT' | 'TRANSITIVE' | 'POTENTIAL' | 'UNKNOWN';

export interface DependencyPath {
  contractId: string;
  consumerId: string;
  kind: DependencyPathKind;
  hops: DependencyPathHop[];
  length: number;
  /** Weakest-link proof level across all hops (never averaged/summed — see proofLevel.ts). */
  proofLevel: ProofLevel;
  /** Human-readable chain, e.g. "Contract -> Symbol -> Alias -> Consumer". */
  explanation: string;
}

export interface PathGraphView {
  getNode(id: string): ContractNode | undefined;
  getEdge(id: string): ContractEdge | undefined;
  outgoingEdgeIds(id: string): Iterable<string>;
}

function noPath(contractId: string, consumerId: string): DependencyPath {
  return {
    contractId,
    consumerId,
    kind: 'UNKNOWN',
    hops: [],
    length: 0,
    proofLevel: 'UNKNOWN',
    explanation: 'No graph path could be found from this contract to this consumer.',
  };
}

/**
 * Breadth-first search for the shortest edge-path from `contractId` to
 * `consumerId`. BFS guarantees the minimum hop count; among paths of equal
 * length, the one discovered first via deterministic (id-sorted) edge
 * ordering wins, so results are stable across runs. Visited-node tracking
 * makes this cycle-safe: `aliases`/`references` edges that loop back on
 * themselves cannot cause infinite traversal.
 */
export function findShortestDependencyPath(graph: PathGraphView, contractId: string, consumerId: string): DependencyPathHop[] | null {
  if (contractId === consumerId) return [];
  const visited = new Set<string>([contractId]);
  const queue: string[] = [contractId];
  const cameFrom = new Map<string, DependencyPathHop>();

  while (queue.length) {
    const current = queue.shift()!;
    const edgeIds = [...graph.outgoingEdgeIds(current)].sort();
    for (const edgeId of edgeIds) {
      const edge = graph.getEdge(edgeId);
      if (!edge) continue;
      if (visited.has(edge.to)) continue;
      const fromNode = graph.getNode(edge.from);
      const toNode = graph.getNode(edge.to);
      if (!fromNode || !toNode) continue;
      visited.add(edge.to);
      cameFrom.set(edge.to, {
        edgeId: edge.id,
        from: edge.from,
        to: edge.to,
        fromType: fromNode.type,
        toType: toNode.type,
        relation: edge.relation,
        resolutionMethod: edge.resolutionMethod,
        confidence: edge.confidence,
      });
      if (edge.to === consumerId) {
        // Reconstruct the path by walking cameFrom back to the start.
        const hops: DependencyPathHop[] = [];
        let cursor = consumerId;
        while (cursor !== contractId) {
          const hop = cameFrom.get(cursor)!;
          hops.unshift(hop);
          cursor = hop.from;
        }
        return hops;
      }
      queue.push(edge.to);
    }
  }
  return null;
}

function classifyPath(hops: DependencyPathHop[]): { kind: DependencyPathKind; proofLevel: ProofLevel } {
  if (hops.length === 0) return { kind: 'UNKNOWN', proofLevel: 'UNKNOWN' };

  let weakest: ProofLevel = 'PROVEN';
  let hasWeakHop = false;
  for (const hop of hops) {
    const hopProof = deriveProofLevel({ resolutionMethod: hop.resolutionMethod, confidence: hop.confidence });
    if (compareProofLevel(hopProof, weakest) < 0) weakest = hopProof;
    if (hop.resolutionMethod === 'fuzzy' || hop.resolutionMethod === 'heuristic') hasWeakHop = true;
  }

  if (weakest === 'UNKNOWN') return { kind: 'UNKNOWN', proofLevel: 'UNKNOWN' };

  const isSingleDirectHop = hops.length === 1 && hops[0]!.relation === 'consumes';

  if (hasWeakHop || weakest === 'POTENTIAL') return { kind: 'POTENTIAL', proofLevel: weakest };
  if (isSingleDirectHop) return { kind: 'DIRECT', proofLevel: weakest };
  return { kind: 'TRANSITIVE', proofLevel: weakest };
}

function explain(hops: DependencyPathHop[], graph: PathGraphView, contractId: string, consumerId: string): string {
  if (!hops.length) return 'No graph path could be found from this contract to this consumer.';
  const names: string[] = [graph.getNode(contractId)?.name ?? contractId];
  for (const hop of hops) names.push(graph.getNode(hop.to)?.name ?? hop.to);
  return names.join(' -> ');
}

/**
 * Explain exactly how `consumerId` became dependent on `contractId`, as a
 * concrete chain of graph edges rather than a bare classification. Never
 * infers DIRECT merely from reachability: a one-hop path with weak evidence
 * is reported as POTENTIAL/UNKNOWN, not DIRECT.
 */
export function explainDependencyPath(graph: PathGraphView, contractId: string, consumerId: string): DependencyPath {
  const hops = findShortestDependencyPath(graph, contractId, consumerId);
  if (!hops || hops.length === 0) return { ...noPath(contractId, consumerId), contractId, consumerId };
  const { kind, proofLevel } = classifyPath(hops);
  return {
    contractId,
    consumerId,
    kind,
    hops,
    length: hops.length,
    proofLevel,
    explanation: explain(hops, graph, contractId, consumerId),
  };
}
