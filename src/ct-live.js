// Live-hämtning av källardata från CellarTracker via Vinkällarens egen Cloudflare
// Worker-proxy (se worker/ct-proxy.js). Ren modul: ingen DOM, fetchImpl injicerbar
// för test. decodeCsvBytes/looksLikeCtError porterar _decode_bytes/_looks_like_error
// från CT-koppling/vinparning/app/cellar.py till JavaScript.

// Provar UTF-8 (strikt), faller tillbaka till ISO-8859-1. Svenska och franska
// tecken (å ä ö é è ç etc.) måste avkodas korrekt oavsett vilket CT faktiskt skickar.
export function decodeCsvBytes(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_) {
    text = new TextDecoder('iso-8859-1').decode(buffer);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Kolumner vi förväntar oss i en giltig CT-export. Om inget av dessa förekommer
// i headerraden är svaret sannolikt CT:s HTML-inloggningssida (skickad med HTTP 200).
const EXPECTED_HEADER_COLUMNS = ['iWine', 'Wine', 'Producer', 'Vintage'];

export function looksLikeCtError(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('<')) return true;
  const firstLine = trimmed.split(/\r?\n/)[0] || '';
  const headerFields = new Set(firstLine.split(',').map(field => field.trim().replace(/^"+/, '').replace(/"+$/, '')));
  return !EXPECTED_HEADER_COLUMNS.some(column => headerFields.has(column));
}

function httpErrorMessage(status) {
  if (status === 401) return 'Fel delad hemlighet mot proxyn';
  if (status === 403) return 'Adressen är inte tillåten i workern (ALLOWED_ORIGINS)';
  if (status === 504) return 'CellarTracker eller proxyn svarar inte — försök igen senare';
  return `Hämtningen misslyckades (HTTP ${status})`;
}

export async function fetchCellarCsv({
  workerUrl,
  sharedSecret,
  user,
  password,
  fetchImpl = (...args) => globalThis.fetch(...args)
}) {
  const headers = { 'content-type': 'application/json' };
  if (sharedSecret) headers['x-vinkallaren-auth'] = sharedSecret;

  let response;
  try {
    response = await fetchImpl(workerUrl, { method: 'POST', headers, body: JSON.stringify({ user, password }) });
  } catch (error) {
    if (error instanceof TypeError) throw new Error('CellarTracker eller proxyn svarar inte — försök igen senare');
    throw error;
  }

  if (!response.ok) throw new Error(httpErrorMessage(response.status));

  const buffer = await response.arrayBuffer();
  const text = decodeCsvBytes(buffer);
  if (looksLikeCtError(text)) throw new Error('CellarTracker-svaret kunde inte tolkas — fel användarnamn/lösenord eller tjänsten nere');
  return text;
}
