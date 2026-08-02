import {
  DropboxTransport,
  IndexedDBStore,
  Repository,
  SyncEngine,
  TransportError,
  beginDropboxOAuth,
  completeDropboxOAuth,
  openVinkallarenDB,
  refreshDropboxAccessToken
} from './data-layer.js';

// Publik appnyckel från Dropbox App Console. App secret får aldrig finnas här.
export const DROPBOX_CLIENT_ID = '3rvdln2dupmohut';
const DEVICE_KEY = 'vinkallaren:device';
const DB_NAME = 'vinkallaren-live-v1';

// Enhetslokal lagring av själva Dropbox-anslutningen (refresh-token + senaste
// access-token). Skrivs ALDRIG via repository, hamnar ALDRIG i export-JSON och
// publiceras ALDRIG — samma policy som settings-store.js tillämpar på API-nycklar.
const AUTH_KEY = 'vinkallaren:dropbox-auth';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let activeSession = null; // { transport, repository, syncEngine }

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

// --- Lagrad Dropbox-anslutning (refresh/access-token) -----------------------

function loadStoredAuth(storage = globalThis.localStorage) {
  try {
    const raw = storage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function saveStoredAuth(auth, storage = globalThis.localStorage) {
  storage.setItem(AUTH_KEY, JSON.stringify(auth));
}

function clearStoredAuth(storage = globalThis.localStorage) {
  storage.removeItem(AUTH_KEY);
}

// Läser den lagrade anslutningen och förnyar access-token om den är nära att
// gå ut (eller redan har gått ut). Kastar ett vänligt fel om anslutningen helt
// saknas eller om Dropbox har återkallat den (invalid_grant).
async function ensureFreshAccessToken({
  storage = globalThis.localStorage,
  fetchImpl = (...args) => globalThis.fetch(...args)
} = {}) {
  const auth = loadStoredAuth(storage);
  if (!auth?.access_token) throw new Error('Ingen Dropbox-anslutning');
  const expiresAt = Number(auth.expires_at) || 0;
  const needsRefresh = expiresAt - Date.now() < REFRESH_MARGIN_MS;
  if (!needsRefresh || !auth.refresh_token) return auth.access_token;
  try {
    const refreshed = await refreshDropboxAccessToken({ clientId: DROPBOX_CLIENT_ID, refreshToken: auth.refresh_token, fetchImpl });
    const next = { ...auth, access_token: refreshed.access_token, expires_at: Date.now() + refreshed.expires_in * 1000 };
    saveStoredAuth(next, storage);
    return next.access_token;
  } catch (error) {
    if (error.code === 'invalid_grant') {
      clearStoredAuth(storage);
      throw new Error('Dropbox-anslutningen har gått ut — anslut igen under Inställningar');
    }
    throw error;
  }
}

// Modulnivå-cache: både boot()-flödet (openLiveRepository) och sessionsflödet
// (ensureActiveSession, när det bygger en helt ny session efter omladdning)
// måste dela EXAKT samma Repository-instans. Repository håller sitt materialiserade
// tillstånd i minnet (domain/materializer.js); två separata instanser mot samma
// IndexedDB skulle bägge kunna skriva/läsa databasen korrekt, men fjärroperationer
// nedladdade i den ena instansen syns aldrig i den andras in-minnes-vy. Utan denna
// cache skulle t.ex. longpoll-synken (som öppnar sin egen session vid behov) kunna
// hämta nya viner till en "skugg-repository" som app.js aldrig läser ur.
let liveRepositoryPromise = null;

export function openLiveRepository({
  indexedDB = globalThis.indexedDB,
  localStorage = globalThis.localStorage,
  crypto = globalThis.crypto
} = {}) {
  if (!liveRepositoryPromise) {
    liveRepositoryPromise = (async () => {
      const db = await openVinkallarenDB({ indexedDB, name: DB_NAME });
      const store = new IndexedDBStore(db);
      const deviceId = liveDeviceId({ storage: localStorage, crypto });
      return new Repository({ store, deviceId }).init();
    })().catch(error => {
      liveRepositoryPromise = null;
      throw error;
    });
  }
  return liveRepositoryPromise;
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
  activeSession = { transport, repository: resolvedRepository, syncEngine };
  return { ...result, repository: resolvedRepository };
}

export async function completeDropboxLive({
  location = globalThis.location,
  history = globalThis.history,
  sessionStorage = globalThis.sessionStorage,
  localStorage = globalThis.localStorage,
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
  // token_access_type=offline ska alltid ge en refresh_token. Om Dropbox mot förmodan
  // ändå utelämnar den sparas access_token/expires_at ändå — sessionen fungerar tills
  // access_token går ut, men överlever inte en omladdning (samma som innan M3).
  saveStoredAuth({
    refresh_token: token.refresh_token || null,
    access_token: token.access_token,
    expires_at: Number.isFinite(token.expires_in) ? Date.now() + token.expires_in * 1000 : null
  }, localStorage);
  history.replaceState(null, '', `${redirectUri}#meny`);
  return result;
}

export function hasActiveDropboxSession() {
  if (activeSession) return true;
  return Boolean(loadStoredAuth()?.refresh_token);
}

// Säkerställer att `activeSession` finns och pekar på en färsk access-token.
// Behåller alltid transport-id 'dropbox-real' så SyncEngine.keyPrefix (som bär
// cursor/uploaded_seq i meta-storen) är kontinuerlig över nya transportinstanser.
async function ensureActiveSession() {
  const accessToken = await ensureFreshAccessToken();
  if (activeSession) {
    activeSession.transport.accessToken = accessToken;
    return activeSession;
  }
  const repository = await openLiveRepository();
  const transport = new DropboxTransport({ accessToken, id: 'dropbox-real' });
  const syncEngine = new SyncEngine({ repository, transport, batchSize: 250 });
  activeSession = { transport, repository, syncEngine };
  return activeSession;
}

export async function syncActiveDropboxSession() {
  if (!hasActiveDropboxSession()) return null;
  const session = await ensureActiveSession();
  try {
    return await session.syncEngine.syncOnce();
  } catch (error) {
    if (error instanceof TransportError && error.status === 401) {
      // Access-token kan ha blivit ogiltig av annat skäl än att expires_at passerats
      // (t.ex. klockskillnad). Tvinga fram EN förnyelse och ETT omförsök innan felet ges vidare.
      const auth = loadStoredAuth();
      if (auth) saveStoredAuth({ ...auth, expires_at: 0 });
      const retried = await ensureActiveSession();
      return await retried.syncEngine.syncOnce();
    }
    throw error;
  }
}

export async function waitAndSyncDropbox({ timeoutMs } = {}) {
  if (!hasActiveDropboxSession()) throw new Error('Ingen Dropbox-anslutning');
  const session = await ensureActiveSession();
  return session.syncEngine.waitAndSync({ timeoutMs });
}

export function disconnectDropbox() {
  activeSession = null;
  clearStoredAuth();
}
