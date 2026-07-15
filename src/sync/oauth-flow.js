import {
  buildDropboxAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  exchangeDropboxCode
} from './oauth-pkce.js';

const PENDING_KEY = 'vinkallaren:dropbox-oauth-pending';

function requireStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
    throw new TypeError('OAuth kräver sessionStorage');
  }
  return storage;
}

export async function beginDropboxOAuth({
  clientId,
  redirectUri,
  scopes = ['files.metadata.read', 'files.content.read', 'files.content.write'],
  storage = globalThis.sessionStorage,
  crypto = globalThis.crypto,
  now = () => Date.now()
}) {
  requireStorage(storage);
  const [{ verifier, challenge }, state] = await Promise.all([
    createPkcePair({ crypto }),
    Promise.resolve(createOAuthState({ crypto }))
  ]);
  const pending = { version: 1, clientId, redirectUri, verifier, state, createdAt: now() };
  storage.setItem(PENDING_KEY, JSON.stringify(pending));
  return {
    url: buildDropboxAuthorizationUrl({ clientId, redirectUri, challenge, state, scopes }),
    state
  };
}

export async function completeDropboxOAuth({
  callbackUrl = globalThis.location?.href,
  storage = globalThis.sessionStorage,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  maxAgeMs = 10 * 60 * 1000
} = {}) {
  requireStorage(storage);
  const url = new URL(callbackUrl);
  const oauthError = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (oauthError) {
    storage.removeItem(PENDING_KEY);
    throw new Error(`Dropbox-auktorisering avbröts: ${oauthError}`);
  }
  const rawPending = storage.getItem(PENDING_KEY);
  if (!rawPending) throw new Error('OAuth-försöket saknas eller har gått ut');
  let pending;
  try { pending = JSON.parse(rawPending); }
  catch (_) { storage.removeItem(PENDING_KEY); throw new Error('OAuth-försöket är skadat'); }
  if (pending.version !== 1 || !pending.clientId || !pending.redirectUri || !pending.verifier || !pending.state || !Number.isFinite(pending.createdAt)) {
    storage.removeItem(PENDING_KEY);
    throw new Error('OAuth-försöket är ogiltigt');
  }
  if (now() - pending.createdAt > maxAgeMs || now() < pending.createdAt) {
    storage.removeItem(PENDING_KEY);
    throw new Error('OAuth-försöket har gått ut');
  }
  if (url.searchParams.get('state') !== pending.state) {
    storage.removeItem(PENDING_KEY);
    throw new Error('OAuth-state stämmer inte');
  }
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Dropbox returnerade ingen auktoriseringskod');
  const token = await exchangeDropboxCode({
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    code,
    verifier: pending.verifier,
    fetchImpl
  });
  storage.removeItem(PENDING_KEY);
  return token;
}

export function clearPendingDropboxOAuth(storage = globalThis.sessionStorage) {
  requireStorage(storage).removeItem(PENDING_KEY);
}
