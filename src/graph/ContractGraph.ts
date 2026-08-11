import type { ContractEdge, ContractNode } from './types.js';
import { validateGraph, type GraphValidationResult } from './GraphValidation.js';
import { explainDependencyPath, type DependencyPath } from './PathTraversal.js';

export class ContractGraph {
  private readonly nodes = new Map<string, ContractNode>();
  private readonly edges = new Map<string, ContractEdge>();
  private readonly outgoing = new Map<string, Set<string>>();
  private readonly incoming = new Map<string, Set<string>>();
  private readonly duplicateNodeIds: string[] = [];
  private readonly duplicateEdgeIds: string[] = [];

  addNode(node: ContractNode): void {
    if (!node?.id) throw new Error('Cannot add invalid node without an id');
    if (this.nodes.has(node.id)) this.duplicateNodeIds.push(node.id);
    this.nodes.set(node.id, structuredClone(node));
    if (!this.outgoing.has(node.id)) this.outgoing.set(node.id, new Set());
    if (!this.incoming.has(node.id)) this.incoming.set(node.id, new Set());
  }
  addEdge(edge: ContractEdge): void {
    if (!edge?.id || !edge.from || !edge.to) throw new Error('Cannot add invalid edge');
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) throw new Error(`Orphan edge rejected: ${edge.from} -> ${edge.to}`);
    if (this.edges.has(edge.id)) this.duplicateEdgeIds.push(edge.id);
    this.edges.set(edge.id, structuredClone(edge));
    this.outgoing.get(edge.from)!.add(edge.id);
    this.incoming.get(edge.to)!.add(edge.id);
  }
  getNode(id: string) { return this.nodes.get(id); }
  getEdge(id: string) { return this.edges.get(id); }
  getNodes() { return [...this.nodes.values()].sort((a,b)=>a.id.localeCompare(b.id)); }
  getEdges() { return [...this.edges.values()].sort((a,b)=>a.id.localeCompare(b.id)); }
  getDirectConsumers(id: string) {
    const out: ContractNode[] = [];
    for (const eid of this.outgoing.get(id) ?? []) { const e=this.edges.get(eid); const n=e&&this.nodes.get(e.to); if(e?.relation==='consumes'&&n) out.push(n); }
    return out.sort((a,b)=>a.id.localeCompare(b.id));
  }
  getTransitiveConsumers(id: string) {
    const seen=new Set<string>(), out=new Map<string,ContractNode>();
    const visit=(cur:string)=>{ if(seen.has(cur)) return; seen.add(cur); for(const eid of this.outgoing.get(cur)??[]){const e=this.edges.get(eid); if(!e)continue; const n=this.nodes.get(e.to); if(!n)continue; if(n.type==='consumer'||e.relation==='consumes')out.set(n.id,n); visit(n.id);} };
    visit(id); return [...out.values()].sort((a,b)=>a.id.localeCompare(b.id));
  }
  getProducers(id: string) { const out:ContractNode[]=[]; for(const eid of this.incoming.get(id)??[]){const e=this.edges.get(eid);const n=e&&this.nodes.get(e.from);if(e?.relation==='produces'&&n)out.push(n);} return out.sort((a,b)=>a.id.localeCompare(b.id)); }
  /** Structural invariant check over the graph's current state. See GraphValidation.ts for the full rule set. */
  validate(): GraphValidationResult {
    return validateGraph({
      nodes: this.getNodes(),
      edges: this.getEdges(),
      outgoing: this.outgoing,
      incoming: this.incoming,
      duplicateNodeIds: [...this.duplicateNodeIds],
      duplicateEdgeIds: [...this.duplicateEdgeIds],
    });
  }
  clone(){const g=new ContractGraph(); for(const n of this.getNodes())g.addNode(n);for(const e of this.getEdges())g.addEdge(e);return g;}
  /**
   * Explain exactly how `consumerId` depends on `contractId` as a concrete
   * chain of graph edges (DIRECT/TRANSITIVE/POTENTIAL/UNKNOWN), not merely
   * whether it is reachable. See PathTraversal.ts for the classification rules.
   */
  explainPath(contractId: string, consumerId: string): DependencyPath {
    return explainDependencyPath(
      { getNode: (id) => this.getNode(id), getEdge: (id) => this.getEdge(id), outgoingEdgeIds: (id) => this.outgoing.get(id) ?? [] },
      contractId,
      consumerId,
    );
  }
}
