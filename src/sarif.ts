import path from "node:path";
import type { DriftReport, Severity, ViolationKind } from "./types.js";
import { buildAgentSummary } from "./agent/NextActions.js";

/**
 * Minimal, spec-accurate SARIF 2.1.0 emitter.
 *
 * Only the subset of the schema GitHub's code-scanning SARIF upload
 * actually consumes is implemented: $schema/version, one run, a
 * de-duplicated `rules` array (driven by `ViolationKind`), and one
 * `result` per violation with a physical location. This is deliberately
 * not a general-purpose SARIF library — see
 * https://docs.github.com/en/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning
 * for the fields GitHub reads.
 */

const RULE_METADATA: Record<
  ViolationKind,
  { name: string; description: string }
> = {
  "missing-field": {
    name: "Missing Required Field",
    description: "A field the client requires is no longer present in the server response.",
  },
  "type-mutation": {
    name: "Type Mutation",
    description: "A field's type changed in a way that is not backward compatible.",
  },
  "enum-variant-added": {
    name: "Enum Variant Added",
    description: "The server may produce an enum/string-literal variant the client's contract does not accept.",
  },
  "nullability-introduced": {
    name: "Nullability Introduced",
    description: "The server may now return null for a field the client does not treat as nullable.",
  },
  "optionality-introduced": {
    name: "Optionality Introduced",
    description: "The server may now omit a field the client treats as always present.",
  },
  "unresolved-route": {
    name: "Unresolved Route",
    description: "A client call-site could not be confidently matched to any server handler.",
  },
};

function sarifLevel(severity: Severity): "error" | "warning" | "note" {
  return severity;
}

export interface SarifBuildOptions {
  toolName?: string;
  toolVersion?: string;
  informationUri?: string;
  /** Directory that emitted URIs are made relative to. GitHub code scanning
   * resolves SARIF `artifactLocation.uri` values against the checked-out
   * repo root, so this must default to the invocation cwd ($GITHUB_WORKSPACE
   * in the composite action) — not just strip a leading slash from an
   * absolute path, which produced a mangled, non-existent path like
   * `home/runner/work/x/x/frontend/src/api/client.ts` instead of the
   * repo-relative `frontend/src/api/client.ts` GitHub needs to link the
   * annotation back to source. */
  baseDir?: string;
}

export function buildSarifReport(
  reports: DriftReport[],
  options: SarifBuildOptions = {},
): object {
  const toolName = options.toolName ?? "driftguard";
  const toolVersion = options.toolVersion ?? "0.1.0";
  const baseDir = options.baseDir ?? process.cwd();

  const usedRuleIds = new Set<ViolationKind>();
  const results: object[] = [];

  for (const report of reports) {
    for (const violation of report.violations) {
      usedRuleIds.add(violation.kind);
      const location = report.match
        ? report.match.client.location
        : report.unresolvedClient?.location;
      if (!location) continue;

      const routeText = report.match
        ? `${report.match.client.method} ${report.match.client.route.raw} -> ${report.match.server.method} ${report.match.server.route.raw}`
        : report.unresolvedClient
        ? `${report.unresolvedClient.method} ${report.unresolvedClient.route.raw}`
        : "";

      results.push({
        ruleId: violation.kind,
        level: sarifLevel(violation.severity),
        message: {
          text: `${violation.message}${routeText ? ` [${routeText}]` : ""}`,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: {
                uri: toRepoRelative(location.file, baseDir),
              },
              region: {
                startLine: location.line,
                startColumn: location.column,
              },
            },
          },
        ],
        properties: {
          confidence: report.match?.confidence ?? null,
          matchStrategy: report.match?.strategy ?? null,
          contractPath: violation.path || undefined,
        },
      });
    }
  }

  const rules = Array.from(usedRuleIds).map((kind) => ({
    id: kind,
    name: RULE_METADATA[kind].name,
    shortDescription: { text: RULE_METADATA[kind].name },
    fullDescription: { text: RULE_METADATA[kind].description },
    defaultConfiguration: {
      level: kind === "unresolved-route" ? "note" : "error",
    },
  }));

  return {
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: toolName,
            version: toolVersion,
            ...(options.informationUri ? { informationUri: options.informationUri } : {}),
            rules,
          },
        },
        results,
      },
    ],
  };
}

function toRepoRelative(file: string, baseDir: string): string {
  const rel = path.relative(baseDir, file);
  // Always emit forward slashes (SARIF/GitHub expect POSIX-style URIs even
  // when analysis runs on Windows), and never emit a leading "/" — a
  // rooted path would be interpreted as an absolute URI, not one relative
  // to the repo checkout.
  return rel.split(path.sep).join("/").replace(/^\/+/, "");
}

/**
 * Renders a GitHub-flavored Markdown PR comment summarizing the drift
 * report. SARIF is correct for the code-scanning tab, but almost nobody
 * checks that tab — a bot comment directly on the PR is what actually
 * gets read, so this is a first-class output alongside sarif/json/text.
 */
export function buildMarkdownComment(
  reports: DriftReport[],
  options: { durationMs?: number; toolName?: string; baseDir?: string } = {},
): string {
  const toolName = options.toolName ?? "driftguard";
  const baseDir = options.baseDir ?? process.cwd();
  const withViolations = reports.filter((r) => r.violations.length > 0);
  const errorCount = reports.flatMap((r) => r.violations).filter((v) => v.severity === "error").length;
  const warningCount = reports.flatMap((r) => r.violations).filter((v) => v.severity === "warning").length;
  const noteCount = reports.flatMap((r) => r.violations).filter((v) => v.severity === "note").length;

  const lines: string[] = [];
  const marker = `<!-- ${toolName}-report -->`;
  lines.push(marker);

  if (withViolations.length === 0) {
    lines.push(`### ${toolName}: no breaking API driftguard detected`);
    if (options.durationMs !== undefined) {
      lines.push("", `_Analyzed in ${options.durationMs.toFixed(1)}ms._`);
    }
    return lines.join("\n");
  }

  const headline = errorCount > 0 ? "ERROR" : warningCount > 0 ? "WARNING" : "NOTE";
  lines.push(
    `### ${headline}: ${toolName}: ${errorCount} breaking change(s) detected`,
    "",
    `${errorCount} error(s) · ${warningCount} warning(s) · ${noteCount} note(s)`,
    "",
  );

  for (const report of withViolations) {
    const header = report.match
      ? `\`${report.match.client.method} ${report.match.client.route.raw}\` → \`${report.match.server.method} ${report.match.server.route.raw}\``
      : `\`${report.unresolvedClient?.method} ${report.unresolvedClient?.route.raw}\``;
    const loc = report.match?.client.location ?? report.unresolvedClient?.location;
    lines.push(`<details>`, `<summary>${header}</summary>`, "");
    if (loc) lines.push(`Location: \`${toRepoRelative(loc.file, baseDir)}:${loc.line}:${loc.column}\``, "");
    for (const v of report.violations) {
      const tag = v.severity === "error" ? "ERROR" : v.severity === "warning" ? "WARNING" : "NOTE";
      lines.push(`- **${tag}** **${v.kind}** — ${v.message}`);
    }
    lines.push("", `</details>`, "");
  }

  if (options.durationMs !== undefined) {
    lines.push(`_Analyzed in ${options.durationMs.toFixed(1)}ms._`);
  }

  return lines.join("\n");
}

/** Builds SARIF directly from a baseline impact report. This is the CI/check
 * path: findings are tied to changes between the git baseline and worktree,
 * rather than merely validating the current client/server pair in isolation. */
export function buildImpactSarifReport(
  report: import('./impact/ImpactEngine.js').ImpactReport,
  options: SarifBuildOptions = {},
): object {
  const baseDir = options.baseDir ?? process.cwd();
  const results: object[] = [];
  const rules: object[] = [];
  const addRule = (id: string, name: string, description: string, level: 'error'|'warning'|'note') => {
    if ((rules as any[]).some(r => r.id === id)) return;
    rules.push({ id, name, shortDescription: { text: name }, fullDescription: { text: description }, defaultConfiguration: { level } });
  };

  for (const impact of report.impacts) {
    const level = impact.severity === 'BREAKING' ? 'error' : impact.severity === 'WARNING' ? 'warning' : 'note';
    const ruleId = `impact-${impact.severity.toLowerCase()}`;
    addRule(ruleId, `Contract impact: ${impact.severity}`, impact.reason, level);
    const rel = path.relative(baseDir, impact.consumerNode.file).split(path.sep).join('/').replace(/^\/+/, '');
    results.push({
      ruleId,
      level,
      message: { text: `${impact.reason} [${impact.dependencyCategory}, confidence ${Math.round(impact.confidence)}%]` },
      locations: [{ physicalLocation: { artifactLocation: { uri: rel }, region: { startLine: impact.consumerNode.location?.line ?? 1, startColumn: impact.consumerNode.location?.column ?? 1 } } }],
      properties: { contractId: impact.targetContractId, dependencyCategory: impact.dependencyCategory, confidence: impact.confidence, pathKind: impact.path?.kind, pathExplanation: impact.path?.explanation },
    });
  }

  const risk = report.risk.report ?? { score: report.risk.score, level: report.risk.score >= 75 ? 'CRITICAL' : report.risk.score >= 50 ? 'HIGH' : report.risk.score >= 25 ? 'MEDIUM' : 'LOW', factors: [], explanation: `Risk Score: ${report.risk.score}/100` } as const;
  if (risk.level !== 'LOW') {
    const level = risk.level === 'CRITICAL' ? 'error' : 'warning';
    const ruleId = `contract-risk-${risk.level.toLowerCase()}`;
    addRule(ruleId, `Contract risk: ${risk.level}`, risk.explanation, level);
    const rel = report.changes[0]?.file ? path.relative(baseDir, report.changes[0].file).split(path.sep).join('/').replace(/^\/+/, '') : undefined;
    results.push({
      ruleId,
      level,
      message: { text: risk.explanation },
      ...(rel ? { locations: [{ physicalLocation: { artifactLocation: { uri: rel }, region: { startLine: 1, startColumn: 1 } } }] } : {}),
      properties: { riskScore: risk.score, riskLevel: risk.level, factors: risk.factors },
    });
  }

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{ tool: { driver: { name: options.toolName ?? 'driftguard', version: options.toolVersion ?? '0.2.0', ...(options.informationUri ? { informationUri: options.informationUri } : {}), rules } }, results }],
  };
}

export function buildImpactMarkdownComment(
  report: import('./impact/ImpactEngine.js').ImpactReport,
  options: { toolName?: string; baseDir?: string } = {},
): string {
  const toolName = options.toolName ?? 'driftguard';
  const lines = [`<!-- ${toolName}-impact-report -->`];
  const risk = report.risk.report;
  lines.push(`### ${report.summary.breaking ? 'BREAKING' : report.summary.warning ? 'WARNING' : 'CLEAN'}: ${toolName} baseline impact`, '');
  lines.push(`**Risk:** ${risk?.level ?? 'LOW'} — ${risk?.score ?? report.risk.score}/100`, '');
  lines.push(`${report.summary.breaking} breaking · ${report.summary.warning} warning · ${report.summary.safe} safe · ${report.summary.unknown} unknown`, '');
  for (const impact of report.impacts) {
        const rel = path.relative(options.baseDir ?? process.cwd(), impact.consumerNode.file).split(path.sep).join('/').replace(/^\/+/, '');
    lines.push(`- **${impact.severity}** [${impact.dependencyCategory}] ${impact.reason} — \`${rel}:${impact.consumerNode.location?.line ?? 1}\` _(proof: ${impact.proofLevel})_`);
    if (impact.path) lines.push(`  - path: ${impact.path.kind} (${impact.path.explanation})`);
  }
  if (risk) lines.push('', '```text', risk.explanation, '```');

  // Include the same derived impact summary exposed by the JSON report.
  // No intent is available at this call site (the Action only ever runs a
  // plain `check`, never `agent-check`/`fix`), so this always takes the
  // no-intent path: verdict derives from raw impact classification only,
  // and repairAvailable is always false here — that field only becomes
  // meaningful once a structured intent has actually been supplied and
  // checked against RepairEngine's supported kinds (rename-field,
  // widen-optionality), which isn't something a bare `check` run can know.
  const summary = buildAgentSummary({ report });
  lines.push('', `**Verdict:** ${summary.verdict}`, '');
  if (summary.nextActions.length) {
    lines.push('<details>', '<summary>Next actions</summary>', '');
    for (const action of summary.nextActions) lines.push(`- ${action}`);
    lines.push('', '</details>');
  }

  return lines.join('\n');
}
