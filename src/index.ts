export * from "./types.js";
export { parseClientCallSites, parseTsClientCallSites, parseClientSource } from "./client-parser.js";
export { parseServerHandlers, parseTsServerHandlers, parseServerSource } from "./server-parser.js";
export { matchRoutes, HeuristicRouteClassifier, type RouteClassifier } from "./route-matcher.js";
export { typeMatch, validateMatch, validateAll } from "./validator.js";
export { buildSarifReport, buildImpactSarifReport, buildImpactMarkdownComment } from "./sarif.js";
export { runAnalysis, parseArgs, main } from "./cli.js";

export { ContractGraph } from "./graph/ContractGraph.js";
export type * from "./graph/types.js";
export { buildContractGraph } from "./graph/GraphBuilder.js";
export { validateGraph, type GraphValidationResult, type GraphValidationIssue, type GraphValidationCode } from "./graph/GraphValidation.js";
export { deriveProofLevel, compareProofLevel, type ProofLevelInput } from "./graph/proofLevel.js";
export { explainDependencyPath, findShortestDependencyPath, type DependencyPath, type DependencyPathHop, type DependencyPathKind } from "./graph/PathTraversal.js";
export { GraphDiffEngine } from "./diff/GraphDiff.js";
export { ImpactEngine } from "./impact/ImpactEngine.js";
export { AgentVerifier } from "./agent/AgentVerifier.js";
export { buildAgentSummary, type AgentActionSummary, type BuildAgentSummaryOptions } from "./agent/NextActions.js";
export { RepairEngine } from "./repair/RepairEngine.js";
export { buildReceipt, type Receipt, type ReceiptVerdict, type RepairEntry, type RepairVerification, type BuildReceiptOptions } from "./receipt/ReceiptEngine.js";

export * from "./graphql-parser.js";
export * from "./risk/index.js";
export * from "./config.js";
