import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractGraph } from '../src/graph/ContractGraph.js';
import { GraphDiffEngine } from '../src/diff/GraphDiff.js';
import { ImpactEngine } from '../src/impact/ImpactEngine.js';
import { AgentVerifier } from '../src/agent/AgentVerifier.js';
import type { ContractChange } from '../src/diff/GraphDiff.js';

const meta=(accessedProperties:string[]=[])=>({confidence:100,evidence:[],accessedProperties});
test('intelligence: provenance graph traverses consumers cycle-safely',()=>{const g=new ContractGraph();g.addNode({id:'c',type:'contract',name:'User',file:'types.ts',metadata:meta()});g.addNode({id:'a',type:'consumer',name:'A',file:'a.ts',metadata:meta(['email'])});g.addNode({id:'b',type:'consumer',name:'B',file:'b.ts',metadata:meta(['id'])});g.addEdge({id:'ca',from:'c',to:'a',relation:'consumes',confidence:100,evidence:[],resolutionMethod:'exact'});g.addEdge({id:'cb',from:'c',to:'b',relation:'consumes',confidence:100,evidence:[],resolutionMethod:'exact'});assert.deepEqual(g.getTransitiveConsumers('c').map(n=>n.id),['a','b']);});
test('intelligence: graph diff detects rename as remove+add',()=>{const b=new ContractGraph(),c=new ContractGraph();b.addNode({id:'c',type:'contract',name:'User',file:'types.ts',shape:{kind:'object',fields:{email:{type:{kind:'primitive',name:'string'},optional:false,nullable:false}}},metadata:meta()});c.addNode({id:'c',type:'contract',name:'User',file:'types.ts',shape:{kind:'object',fields:{emailAddress:{type:{kind:'primitive',name:'string'},optional:false,nullable:false}}},metadata:meta()});const d=GraphDiffEngine.compareGraphs(b,c);assert.equal(d.length,1);assert.deepEqual(d[0]?.fieldChanges.map(x=>x.kind),['removed','added']);});
test('intelligence: impact distinguishes breaking and safe',()=>{const b=new ContractGraph(),c=new ContractGraph();b.addNode({id:'c',type:'contract',name:'User',file:'types.ts',shape:{kind:'object',fields:{email:{type:{kind:'primitive',name:'string'},optional:false,nullable:false},id:{type:{kind:'primitive',name:'string'},optional:false,nullable:false}}},metadata:meta()});c.addNode({id:'c',type:'contract',name:'User',file:'types.ts',shape:{kind:'object',fields:{emailAddress:{type:{kind:'primitive',name:'string'},optional:false,nullable:false},id:{type:{kind:'primitive',name:'string'},optional:false,nullable:false}}},metadata:meta()});for(const [id,p] of [['a',['email']],['b',['id']]] as const){c.addNode({id,type:'consumer',name:id,file:`${id}.ts`,metadata:meta(p)});c.addEdge({id:`e${id}`,from:'c',to:id,relation:'consumes',confidence:100,evidence:[],resolutionMethod:'exact'});}const r=ImpactEngine.evaluateImpact('main','worktree',GraphDiffEngine.compareGraphs(b,c),c);assert.equal(r.summary.breaking,1);assert.equal(r.summary.safe,1);});
test('intelligence: intent is incomplete when breaking consumers remain',()=>{const report=ImpactEngine.evaluateImpact('main','worktree',[{contractId:'c',kind:'modified',nodeName:'User',file:'types.ts',fieldChanges:[{path:'email',kind:'removed'},{path:'emailAddress',kind:'added'}],renames:[],confidence:100,evidence:[]}],(()=>{const g=new ContractGraph();g.addNode({id:'c',type:'contract',name:'User',file:'types.ts',metadata:meta()});g.addNode({id:'a',type:'consumer',name:'A',file:'a.ts',metadata:meta(['email'])});g.addEdge({id:'e',from:'c',to:'a',relation:'consumes',confidence:100,evidence:[],resolutionMethod:'exact'});return g;})());const r=AgentVerifier.verifyIntent({kind:'rename-field',contractId:'c',fromPath:'email',toPath:'emailAddress'},report);assert.equal(r.status,'INCOMPLETE');});

// Regression: GraphDiffEngine.compareGraphs() always produces field paths prefixed with
// "root." (see diffType('root', ...)) — AgentVerifier must strip that prefix the same way
// ImpactEngine.classify() does, or every real (non-synthetic) rename intent is reported as
// not matching the diff even when it did.
test('intelligence: AgentVerifier matches a rename intent against REAL GraphDiffEngine output (which prefixes field paths with "root.")',()=>{
  const b=new ContractGraph(),c=new ContractGraph();
  b.addNode({id:'c',type:'contract',name:'User',file:'types.ts',shape:{kind:'object',fields:{email:{type:{kind:'primitive',name:'string'},optional:false,nullable:false}}},metadata:meta()});
  c.addNode({id:'c',type:'contract',name:'User',file:'types.ts',shape:{kind:'object',fields:{emailAddress:{type:{kind:'primitive',name:'string'},optional:false,nullable:false}}},metadata:meta()});
  const changes=GraphDiffEngine.compareGraphs(b,c);
  assert.equal(changes[0]!.fieldChanges[0]!.path,'root.email'); // sanity: confirms the real prefix this test guards against
  const report=ImpactEngine.evaluateImpact('main','worktree',changes,c);
  const r=AgentVerifier.verifyIntent({kind:'rename-field',contractId:'c',fromPath:'email',toPath:'emailAddress'},report);
  assert.ok(r.evidence.some(e=>e.startsWith('Observed producer rename')),'expected the rename to be recognized, not reported as a diff mismatch');
  assert.ok(!r.evidence.some(e=>e.startsWith('Intent does not match')));
});

// Regression: a consumer that accesses a field the diff newly ADDED must never be classified
// BREAKING on that basis alone — the field did not exist in the baseline.
// This is required for post-repair re-verification: a client that
// was just migrated to use the new field name legitimately accesses an "added" path, and
// must not be reported as still-broken for doing exactly the right thing.
test('intelligence: accessing a newly ADDED field is not itself breaking (only accessing a REMOVED/changed field is)',()=>{
  const b=new ContractGraph(),c=new ContractGraph();
  b.addNode({id:'c',type:'contract',name:'User',file:'types.ts',shape:{kind:'object',fields:{email:{type:{kind:'primitive',name:'string'},optional:false,nullable:false}}},metadata:meta()});
  c.addNode({id:'c',type:'contract',name:'User',file:'types.ts',shape:{kind:'object',fields:{emailAddress:{type:{kind:'primitive',name:'string'},optional:false,nullable:false}}},metadata:meta()});
  c.addNode({id:'consumer:migrated',type:'consumer',name:'migrated',file:'migrated.ts',metadata:meta(['emailAddress'])});
  c.addEdge({id:'e',from:'c',to:'consumer:migrated',relation:'consumes',confidence:100,evidence:[],resolutionMethod:'exact'});
  const report=ImpactEngine.evaluateImpact('main','worktree',GraphDiffEngine.compareGraphs(b,c),c);
  assert.equal(report.summary.breaking,0);
  assert.equal(report.impacts[0]!.severity,'SAFE');
});

test('intelligence: repair dry-run rewrites only AST property accesses and does not mutate files',async()=>{const { RepairEngine }=await import('../src/repair/RepairEngine.js');const { ContractGraph }=await import('../src/graph/ContractGraph.js');const g=new ContractGraph();g.addNode({id:'c',type:'contract',name:'User',file:'types.ts',metadata:{confidence:100,evidence:[]}});g.addNode({id:'consumer:a',type:'consumer',name:'A',file:'a.ts',metadata:{confidence:100,evidence:[]}});g.addEdge({id:'e',from:'c',to:'consumer:a',relation:'consumes',confidence:100,evidence:[],resolutionMethod:'exact'});const report={baseIdentity:'main',currentIdentity:'worktree',timestamp:new Date().toISOString(),changes:[],impacts:[{consumerNode:g.getNode('consumer:a')!,targetContractId:'c',dependencyCategory:'DIRECT' as const,severity:'BREAKING' as const,reason:'changed email',fieldLevelMatch:true,changedPaths:['email'],evidence:[],confidence:100,proofLevel:'PROVEN' as const}],risk:{score:100,factors:{confirmedBreaking:1,potentialBreaking:0,highCriticalityConsumers:0,totalConsumers:1,unresolvedUnknowns:0}},summary:{totalChanges:1,breaking:1,warning:0,safe:0,unknown:0,impactScore:100}};const files={'a.ts':'const email=user.email;'};const r=RepairEngine.executeSafeRenameRepair({kind:'rename-field',contractId:'c',fromPath:'email',toPath:'emailAddress'},report,g,p=>files[p]!,undefined,true);assert.equal(r.dryRun,true);assert.equal(r.applied,false);assert.equal(r.patches[0]?.patchedContent,'const email=user.emailAddress;');assert.equal(files['a.ts'],'const email=user.email;');});

// Regression: assignment targets must not be rewritten by field-rename repair.
// A request-body assignment such as `newOrder.server = x` must remain unchanged.
// a real response-read `orderData.server` elsewhere, purely because both
// share the property name "server" with no scoping by base object. This
// pins the fix: assignment targets (`=`, compound assignment, `++`/`--`)
// are never rewritten, since a rename-field repair only ever makes sense
// for a *read* of a server response.
test('intelligence: repair never rewrites an assignment target, only reads (real-repo false positive found via GolangFullStackApp stress test)',async()=>{
  const { RepairEngine }=await import('../src/repair/RepairEngine.js');
  const { ContractGraph }=await import('../src/graph/ContractGraph.js');
  const g=new ContractGraph();
  g.addNode({id:'c',type:'contract',name:'Order',file:'types.ts',metadata:{confidence:100,evidence:[]}});
  g.addNode({id:'consumer:a',type:'consumer',name:'A',file:'a.js',metadata:{confidence:100,evidence:[]}});
  g.addEdge({id:'e',from:'c',to:'consumer:a',relation:'consumes',confidence:100,evidence:[],resolutionMethod:'exact'});
  const report={baseIdentity:'main',currentIdentity:'worktree',timestamp:new Date().toISOString(),changes:[],impacts:[{consumerNode:g.getNode('consumer:a')!,targetContractId:'c',dependencyCategory:'DIRECT' as const,severity:'BREAKING' as const,reason:'changed server',fieldLevelMatch:true,changedPaths:['server'],evidence:[],confidence:100,proofLevel:'PROVEN' as const}],risk:{score:100,factors:{confirmedBreaking:1,potentialBreaking:0,highCriticalityConsumers:0,totalConsumers:1,unresolvedUnknowns:0}},summary:{totalChanges:1,breaking:1,warning:0,safe:0,unknown:0,impactScore:100}};
  const source=[
    'function changeWaiterForOrder(){',
    '  newOrder.server = event.target.value;', // plain assignment -- must NOT be renamed
    '  count.server += 1;',                    // compound assignment -- must NOT be renamed
    '  const shown = orderData.server;',        // genuine read -- MUST be renamed
    '}',
  ].join('\n');
  const files={'a.js':source};
  const r=RepairEngine.executeSafeRenameRepair({kind:'rename-field',contractId:'c',fromPath:'server',toPath:'waiterName'},report,g,p=>files[p]!,undefined,true);
  const patched=r.patches[0]!.patchedContent;
  assert.match(patched,/newOrder\.server = event\.target\.value;/,'plain assignment target must stay untouched');
  assert.match(patched,/count\.server \+= 1;/,'compound assignment target must stay untouched');
  assert.match(patched,/const shown = orderData\.waiterName;/,'a genuine read must still be renamed');
});




test('intelligence: removed contract uses baseline consumers and is breaking',()=>{
  const base=new ContractGraph(), current=new ContractGraph();
  base.addNode({id:'c',type:'contract',name:'User',file:'types.ts',metadata:meta()});
  base.addNode({id:'consumer',type:'consumer',name:'consumer',file:'consumer.ts',metadata:meta(['email'])});
  base.addEdge({id:'e',from:'c',to:'consumer',relation:'consumes',confidence:100,evidence:[],resolutionMethod:'exact'});
  const changes: ContractChange[]=[{contractId:'c',kind:'removed',nodeName:'User',file:'types.ts',fieldChanges:[],renames:[],confidence:100,evidence:[]}];
  const report=ImpactEngine.evaluateImpact('main','worktree',changes,current,{baselineGraph:base});
  assert.equal(report.summary.breaking,1);
  assert.equal(report.impacts[0]?.consumerNode.id,'consumer');
});
