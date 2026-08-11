import type { FieldType } from '../types.js';

export interface Location { line: number; column: number; }
export type EvidenceKind = 'ast' | 'symbol-resolution' | 'route-match' | 'type-resolution' | 'value-resolution' | 'import-resolution';
/**
 * A single piece of provenance backing a claim (an edge, a change, an impact).
 * The `id`/`endLine`/`endColumn`/`resolutionMethod`/`supportingNodeIds`/`supportingEdgeIds`
 * fields are optional additions layered on top of the original string-description
 * evidence shape so existing call sites that construct `{ kind, file, description,
 * confidence }` literals keep compiling unchanged.
 */
export interface Evidence { id?: string; kind: EvidenceKind; file: string; line?: number; column?: number; endLine?: number; endColumn?: number; description: string; confidence: number; resolutionMethod?: ResolutionMethod; supportingNodeIds?: string[]; supportingEdgeIds?: string[]; }
export type ContractNodeType = 'producer' | 'consumer' | 'contract' | 'symbol' | 'file';
export interface ContractNodeMetadata { framework?: string; serviceName?: string; confidence: number; evidence: Evidence[]; sourceKind?: string; endpointUrl?: string; httpMethod?: string; isDynamicAccess?: boolean; accessedProperties?: string[]; unguardedContinuation?: string[]; }
export interface ContractNode { id: string; type: ContractNodeType; name: string; file: string; location?: Location; shape?: FieldType; metadata: ContractNodeMetadata; }
export type ContractEdgeRelation = 'produces' | 'consumes' | 'defines' | 'references' | 'aliases';
export type ResolutionMethod = 'exact' | 'fuzzy' | 'symbol' | 'type' | 'heuristic' | 'inferred';
export interface ContractEdge { id: string; from: string; to: string; relation: ContractEdgeRelation; confidence: number; evidence: Evidence[]; resolutionMethod: ResolutionMethod; }

/**
 * How strongly a claim is backed by evidence. This is a *classification*, not a
 * probability — driftguard never presents ProofLevel as a statistical
 * confidence interval. The ordering PROVEN > STRONG > POTENTIAL > UNKNOWN is a
 * strict ranking used only for display/sorting, never averaged or summed.
 *
 *  PROVEN     exact AST + exact symbol/route resolution, no ambiguity
 *  STRONG     resolved via symbol/type resolution, no dynamic access, high confidence
 *  POTENTIAL  a plausible dependency exists but exact resolution is not proven
 *  UNKNOWN    dynamic/computed access, unresolved symbol, or parser failure
 */
export type ProofLevel = 'PROVEN' | 'STRONG' | 'POTENTIAL' | 'UNKNOWN';

