import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  EVIDENCE_CONTRACT_NAME,
  EVIDENCE_CONTRACT_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  PROJECT_IDENTITY_VERSION,
  parseAdapterResult,
  validateEvidenceCompatibility,
} from '@builder-radar/evidence-contract';
import {
  WORKER_EVIDENCE_COMPATIBILITY,
  completeIdentityToLegacyPrivateProfile,
  validateWorkerIdentityBeforePaidAcquisition,
  workerSourcesToEngines,
  type WorkerIdentityRow,
} from '../src/workers/lib/evidence-contract-boundary';

const now = '2026-08-02T10:00:00.000Z';

function identityRow(): WorkerIdentityRow {
  const identityVersion = `${PROJECT_IDENTITY_VERSION}:identity-1`;
  return {
    projectId: 'project-1',
    baselineId: 'baseline-1',
    canonicalName: 'Tally',
    canonicalDomain: 'tally.so',
    category: 'online form builder',
    aliases: ['Tally Forms'],
    domainAliases: ['tally.so'],
    ambiguousAliases: ['Tally ERP'],
    negativeMeanings: ['a count'],
    geography: ['US'],
    identityVersion,
    identityVerificationStatus: 'user_approved',
    identityProvenance: ['market-setup:event-1'],
    identityVerifiedAt: now,
    marketProfile: { locale: 'en-US', icp: { languages: ['English'] } },
    competitorIdentities: [{
      identityVersion,
      canonicalName: 'Typeform',
      canonicalDomain: 'typeform.com',
      category: 'online form builder',
      aliases: [],
      domainAliases: ['typeform.com'],
      ambiguousAliases: [],
      negativeMeanings: [],
      geography: ['US'],
      relationship: 'direct',
      verificationStatus: 'user_approved',
      provenance: ['market-setup:event-1'],
      userApprovedAt: now,
    }],
  };
}

test('worker accepts only a complete verified current identity before paid acquisition', () => {
  const result = validateWorkerIdentityBeforePaidAcquisition(identityRow());
  assert.equal(result.success, true);
  if (result.success) {
    const legacy = completeIdentityToLegacyPrivateProfile(result.value);
    assert.equal(legacy.contractVersion, result.value.identityVersion);
    assert.equal(legacy.competitors?.[0]?.canonicalDomain, 'typeform.com');
  }
});

test('worker does not upgrade partial, unverified, or stale identities', () => {
  const partial = validateWorkerIdentityBeforePaidAcquisition({ ...identityRow(), canonicalDomain: null });
  assert.equal(partial.success, false);
  if (!partial.success) assert.equal(partial.failure.primaryFailureCode, 'identity_incomplete');

  const unverified = validateWorkerIdentityBeforePaidAcquisition({
    ...identityRow(), identityVerificationStatus: 'unverified', identityVerifiedAt: null,
  });
  assert.equal(unverified.success, false);
  if (!unverified.success) assert.equal(unverified.failure.primaryFailureCode, 'identity_unverified');

  const stale = validateWorkerIdentityBeforePaidAcquisition({ ...identityRow(), identityVersion: 'project_identity_v2' });
  assert.equal(stale.success, false);
  if (!stale.success) assert.equal(stale.failure.primaryFailureCode, 'identity_version_mismatch');
});

test('worker rejects unknown engine identifiers rather than treating them as generic', () => {
  assert.deepEqual(workerSourcesToEngines(['chatgpt', 'claude']), ['chatgpt-consumer', 'claude']);
  assert.throws(() => workerSourcesToEngines(['generic-engine']), { name: 'EvidenceContractError' });
});

test('worker compatibility gate fails closed on any contract tuple drift', () => {
  assert.equal(validateEvidenceCompatibility(WORKER_EVIDENCE_COMPATIBILITY).success, true);
  assert.equal(validateEvidenceCompatibility({ ...WORKER_EVIDENCE_COMPATIBILITY, schemaVersion: 'evidence_adapter_v2' }).success, false);
  assert.equal(validateEvidenceCompatibility({ ...WORKER_EVIDENCE_COMPATIBILITY, identityVersion: 'project_identity_v4' }).success, false);
});

test('worker tests execute the installed shared adapter parser', () => {
  const invalid = parseAdapterResult({
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    engine: 'unknown-engine',
  });
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.equal(invalid.failure.primaryFailureCode, 'unsupported_engine');
});

test('worker and private application pin identical artifact bytes and package versions', () => {
  const workerPackage = JSON.parse(readFileSync('package.json', 'utf8'));
  const privatePackage = existsSync('../package.json') ? JSON.parse(readFileSync('../package.json', 'utf8')) : null;
  const workerManifest = JSON.parse(readFileSync('vendor/evidence-contract-artifact.json', 'utf8'));
  const privateManifest = existsSync('../vendor/evidence-contract-artifact.json') ? JSON.parse(readFileSync('../vendor/evidence-contract-artifact.json', 'utf8')) : null;
  const dependency = `file:vendor/${workerManifest.artifact}`;
  assert.equal(workerPackage.dependencies[EVIDENCE_CONTRACT_NAME], dependency);
  if (privatePackage) {
    assert.equal(privatePackage.dependencies[EVIDENCE_CONTRACT_NAME], dependency);
  }
  assert.equal(workerManifest.packageVersion, EVIDENCE_CONTRACT_VERSION);
  if (privateManifest) {
    assert.deepEqual(workerManifest, privateManifest);
  }
  const bytes = readFileSync(`vendor/${workerManifest.artifact}`);
  assert.equal(createHash('sha512').update(bytes).digest('hex'), workerManifest.sha512);
});
