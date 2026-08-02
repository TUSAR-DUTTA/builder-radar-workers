import {
  CONTRACT_SOURCE_COMMIT,
  ENGINE_IDS,
  EVIDENCE_CONTRACT_NAME,
  EVIDENCE_CONTRACT_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  PRIVATE_INGESTION_VERSION,
  PROJECT_IDENTITY_VERSION,
  WORKER_CONSUMER_VERSION,
  WORKER_SOURCE_COMMIT,
  EvidenceContractError,
  assertEvidenceCompatibility,
  isEngineId,
  validateIdentityForPreAcquisition,
  type CompleteProjectIdentity,
  type EngineId,
  type EvidenceFailureCode,
  type IdentityProvenance,
  type ValidationResult,
  type VerifiedCompetitorIdentity,
} from '@builder-radar/evidence-contract';

export const WORKER_EVIDENCE_COMPATIBILITY = Object.freeze({
  contractName: EVIDENCE_CONTRACT_NAME,
  contractVersion: EVIDENCE_CONTRACT_VERSION,
  schemaVersion: EVIDENCE_SCHEMA_VERSION,
  identityVersion: PROJECT_IDENTITY_VERSION,
  workerVersion: WORKER_CONSUMER_VERSION,
  ingestionVersion: PRIVATE_INGESTION_VERSION,
  contractSourceCommit: CONTRACT_SOURCE_COMMIT,
  workerSourceCommit: WORKER_SOURCE_COMMIT,
  engines: ENGINE_IDS,
});

export function assertWorkerEvidenceCompatibility() {
  return assertEvidenceCompatibility(WORKER_EVIDENCE_COMPATIBILITY);
}

export function workerSourcesToEngines(sources: readonly string[]): EngineId[] {
  const engines = sources.map((source) => source === 'chatgpt' ? 'chatgpt-consumer' : source);
  const unknown = engines.find((engine) => !isEngineId(engine));
  if (unknown) {
    throw new EvidenceContractError({
      primaryFailureCode: 'unsupported_engine',
      message: `Unknown worker engine: ${unknown}`,
      path: 'sources',
      diagnostics: { engine: unknown },
    });
  }
  return engines as EngineId[];
}

export interface WorkerIdentityRow {
  projectId: string;
  baselineId: unknown;
  canonicalName: unknown;
  canonicalDomain: unknown;
  category: unknown;
  aliases: unknown;
  domainAliases: unknown;
  ambiguousAliases: unknown;
  negativeMeanings: unknown;
  geography: unknown;
  identityVersion: unknown;
  identityVerificationStatus: unknown;
  identityProvenance: unknown;
  identityVerifiedAt: unknown;
  competitorIdentities: unknown;
  marketProfile: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function explicitLocaleAndLanguage(marketProfile: unknown): { locale: string; language: string } {
  const profile = record(marketProfile);
  const icp = record(profile?.icp);
  const measurement = record(profile?.measurement);
  const locale = stringOrEmpty(profile?.locale || icp?.locale || measurement?.locale);
  const language = stringOrEmpty(profile?.language) || strings(icp?.languages)[0] || '';
  return { locale, language };
}

function provenance(status: unknown, references: unknown, verifiedAt: unknown): IdentityProvenance {
  return {
    source: status === 'user_approved' ? 'user_approved'
      : status === 'verified_import' ? 'verified_import' : 'unknown',
    references: strings(references),
    verifiedAt: isoOrNull(verifiedAt),
  };
}

function competitorCandidate(value: unknown): VerifiedCompetitorIdentity | Record<string, unknown> {
  const competitor = record(value) ?? {};
  const status = competitor.verificationStatus;
  return {
    identityVersion: competitor.identityVersion,
    canonicalName: competitor.canonicalName,
    canonicalDomain: competitor.canonicalDomain,
    category: competitor.category,
    aliases: strings(competitor.aliases),
    domainAliases: strings(competitor.domainAliases),
    ambiguousAliases: strings(competitor.ambiguousAliases),
    negativeMeanings: strings(competitor.negativeMeanings),
    geography: strings(competitor.geography),
    relationship: competitor.relationship,
    verificationStatus: status,
    provenance: provenance(status, competitor.provenance, competitor.userApprovedAt),
  };
}

/** Build the complete candidate without filling missing fields from display names or defaults. */
export function validateWorkerIdentityBeforePaidAcquisition(
  row: WorkerIdentityRow | null | undefined,
): ValidationResult<CompleteProjectIdentity> {
  if (!row) return validateIdentityForPreAcquisition(null);
  const locale = explicitLocaleAndLanguage(row.marketProfile);
  const candidate = {
    identityVersion: row.identityVersion,
    projectId: row.projectId,
    baselineId: row.baselineId,
    canonicalProductName: row.canonicalName,
    canonicalDomain: row.canonicalDomain,
    category: row.category,
    aliases: strings(row.aliases),
    domainAliases: strings(row.domainAliases),
    ambiguousAliases: strings(row.ambiguousAliases),
    negativeMeanings: strings(row.negativeMeanings),
    geography: strings(row.geography),
    locale: locale.locale,
    language: locale.language,
    verificationStatus: row.identityVerificationStatus,
    provenance: provenance(row.identityVerificationStatus, row.identityProvenance, row.identityVerifiedAt),
    competitors: Array.isArray(row.competitorIdentities) ? row.competitorIdentities.map(competitorCandidate) : [],
  };
  return validateIdentityForPreAcquisition(candidate);
}

/** Explicit R1 adapter into the still-private v3 analysis functions; remove after R2 ingestion. */
export function completeIdentityToLegacyPrivateProfile(identity: CompleteProjectIdentity) {
  if (identity.verificationStatus !== 'user_approved' && identity.verificationStatus !== 'verified_import') {
    throw new EvidenceContractError({
      primaryFailureCode: 'identity_unverified',
      message: 'Complete identity lost verification before private ingestion adaptation.',
      path: 'verificationStatus',
      diagnostics: {},
    });
  }
  const competitors = identity.competitors.map((competitor) => {
    if (competitor.verificationStatus !== 'user_approved' && competitor.verificationStatus !== 'verified_import') {
      throw new EvidenceContractError({
        primaryFailureCode: 'competitor_unverified',
        message: 'Competitor identity lost verification before private ingestion adaptation.',
        path: 'competitors',
        diagnostics: { competitor: competitor.canonicalName },
      });
    }
    return {
      canonicalName: competitor.canonicalName,
      canonicalDomain: competitor.canonicalDomain,
      category: competitor.category,
      aliases: competitor.aliases,
      domainAliases: competitor.domainAliases,
      ambiguousAliases: competitor.ambiguousAliases,
      negativeMeanings: competitor.negativeMeanings,
      geography: competitor.geography,
      relationship: competitor.relationship,
      verificationStatus: competitor.verificationStatus,
      provenance: competitor.provenance.references,
      identityVersion: competitor.identityVersion,
    };
  });
  return {
    canonicalName: identity.canonicalProductName,
    canonicalDomain: identity.canonicalDomain,
    category: identity.category,
    aliases: identity.aliases,
    domainAliases: identity.domainAliases,
    ambiguousAliases: identity.ambiguousAliases,
    negativeMeanings: identity.negativeMeanings,
    geography: identity.geography,
    verificationStatus: identity.verificationStatus,
    provenance: identity.provenance.references,
    identityVersion: identity.identityVersion,
    contractVersion: identity.identityVersion,
    competitors,
  };
}

export function blockedIdentityCode(result: ValidationResult<CompleteProjectIdentity>): EvidenceFailureCode | null {
  return result.success ? null : result.failure.primaryFailureCode;
}

assertWorkerEvidenceCompatibility();
