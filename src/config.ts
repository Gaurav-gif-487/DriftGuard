import fs from 'node:fs';
import path from 'node:path';
import type { RiskConfiguration, ServiceCriticality } from './risk/riskConfig.js';
import type { CustomRiskRule } from './risk/riskConfig.js';

export interface ServiceConfig {
  criticality: ServiceCriticality;
  isPublicApi?: boolean;
  environment?: 'production' | 'staging' | 'development';
  /** Optional path prefix used to select this service in multi-service repos. */
  pathPrefix?: string;
}

export interface ContractDriftConfig {
  version?: string;
  client?: string;
  server?: string;
  serviceName?: string;
  services?: Record<string, ServiceConfig>;
  risk?: {
    baseWeightBreaking?: number;
    baseWeightUnknown?: number;
    publicApiBonus?: number;
    transitiveBlastRadiusThreshold?: number;
    transitiveBlastRadiusBonus?: number;
    criticalityMultipliers?: Record<ServiceCriticality, number>;
    thresholds?: { critical?: number; high?: number; medium?: number };
    sensitiveFields?: string[];
  };
}

export interface LoadedConfig {
  file: string | null;
  raw: ContractDriftConfig;
  riskConfig: Partial<RiskConfiguration>;
  services: Record<string, ServiceConfig>;
}

export class ConfigLoader {
  static load(targetDir: string = process.cwd()): LoadedConfig {
    const candidates = ['driftguard.config.json', '.driftguard.json'].map(name => path.join(targetDir, name));
    const file = candidates.find(fs.existsSync) ?? null;
    if (!file) return { file: null, raw: {}, riskConfig: {}, services: {} };

    let raw: ContractDriftConfig;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ContractDriftConfig; }
    catch (error) { throw new Error(`Failed to parse configuration file at ${file}: ${error instanceof Error ? error.message : String(error)}`); }

    if (raw.version && raw.version !== '2.0') throw new Error(`Unsupported driftguard config version "${raw.version}" (expected "2.0").`);
    validateServices(raw.services ?? {});
    const customRules: CustomRiskRule[] = [];
    if (raw.risk?.sensitiveFields?.length) {
      const sensitive = new Set(raw.risk.sensitiveFields);
      customRules.push({
        id: 'configured-sensitive-fields',
        name: 'Sensitive Field Mutation',
        evaluate: impacts => {
          const hits = impacts.filter(i => i.changedPaths.some(path => { const leaf = path.split('.').filter(Boolean).pop() ?? path; return [...sensitive].some(field => leaf === field || path === field); }));
          if (!hits.length) return null;
          return { name: 'Sensitive Field Mutation', points: 25, description: `+25 pts (affected configured sensitive field(s))` };
        },
      });
    }
    const riskConfig: Partial<RiskConfiguration> = { customRules };
    if (raw.risk?.baseWeightBreaking !== undefined) riskConfig.baseWeightBreaking = raw.risk.baseWeightBreaking;
    if (raw.risk?.baseWeightUnknown !== undefined) riskConfig.baseWeightUnknown = raw.risk.baseWeightUnknown;
    if (raw.risk?.publicApiBonus !== undefined) riskConfig.publicApiBonus = raw.risk.publicApiBonus;
    if (raw.risk?.transitiveBlastRadiusThreshold !== undefined) riskConfig.transitiveBlastRadiusThreshold = raw.risk.transitiveBlastRadiusThreshold;
    if (raw.risk?.transitiveBlastRadiusBonus !== undefined) riskConfig.transitiveBlastRadiusBonus = raw.risk.transitiveBlastRadiusBonus;
    if (raw.risk?.criticalityMultipliers) riskConfig.criticalityMultipliers = raw.risk.criticalityMultipliers;
    if (raw.risk?.thresholds) riskConfig.thresholds = { critical: raw.risk.thresholds.critical ?? 75, high: raw.risk.thresholds.high ?? 50, medium: raw.risk.thresholds.medium ?? 25 };
    return { file, raw, riskConfig, services: raw.services ?? {} };
  }

  static resolveService(config: LoadedConfig, serverDir: string): { name?: string; meta: ServiceConfig } {
    const explicit = config.raw.serviceName;
    if (explicit && config.services[explicit]) return { name: explicit, meta: config.services[explicit]! };
    const normalizedServer = path.resolve(serverDir).replaceAll('\\', '/').toLowerCase();
    for (const [name, meta] of Object.entries(config.services)) {
      if (meta.pathPrefix && normalizedServer.includes(meta.pathPrefix.replaceAll('\\', '/').toLowerCase())) return { name, meta };
    }
    const base = path.basename(path.resolve(serverDir)).toLowerCase();
    const found = Object.entries(config.services).find(([name]) => name.toLowerCase() === base);
    if (found) return { name: found[0], meta: found[1] };
    return { meta: { criticality: 'TIER_2_MEDIUM', isPublicApi: false } };
  }
}

function validateServices(services: Record<string, ServiceConfig>): void {
  const tiers = new Set<ServiceCriticality>(['TIER_0_CRITICAL','TIER_1_HIGH','TIER_2_MEDIUM','TIER_3_LOW']);
  for (const [name, service] of Object.entries(services)) {
    if (!name.trim()) throw new Error('Service names in driftguard config cannot be empty.');
    if (!tiers.has(service.criticality)) throw new Error(`Invalid criticality for service "${name}".`);
  }
}
