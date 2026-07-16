// Enda modulen som rör enhetslokala hemligheter/inställningar (API-nycklar, CT-uppgifter).
// Dessa värden lagras uteslutande i localStorage på den här enheten: de skrivs
// ALDRIG via repository.setField, hamnar ALDRIG i export-JSON och publiceras ALDRIG.

export const DEVICE_SETTINGS_KEY = 'vinkallaren:device-settings';
export const USAGE_LOG_KEY = 'vinkallaren:usage-log';

const MAX_USAGE_ENTRIES = 200;
const USD_PER_SEK = 10;

const DEFAULT_SETTINGS = Object.freeze({
  anthropicApiKey: '',
  anthropicModel: 'claude-opus-4-8',
  ctUser: '',
  ctPassword: '',
  ctWorkerUrl: '',
  ctWorkerSecret: '',
  ctAutoRefresh: false
});

// USD per miljon tokens (Mtok).
const MODEL_PRICE_USD_PER_MTOK = Object.freeze({
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 }
});

function readJson(storage, key, fallback) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (_) {
    return fallback;
  }
}

export function loadDeviceSettings(storage = globalThis.localStorage) {
  const parsed = readJson(storage, DEVICE_SETTINGS_KEY, {});
  const patch = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  return { ...DEFAULT_SETTINGS, ...patch };
}

export function saveDeviceSettings(patch, storage = globalThis.localStorage) {
  const next = { ...loadDeviceSettings(storage), ...patch };
  storage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function clearSecret(name, storage = globalThis.localStorage) {
  return saveDeviceSettings({ [name]: DEFAULT_SETTINGS[name] }, storage);
}

export function appendUsage(entry, storage = globalThis.localStorage) {
  const existing = readJson(storage, USAGE_LOG_KEY, []);
  const log = Array.isArray(existing) ? existing : [];
  log.push(entry);
  const trimmed = log.length > MAX_USAGE_ENTRIES ? log.slice(log.length - MAX_USAGE_ENTRIES) : log;
  storage.setItem(USAGE_LOG_KEY, JSON.stringify(trimmed));
  return trimmed;
}

export function usageSummary(storage = globalThis.localStorage) {
  const existing = readJson(storage, USAGE_LOG_KEY, []);
  const log = Array.isArray(existing) ? existing : [];
  let inputTokens = 0;
  let outputTokens = 0;
  let usd = 0;
  for (const entry of log) {
    const price = MODEL_PRICE_USD_PER_MTOK[entry?.model] || MODEL_PRICE_USD_PER_MTOK['claude-opus-4-8'];
    const input = Number(entry?.inputTokens) || 0;
    const output = Number(entry?.outputTokens) || 0;
    inputTokens += input;
    outputTokens += output;
    usd += (input / 1_000_000) * price.input + (output / 1_000_000) * price.output;
  }
  const estimatedSek = Math.round(usd * USD_PER_SEK * 100) / 100;
  return { calls: log.length, inputTokens, outputTokens, estimatedSek };
}
