import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const textExtensions = /\.(?:ya?ml|json|mjs|cjs|js|ts|tsx|md|txt|env|sh|ps1)$/i;
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
const rawTokenDetectors = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\b/,
];
const assignmentDetector = /(?:password|secret|session|cookie|authorization|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-/.+=]{20,}/i;
const findings = [];
for (const file of files) {
  if (!existsSync(file) || !textExtensions.test(file) || file.startsWith('vendor/') || file === 'scripts/scan-secrets.mjs') continue;
  const text = readFileSync(file, 'utf8');
  for (const detector of rawTokenDetectors) {
    if (detector.test(text)) findings.push(`${file}: ${detector.source.slice(0, 60)}`);
  }
  for (const line of text.split(/\r?\n/)) {
    if (/process\.env|\$\{\{\s*secrets\.|env\.[A-Z_]+/.test(line)) continue;
    if (assignmentDetector.test(line)) findings.push(`${file}: suspicious credential assignment`);
  }
}
if (findings.length) {
  console.error(`Potential secret material found in tracked files:\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan passed for ${files.length} tracked paths.`);
