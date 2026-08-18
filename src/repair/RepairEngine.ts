import ts from 'typescript';
import type { ContractGraph } from '../graph/ContractGraph.js';
import type { ImpactReport } from '../impact/ImpactEngine.js';
import type { StructuredChangeIntent } from '../agent/AgentVerifier.js';
export interface FilePatch{filePath:string;originalContent:string;patchedContent:string;}
export interface RepairResult{applied:boolean;dryRun:boolean;patches:FilePatch[];validationReport?:ImpactReport;skipped:string[];}
// A rename-field repair fixes a client *reading* a response field under its
// old name -- it should never touch a write. Writing to `.oldName` (a plain
// assignment, compound assignment, or ++/--) is virtually always either
// building an outgoing request body or mutating unrelated local state that
// merely happens to share the field's name; renaming it would silently
// change behavior the tool has no evidence about. Real-repo stress test
// (akkasel/GolangFullStackApp's frontend) caught this: `newOrder.server =
// event.target.value` shares the field name "server" with a genuine
// response-read elsewhere in the same file, and a name-only match rewrote
// both. Skipping assignment targets removes that specific false-positive
// class; it does not fully solve name-vs-base-object ambiguity for
// *reads* that happen to share a field name across unrelated objects in
// the same file -- see ROADMAP.md's location-scoped repair item for the
// complete fix, which needs per-access evidence coordinates threaded
// through from the client-parser, not just this local mitigation.
function isAssignmentTarget(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
  if (ts.isPostfixUnaryExpression(p) && p.operand === node) return true;
  if (ts.isPrefixUnaryExpression(p) && p.operand === node &&
      (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  return false;
}
function renameInSource(source:string,from:string,to:string):string{const sf=ts.createSourceFile('repair.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const edits:{start:number;end:number;text:string}[]=[];function visit(n:ts.Node){if(ts.isPropertyAccessExpression(n)&&n.name.text===from&&!isAssignmentTarget(n)){edits.push({start:n.name.getStart(sf),end:n.name.getEnd(),text:to});}else if(ts.isElementAccessExpression(n)&&n.argumentExpression&&ts.isStringLiteral(n.argumentExpression)&&n.argumentExpression.text===from&&!isAssignmentTarget(n)){edits.push({start:n.argumentExpression.getStart(sf),end:n.argumentExpression.getEnd(),text:`'${to}'`});}else if(ts.isBindingElement(n)&&ts.isIdentifier(n.propertyName??n.name)&&((n.propertyName??n.name) as ts.Identifier).text===from){const x=(n.propertyName??n.name) as ts.Identifier;edits.push({start:x.getStart(sf),end:x.getEnd(),text:to});}ts.forEachChild(n,visit);}visit(sf);for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);return source;}
// Inserts `?` immediately before the `.`/`[` of a direct property/element
// access on `field`, turning `res.field` into `res.field?.` and
// `res['field']` into `res?.['field']` — the minimal mechanical edit that
// stops a crash when a field goes from required to optional, without
// guessing a fallback value. Deliberately does NOT touch destructuring
// patterns (`const { field } = res`): destructuring an absent field never
// throws by itself, and rewriting the *next* access to that local variable
// would require cross-statement data-flow analysis this tool doesn't do —
// so destructured usages are left for the skip/unrepairable path rather
// than being guessed at. Already-optional-chained access (`res.field?.x`)
// is left untouched (questionDotToken already present).
function optionalChainInSource(source:string,field:string):string{const sf=ts.createSourceFile('repair.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);const edits:{start:number;end:number;text:string}[]=[];
  function matchesField(expr:ts.Node):boolean{if(ts.isPropertyAccessExpression(expr))return expr.name.text===field;if(ts.isElementAccessExpression(expr))return !!expr.argumentExpression&&ts.isStringLiteral(expr.argumentExpression)&&expr.argumentExpression.text===field;return false;}
  function visit(n:ts.Node){
    // We insert '?' at the dot/bracket/paren of the ACCESS THAT FOLLOWS the
    // field access, not at the field access itself -- e.g. for
    // `res.field.toFixed(0)`, the crash risk is calling `.toFixed` on a
    // possibly-undefined `res.field`, so the edit belongs at the dot before
    // `toFixed` (n.expression matches field), not at the dot before `field`
    // (n itself matching field would protect entry into `field`, which
    // never throws on its own).
    if(ts.isPropertyAccessExpression(n)&&matchesField(n.expression)&&!n.questionDotToken){
      let i=n.expression.getEnd();const bound=n.name.getStart(sf);while(i<bound&&sf.text[i]!=='.')i++;if(i<bound)edits.push({start:i,end:i,text:'?'});
    }else if(ts.isElementAccessExpression(n)&&matchesField(n.expression)&&!n.questionDotToken){
      let i=n.expression.getEnd();const bound=n.getEnd();while(i<bound&&sf.text[i]!=='[')i++;if(i<bound)edits.push({start:i,end:i,text:'?.'});
    }else if(ts.isCallExpression(n)&&matchesField(n.expression)&&!n.questionDotToken){
      let i=n.expression.getEnd();const bound=n.getEnd();while(i<bound&&sf.text[i]!=='(')i++;if(i<bound)edits.push({start:i,end:i,text:'?.'});
    }
    ts.forEachChild(n,visit);
  }
  visit(sf);for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+e.text+source.slice(e.end);return source;
}

export class RepairEngine{
  static executeSafeRenameRepair(intent:StructuredChangeIntent,report:ImpactReport,_graph:ContractGraph,readFile:(p:string)=>string,writeFile:((p:string,c:string)=>void)|undefined,dryRun=true):RepairResult{
    if(intent.kind!=='rename-field'||!intent.fromPath||!intent.toPath)throw new Error('Only rename-field repair is supported safely');
    const from=intent.fromPath.split('.').pop()!,to=intent.toPath.split('.').pop()!;
    return RepairEngine.applyPerFileTransform(intent,report,readFile,writeFile,dryRun,`no proven AST property access for '${from}'`,(source)=>renameInSource(source,from,to));
  }
  static executeSafeOptionalChainingRepair(intent:StructuredChangeIntent,report:ImpactReport,_graph:ContractGraph,readFile:(p:string)=>string,writeFile:((p:string,c:string)=>void)|undefined,dryRun=true):RepairResult{
    if(intent.kind!=='widen-optionality'||!intent.fromPath)throw new Error('Only widen-optionality repair is supported safely');
    const field=intent.fromPath.split('.').pop()!;
    return RepairEngine.applyPerFileTransform(intent,report,readFile,writeFile,dryRun,`no proven AST property access for '${field}' (or already optional-chained)`,(source)=>optionalChainInSource(source,field));
  }
  // Shared per-consumer-file loop used by both repair kinds: same
  // provenance gating (fieldLevelMatch + confidence>=70), same one-patch-
  // per-file dedupe, same dry-run/apply split. Only the actual text
  // transform differs between rename and optional-chaining repair.
  private static applyPerFileTransform(intent:StructuredChangeIntent,report:ImpactReport,readFile:(p:string)=>string,writeFile:((p:string,c:string)=>void)|undefined,dryRun:boolean,noOpSkipMessage:string,transform:(source:string)=>string):RepairResult{
    const patches:FilePatch[]=[];const skipped:string[]=[];const seen=new Set<string>();
    for(const impact of report.impacts.filter(i=>i.targetContractId===intent.contractId&&i.severity==='BREAKING')){
      const file=impact.consumerNode.file;if(seen.has(file))continue;seen.add(file);
      if(!impact.fieldLevelMatch||impact.confidence<70){skipped.push(`${file}: insufficient provenance confidence`);continue;}
      let original:string;try{original=readFile(file);}catch{skipped.push(`${file}: file could not be read`);continue;}
      const patched=transform(original);
      if(patched===original){skipped.push(`${file}: ${noOpSkipMessage}`);continue;}
      patches.push({filePath:file,originalContent:original,patchedContent:patched});
    }
    if(!dryRun&&writeFile)for(const p of patches)writeFile(p.filePath,p.patchedContent);
    return{applied:!dryRun&&patches.length>0,dryRun,patches,skipped};
  }
}
