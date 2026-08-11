import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ContractGraph } from '../graph/ContractGraph.js';
import { buildContractGraph } from '../graph/GraphBuilder.js';
import { GraphDiffEngine, type ContractChange } from '../diff/GraphDiff.js';
import { ImpactEngine, type ImpactReport } from '../impact/ImpactEngine.js';
import { AgentVerifier, type StructuredChangeIntent, type IntentVerificationResult } from '../agent/AgentVerifier.js';
import { RepairEngine } from '../repair/RepairEngine.js';

export type ReceiptVerdict = 'PROVEN' | 'PASS' | 'REVIEW_REQUIRED' | 'FAIL';

export interface RepairEntry {
  filePath: string;
  status: 'PATCHED' | 'SKIPPED';
  reason: string;
}

/**
 * The result of actually applying proposed repair patches to an in-memory
 * (temp-directory) copy of the client source, rebuilding the contract graph
 * from that patched copy, and re-running diff + impact against it. This is
 * spec section 7 steps 9-14: the receipt never *claims* a repair worked —
 * it rebuilds the graph and checks.
 */
export interface RepairVerification {
  attempted: number;
  /** True only when patches were actually rebuilt into a graph and re-analyzed (not merely dry-run text patches). */
  verifiedGraph: boolean;
  /** Consumers that were BREAKING before the repair and are no longer BREAKING after it, confirmed by re-analysis. */
  fixedConsumers: string[];
  /** Consumers still BREAKING after the repair attempt. */
  stillBreakingConsumers: string[];
  /** Consumers that were NOT breaking before but ARE breaking after the repair — a regression. Golden rule: this must never be silently ignored. */
  newBreakingConsumers: string[];
}

export interface Receipt {
  schemaVersion: 3;
  /** The single explicitly-non-deterministic field, per spec section 10. */
  generatedAt: string;
  baseIdentity: string;
  currentIdentity: string;
  intent: StructuredChangeIntent | null;
  changes: ContractChange[];
  impacts: ImpactReport['impacts'];
  repairs: RepairEntry[];
  verification: IntentVerificationResult | null;
  repairVerification: RepairVerification | null;
  verdict: ReceiptVerdict;
  limitations: string[];
}

function parseSkippedEntry(raw: string): RepairEntry {
  const idx = raw.indexOf(': ');
  if (idx === -1) return { filePath: raw, status: 'SKIPPED', reason: 'unspecified' };
  return { filePath: raw.slice(0, idx), status: 'SKIPPED', reason: raw.slice(idx + 2) };
}

/** Recursively copies `srcDir` into a fresh temp directory and returns its path. Caller owns cleanup. */
function snapshotDirToTemp(srcDir: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'driftguard-receipt-'));
  const dest = path.join(tmp, 'client');
  fs.cpSync(srcDir, dest, { recursive: true });
  return dest;
}

export interface BuildReceiptOptions {
  baseIdentity: string;
  currentIdentity: string;
  clientDir: string;
  serverDir: string;
  currentGraph: ContractGraph;
  baselineGraph: ContractGraph;
  changes: ContractChange[];
  report: ImpactReport;
  intent?: StructuredChangeIntent;
  threshold: number;
  serviceName?: string;
}

export async function buildReceipt(opts: BuildReceiptOptions): Promise<Receipt> {
  const limitations: string[] = [
    'This receipt never writes to the real working tree during generation; repair verification runs against a temporary copy only. Use `driftguard fix --apply` to apply patches for real.',
  ];

  if (!opts.intent) {
    limitations.push('No structured change intent (--rename) was supplied; the verdict reflects raw impact classification only, with no producer/consumer intent verification.');
    const verdict: ReceiptVerdict = opts.report.summary.breaking > 0 ? 'FAIL' : opts.report.summary.unknown > 0 ? 'REVIEW_REQUIRED' : 'PASS';
    return {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      baseIdentity: opts.baseIdentity,
      currentIdentity: opts.currentIdentity,
      intent: null,
      changes: opts.changes,
      impacts: opts.report.impacts,
      repairs: [],
      verification: null,
      repairVerification: null,
      verdict,
      limitations,
    };
  }

  const verification = AgentVerifier.verifyIntent(opts.intent, opts.report);

  if (opts.intent.kind !== 'rename-field' && opts.intent.kind !== 'widen-optionality') {
    limitations.push(`Repair is only implemented for rename-field and widen-optionality intents; '${opts.intent.kind}' cannot be attempted or verified yet.`);
    return {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      baseIdentity: opts.baseIdentity,
      currentIdentity: opts.currentIdentity,
      intent: opts.intent,
      changes: opts.changes,
      impacts: opts.report.impacts,
      repairs: [],
      verification,
      repairVerification: null,
      verdict: verification.status === 'COMPLETE' ? 'PASS' : 'REVIEW_REQUIRED',
      limitations,
    };
  }

  const dryRun = opts.intent.kind === 'widen-optionality'
    ? RepairEngine.executeSafeOptionalChainingRepair(
        opts.intent,
        opts.report,
        opts.currentGraph,
        (p) => fs.readFileSync(p, 'utf8'),
        undefined,
        true,
      )
    : RepairEngine.executeSafeRenameRepair(
        opts.intent,
        opts.report,
        opts.currentGraph,
        (p) => fs.readFileSync(p, 'utf8'),
        undefined,
        true,
      );

  const repairs: RepairEntry[] = [
    ...dryRun.patches.map((p): RepairEntry => ({ filePath: p.filePath, status: 'PATCHED', reason: 'proven safe AST rewrite' })),
    ...dryRun.skipped.map(parseSkippedEntry),
  ];

  if (dryRun.patches.length === 0) {
    limitations.push('No repair patches could be generated with proven provenance; repair round-trip re-analysis was not performed.');
    const breakingConsumers = opts.report.impacts.filter((i) => i.targetContractId === opts.intent!.contractId && i.severity === 'BREAKING').map((i) => i.consumerNode.id);
    return {
      schemaVersion: 3,
      generatedAt: new Date().toISOString(),
      baseIdentity: opts.baseIdentity,
      currentIdentity: opts.currentIdentity,
      intent: opts.intent,
      changes: opts.changes,
      impacts: opts.report.impacts,
      repairs,
      verification,
      repairVerification: { attempted: 0, verifiedGraph: false, fixedConsumers: [], stillBreakingConsumers: breakingConsumers, newBreakingConsumers: [] },
      verdict: verification.status === 'COMPLETE' ? 'PASS' : 'FAIL',
      limitations,
    };
  }

  // Actually apply the patches to a temp copy of the client tree, rebuild the
  // graph from that copy, and re-run diff + impact — this is the part that
  // makes "PROVEN" mean something rather than trusting the dry-run text edit.
  let tempClientDir: string | undefined;
  let repairVerification: RepairVerification;
  let postReport: ImpactReport | undefined;
  try {
    tempClientDir = snapshotDirToTemp(opts.clientDir);
    let allPatchesInTree = true;
    for (const patch of dryRun.patches) {
      const rel = path.relative(opts.clientDir, patch.filePath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        allPatchesInTree = false;
        continue;
      }
      const dest = path.join(tempClientDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, patch.patchedContent, 'utf8');
    }
    if (!allPatchesInTree) limitations.push('One or more patches touched a file outside --client and could not be included in the verified re-analysis.');

    const patchedGraph = await buildContractGraph(tempClientDir, opts.serverDir, { threshold: opts.threshold, serviceName: opts.serviceName });
    const patchedChanges = GraphDiffEngine.compareGraphs(opts.baselineGraph, patchedGraph);
    postReport = ImpactEngine.evaluateImpact(opts.baseIdentity, `${opts.currentIdentity}:repaired`, patchedChanges, patchedGraph, { baselineGraph: opts.baselineGraph });

    // Consumer node IDs are assigned from module-level counters in each
    // parser and are only stable within one graph build.
    // process. Rebuilding the graph from the patched temp copy therefore
    // produces different numeric IDs for the same real call-sites, so
    // comparing `consumerNode.id` directly between the pre- and post-repair
    // reports would silently mismatch every consumer. Correlate by call-site
    // location instead (relative-to-client-root file path + line/column of
    // the client call expression), which is stable across both builds
    // because the repair only rewrites property-access identifiers, not the
    // call-site expression itself.
    const correlationKey = (root: string, file: string, line: number | undefined, column: number | undefined) =>
      `${path.relative(root, file).split(path.sep).join('/')}:${line ?? '?'}:${column ?? '?'}`;

    const preBreaking = new Map(
      opts.report.impacts
        .filter((i) => i.targetContractId === opts.intent!.contractId && i.severity === 'BREAKING')
        .map((i) => [correlationKey(opts.clientDir, i.consumerNode.file, i.consumerNode.location?.line, i.consumerNode.location?.column), i.consumerNode.id] as const),
    );
    const postBreaking = new Map(
      postReport.impacts
        .filter((i) => i.severity === 'BREAKING')
        .map((i) => [correlationKey(tempClientDir!, i.consumerNode.file, i.consumerNode.location?.line, i.consumerNode.location?.column), i.consumerNode.id] as const),
    );

    const fixedConsumers = [...preBreaking.entries()].filter(([key]) => !postBreaking.has(key)).map(([, id]) => id).sort();
    const stillBreakingConsumers = [...preBreaking.entries()].filter(([key]) => postBreaking.has(key)).map(([, id]) => id).sort();
    const newBreakingConsumers = [...postBreaking.entries()].filter(([key]) => !preBreaking.has(key)).map(([, id]) => id).sort();

    repairVerification = { attempted: dryRun.patches.length, verifiedGraph: true, fixedConsumers, stillBreakingConsumers, newBreakingConsumers };
  } finally {
    if (tempClientDir) fs.rmSync(path.dirname(tempClientDir), { recursive: true, force: true });
  }

  if (repairVerification.newBreakingConsumers.length > 0) {
    limitations.push('The repair, when actually rebuilt and re-analyzed, introduced new BREAKING impacts that did not exist before it. This is always a FAIL — a regression is never masked by an otherwise-successful rename.');
  }

  const postVerification = postReport ? AgentVerifier.verifyIntent(opts.intent, postReport) : undefined;
  let verdict: ReceiptVerdict;
  if (verification.status === 'UNVERIFIED') {
    verdict = 'FAIL';
  } else if (repairVerification.newBreakingConsumers.length > 0) {
    verdict = 'FAIL';
  } else if (repairVerification.stillBreakingConsumers.length > 0) {
    verdict = 'FAIL';
  } else if (postVerification?.status === 'COMPLETE') {
    verdict = 'PROVEN';
  } else {
    // Repair eliminated the BREAKING consumers we knew about, but the
    // post-repair re-verification still found something (e.g. UNKNOWN
    // consumers) that keeps it from being a proven-complete fix.
    limitations.push('All known BREAKING consumers were fixed and verified by re-analysis, but at least one consumer remains UNKNOWN post-repair and could not be statically proven safe.');
    verdict = 'REVIEW_REQUIRED';
  }

  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    baseIdentity: opts.baseIdentity,
    currentIdentity: opts.currentIdentity,
    intent: opts.intent,
    changes: opts.changes,
    impacts: opts.report.impacts,
    repairs,
    verification,
    repairVerification,
    verdict,
    limitations,
  };
}
