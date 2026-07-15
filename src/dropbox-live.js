import {
  DropboxTransport,
  IndexedDBStore,
  Repository,
  SyncEngine,
  beginDropboxOAuth,
  completeDropboxOAuth,
  openVinkallarenDB
} from './data-layer.js';

// Publik appnyckel från Dropbox App Console. App secret får aldrig finnas här.
export const DROPBOX_CLIENT_ID = '3rvdln2dupmohut';
const DEVICE_KEY = 'vinkallaren:device';
const DB_NAME = 'vinkallaren-live-v1';

let activeSession = null;

export function dropboxConfigured() {
  return Boolean(DROPBOX_CLIENT_ID && !DROPBOX_CLIENT_ID.startsWith('REPLACE_'));
}

export function currentDropboxRedirectUri(location = globalThis.location) {
  if (!location?.href) throw new TypeError('Webbadress saknas');
  const url = new URL('./', location.href);
  url.search = '';
  url.hash = '';
  return url.href;
}

export function isDropboxCallback(location = globalThis.location) {
  const search = new URL(location.href).searchParams;
  return search.has('code') || search.has('error') || search.has('error_description');
}

function liveDeviceId({ storage = globalThis.localStorage, crypto = globalThis.crypto } = {}) {
  const existing = storage.getItem(DEVICE_KEY);
  if (existing) return existing;
  if (!crypto?.randomUUID) throw new Error('Web Crypto randomUUID krävs för enhets-id');
  const created = `web-${crypto.randomUUID()}`;
  storage.setItem(DEVICE_KEY, created);
  return created;
}

export async function openLiveRepository({
  indexedDB = globalThis.indexedDB,
  localStorage = globalThis.localStorage,
  crypto = globalThis.crypto
} = {}) {
  const db = await openVinkallarenDB({ indexedDB, name: DB_NAME });
  const store = new IndexedDBStore(db);
  const deviceId = liveDeviceId({ storage: localStorage, crypto });
  return new Repository({ store, deviceId }).init();
}

export async function beginDropboxLive({
  location = globalThis.location,
  storage = globalThis.sessionStorage,
  crypto = globalThis.crypto
} = {}) {
  if (!dropboxConfigured()) throw new Error('Dropbox-appnyckeln är inte konfigurerad ännu');
  const redirectUri = currentDropboxRedirectUri(location);
  const authorization = await beginDropboxOAuth({
    clientId: DROPBOX_CLIENT_ID,
    redirectUri,
    storage,
    crypto
  });
  location.assign(authorization.url);
  return authorization;
}

async function runRealSync({ accessToken, repository = null }) {
  const resolvedRepository = repository || await openLiveRepository();
  const transport = new DropboxTransport({ accessToken, id: 'dropbox-real' });
  const syncEngine = new SyncEngine({ repository: resolvedRepository, transport, batchSize: 250 });
  const result = await syncEngine.syncOnce();
  activeSession = { transport, repository: resolvedRepository, syncEngine, expiresAt: null };
  return { ...result, repository: resolvedRepository };
}

export async function completeDropboxLive({
  location = globalThis.location,
  history = globalThis.history,
  sessionStorage = globalThis.sessionStorage,
  repository = null,
  fetchImpl = (...args) => globalThis.fetch(...args)
} = {}) {
  if (!isDropboxCallback(location)) return null;
  const redirectUri = currentDropboxRedirectUri(location);
  const token = await completeDropboxOAuth({
    callbackUrl: location.href,
    storage: sessionStorage,
    fetchImpl
  });
  const result = await runRealSync({ accessToken: token.access_token, repository });
  activeSession.expiresAt = Number.isFinite(token.expires_in) ? Date.now() + token.expires_in * 1000 : null;
  history.replaceState(null, '', `${redirectUri}#valj`);
  return result;
}

export function hasActiveDropboxSession() {
  return Boolean(activeSession);
}

export async function syncActiveDropboxSession() {
  return activeSession ? activeSession.syncEngine.syncOnce() : null;
}
