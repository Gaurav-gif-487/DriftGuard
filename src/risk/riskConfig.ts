export type ServiceCriticality = 'TIER_0_CRITICAL' | 'TIER_1_HIGH' | 'TIER_2_MEDIUM' | 'TIER_3_LOW';

export interface RiskEvaluationContext {
  serviceName?: string;
  criticality?: ServiceCriticality;
  isPublicApi?: boolean;
  environment?: 'production' | 'staging' | 'development';
}

export interface CustomRiskRule {
  id: string;
  name: string;
  evaluate: (impacts: readonly import('../impact/ImpactEngine.js').AffectedConsumerImpact[], context: RiskEvaluationContext) => import('./RiskEngine.js').RiskFactor | null;
}

export interface RiskConfiguration {
  baseWeightBreaking: number;
  baseWeightUnknown: number;
  publicApiBonus: number;
  transitiveBlastRadiusThreshold: number;
  transitiveBlastRadiusBonus: number;
  criticalityMultipliers: Record<ServiceCriticality, number>;
  thresholds: { critical: number; high: number; medium: number };
  customRules: CustomRiskRule[];
}

export const DEFAULT_RISK_CONFIG: RiskConfiguration = {
  baseWeightBreaking: 16,
  baseWeightUnknown: 10,
  publicApiBonus: 20,
  transitiveBlastRadiusThreshold: 3,
  transitiveBlastRadiusBonus: 25,
  criticalityMultipliers: {
    TIER_0_CRITICAL: 1.5,
    TIER_1_HIGH: 1.2,
    TIER_2_MEDIUM: 1,
    TIER_3_LOW: 0.7,
  },
  thresholds: { critical: 75, high: 50, medium: 25 },
  customRules: [],
};
