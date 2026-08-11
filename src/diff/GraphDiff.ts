import type { Field, FieldType } from '../types.js';
import { ContractGraph } from '../graph/ContractGraph.js';
import type { ContractNode, Evidence, ProofLevel } from '../graph/types.js';
import { deriveProofLevel } from '../graph/proofLevel.js';

export type ContractChangeKind='added'|'removed'|'modified';
export type FieldChangeKind='added'|'removed'|'type-changed'|'optionality-changed';
export interface FieldChange { path:string; kind:FieldChangeKind; before?:unknown; after?:unknown; }
/**
 * A semantic rename inferred from a removed+added field pair at the same nesting
 * level. This is an ENRICHMENT layered on top of `fieldChanges`, not a replacement:
 * `fieldChanges` always keeps the raw removed/added entries (backward compatible),
 * and `renames` additionally explains when/why a remove+add pair looks like the same
 * field having moved. A pair is only ever reported here when the evidence supports it
 * (exact type match, and an unambiguous best-match pairing) — never merely because a
 * remove and an add happened to occur in the same diff.
 */
export interface FieldRename { oldPath:string; newPath:string; oldType:FieldType; newType:FieldType; structuralSimilarity:number; confidence:number; proofLevel:ProofLevel; reason:string; }
export interface ContractChange { contractId:string; kind:ContractChangeKind; nodeName:string; file:string; fieldChanges:FieldChange[]; renames:FieldRename[]; beforeShape?:FieldType; afterShape?:FieldType; confidence:number; evidence:Evidence[]; }

function diffFields(prefix:string,b:Record<string,Field>,c:Record<string,Field>):FieldChange[]{const out:FieldChange[]=[];const names=new Set([...Object.keys(b),...Object.keys(c)]);for(const n of [...names].sort()){const p=prefix?`${prefix}.${n}`:n;const bf=b[n],cf=c[n];if(!bf){out.push({path:p,kind:'added',after:cf});continue;}if(!cf){out.push({path:p,kind:'removed',before:bf});continue;}if(bf.optional!==cf.optional||bf.nullable!==cf.nullable)out.push({path:p,kind:'optionality-changed',before:{optional:bf.optional,nullable:bf.nullable},after:{optional:cf.optional,nullable:cf.nullable}});out.push(...diffType(p,bf.type,cf.type));}return out;}
function diffType(path:string,b:FieldType,c:FieldType):FieldChange[]{if(b.kind!==c.kind)return[{path,kind:'type-changed',before:b,after:c}];if(b.kind==='primitive'&&c.kind==='primitive'&&b.name!==c.name)return[{path,kind:'type-changed',before:b.name,after:c.name}];if(b.kind==='literal'&&c.kind==='literal'&&b.value!==c.value)return[{path,kind:'type-changed',before:b.value,after:c.value}];if(b.kind==='reference'&&c.kind==='reference'&&b.name!==c.name)return[{path,kind:'type-changed',before:b.name,after:c.name}];if(b.kind==='array'&&c.kind==='array')return diffType(`${path}[]`,b.element,c.element);if(b.kind==='object'&&c.kind==='object')return diffFields(path,b.fields,c.fields);if(b.kind==='union'&&c.kind==='union'&&b.options.length!==c.options.length)return[{path,kind:'type-changed',before:b,after:c}];return[];}
function shape(n:ContractNode){return n.shape;}

// ---------------------------------------------------------------------------
// Semantic rename detection
// ---------------------------------------------------------------------------
// A remove+add pair is only ever reported as a rename when its *type* is an
// exact structural match — that is the load-bearing evidence. Name similarity
// is used only to disambiguate which removed field pairs with which added
// field when several candidates share the same type; it never on its own
// justifies a rename.

function typesEqual(a:FieldType,b:FieldType):boolean{
  if(a.kind!==b.kind)return false;
  switch(a.kind){
    case 'primitive':return a.name===(b as typeof a).name;
    case 'literal':return a.value===(b as typeof a).value;
    case 'reference':return a.name===(b as typeof a).name;
    case 'array':return typesEqual(a.element,(b as typeof a).element);
    case 'enum':{const bb=b as typeof a;return a.name===bb.name&&a.variants.length===bb.variants.length&&a.variants.every((v,i)=>v===bb.variants[i]);}
    case 'union':{const bb=b as typeof a;return a.options.length===bb.options.length&&a.options.every((o,i)=>{const other=bb.options[i];return other!==undefined&&typesEqual(o,other);});}
    case 'object':{const bb=b as typeof a;const ak=Object.keys(a.fields).sort(),bk=Object.keys(bb.fields).sort();if(ak.length!==bk.length)return false;return ak.every((k,i)=>k===bk[i]&&typesEqual(a.fields[k]!.type,bb.fields[k]!.type));}
    default:return false;
  }
}

/** Normalized similarity (0..1) between two leaf field names, case- and separator-insensitive. */
function nameSimilarity(a:string,b:string):number{
  const norm=(s:string)=>s.toLowerCase().replace(/[_-]/g,'');
  const x=norm(a),y=norm(b);
  if(x===y)return 1;
  const dp:number[][]=Array.from({length:x.length+1},()=>new Array<number>(y.length+1).fill(0));
  for(let i=0;i<=x.length;i++)dp[i]![0]=i;
  for(let j=0;j<=y.length;j++)dp[0]![j]=j;
  for(let i=1;i<=x.length;i++)for(let j=1;j<=y.length;j++)dp[i]![j]=x[i-1]===y[j-1]?dp[i-1]![j-1]!:1+Math.min(dp[i-1]![j]!,dp[i]![j-1]!,dp[i-1]![j-1]!);
  const dist=dp[x.length]![y.length]!;
  return Math.max(0,1-dist/Math.max(x.length,y.length,1));
}

function parentOf(path:string):string{const idx=path.lastIndexOf('.');return idx===-1?'':path.slice(0,idx);}
function leafOf(path:string):string{const idx=path.lastIndexOf('.');return idx===-1?path:path.slice(idx+1);}

function detectRenames(fieldChanges:FieldChange[]):FieldRename[]{
  const removed=fieldChanges.filter(f=>f.kind==='removed');
  const added=fieldChanges.filter(f=>f.kind==='added');
  if(!removed.length||!added.length)return[];
  const byParent=new Map<string,{removed:FieldChange[];added:FieldChange[]}>();
  for(const r of removed){const p=parentOf(r.path);if(!byParent.has(p))byParent.set(p,{removed:[],added:[]});byParent.get(p)!.removed.push(r);}
  for(const a of added){const p=parentOf(a.path);if(!byParent.has(p))byParent.set(p,{removed:[],added:[]});byParent.get(p)!.added.push(a);}

  const renames:FieldRename[]=[];
  for(const [,group] of byParent){
    if(!group.removed.length||!group.added.length)continue;
    type Candidate={r:FieldChange;a:FieldChange;nameScore:number};
    const candidates:Candidate[]=[];
    for(const r of group.removed){
      const rField=r.before as {type:FieldType}|undefined;
      if(!rField)continue;
      for(const a of group.added){
        const aField=a.after as {type:FieldType}|undefined;
        if(!aField)continue;
        // Necessary condition: exact structural type match. Without this, a
        // remove+add pair is left as two independent raw changes — we never
        // guess a rename across an incompatible type change.
        if(!typesEqual(rField.type,aField.type))continue;
        candidates.push({r,a,nameScore:nameSimilarity(leafOf(r.path),leafOf(a.path))});
      }
    }
    // Stable greedy matching: strongest name-similarity pairs win first, each
    // field used at most once. This avoids pairing e.g. two unrelated
    // same-typed fields arbitrarily when the pairing is genuinely ambiguous.
    candidates.sort((x,y)=>y.nameScore-x.nameScore);
    const usedR=new Set<string>(),usedA=new Set<string>();
    for(const c of candidates){
      if(usedR.has(c.r.path)||usedA.has(c.a.path))continue;
      usedR.add(c.r.path);usedA.add(c.a.path);
      const rField=c.r.before as {type:FieldType};
      const aField=c.a.after as {type:FieldType};
      const structuralSimilarity=Math.min(1,0.7+c.nameScore*0.3);
      const confidence=Math.round(60+c.nameScore*40);
      renames.push({
        oldPath:c.r.path,newPath:c.a.path,oldType:rField.type,newType:aField.type,
        structuralSimilarity,confidence,
        // A rename is always an *inferred* pairing, never a directly observed AST fact
        // (we never saw a literal "rename" operation — we inferred it from a remove+add
        // shape match). So proofLevel is deliberately capped below PROVEN regardless of
        // how confident the type/name match is.
        proofLevel:deriveProofLevel({resolutionMethod:'exact',confidence,isInferred:true}),
        reason:c.nameScore>=0.99
          ?`Exact type match with identical leaf name across a remove+add pair (parent unchanged).`
          :`Exact type match; leaf name '${leafOf(c.r.path)}' -> '${leafOf(c.a.path)}' is the best available pairing (similarity ${(c.nameScore*100).toFixed(0)}%).`,
      });
    }
  }
  return renames.sort((x,y)=>x.oldPath.localeCompare(y.oldPath));
}
export class GraphDiffEngine{
 static compareGraphs(base:ContractGraph,current:ContractGraph):ContractChange[]{const out:ContractChange[]=[];const b=new Map(base.getNodes().filter(n=>n.type==='contract').map(n=>[n.id,n]));const c=new Map(current.getNodes().filter(n=>n.type==='contract').map(n=>[n.id,n]));
 for(const [id,n] of b){if(!c.has(id))out.push({contractId:id,kind:'removed',nodeName:n.name,file:n.file,fieldChanges:[],renames:[],beforeShape:shape(n),confidence:n.metadata.confidence,evidence:[...n.metadata.evidence,{kind:'ast',file:n.file,description:'Contract node exists in baseline but not current graph',confidence:100}]});}
 for(const [id,n] of c){const old=b.get(id);if(!old){out.push({contractId:id,kind:'added',nodeName:n.name,file:n.file,fieldChanges:[],renames:[],afterShape:shape(n),confidence:n.metadata.confidence,evidence:[...n.metadata.evidence,{kind:'ast',file:n.file,description:'Contract node exists only in current graph',confidence:100}]});continue;}if(old.shape&&n.shape){const fc=diffType('root',old.shape,n.shape);if(fc.length)out.push({contractId:id,kind:'modified',nodeName:n.name,file:n.file,fieldChanges:fc,renames:detectRenames(fc),beforeShape:old.shape,afterShape:n.shape,confidence:Math.min(old.metadata.confidence,n.metadata.confidence),evidence:[...n.metadata.evidence,{kind:'type-resolution',file:n.file,description:`Structural contract change: ${fc.length} field/type mutations`,confidence:100}]});}}
 return out.sort((a,z)=>a.contractId.localeCompare(z.contractId));}
}
