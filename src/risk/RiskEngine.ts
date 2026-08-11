import type { AffectedConsumerImpact } from '../impact/ImpactEngine.js';
import { DEFAULT_RISK_CONFIG, type RiskConfiguration, type RiskEvaluationContext } from './riskConfig.js';

export interface RiskFactor { name: string; points: number; description: string; }
export interface RiskReport {
  score: number;
  level: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  factors: RiskFactor[];
  explanation: string;
}

export class RiskEngine {
  private readonly config: RiskConfiguration;

  constructor(customConfig: Partial<RiskConfiguration> = {}) {
    this.config = {
      ...DEFAULT_RISK_CONFIG,
      ...customConfig,
      criticalityMultipliers: { ...DEFAULT_RISK_CONFIG.criticalityMultipliers, ...(customConfig.criticalityMultipliers ?? {}) },
      thresholds: { ...DEFAULT_RISK_CONFIG.thresholds, ...(customConfig.thresholds ?? {}) },
      customRules: customConfig.customRules ?? DEFAULT_RISK_CONFIG.customRules,
    };
    this.validateConfig();
  }

  calculateRisk(impacts: readonly AffectedConsumerImpact[], context: RiskEvaluationContext = {}): RiskReport {
    const factors: RiskFactor[] = [];
    const criticality = context.criticality ?? 'TIER_2_MEDIUM';
    const multiplier = this.config.criticalityMultipliers[criticality];
    let rawScore = 0;

    const breaking = impacts.filter(i => i.severity === 'BREAKING').length;
    const unknown = impacts.filter(i => i.severity === 'UNKNOWN').length;
    if (breaking) {
      const points = Math.round(breaking * this.config.baseWeightBreaking * multiplier);
      rawScore += points;
      factors.push({ name: 'Confirmed Breaking Consumers', points, description: `+${points} pts (${breaking} breaking accesses × ${multiplier}x ${criticality} multiplier)` });
    }
    if (unknown) {
      const points = Math.round(unknown * this.config.baseWeightUnknown * multiplier);
      rawScore += points;
      factors.push({ name: 'Unresolved Dynamic Access', points, description: `+${points} pts (${unknown} unresolved accesses × ${multiplier}x ${criticality} multiplier)` });
    }
    if (context.isPublicApi) {
      const points = this.config.publicApiBonus;
      rawScore += points;
      factors.push({ name: 'Public API Exposure', points, description: `+${points} pts (contract is exposed to external clients)` });
    }
    const transitive = impacts.filter(i => i.dependencyCategory === 'TRANSITIVE').length;
    if (transitive > this.config.transitiveBlastRadiusThreshold) {
      const points = this.config.transitiveBlastRadiusBonus;
      rawScore += points;
      factors.push({ name: 'High Transitive Blast Radius', points, description: `+${points} pts (${transitive} transitive downstream consumers exceed configured threshold ${this.config.transitiveBlastRadiusThreshold})` });
    }
    if (context.environment === 'production' && breaking > 0) {
      const points = Math.round(this.config.baseWeightBreaking * 0.25);
      rawScore += points;
      factors.push({ name: 'Production Environment', points, description: `+${points} pts (breaking change targets production)` });
    }
    for (const rule of this.config.customRules) {
      const factor = rule.evaluate(impacts, context);
      if (factor) { rawScore += factor.points; factors.push(factor); }
    }

    const score = Math.min(100, Math.max(0, Math.round(rawScore)));
    const level = score >= this.config.thresholds.critical ? 'CRITICAL'
      : score >= this.config.thresholds.high ? 'HIGH'
      : score >= this.config.thresholds.medium ? 'MEDIUM' : 'LOW';
    const explanation = [
      `Risk Score: ${score}/100 (${level}) [Service: ${context.serviceName ?? 'Unknown'}, Tier: ${criticality}]`,
      'Factor Breakdown:',
      ...factors.map(f => `  • ${f.name}: ${f.description}`),
    ].join('\n');
    return { score, level, factors, explanation };
  }

  private validateConfig(): void {
    const numeric = [this.config.baseWeightBreaking, this.config.baseWeightUnknown, this.config.publicApiBonus,
      this.config.transitiveBlastRadiusThreshold, this.config.transitiveBlastRadiusBonus, ...Object.values(this.config.criticalityMultipliers), ...Object.values(this.config.thresholds)];
    if (numeric.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Risk configuration contains invalid negative or non-finite values.');
    if (this.config.thresholds.critical > 100 || this.config.thresholds.high > 100 || this.config.thresholds.medium > 100) {
      throw new Error('Risk thresholds must be between 0 and 100.');
    }
    if (this.config.thresholds.medium > this.config.thresholds.high || this.config.thresholds.high > this.config.thresholds.critical) {
      throw new Error('Risk thresholds must satisfy medium <= high <= critical.');
    }
  }
}
