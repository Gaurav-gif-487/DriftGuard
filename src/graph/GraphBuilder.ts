import fs from 'node:fs';
import ts from 'typescript';
import { parseClientCallSites } from '../client-parser.js';
import { parseServerHandlers } from '../server-parser.js';
import { matchRoutes } from '../route-matcher.js';
import type { ServerHandler } from '../types.js';
import { ContractGraph } from './ContractGraph.js';
import type { Evidence } from './types.js';

const ev=(kind: Evidence['kind'], file:string, description:string, confidence:number, line?:number, column?:number):Evidence=>({kind,file,description,confidence,line,column});
const contractId=(s:ServerHandler)=>`contract:${s.method}:${s.route.raw}`;
function usageEvidence(file:string,line:number,column:number):{properties:string[];dynamic:boolean;evidence:Evidence[];unguardedContinuation:string[]} {
  let source:string; try{source=fs.readFileSync(file,'utf8');}catch{return{properties:[],dynamic:false,evidence:[],unguardedContinuation:[]};}
  const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX); const pos=sf.getPositionOfLineAndCharacter(Math.max(0,line-1),Math.max(0,column-1)); let target:ts.Node|undefined;
  const find=(n:ts.Node)=>{if(pos>=n.getStart(sf)&&pos<=n.getEnd()){target=n;ts.forEachChild(n,find);}};find(sf); if(!target)return{properties:[],dynamic:false,evidence:[],unguardedContinuation:[]};
  let decl:ts.VariableDeclaration|undefined; for(let n:ts.Node|undefined=target;n;n=n.parent){if(ts.isVariableDeclaration(n)){decl=n;break;}}
  if(!decl)return{properties:[],dynamic:false,evidence:[],unguardedContinuation:[]};
  const props=new Set<string>(), evidence:Evidence[]=[];let dynamic=false;
  const names=new Set<string>(); const collectBinding=(n:ts.BindingName)=>{if(ts.isIdentifier(n))names.add(n.text);else n.elements.forEach(e=>{if(ts.isBindingElement(e)){if(ts.isIdentifier(e.name))names.add(e.name.text);else collectBinding(e.name);if(e.propertyName&&ts.isIdentifier(e.propertyName))props.add(e.propertyName.text);}})};
  collectBinding(decl.name);
  // For each direct field access (`ident.field`), tracks whether the field
  // is ever *further dereferenced without optional chaining* (e.g.
  // `res.field.toFixed()`), as opposed to a terminal access (`res.field`
  // alone, which never throws) or a guarded continuation (`res.field?.x`).
  // Used by ImpactEngine to recognize when a `widen-optionality` repair
  // (inserting `?.` at the continuation) has actually neutralized the risk
  // — bare property access on an optional-now field is never itself
  // unsafe in JS, only what comes *after* it can be.
  const unguardedContinuation=new Set<string>();
  const directFieldName=(expr:ts.Node):string|undefined=>{
    if(ts.isPropertyAccessExpression(expr)&&ts.isIdentifier(expr.expression)&&names.has(expr.expression.text))return expr.name.text;
    if(ts.isElementAccessExpression(expr)&&ts.isIdentifier(expr.expression)&&names.has(expr.expression.text)&&expr.argumentExpression&&ts.isStringLiteral(expr.argumentExpression))return expr.argumentExpression.text;
    return undefined;
  };
  const visit=(n:ts.Node)=>{
    if(ts.isPropertyAccessExpression(n)&&ts.isIdentifier(n.expression)&&names.has(n.expression.text)){props.add(n.name.text);evidence.push(ev('ast',file,`Property access ${n.expression.text}.${n.name.text}`,100,sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,sf.getLineAndCharacterOfPosition(n.getStart(sf)).character+1));}
    else if(ts.isElementAccessExpression(n)&&ts.isIdentifier(n.expression)&&names.has(n.expression.text)){if(n.argumentExpression&&ts.isStringLiteral(n.argumentExpression))props.add(n.argumentExpression.text);else dynamic=true;}
    if((ts.isPropertyAccessExpression(n)||ts.isElementAccessExpression(n)||ts.isCallExpression(n))){const field=directFieldName(n.expression);if(field&&!n.questionDotToken)unguardedContinuation.add(field);}
    ts.forEachChild(n,visit);
  };visit(sf);
  return{properties:[...props].sort(),dynamic,evidence,unguardedContinuation:[...unguardedContinuation].sort()};
}

export interface GraphBuildOptions { threshold?: number; serviceName?: string; }
export async function buildContractGraph(clientDir:string, serverDir:string, options:GraphBuildOptions={}):Promise<ContractGraph>{
  const threshold=options.threshold??0.6; const [clients,servers]=await Promise.all([parseClientCallSites(clientDir),parseServerHandlers(serverDir)]); const {matches}=matchRoutes(clients,servers,{confidenceThreshold:threshold});
  const g=new ContractGraph();
  for(const s of servers){const id=contractId(s);g.addNode({id,type:'contract',name:`${s.method} ${s.route.raw}`,file:s.location.file,location:{line:s.location.line,column:s.location.column},shape:s.responseSchema?.fields?{kind:'object',fields:s.responseSchema.fields}:undefined,metadata:{framework:s.framework,serviceName:options.serviceName,confidence:100,evidence:[ev('ast',s.location.file,`Server handler ${s.id}`,100,s.location.line,s.location.column)],endpointUrl:s.route.raw,httpMethod:s.method}});g.addNode({id:`producer:${s.id}`,type:'producer',name:s.id,file:s.location.file,location:{line:s.location.line,column:s.location.column},metadata:{framework:s.framework,serviceName:options.serviceName,confidence:100,evidence:[ev('ast',s.location.file,'Server route handler discovered',100,s.location.line,s.location.column)]}});g.addEdge({id:`produces:${s.id}`,from:`producer:${s.id}`,to:id,relation:'produces',confidence:100,evidence:[ev('ast',s.location.file,'Handler produces contract',100)],resolutionMethod:'exact'});}
  for(const c of clients){const match=matches.find(m=>m.client.id===c.id);const server=match?.server;const id=`consumer:${c.id}`; const usage=usageEvidence(c.location.file,c.location.line,c.location.column); g.addNode({id,type:'consumer',name:c.id,file:c.location.file,location:{line:c.location.line,column:c.location.column},metadata:{framework:c.framework,confidence:match?Math.round(match.confidence*100):0,evidence:[ev('ast',c.location.file,'Client call-site discovered',100,c.location.line,c.location.column),...usage.evidence,...(match?[ev('route-match',c.location.file,`Matched ${server!.method} ${server!.route.raw} using ${match.strategy}`,Math.round(match.confidence*100),c.location.line,c.location.column)]:[])],endpointUrl:c.route.raw,httpMethod:c.method,isDynamicAccess:c.dynamic||usage.dynamic,accessedProperties:usage.properties,unguardedContinuation:usage.unguardedContinuation}});
    if(server){const cid=contractId(server);g.addEdge({id:`consumes:${c.id}`,from:cid,to:id,relation:'consumes',confidence:match!.confidence*100,evidence:[ev('route-match',c.location.file,`Resolved client route to ${server.id}`,match!.confidence*100,c.location.line,c.location.column)],resolutionMethod:match!.strategy==='exact'?'exact':'fuzzy'});}
  }
  return g;
}
export { contractId };
