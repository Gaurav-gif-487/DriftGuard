import { ContractGraph } from '../graph/ContractGraph.js';
import type { ContractNode, Evidence } from '../graph/types.js';
import type { ContractChange } from '../diff/GraphDiff.js';
import { RiskEngine, type RiskReport } from '../risk/RiskEngine.js';
import type { RiskConfiguration, RiskEvaluationContext } from '../risk/riskConfig.js';
import { deriveProofLevel, compareProofLevel } from '../graph/proofLevel.js';
import type { ProofLevel } from '../graph/types.js';
import type { DependencyPath } from '../graph/PathTraversal.js';

export type ImpactSeverity = 'BREAKING'|'WARNING'|'SAFE'|'UNKNOWN';
export type DependencyCategory = 'DIRECT'|'TRANSITIVE'|'POTENTIAL'|'UNUSED'|'UNKNOWN';
export interface AffectedConsumerImpact { consumerNode: ContractNode; targetContractId: string; dependencyCategory: DependencyCategory; severity: ImpactSeverity; reason: string; fieldLevelMatch: boolean; changedPaths: string[]; evidence: Evidence[]; confidence: number; proofLevel: ProofLevel; path: DependencyPath; }
export interface RiskFactors { confirmedBreaking: number; potentialBreaking: number; highCriticalityConsumers: number; totalConsumers: number; unresolvedUnknowns: number; }
export interface ImpactRisk { score: number; factors: RiskFactors; report?: RiskReport; }
export interface ImpactReport { baseIdentity:string; currentIdentity:string; timestamp:string; changes:ContractChange[]; impacts:AffectedConsumerImpact[]; risk:ImpactRisk; summary:{totalChanges:number;breaking:number;warning:number;safe:number;unknown:number;impactScore:number;}; }
const ratio=(n:number,d:number)=>d?Math.min(1,n/d):0;

export class ImpactEngine {
  static evaluateImpact(
    baseIdentity:string,
    currentIdentity:string,
    changes:ContractChange[],
    graph:ContractGraph,
    options:{baselineGraph?:ContractGraph;riskConfig?:Partial<RiskConfiguration>;riskContext?:RiskEvaluationContext} = {},
  ):ImpactReport {
    const impacts:AffectedConsumerImpact[]=[];
    // Consumers must be resolved from the graph in which the dependency existed.
    // This is critical for deleted endpoints/contracts: the current graph no longer
    // contains the edge, so looking only at `graph` would silently report zero impact.
    for(const change of changes){
      const sourceGraph = change.kind === 'removed' ? (options.baselineGraph ?? graph) : graph;
      for(const consumer of sourceGraph.getTransitiveConsumers(change.contractId)) {
        impacts.push(this.classify(change,consumer,sourceGraph));
      }
    }

    const dedupe=new Map<string,AffectedConsumerImpact>();
    for(const impact of impacts){const key=`${impact.targetContractId}:${impact.consumerNode.id}`;const previous=dedupe.get(key);if(!previous||impact.confidence>previous.confidence)dedupe.set(key,impact);}
    const final=[...dedupe.values()].sort((a,b)=>a.consumerNode.id.localeCompare(b.consumerNode.id));
    const breaking=final.filter(i=>i.severity==='BREAKING').length;
    const warning=final.filter(i=>i.severity==='WARNING').length;
    const safe=final.filter(i=>i.severity==='SAFE').length;
    const unknown=final.filter(i=>i.severity==='UNKNOWN').length;
    const factors:RiskFactors={
      confirmedBreaking:ratio(breaking,Math.max(1,final.length)),
      potentialBreaking:ratio(warning,Math.max(1,final.length)),
      highCriticalityConsumers:0,
      totalConsumers:ratio(final.length,Math.max(1,final.length+5)),
      unresolvedUnknowns:ratio(unknown,Math.max(1,final.length)),
    };
    const riskContext=options.riskContext ?? { serviceName: graph.getNodes().find(n=>n.type==='contract')?.metadata.serviceName };
    const riskReport=new RiskEngine(options.riskConfig).calculateRisk(final,riskContext);
    return {
      baseIdentity,currentIdentity,timestamp:new Date().toISOString(),changes,impacts:final,
      risk:{score:riskReport.score,factors,report:riskReport},
      summary:{totalChanges:changes.length,breaking,warning,safe,unknown,impactScore:riskReport.score},
    };
  }

  private static classify(change:ContractChange,consumer:ContractNode,graph:ContractGraph):AffectedConsumerImpact {
    const metadata=consumer.metadata;
    const edge=graph.getEdges().find(e=>e.to===consumer.id&&e.relation==='consumes'&&e.from===change.contractId);
    const confidence=edge?.confidence??metadata.confidence;
    // Concrete edge chain explaining *how* this consumer became dependent on
    // this contract (DIRECT/TRANSITIVE/POTENTIAL/UNKNOWN), independent of the
    // field-level severity classification below. Reachability alone never
    // implies DIRECT — see PathTraversal.ts.
    const path=graph.explainPath(change.contractId,consumer.id);
    if(metadata.isDynamicAccess)return{consumerNode:consumer,targetContractId:change.contractId,dependencyCategory:'UNKNOWN',severity:'UNKNOWN',reason:'Dynamic/computed access cannot be statically proven.',fieldLevelMatch:false,changedPaths:change.fieldChanges.map(f=>f.path.replace(/^root\./,'')),evidence:metadata.evidence,confidence,proofLevel:'UNKNOWN',path};
    if(change.kind==='removed')return{consumerNode:consumer,targetContractId:change.contractId,dependencyCategory:edge?'DIRECT':'TRANSITIVE',severity:'BREAKING',reason:'The consumed contract was removed.',fieldLevelMatch:true,changedPaths:[],evidence:metadata.evidence,confidence,proofLevel:deriveProofLevel({resolutionMethod:edge?.resolutionMethod,confidence}),path};
    const changed=change.fieldChanges.map(f=>f.path.replace(/^root\./,''));
    // Accessing a field the diff newly ADDED is never itself a breaking signal — that
    // field didn't exist before, so no consumer could have depended on it going missing.
    // Only removed fields and type/optionality changes on fields that already existed
    // represent something an existing consumer's access can actually break on.
    const breakingCandidates=change.fieldChanges.filter(f=>f.kind!=='added').map(f=>f.path.replace(/^root\./,''));
    const accessed=metadata.accessedProperties??[];
    const hit=breakingCandidates.find(p=>accessed.includes(p)||accessed.some(a=>p.endsWith(`.${a}`)));
    if(hit){
      // Special case: a field that widened from required to optional is
      // NOT actually unsafe for a consumer whose access to it is guarded
      // (optional-chained continuation) or terminal (never dereferenced
      // further) — bare property access on a now-optional field never
      // throws in JS. This is what lets a `widen-optionality` repair
      // (RepairEngine.executeSafeOptionalChainingRepair) actually resolve
      // to SAFE on re-analysis instead of being permanently stuck BREAKING
      // regardless of the repair. Every other breaking-candidate kind
      // (removed, type-changed, or an unguarded widen) is untouched.
      const hitChange=change.fieldChanges.find(f=>f.path.replace(/^root\./,'')===hit);
      const before=hitChange?.before as {optional?:boolean}|undefined;
      const after=hitChange?.after as {optional?:boolean}|undefined;
      const widened=hitChange?.kind==='optionality-changed'&&before?.optional===false&&after?.optional===true;
      const leaf=hit.split('.').pop()!;
      const guarded=widened&&!(metadata.unguardedContinuation??[]).includes(leaf);
      if(guarded)return{consumerNode:consumer,targetContractId:change.contractId,dependencyCategory:edge?'DIRECT':'TRANSITIVE',severity:'SAFE',reason:`Field '${hit}' widened from required to optional, but the consumer's access is guarded (optional-chained or not further dereferenced).`,fieldLevelMatch:true,changedPaths:[hit],evidence:metadata.evidence,confidence,proofLevel:deriveProofLevel({resolutionMethod:edge?.resolutionMethod,confidence}),path};
      return{consumerNode:consumer,targetContractId:change.contractId,dependencyCategory:edge?'DIRECT':'TRANSITIVE',severity:'BREAKING',reason:`Consumer accesses changed field '${hit}'.`,fieldLevelMatch:true,changedPaths:[hit],evidence:metadata.evidence,confidence,proofLevel:deriveProofLevel({resolutionMethod:edge?.resolutionMethod,confidence}),path};
    }
    if(accessed.length)return{consumerNode:consumer,targetContractId:change.contractId,dependencyCategory:'UNUSED',severity:'SAFE',reason:'Known static accesses do not intersect changed fields.',fieldLevelMatch:false,changedPaths:changed,evidence:metadata.evidence,confidence,proofLevel:deriveProofLevel({resolutionMethod:edge?.resolutionMethod,confidence}),path};
    // No known accessed-property evidence at all: the dependency itself is known (the edge
    // exists) but field-level usage could not be proven either way. This can never be
    // reported as PROVEN/STRONG no matter how confident the edge resolution was — capped
    // at POTENTIAL, matching the POTENTIAL dependency category.
    const uncapped=deriveProofLevel({resolutionMethod:edge?.resolutionMethod,confidence});
    const proofLevel:ProofLevel=compareProofLevel(uncapped,'POTENTIAL')>0?'POTENTIAL':uncapped;
    return{consumerNode:consumer,targetContractId:change.contractId,dependencyCategory:'POTENTIAL',severity:'WARNING',reason:'Consumer dependency is known, but field-level usage could not be proven.',fieldLevelMatch:false,changedPaths:changed,evidence:metadata.evidence,confidence,proofLevel,path};
  }
}
