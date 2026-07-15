const base64Url = bytes => {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  if (typeof btoa !== 'function') throw new Error('Base64-kodning saknas i webbläsaren');
  const base64 = btoa(binary);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

export async function createPkcePair({ crypto = globalThis.crypto } = {}) {
  if (!crypto?.getRandomValues || !crypto?.subtle?.digest) throw new Error('Web Crypto krävs för PKCE');
  const random = new Uint8Array(48);
  crypto.getRandomValues(random);
  const verifier = base64Url(random);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64Url(digest), method: 'S256' };
}

export function createOAuthState({ crypto = globalThis.crypto } = {}) {
  if (!crypto?.getRandomValues) throw new Error('Web Crypto krävs för OAuth-state');
  const random = new Uint8Array(24);
  crypto.getRandomValues(random);
  return base64Url(random);
}

export function buildDropboxAuthorizationUrl({ clientId, redirectUri, challenge, state, scopes = [] }) {
  if (!clientId || !redirectUri || !challenge || !state) throw new TypeError('OAuth-parametrar saknas');
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('state', state);
  if (scopes.length) url.searchParams.set('scope', scopes.join(' '));
  return url.toString();
}

export async function exchangeDropboxCode({ clientId, redirectUri, code, verifier, fetchImpl = (...args) => globalThis.fetch(...args) }) {
  if (!fetchImpl) throw new Error('fetch saknas');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier
  });
  const response = await fetchImpl.call(globalThis, 'https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || payload.error || `Dropbox OAuth misslyckades (${response.status})`);
  return payload;
}
