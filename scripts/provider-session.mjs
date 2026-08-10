import { gunzipSync } from 'node:zlib';

const providerFile = Object.freeze({
  chatgpt: 'chatgpt_auth_state.json',
  claude: 'claude_auth_state.json',
  perplexity: 'perplexity_auth_state.json',
  grok: 'grok_auth_state.json',
  'google-aio': 'google_auth_state.json',
});

function strictBase64(value, label) {
  const compact = (value ?? '').replace(/\s/g, '');
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error(`${label}_malformed_base64`);
  }
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw new Error(`${label}_malformed_base64`);
  }
  return bytes;
}

function grokPlainRepresentation(env) {
  const chunks = [1, 2, 3, 4, 5].map((index) => env[`GROK_SESSION_B64_${index}`]?.trim() ?? '');
  let last = -1;
  chunks.forEach((chunk, index) => { if (chunk) last = index; });
  if (last < 0) return '';
  for (let index = 0; index <= last; index += 1) {
    if (!chunks[index]) throw new Error(`grok_session_missing_chunk_${index + 1}`);
  }
  return chunks.slice(0, last + 1).join('');
}

export function reconstructProviderSession(provider, env) {
  const filename = providerFile[provider];
  if (!filename) throw new Error('selected_provider_unsupported');
  const prefix = provider === 'google-aio' ? 'GOOGLE' : provider.toUpperCase();
  const compressed = env[`${prefix}_SESSION_GZ_B64`]?.trim() ?? '';
  const plain = provider === 'grok'
    ? grokPlainRepresentation(env)
    : env[`${prefix}_SESSION_B64`]?.trim() ?? '';
  if (!compressed && !plain) throw new Error('selected_provider_session_unavailable');

  let bytes;
  let representation;
  if (compressed) {
    representation = 'gzip_base64';
    try { bytes = gunzipSync(strictBase64(compressed, `${provider}_session_gzip`)); }
    catch (error) {
      if (error instanceof Error && error.message.endsWith('_malformed_base64')) throw error;
      throw new Error(`${provider}_session_malformed_gzip`);
    }
  } else {
    representation = provider === 'grok' && env.GROK_SESSION_B64_2 ? 'chunked_base64' : 'base64';
    bytes = strictBase64(plain, `${provider}_session`);
  }

  let state;
  try { state = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${provider}_session_malformed_json`); }
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    throw new Error(`${provider}_session_contract_invalid`);
  }
  return { bytes, filename, representation };
}
