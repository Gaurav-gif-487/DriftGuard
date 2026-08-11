#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseClientCallSites } from "./client-parser.js";
import { parseServerHandlers } from "./server-parser.js";
import { matchRoutes } from "./route-matcher.js";
import { validateAll } from "./validator.js";
import { buildSarifReport, buildImpactSarifReport, buildImpactMarkdownComment, buildMarkdownComment } from "./sarif.js";
import type { DriftReport } from "./types.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { buildContractGraph } from "./graph/GraphBuilder.js";
import type { ContractGraph } from "./graph/ContractGraph.js";
import { GraphDiffEngine } from "./diff/GraphDiff.js";
import { ImpactEngine, type ImpactReport } from "./impact/ImpactEngine.js";
import { AgentVerifier, type StructuredChangeIntent } from "./agent/AgentVerifier.js";
import { buildAgentSummary } from "./agent/NextActions.js";
import { RepairEngine } from "./repair/RepairEngine.js";
import { buildReceipt } from "./receipt/ReceiptEngine.js";
import { ConfigLoader } from "./config.js";
import type { GraphValidationResult } from "./graph/GraphValidation.js";

interface CliArgs {
  client: string;
  server: string;
  format: "sarif" | "json" | "text" | "markdown";
  out: string | null;
  threshold: number;
  strict: boolean;
  help: boolean;
  demo: boolean;
  explain: boolean;
  /** Usage errors collected during parsing (unknown flags, bad values, stray
   *  positionals). Parsing never throws or exits; main() reports these and
   *  returns a non-zero exit code so every problem is surfaced at once. */
  errors: string[];
}

const PERFORMANCE_BUDGET_MS = 300;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    client: "",
    server: "",
    format: "text",
    out: null,
    threshold: 0.6,
    strict: false,
    help: false,
    demo: false,
    explain: false,
    errors: [],
  };

  const VALUE_FLAGS = new Set(["client", "server", "format", "out", "threshold"]);

  const assign = (key: string, value: string) => {
    switch (key) {
      case "client":
        args.client = value;
        break;
      case "server":
        args.server = value;
        break;
      case "format":
        // An unrecognized --format used to fall back to text silently, which
        // means `--format=jsonl` in CI produced a human report nobody parsed
        // and no indication anything was wrong. Fail loud instead.
        if (value === "sarif" || value === "json" || value === "text" || value === "markdown") {
          args.format = value;
        } else {
          args.errors.push(`unknown --format value "${value}" (expected: sarif, json, text, markdown)`);
        }
        break;
      case "out":
        args.out = value;
        break;
      case "threshold":
        args.threshold = Number(value);
        break;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    if (raw === "--help" || raw === "-h") {
      args.help = true;
      continue;
    }
    if (raw === "--strict") {
      args.strict = true;
      continue;
    }
    if (raw === "--demo") {
      args.demo = true;
      continue;
    }
    if (raw === "--explain") {
      args.explain = true;
      continue;
    }
    if (raw === "--") continue;
    if (!raw.startsWith("--")) {
      args.errors.push(`unexpected argument "${raw}" (all inputs are named flags, e.g. --client=./web)`);
      continue;
    }
    const eq = raw.indexOf("=");
    const key = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    if (!VALUE_FLAGS.has(key)) {
      args.errors.push(`unknown flag "--${key}"`);
      continue;
    }
    if (eq !== -1) {
      assign(key, raw.slice(eq + 1));
      continue;
    }
    // Space-separated form (`--client ./web`). Previously only `--client=./web`
    // was recognized and the space form was dropped on the floor: the CLI then
    // printed help with exit 1 and no explanation of what was wrong.
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args.errors.push(`--${key} requires a value`);
      continue;
    }
    assign(key, next);
    i++;
  }

  return args;
}

const HELP_TEXT = `driftguard — zero-execution API driftguard detector

USAGE
  driftguard --client=<dir> --server=<dir> [options]
  driftguard check --base=<git-ref> [--client=<dir> --server=<dir>] [options]
  (every flag also accepts the space-separated form: --client <dir>)

REQUIRED
  --client=<dir>       Root of the client/frontend repo (or subdirectory)
  --server=<dir>       Root of the server/backend repo (or subdirectory)

OPTIONS
  --format=<fmt>       sarif | json | text | markdown   (default: text)
  --out=<file>         Write report to file instead of stdout
  --threshold=<0..1>   Min confidence for fuzzy dynamic-route resolution (default: 0.6)
  --strict             Exit non-zero even when only unresolved routes are found
  --explain            Show segment-by-segment scoring evidence for fuzzy matches, and closest-candidate detail for unresolved routes (text format only)
  --demo               Run against the bundled fixtures/ repos, ignoring --client/--server

CHECK
  check --base=<git-ref>  Compare configured/current client+server code with a git baseline.
  check uses driftguard.config.json (or .driftguard.json) when paths are omitted.

VALIDATE
  validate [--client=<dir> --server=<dir>] [--strict]
  Builds the current contract graph and runs ContractGraph.validate() over it: orphan edge
  references, duplicate node/edge IDs, out-of-range confidence, malformed evidence, adjacency-index
  consistency, and impossible relations (e.g. a 'produces' edge not going producer -> contract).
  Paths default to driftguard.config.json like check does. Exits 1 if any error-severity issue
  is found; with --strict, warnings also fail the run. --format=json emits the raw
  GraphValidationResult ({ valid, errors, warnings }).

STRUCTURED JSON
  impact/agent-check/fix --format=json all include an additive agent summary:
  { verdict, breaking, warning, safe, unknown, repairAvailable, nextActions }
  nextActions are concrete, deterministic suggestions (e.g. the literal 'fix --rename=... --apply'
  command to run).

  Structured intents (--rename / --widen-optional) are mutually exclusive per command:
    --rename=Contract.oldField->newField        Repairable: rewrites the property access/binding.
    --widen-optional=Contract.fieldPath          Field went from required to optional. Repairable:
                                                  inserts optional chaining (?.) at the next proven
                                                  dereference (e.g. res.field.x -> res.field?.x).
  add-field/remove-field and generic change-type intents are accepted for verification only —
  repair is not implemented for them (repairAvailable: false, manual fix required).

RECEIPT
  receipt --client=<dir> --server=<dir> --base=<git-ref> [--rename=Contract.old->new | --widen-optional=Contract.field] [--apply]
  Machine-readable verification artifact combining diff + impact + (optionally) agent-intent
  verification and an actual in-memory repair round-trip re-analysis. Verdict is one of
  PROVEN | PASS | REVIEW_REQUIRED | FAIL. --apply only writes to the real working tree when
  the verdict is PROVEN.

  -h, --help           Show this help text

EXAMPLES
  npx driftguard --demo
  npx driftguard --client=./frontend --server=./backend --format=sarif --out=report.sarif
  npx driftguard --client=./apps/web --server=./services/orders-api --format=markdown
`;

/** Text locations are rendered relative to the client root (POSIX separators),
 *  matching the SARIF and Markdown outputs. Absolute machine paths are noise in
 *  CI logs and are not clickable in most terminals when the log is read from
 *  another machine. */
function displayPath(file: string, baseDir: string): string {
  const rel = path.relative(baseDir, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return file.split(path.sep).join("/");
  return rel.split(path.sep).join("/");
}

/** Aggregate diagnostic, distinct from any single per-route message: when
 *  *every* client call in the whole report fails to resolve, and all of
 *  them fail for the identical structural reason ("no-dynamic-route" — a
 *  static client path with zero exact server match, meaning the matcher
 *  never even found a *candidate* to compare against, let alone an
 *  ambiguous or below-threshold one), that pattern is a much stronger
 *  signal of a systemic --server scope problem (e.g. --server pointed at
 *  just a routes/ subdirectory, missing the file that mounts a shared
 *  '/api/v1'-style prefix elsewhere in the app) than of every endpoint
 *  independently being missing on the server. A common example is a server
 *  scan rooted below the file that mounts the shared route prefix.
 *  was scanned — not because the app actually had 23 missing endpoints.
 *  Deliberately conservative: requires total failure (not just "most"),
 *  a minimum sample size, and a uniform reason, specifically to avoid
 *  firing on a genuinely half-migrated API with a real mix of resolved
 *  and unresolved routes, where this diagnosis would be actively wrong. */
function detectServerScopeMismatch(reports: DriftReport[]): string | null {
  const matchedCount = reports.filter((r) => r.match).length;
  if (matchedCount > 0) return null;

  const unresolved = reports.filter((r) => !r.match && r.unresolvedClient);
  if (unresolved.length < 3) return null;

  const allNoDynamicRoute = unresolved.every((r) => r.unresolvedReason?.reason === "no-dynamic-route");
  if (!allNoDynamicRoute) return null;

  const firstSegments = new Set(
    unresolved
      .map((r) => r.unresolvedClient!.route.segments[0])
      .filter((s): s is Extract<typeof s, { kind: "static" }> => s?.kind === "static")
      .map((s) => s.value),
  );
  const sharedPrefix = firstSegments.size === 1 ? [...firstSegments][0] : null;
  const prefixNote = sharedPrefix
    ? ` — every one shares a leading '/${sharedPrefix}' segment that never appears on the server side scanned here`
    : "";

  return (
    `NOTE: all ${unresolved.length} client call(s) failed to resolve for the identical reason (no exact server match)${prefixNote}. ` +
    `This usually means --server doesn't cover the file(s) that mount a shared path prefix (e.g. an outer app.include_router/router.use ` +
    `applying '/api/v1' outside the directory scanned), rather than every endpoint independently being missing. Consider widening --server ` +
    `to include the app's top-level routing/mount file(s).`
  );
}

function formatText(reports: DriftReport[], durationMs: number, explain: boolean, baseDir: string): string {
  const lines: string[] = [];
  const withViolations = reports.filter((r) => r.violations.length > 0);

  if (withViolations.length === 0) {
    lines.push("No breaking API driftguard detected.");
  } else {
    for (const report of withViolations) {
      const header = report.match
        ? `${report.match.client.method} ${report.match.client.route.raw}  →  ${report.match.server.method} ${report.match.server.route.raw}  (${report.match.strategy}, confidence ${report.match.confidence})`
        : `${report.unresolvedClient?.method} ${report.unresolvedClient?.route.raw}`;
      lines.push(header);
      const loc = report.match?.client.location ?? report.unresolvedClient?.location;
      if (loc) lines.push(`  at ${displayPath(loc.file, baseDir)}:${loc.line}:${loc.column}`);
      if (explain && report.match?.explanation) {
        lines.push(`  why: ${formatExplanation(report.match.explanation)}`);
      }
      for (const v of report.violations) {
        const tag = v.severity === "error" ? "ERROR" : v.severity === "warning" ? "WARNING" : "NOTE";
        lines.push(`  ${tag} [${v.kind}] ${v.message}`);
      }
      lines.push("");
    }
  }

  const errorCount = reports.flatMap((r) => r.violations).filter((v) => v.severity === "error").length;
  const warningCount = reports.flatMap((r) => r.violations).filter((v) => v.severity === "warning").length;
  const noteCount = reports.flatMap((r) => r.violations).filter((v) => v.severity === "note").length;

  const scopeHint = detectServerScopeMismatch(reports);
  if (scopeHint) {
    lines.push(scopeHint, "");
  }

  lines.push(
    `${errorCount} error(s), ${warningCount} warning(s), ${noteCount} note(s) — analyzed in ${durationMs.toFixed(1)}ms`,
  );
  return lines.join("\n");
}

/** Renders a fuzzy match's per-segment evidence as a compact one-liner,
 *  e.g. "users(1.0) + :id≈:userId(0.85) → 0.93 (depth 2/2)". Kept dense
 *  and single-line since this sits inline in text output, not its own
 *  block — someone scanning CI output should be able to skim past it. */
function formatExplanation(explanation: NonNullable<DriftReport["match"]>["explanation"]): string {
  if (!explanation) return "";
  const segs = explanation.segments
    .map((s) => {
      const op = s.kind === "static-exact" ? "=" : s.kind === "unaligned" ? "vs" : "≈";
      return `${s.client}${op}${s.server}(${s.score})`;
    })
    .join(" + ");
  return `${segs} — alignment ${explanation.alignmentScore.toFixed(2)}, depth-agreement ${explanation.lengthAgreement.toFixed(2)}`;
}

export async function runAnalysis(clientDir: string, serverDir: string, threshold: number) {
  const start = process.hrtime.bigint();
  const [clients, servers] = await Promise.all([parseClientCallSites(clientDir), parseServerHandlers(serverDir)]);
  const { matches, unresolved, unresolvedExplanations } = matchRoutes(clients, servers, {
    confidenceThreshold: threshold,
  });
  const reports = validateAll(matches, unresolved, unresolvedExplanations);
  const end = process.hrtime.bigint();
  const durationMs = Number(end - start) / 1_000_000;
  return { clients, servers, matches, unresolved, reports, durationMs };
}

/** Package root (one level up from dist/ or src/), used to locate bundled demo fixtures. */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === "check") return runCheckCommand(argv.slice(1));
  if (command === "validate") return runValidateCommand(argv.slice(1));
  if (command === "receipt") return runReceiptCommand(argv.slice(1));
  if (command === "impact" || command === "agent-check" || command === "fix") {
    return runIntelligenceCommand(command, argv.slice(1));
  }
  const args = parseArgs(argv);

  if (args.demo) {
    args.client = path.join(packageRoot(), "fixtures", "frontend");
    args.server = path.join(packageRoot(), "fixtures", "backend");
    if (args.format === "text") args.format = "text";
    process.stderr.write(
      "driftguard: --demo mode — running against the bundled fixtures/ repos (seeded, intentional drift)\n\n",
    );
  }

  if (args.errors.length > 0 && !args.help) {
    for (const message of args.errors) process.stderr.write(`driftguard: ${message}\n`);
    process.stderr.write("driftguard: run with --help for usage.\n");
    return 1;
  }

  if (!args.help && !args.demo && (!args.client || !args.server)) {
    process.stderr.write("driftguard: --client and --server are both required (or use --demo).\n\n");
    process.stdout.write(HELP_TEXT);
    return 1;
  }

  if (args.help || !args.client || !args.server) {
    process.stdout.write(HELP_TEXT);
    return args.help ? 0 : 1;
  }

  const clientDir = path.resolve(args.client);
  const serverDir = path.resolve(args.server);

  if (!fs.existsSync(clientDir)) {
    process.stderr.write(`driftguard: client directory not found: ${clientDir}\n`);
    return 1;
  }
  if (!fs.existsSync(serverDir)) {
    process.stderr.write(`driftguard: server directory not found: ${serverDir}\n`);
    return 1;
  }

  // `Number("abc")` is NaN and `Number("")` is 0 — the naive `Number(value)`
  // parse in parseArgs() doesn't distinguish "user typo'd the threshold"
  // from "user gave a real number". Left unchecked this is a genuinely
  // silent failure mode: every threshold comparison in route-matcher.ts is
  // `score >= threshold`, which is false for *any* score when threshold is
  // NaN — so a mistyped --threshold quietly turns off all fuzzy dynamic-route
  // resolution and reports extra routes as unresolved, with no message
  // explaining why. Out-of-[0,1] values are equally silent: 1.5 has the same
  // always-false effect (scores never exceed 1.0), and a negative threshold
  // makes every fuzzy candidate pass regardless of how bad the match is.
  if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 1) {
    process.stderr.write(
      `driftguard: --threshold must be a number between 0 and 1 (got "${args.threshold}")\n`,
    );
    return 1;
  }

  const { reports, durationMs } = await runAnalysis(clientDir, serverDir, args.threshold);

  let output: string;
  if (args.format === "sarif") {
    // location.file (client-parser.ts / walkFiles) is always an absolute
    // path rooted under `clientDir` — every SARIF/markdown location in this
    // tool comes from a client call-site, never a server one (see
    // sarif.ts). Defaulting baseDir to process.cwd() only produces a clean
    // repo-relative URI when the CLI happens to be invoked from exactly
    // that root; run it from anywhere else (a subdirectory, a CI
    // working-directory that isn't the checkout root, a globally-installed
    // CLI invoked with an absolute --client) and toRepoRelative() silently
    // emits a "../"-prefixed or fully-absolute-looking URI that GitHub's
    // code-scanning UI won't resolve to a source line. Passing the already-
    // resolved clientDir makes this correct regardless of invocation cwd.
    output = JSON.stringify(buildSarifReport(reports, { baseDir: clientDir }), null, 2);
  } else if (args.format === "json") {
    output = JSON.stringify(reports, null, 2);
  } else if (args.format === "markdown") {
    output = buildMarkdownComment(reports, { durationMs, baseDir: clientDir });
  } else {
    output = formatText(reports, durationMs, args.explain, clientDir);
  }

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, output, "utf8");
    process.stderr.write(`driftguard: wrote ${args.format} report to ${args.out}\n`);
  } else {
    process.stdout.write(output + "\n");
  }

  process.stderr.write(
    `driftguard: analyzed in ${durationMs.toFixed(1)}ms` +
      (durationMs > PERFORMANCE_BUDGET_MS
        ? ` (exceeded ${PERFORMANCE_BUDGET_MS}ms budget — see README "Performance" for scaling notes)\n`
        : ` (within ${PERFORMANCE_BUDGET_MS}ms budget)\n`),
  );

  const hasErrors = reports.some((r) => r.violations.some((v) => v.severity === "error"));
  const hasUnresolved = reports.some((r) => r.violations.some((v) => v.kind === "unresolved-route"));
  if (hasErrors) return 1;
  if (args.strict && hasUnresolved) return 1;
  return 0;
}


interface IntelligenceArgs { client:string; server:string; base:string; threshold:number; format:'text'|'json'; rename?:string; widenOptional?:string; apply:boolean; explain:boolean; }
function parseIntelligenceArgs(argv:string[]): IntelligenceArgs {
  const a:IntelligenceArgs={client:'',server:'',base:'main',threshold:0.6,format:'text',apply:false,explain:false};
  const values=new Set(['client','server','base','threshold','format','rename','widen-optional']);
  for(let i=0;i<argv.length;i++){const raw=argv[i]!;if(raw==='--apply'){a.apply=true;continue;}if(raw==='--explain'){a.explain=true;continue;}if(!raw.startsWith('--'))throw new Error(`unexpected argument "${raw}"`);const eq=raw.indexOf('=');const key=eq<0?raw.slice(2):raw.slice(2,eq);if(!values.has(key))throw new Error(`unknown flag "--${key}"`);let value=eq<0?argv[++i]:raw.slice(eq+1);if(value===undefined||value.startsWith('--'))throw new Error(`--${key} requires a value`);if(key==='client')a.client=value;else if(key==='server')a.server=value;else if(key==='base')a.base=value;else if(key==='rename')a.rename=value;else if(key==='widen-optional')a.widenOptional=value;else if(key==='threshold')a.threshold=Number(value);else if(key==='format'){if(value!=='text'&&value!=='json')throw new Error('--format must be text or json');a.format=value;} }
  // client/server may be omitted here — resolved the same way `check` does,
  // via config.raw or discoverProjectRoots, in runIntelligenceCommand. This
  // closes a real zero-config gap: `check` could already run against a
  // bare `driftguard check` with no flags on a conventionally-laid-out
  // repo, but `impact`/`agent-check`/`fix` demanded explicit --client/
  // --server even on the exact same repo, for no functional reason.
  if(!Number.isFinite(a.threshold)||a.threshold<0||a.threshold>1)throw new Error('--threshold must be a number between 0 and 1');if(a.rename&&a.widenOptional)throw new Error('--rename and --widen-optional are mutually exclusive; pass one intent at a time');return a;
}
function gitRoot():string{ return execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim(); }
function baselinePath(ref:string, target:string, root:string, tmp:string):string{
  // `EMPTY` is used for an initial push where GitHub's before SHA is all zeros.
  // Treating it as an empty repository gives a deterministic first-run analysis
  // instead of asking git to resolve an impossible object name.
  if(ref === 'EMPTY' || /^0+$/.test(ref)){
    const rel=path.relative(root,path.resolve(target));
    if(rel.startsWith('..')||path.isAbsolute(rel)) throw new Error(`baseline analysis requires --client/--server paths inside the git repository: ${target}`);
    const empty=path.join(tmp,rel);
    fs.mkdirSync(empty,{recursive:true});
    return empty;
  }
  const rel=path.relative(root,path.resolve(target));
  if(rel.startsWith('..')||path.isAbsolute(rel)) throw new Error(`baseline analysis requires --client/--server paths inside the git repository: ${target}`);
  if(!rel){
    const archive=execFileSync('git',['archive',ref],{maxBuffer:128*1024*1024});
    execFileSync('tar',['-x','-C',tmp],{input:archive});
    return tmp;
  }
  const archive=execFileSync('git',['archive',ref,'--',rel],{maxBuffer:128*1024*1024});
  execFileSync('tar',['-x','-C',tmp],{input:archive});
  return path.join(tmp,rel);
}
async function baselineGraphs(opts:IntelligenceArgs){const root=gitRoot();const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'driftguard-base-'));try{const client=baselinePath(opts.base,path.resolve(opts.client),root,tmp);const server=baselinePath(opts.base,path.resolve(opts.server),root,tmp);const base=await buildContractGraph(client,server,{threshold:opts.threshold});return{root,tmp,base};}catch(e){fs.rmSync(tmp,{recursive:true,force:true});throw e;}}
function parseRename(raw:string):StructuredChangeIntent{const parts=raw.split('->');if(parts.length!==2)throw new Error('--rename must use Contract.oldField->Contract.newField');const [left,right]=parts;const [contractId,...fromParts]=left!.split('.');const toParts=right!.split('.');const to=toParts.slice(1).join('.');const from=fromParts.join('.');if(!contractId||!from||!to)throw new Error('--rename must use Contract.oldField->Contract.newField');return{kind:'rename-field',contractId,fromPath:from,toPath:to};}
function parseWidenOptional(raw:string):StructuredChangeIntent{const [contractId,...fieldParts]=raw.split('.');const field=fieldParts.join('.');if(!contractId||!field)throw new Error('--widen-optional must use Contract.field');return{kind:'widen-optionality',contractId,fromPath:field,toPath:field};}
/** Builds the structured intent from whichever mutually-exclusive intent flag was passed (parseIntelligenceArgs already rejects both being set together), or undefined if neither was passed. */
function parseIntentFromOpts(opts:{rename?:string;widenOptional?:string}):StructuredChangeIntent|undefined{
  if(opts.rename)return parseRename(opts.rename);
  if(opts.widenOptional)return parseWidenOptional(opts.widenOptional);
  return undefined;
}
/** Dispatches to the correct RepairEngine method for the intent's kind. Throws for kinds with no implemented repair (executeSafeRenameRepair/executeSafeOptionalChainingRepair already throw with a clear message if called with the wrong kind, so an unsupported kind reaching here is itself a bug, not a silent no-op). */
function executeRepair(intent:StructuredChangeIntent,report:ImpactReport,graph:ContractGraph,readFile:(p:string)=>string,writeFile:((p:string,c:string)=>void)|undefined,dryRun:boolean){
  if(intent.kind==='rename-field')return RepairEngine.executeSafeRenameRepair(intent,report,graph,readFile,writeFile,dryRun);
  if(intent.kind==='widen-optionality')return RepairEngine.executeSafeOptionalChainingRepair(intent,report,graph,readFile,writeFile,dryRun);
  throw new Error(`No repair is implemented for intent kind '${intent.kind}' yet — only rename-field and widen-optionality are supported.`);
}

interface CheckArgs { client?: string; server?: string; base:string; threshold:number; format:'text'|'json'|'sarif'|'markdown'; out?:string; strict:boolean; }
function parseCheckArgs(argv:string[]):CheckArgs {
  const a:CheckArgs={base:'origin/main',threshold:0.6,format:'text',strict:false};
  const values=new Set(['client','server','base','threshold','format','out']);
  for(let i=0;i<argv.length;i++){
    const raw=argv[i]!;
    if(raw==='--strict'){a.strict=true;continue;}
    if(raw==='--help'||raw==='-h'){throw new Error('check requires a baseline; see `driftguard --help`');}
    if(!raw.startsWith('--'))throw new Error(`unexpected argument "${raw}"`);
    const eq=raw.indexOf('='); const key=eq<0?raw.slice(2):raw.slice(2,eq);
    if(!values.has(key))throw new Error(`unknown flag "--${key}"`);
    const value=eq<0?argv[++i]:raw.slice(eq+1);
    if(value===undefined||value.startsWith('--'))throw new Error(`--${key} requires a value`);
    if(key==='client')a.client=value; else if(key==='server')a.server=value; else if(key==='base')a.base=value;
    else if(key==='threshold')a.threshold=Number(value);
    else if(key==='format'){if(!['text','json','sarif','markdown'].includes(value))throw new Error('--format must be sarif, json, text, or markdown');a.format=value as CheckArgs['format'];}
    else if(key==='out')a.out=value;
  }
  if(!Number.isFinite(a.threshold)||a.threshold<0||a.threshold>1)throw new Error('--threshold must be a number between 0 and 1');
  return a;
}

interface ValidateArgs { client?: string; server?: string; threshold:number; format:'text'|'json'; out?:string; strict:boolean; }
function parseValidateArgs(argv:string[]):ValidateArgs {
  const a:ValidateArgs={threshold:0.6,format:'text',strict:false};
  const values=new Set(['client','server','threshold','format','out']);
  for(let i=0;i<argv.length;i++){
    const raw=argv[i]!;
    if(raw==='--strict'){a.strict=true;continue;}
    if(raw==='--help'||raw==='-h'){throw new Error('validate builds the current contract graph and checks it for structural issues; see `driftguard --help`');}
    if(!raw.startsWith('--'))throw new Error(`unexpected argument "${raw}"`);
    const eq=raw.indexOf('='); const key=eq<0?raw.slice(2):raw.slice(2,eq);
    if(!values.has(key))throw new Error(`unknown flag "--${key}"`);
    const value=eq<0?argv[++i]:raw.slice(eq+1);
    if(value===undefined||value.startsWith('--'))throw new Error(`--${key} requires a value`);
    if(key==='client')a.client=value; else if(key==='server')a.server=value;
    else if(key==='threshold')a.threshold=Number(value);
    else if(key==='format'){if(value!=='text'&&value!=='json')throw new Error('--format must be text or json');a.format=value as ValidateArgs['format'];}
    else if(key==='out')a.out=value;
  }
  if(!Number.isFinite(a.threshold)||a.threshold<0||a.threshold>1)throw new Error('--threshold must be a number between 0 and 1');
  return a;
}

function formatValidateText(result: GraphValidationResult): string {
  const lines: string[] = [];
  if (result.errors.length === 0 && result.warnings.length === 0) {
    lines.push('Contract graph is structurally valid - no issues found.');
    return lines.join('\n');
  }
  lines.push(`CONTRACT GRAPH VALIDATION: ${result.valid ? 'VALID (with warnings)' : 'INVALID'}`, `${result.errors.length} error(s) · ${result.warnings.length} warning(s)`, '');
  for (const issue of result.errors) lines.push(`  ERROR [${issue.code}] ${issue.message}`);
  for (const issue of result.warnings) lines.push(`  WARNING [${issue.code}] ${issue.message}`);
  return lines.join('\n');
}

async function runValidateCommand(argv:string[]):Promise<number>{
  try{
    const opts=parseValidateArgs(argv);
    const root=gitRoot();
    const config=ConfigLoader.load(root);
    const discovered=discoverProjectRoots(root);
    const client=path.resolve(root,opts.client ?? config.raw.client ?? discovered.client ?? '');
    const server=path.resolve(root,opts.server ?? config.raw.server ?? discovered.server ?? '');
    if(!opts.client && !config.raw.client && !discovered.client || !opts.server && !config.raw.server && !discovered.server) throw new Error('validate requires --client/--server or client/server paths in driftguard.config.json');
    if(!fs.existsSync(client)||!fs.existsSync(server)) throw new Error(`Configured analysis path does not exist: ${!fs.existsSync(client)?client:server}`);
    const service=ConfigLoader.resolveService(config,server);
    const graph=await buildContractGraph(client,server,{threshold:opts.threshold,serviceName:service.name});
    const result=graph.validate();
    const output=opts.format==='json'?JSON.stringify(result,null,2):formatValidateText(result);
    if(opts.out){fs.mkdirSync(path.dirname(path.resolve(opts.out)),{recursive:true});fs.writeFileSync(opts.out,output,'utf8');}else process.stdout.write(output+'\n');
    if(!result.valid) return 1;
    if(opts.strict && result.warnings.length>0) return 1;
    return 0;
  }catch(e){process.stderr.write(`driftguard: ${e instanceof Error?e.message:String(e)}\n`);return 2;}
}

function discoverProjectRoots(root:string):{client?:string;server?:string}{
  const pairs:[string,string][]=[['frontend','backend'],['client','server'],['web','api'],['apps/web','apps/api']];
  for(const [client,server] of pairs){if(fs.existsSync(path.join(root,client))&&fs.existsSync(path.join(root,server)))return{client,server};}
  return{};
}

async function runCheckCommand(argv:string[]):Promise<number>{
  try{
    const opts=parseCheckArgs(argv);
    const root=gitRoot();
    const config=ConfigLoader.load(root);
    const discovered=discoverProjectRoots(root);
    const client=path.resolve(root,opts.client ?? config.raw.client ?? discovered.client ?? '');
    const server=path.resolve(root,opts.server ?? config.raw.server ?? discovered.server ?? '');
    if(!opts.client && !config.raw.client && !discovered.client || !opts.server && !config.raw.server && !discovered.server) throw new Error('check requires --client/--server or client/server paths in driftguard.config.json');
    if(!fs.existsSync(client)||!fs.existsSync(server)) throw new Error(`Configured analysis path does not exist: ${!fs.existsSync(client)?client:server}`);
    const service=ConfigLoader.resolveService(config,server);
    const current=await buildContractGraph(client,server,{threshold:opts.threshold,serviceName:service.name});
    const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'driftguard-check-'));
    try{
      const baseClient=baselinePath(opts.base,client,root,tmp);
      const baseServer=baselinePath(opts.base,server,root,tmp);
      const baseline=await buildContractGraph(baseClient,baseServer,{threshold:opts.threshold,serviceName:service.name});
      const changes=GraphDiffEngine.compareGraphs(baseline,current);
      const report=ImpactEngine.evaluateImpact(opts.base,'WORKTREE',changes,current,{baselineGraph:baseline,riskConfig:config.riskConfig,riskContext:{serviceName:service.name,...service.meta}});
      let output:string;
      if(opts.format==='sarif'){
        output=JSON.stringify(buildImpactSarifReport(report,{baseDir:root}),null,2);
      } else if(opts.format==='markdown'){
        output=buildImpactMarkdownComment(report,{baseDir:root});
      } else if(opts.format==='json') output=JSON.stringify(report,null,2);
      else output=[`CONTRACT DRIFT CHECK`, `Base: ${opts.base}`, `Changes: ${report.summary.totalChanges}`, `Breaking: ${report.summary.breaking}`, `Warning: ${report.summary.warning}`, `Unknown: ${report.summary.unknown}`, '', (report.risk.report?.explanation ?? `Risk Score: ${report.risk.score}/100`)].join('\n');
      if(opts.out){fs.mkdirSync(path.dirname(path.resolve(opts.out)),{recursive:true});fs.writeFileSync(opts.out,output,'utf8');}else process.stdout.write(output+'\n');
      if(report.summary.breaking>0) return 1;
      if(opts.strict && report.summary.unknown>0) return 1;
      return 0;
    } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
  }catch(e){process.stderr.write(`driftguard: ${e instanceof Error?e.message:String(e)}\n`);return 2;}
}

async function runIntelligenceCommand(command:'impact'|'agent-check'|'fix',argv:string[]):Promise<number>{try{const opts=parseIntelligenceArgs(argv);const root=gitRoot();const config=ConfigLoader.load(root);const discovered=discoverProjectRoots(root);const clientOpt=opts.client||config.raw.client||discovered.client;const serverOpt=opts.server||config.raw.server||discovered.server;if(!clientOpt||!serverOpt)throw new Error(`${command} requires --client/--server, client/server paths in driftguard.config.json, or a conventionally-named client+server directory pair (e.g. frontend/backend)`);const serverDir=path.resolve(root,serverOpt);const clientDir=path.resolve(root,clientOpt);if(!fs.existsSync(clientDir)||!fs.existsSync(serverDir))throw new Error(`Configured analysis path does not exist: ${!fs.existsSync(clientDir)?clientDir:serverDir}`);const service=ConfigLoader.resolveService(config,serverDir);const current=await buildContractGraph(clientDir,serverDir,{threshold:opts.threshold,serviceName:service.name});const b=await baselineGraphs({...opts,client:clientDir,server:serverDir});const changes=GraphDiffEngine.compareGraphs(b.base,current);const report=ImpactEngine.evaluateImpact(opts.base,'WORKTREE',changes,current,{baselineGraph:b.base,riskConfig:config.riskConfig,riskContext:{serviceName:service.name,...service.meta}});
  if(command==='agent-check'){
    if(!opts.rename&&!opts.widenOptional)throw new Error('--rename or --widen-optional is required for agent-check');
    const intent=parseIntentFromOpts(opts)!;
    const result=AgentVerifier.verifyIntent(intent,report);
    const summary=buildAgentSummary({report,intent,verification:result,renameFlagText:opts.rename??opts.widenOptional});
    if(opts.format==='json')console.log(JSON.stringify({...result,...summary},null,2));
    else{
      console.log(`AGENT CHECK: ${result.status}`);
      console.log(result.evidence.map(x=>`  ${x}`).join('\n'));
      console.log(`Consumers: ${result.details.updatedConsumers} safe, ${result.details.remainingConsumers} breaking, ${result.details.unknownConsumers} unknown`);
      console.log(`repairAvailable: ${summary.repairAvailable}`);
      for(const a of summary.nextActions)console.log(`NEXT: ${a}`);
    }
    return result.status==='COMPLETE'?0:1;
  }
  if(command==='fix'){
    if(!opts.rename&&!opts.widenOptional)throw new Error('--rename or --widen-optional is required for fix');
    const intent=parseIntentFromOpts(opts)!;
    const result=executeRepair(intent,report,current,p=>fs.readFileSync(p,'utf8'),(p,c)=>fs.writeFileSync(p,c,'utf8'),!opts.apply);
    const summary=buildAgentSummary({report,intent,repair:result,renameFlagText:opts.rename??opts.widenOptional});
    if(opts.format==='json')console.log(JSON.stringify({...result,...summary},null,2));
    else{
      console.log(`REPAIR ${result.dryRun?'DRY-RUN':'APPLIED'}: ${result.patches.length} patch(es)`);
      for(const p of result.patches)console.log(`  ${p.filePath}`);
      for(const x of result.skipped)console.log(`  SKIP ${x}`);
      for(const a of summary.nextActions)console.log(`NEXT: ${a}`);
    }
    return result.skipped.length&&result.patches.length===0?1:0;
  }
  const summary=buildAgentSummary({report});
  if(opts.format==='json')console.log(JSON.stringify({...report,...summary},null,2));
  else{
    console.log(`CONTRACT IMPACT: ${report.summary.impactScore}/100`);
    console.log(`Changes ${report.summary.totalChanges} | BREAKING ${report.summary.breaking} | WARNING ${report.summary.warning} | SAFE ${report.summary.safe} | UNKNOWN ${report.summary.unknown}`);
    for(const c of report.changes)for(const r of c.renames)console.log(`[RENAME] ${c.nodeName}.${r.oldPath} -> ${r.newPath} (confidence ${r.confidence})`);
    for(const i of report.impacts){console.log(`[${i.severity}] ${i.consumerNode.file}: ${i.reason} (${i.dependencyCategory}, proof=${i.proofLevel})`);if(opts.explain&&i.path)console.log(`    path: ${i.path.kind} — ${i.path.explanation}`);}
    if(opts.explain)console.log(`Risk factors: ${JSON.stringify(report.risk.factors)}`);
    for(const a of summary.nextActions)console.log(`NEXT: ${a}`);
  }
  return report.summary.breaking>0?1:0;
}catch(e){console.error(`driftguard: ${e instanceof Error?e.message:String(e)}`);return 2;}}

async function runReceiptCommand(argv:string[]):Promise<number>{
  try{
    const opts=parseIntelligenceArgs(argv);
    const root=gitRoot();
    const config=ConfigLoader.load(root);
    const serverDir=path.resolve(opts.server);
    const clientDir=path.resolve(opts.client);
    const service=ConfigLoader.resolveService(config,serverDir);
    const current=await buildContractGraph(clientDir,serverDir,{threshold:opts.threshold,serviceName:service.name});
    const b=await baselineGraphs(opts);
    const changes=GraphDiffEngine.compareGraphs(b.base,current);
    const report=ImpactEngine.evaluateImpact(opts.base,'WORKTREE',changes,current,{baselineGraph:b.base,riskConfig:config.riskConfig,riskContext:{serviceName:service.name,...service.meta}});
    const intent=parseIntentFromOpts(opts);
    const receipt=await buildReceipt({baseIdentity:opts.base,currentIdentity:'WORKTREE',clientDir,serverDir,currentGraph:current,baselineGraph:b.base,changes,report,intent,threshold:opts.threshold,serviceName:service.name});

    // A receipt only ever *verifies* a repair in a temp copy. Real writes to
    // the working tree require both --apply and a PROVEN verdict, mirroring
    // spec section 7 step 15 ("only then allow --apply").
    if(opts.apply && intent){
      if(receipt.verdict!=='PROVEN'){
        process.stderr.write(`driftguard: refusing --apply — receipt verdict is ${receipt.verdict}, not PROVEN.\n`);
      } else {
        const applied=executeRepair(intent,report,current,p=>fs.readFileSync(p,'utf8'),(p,c)=>fs.writeFileSync(p,c,'utf8'),false);
        process.stderr.write(`driftguard: applied ${applied.patches.length} verified patch(es) to the working tree.\n`);
      }
    } else if(opts.apply && !intent){
      process.stderr.write('driftguard: --apply requires --rename or --widen-optional (nothing to apply without an intent).\n');
    }

    if(opts.format==='json'){
      console.log(JSON.stringify(receipt,null,2));
    } else {
      console.log(`RECEIPT: ${receipt.verdict}`);
      console.log(`Base: ${receipt.baseIdentity}  Current: ${receipt.currentIdentity}`);
      if(receipt.intent)console.log(`Intent: ${receipt.intent.kind} ${receipt.intent.contractId}.${receipt.intent.fromPath} -> ${receipt.intent.toPath}`);
      console.log(`Changes: ${receipt.changes.length}  Impacts: ${receipt.impacts.length}`);
      if(receipt.verification)console.log(`Verification: ${receipt.verification.status} (${receipt.verification.details.updatedConsumers} safe, ${receipt.verification.details.remainingConsumers} breaking, ${receipt.verification.details.unknownConsumers} unknown)`);
      if(receipt.repairVerification){
        const rv=receipt.repairVerification;
        console.log(`Repair: ${rv.attempted} attempted, verified-by-reanalysis=${rv.verifiedGraph}`);
        console.log(`  fixed: ${rv.fixedConsumers.join(', ')||'(none)'}`);
        console.log(`  still breaking: ${rv.stillBreakingConsumers.join(', ')||'(none)'}`);
        console.log(`  new breaking (regression): ${rv.newBreakingConsumers.join(', ')||'(none)'}`);
      }
      for(const r of receipt.repairs)console.log(`  [${r.status}] ${r.filePath}: ${r.reason}`);
      for(const l of receipt.limitations)console.log(`LIMITATION: ${l}`);
    }
    return receipt.verdict==='PROVEN'||receipt.verdict==='PASS'?0:1;
  }catch(e){process.stderr.write(`driftguard: ${e instanceof Error?e.message:String(e)}\n`);return 2;}
}

// pathToFileURL handles Windows drive letters and paths containing spaces,
// which naive `file://${argv[1]}` string concatenation gets wrong.
const isDirectRun = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
