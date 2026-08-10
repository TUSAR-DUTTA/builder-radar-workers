export function assertExactCommitSha(value, label = 'runtime commit') {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) {
    throw new Error(`${label} must be an exact lowercase 40-hex commit SHA; refs, tags, branches, and abbreviated SHAs are forbidden`);
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertExactCommitSha(process.argv[2], process.argv[3]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'runtime SHA validation failed'}\n`);
    process.exitCode = 1;
  }
}
import { pathToFileURL } from 'node:url';
