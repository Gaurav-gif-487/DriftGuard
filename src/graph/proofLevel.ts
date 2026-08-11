import type { ProofLevel, ResolutionMethod } from './types.js';

/**
 * Inputs used to derive a ProofLevel. Every field is deliberately explicit —
 * no black-box scoring. Callers must provide accurate `isDynamic` and
 * `resolutionMethod`; this function never upgrades a claim past what those
 * inputs support.
 */
export interface ProofLevelInput {
  /** Dynamic/computed access (e.g. obj[key]) can never be proven statically. */
  isDynamic?: boolean;
  /** How the underlying relationship/field was resolved, if known. */
  resolutionMethod?: ResolutionMethod;
  /** 0-100 confidence associated with the underlying evidence/edge. */
  confidence: number;
  /** True when the claim itself is inferred (e.g. a rename pairing) rather than a direct structural fact. Inferred claims are capped below PROVEN, no matter how confident. */
  isInferred?: boolean;
}

const RANK: Record<ProofLevel, number> = { UNKNOWN: 0, POTENTIAL: 1, STRONG: 2, PROVEN: 3 };

/** Strict ranking for sorting/comparison. Never sum or average these. */
export function compareProofLevel(a: ProofLevel, b: ProofLevel): number {
  return RANK[a] - RANK[b];
}

/**
 * Deterministic classification. Golden rule mirrored from the impact engine:
 * when proof fails, the result is UNKNOWN — never silently upgraded.
 */
export function deriveProofLevel(input: ProofLevelInput): ProofLevel {
  const { isDynamic, resolutionMethod, confidence, isInferred } = input;

  if (isDynamic) return 'UNKNOWN';
  if (!resolutionMethod) return confidence >= 50 ? 'POTENTIAL' : 'UNKNOWN';
  if (resolutionMethod === 'inferred') return confidence >= 80 ? 'POTENTIAL' : 'UNKNOWN';

  if (resolutionMethod === 'exact') {
    if (isInferred) return confidence >= 80 ? 'STRONG' : 'POTENTIAL';
    return confidence >= 95 ? 'PROVEN' : confidence >= 80 ? 'STRONG' : 'POTENTIAL';
  }

  if (resolutionMethod === 'symbol' || resolutionMethod === 'type') {
    // Symbol/type resolution is never treated as PROVEN on its own — it is one
    // resolution step removed from the literal AST occurrence, so the ceiling is STRONG.
    return confidence >= 80 ? 'STRONG' : confidence >= 40 ? 'POTENTIAL' : 'UNKNOWN';
  }

  if (resolutionMethod === 'fuzzy' || resolutionMethod === 'heuristic') {
    // Heuristic evidence is, by definition, never PROVEN or STRONG — golden rule:
    // never convert heuristic evidence into PROVEN.
    return confidence >= 40 ? 'POTENTIAL' : 'UNKNOWN';
  }

  return 'UNKNOWN';
}
