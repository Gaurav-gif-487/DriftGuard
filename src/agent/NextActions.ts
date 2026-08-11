import type { AffectedConsumerImpact, ImpactReport } from '../impact/ImpactEngine.js';
import type { IntentVerificationResult, StructuredChangeIntent } from './AgentVerifier.js';
import type { RepairResult } from '../repair/RepairEngine.js';

/**
 * The concise, agent-consumable summary from spec section 11:
 *
 *   { verdict, breaking, unknown, safe, repairAvailable, nextActions }
 *
 * This is always additive to a command's existing JSON output (merged in as
 * extra top-level fields), never a replacement — existing consumers of
 * `agent-check`/`fix`/`impact` JSON output keep working unchanged.
 */
export interface AgentActionSummary {
  verdict: string;
  breaking: number;
  warning: number;
  safe: number;
  unknown: number;
  repairAvailable: boolean;
  nextActions: string[];
}

const HINT_CAP = 5;

function fileHints(impacts: AffectedConsumerImpact[]): string {
  const hints = impacts.map((i) => `${i.consumerNode.file}:${i.consumerNode.location?.line ?? '?'}`);
  const shown = hints.slice(0, HINT_CAP);
  if (hints.length > HINT_CAP) shown.push(`+${hints.length - HINT_CAP} more`);
  return shown.join(', ');
}

function countsFor(impacts: AffectedConsumerImpact[]) {
  return {
    breaking: impacts.filter((i) => i.severity === 'BREAKING'),
    warning: impacts.filter((i) => i.severity === 'WARNING'),
    safe: impacts.filter((i) => i.severity === 'SAFE'),
    unknown: impacts.filter((i) => i.severity === 'UNKNOWN'),
  };
}

function intentFlag(intent: StructuredChangeIntent): string {
  if (intent.kind === 'rename-field') return `--rename=${intent.contractId}.${intent.fromPath}->${intent.toPath}`;
  if (intent.kind === 'widen-optionality') return `--widen-optional=${intent.contractId}.${intent.fromPath}`;
  return `--rename=${intent.contractId}.${intent.fromPath}->${intent.toPath}`;
}
const REPAIRABLE_KINDS: StructuredChangeIntent['kind'][] = ['rename-field', 'widen-optionality'];

export interface BuildAgentSummaryOptions {
  report: ImpactReport;
  intent?: StructuredChangeIntent;
  /** The exact intent flag text the user passed (e.g. `Contract.old->new` for --rename, or `Contract.field` for --widen-optional), so nextActions can suggest the literal command to re-run. */
  renameFlagText?: string;
  verification?: IntentVerificationResult;
  repair?: RepairResult;
}

/** No intent supplied at all (plain `impact` / `analyze`): verdict reflects raw impact classification only. */
function summarizeWithoutIntent(report: ImpactReport): AgentActionSummary {
  const { breaking, warning, safe, unknown } = countsFor(report.impacts);
  const nextActions: string[] = [];
  if (breaking.length > 0) {
    nextActions.push(
      `${breaking.length} breaking consumer(s) found. Supply --rename=Contract.old->new or --widen-optional=Contract.field to \`driftguard agent-check\` or \`driftguard fix\` to attempt a verified repair. Affected: ${fileHints(breaking)}`,
    );
  }
  if (unknown.length > 0) {
    nextActions.push(`${unknown.length} consumer(s) could not be statically resolved (UNKNOWN) and require manual review. Affected: ${fileHints(unknown)}`);
  }
  if (breaking.length === 0 && unknown.length === 0) {
    nextActions.push('No further action required.');
  }
  return {
    verdict: breaking.length > 0 ? 'FAIL' : unknown.length > 0 ? 'REVIEW_REQUIRED' : 'PASS',
    breaking: breaking.length,
    warning: warning.length,
    safe: safe.length,
    unknown: unknown.length,
    repairAvailable: false,
    nextActions,
  };
}

/** An intent was supplied and verified (agent-check), but no repair has been run yet in this command. */
function summarizeWithVerification(report: ImpactReport, intent: StructuredChangeIntent, verification: IntentVerificationResult, renameFlagText?: string): AgentActionSummary {
  const related = report.impacts.filter((i) => i.targetContractId === intent.contractId);
  const { breaking, warning, safe, unknown } = countsFor(related);
  const nextActions: string[] = [];
  const flagName = intent.kind === 'widen-optionality' ? '--widen-optional' : '--rename';
  const intentHint = renameFlagText ? `${flagName}=${renameFlagText}` : intentFlag(intent);
  const repairable = REPAIRABLE_KINDS.includes(intent.kind);

  if (verification.status === 'UNVERIFIED') {
    nextActions.push('The supplied intent does not match the observed contract diff — check the target contract ID and field names, then re-run.');
  } else if (verification.status === 'COMPLETE') {
    nextActions.push('No further action required — all consumers verified compatible.');
  } else {
    if (breaking.length > 0) {
      if (repairable) {
        nextActions.push(`Run \`driftguard fix ${intentHint} --apply\` to attempt an automatic repair for ${breaking.length} breaking consumer(s). Affected: ${fileHints(breaking)}`);
      } else {
        nextActions.push(`${breaking.length} breaking consumer(s) remain; automatic repair is not yet implemented for '${intent.kind}' intents — manual fix required. Affected: ${fileHints(breaking)}`);
      }
    }
    if (unknown.length > 0) {
      nextActions.push(`${unknown.length} consumer(s) could not be statically resolved (UNKNOWN) and require manual review. Affected: ${fileHints(unknown)}`);
    }
    if (warning.length > 0) {
      nextActions.push(`${warning.length} consumer(s) have an unproven (POTENTIAL) dependency on this contract; review the evidence before merging. Affected: ${fileHints(warning)}`);
    }
  }

  return {
    verdict: verification.status,
    breaking: breaking.length,
    warning: warning.length,
    safe: safe.length,
    unknown: unknown.length,
    repairAvailable: repairable && breaking.length > 0,
    nextActions,
  };
}

/** A repair was actually attempted (fix command). Counts reflect the pre-repair report — `RepairEngine` doesn't rebuild the graph itself; only `driftguard receipt` verifies the post-repair state. */
function summarizeWithRepair(report: ImpactReport, intent: StructuredChangeIntent, repair: RepairResult, renameFlagText?: string): AgentActionSummary {
  const related = report.impacts.filter((i) => i.targetContractId === intent.contractId);
  const { breaking, warning, safe, unknown } = countsFor(related);
  const nextActions: string[] = [];
  const flagName = intent.kind === 'widen-optionality' ? '--widen-optional' : '--rename';
  const intentHint = renameFlagText ? `${flagName}=${renameFlagText}` : intentFlag(intent);

  let verdict: string;
  if (repair.applied) {
    verdict = 'APPLIED';
    nextActions.push(`Applied ${repair.patches.length} patch(es) to disk. Run \`driftguard receipt ${intentHint}\` to get a verified PROVEN/FAIL verdict confirming no breaking impacts remain.`);
  } else if (repair.dryRun && repair.patches.length > 0) {
    verdict = 'DRY_RUN';
    nextActions.push(`${repair.patches.length} patch(es) ready (dry-run). Run \`driftguard receipt ${intentHint}\` first to get a verified PROVEN/FAIL verdict, then re-run \`fix ${intentHint} --apply\` if it's PROVEN.`);
  } else {
    verdict = 'NO_REPAIR_AVAILABLE';
    if (repair.skipped.length > 0) {
      nextActions.push(`No patches could be generated safely (${repair.skipped.length} item(s) skipped) — manual fix required. First reasons: ${repair.skipped.slice(0, HINT_CAP).join('; ')}`);
    } else {
      nextActions.push('Nothing to repair.');
    }
  }
  if (unknown.length > 0) {
    nextActions.push(`${unknown.length} consumer(s) could not be statically resolved (UNKNOWN) and are not addressed by this repair — review manually. Affected: ${fileHints(unknown)}`);
  }

  return {
    verdict,
    breaking: breaking.length,
    warning: warning.length,
    safe: safe.length,
    unknown: unknown.length,
    repairAvailable: repair.patches.length > 0,
    nextActions,
  };
}

export function buildAgentSummary(opts: BuildAgentSummaryOptions): AgentActionSummary {
  if (opts.intent && opts.repair) return summarizeWithRepair(opts.report, opts.intent, opts.repair, opts.renameFlagText);
  if (opts.intent && opts.verification) return summarizeWithVerification(opts.report, opts.intent, opts.verification, opts.renameFlagText);
  return summarizeWithoutIntent(opts.report);
}
