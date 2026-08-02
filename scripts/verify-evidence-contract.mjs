import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'vendor', 'evidence-contract-artifact.json'), 'utf8'));
const artifact = readFileSync(join(root, 'vendor', manifest.artifact));
const sha512 = createHash('sha512').update(artifact).digest('hex');
const integrity = `sha512-${createHash('sha512').update(artifact).digest('base64')}`;
if (sha512 !== manifest.sha512 || integrity !== manifest.integrity) {
  throw new Error('Evidence-contract artifact integrity mismatch.');
}

const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const exactDependency = `file:vendor/${manifest.artifact}`;
if (rootPackage.dependencies?.[manifest.packageName] !== exactDependency) {
  throw new Error(`Evidence-contract dependency must be pinned to ${exactDependency}.`);
}

const installedPackage = JSON.parse(readFileSync(join(root, 'node_modules', '@builder-radar', 'evidence-contract', 'package.json'), 'utf8'));
if (installedPackage.name !== manifest.packageName || installedPackage.version !== manifest.packageVersion) {
  throw new Error('Installed evidence-contract package/version mismatch.');
}

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const lockPackage = lock.packages?.['node_modules/@builder-radar/evidence-contract'];
if (!lockPackage || lockPackage.version !== manifest.packageVersion
  || lockPackage.integrity !== manifest.integrity || lockPackage.resolved !== exactDependency) {
  throw new Error('package-lock does not pin the exact evidence-contract artifact and integrity.');
}

console.log(`${manifest.packageName}@${manifest.packageVersion} verified (${manifest.integrity}).`);
