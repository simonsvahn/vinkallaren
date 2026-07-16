// Claude-anropet: ren logik, ingen DOM. Systempromptens första del är en ordagrann
// portering av den svenska sommelier-prompten i CT-koppling/vinparning/app/pairing.py
// (se även CT-koppling/DESIGN.md §7.3), plus en extra mening om nivå-kolumnen som
// är specifik för Vinkällarens inventarietabell.

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export const SOMMELIER_MODELS = Object.freeze({
  'claude-opus-4-8': 'Opus 4.8 (bäst, standard)',
  'claude-sonnet-5': 'Sonnet 5 (snabbare, billigare)',
  'claude-haiku-4-5': 'Haiku 4.5 (snabbast)'
});

export const SOMMELIER_SYSTEM = 'Du är en erfaren sommelier som hjälper ett svenskt hushåll att välja vin ur deras egen vinkällare, och mat till deras viner. Du svarar alltid på svenska. Du rekommenderar ENDAST flaskor som finns i den inventarielista du får — hitta aldrig på viner. Ta hänsyn till drickfönster (prioritera flaskor som är i eller nära sin mognad; varna om en flaska öppnas för tidigt). Ta hänsyn till tillfälle: till vardag föreslås enklare flaskor, till fest får finare flaskor användas. Motivera alltid konkret varför vinet passar maten (syra, tanniner, kropp, sötma, aromer) utan att bli akademisk. Kolumnen "nivå" i inventarielistan visar flaskans karaktär: nivå 1 är en enklare vardagsflaska, nivå 3 är källarens finaste flaskor (fest).';

export class SommelierError extends Error {
  constructor(message, { code = null, retryable = false } = {}) {
    super(message);
    this.name = 'SommelierError';
    this.code = code;
    this.retryable = retryable;
  }
}

const INVENTORY_HEADER = 'id | producent | vin | årgång | kategori | druva | region | antal | format | drickfönster | plats/fack | nivå | not';
const EMPTY_INVENTORY_TEXT = '(inga flaskor på vald plats)';

export function inventoryRow(wine) {
  const cell = value => String(value ?? '').replaceAll('|', '/').trim();
  const place = wine.bin ? `${wine.location || ''}/${wine.bin}` : (wine.location || '');
  return [
    wine.id,
    wine.producer,
    wine.cuvee,
    wine.vintage,
    wine.category,
    wine.varietal,
    wine.region,
    wine.quantity,
    `${wine.size || '750'} ml`,
    wine.window,
    place,
    wine.tier,
    String(wine.description || '').slice(0, 140)
  ].map(cell).join(' | ');
}

export function buildInventoryTable(wines) {
  if (!wines.length) return EMPTY_INVENTORY_TEXT;
  return [INVENTORY_HEADER, ...wines.map(inventoryRow)].join('\n');
}

export function buildPairingPrompt({ foodText, occasion, locationLabel, wines }) {
  return `## Maten
${foodText}
Tillfälle: ${occasion}

## Tillgängliga flaskor (plats: ${locationLabel})
${buildInventoryTable(wines)}

Föreslå de 1–3 bästa flaskorna till maten ovan. Sätt general_note till en tom sträng om du inte har något övergripande att säga.`;
}

export const PAIRING_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          wine_id: { type: 'string' },
          motivation: { type: 'string' },
          serving_advice: { type: 'string' }
        },
        required: ['wine_id', 'motivation', 'serving_advice'],
        additionalProperties: false
      }
    },
    general_note: { type: 'string' }
  },
  required: ['recommendations', 'general_note'],
  additionalProperties: false
});

export function buildRequestBody({ model, userPrompt }) {
  return {
    model,
    max_tokens: 16000,
    ...(model === 'claude-haiku-4-5' ? {} : { thinking: { type: 'adaptive' } }),
    system: [{ type: 'text', text: SOMMELIER_SYSTEM }],
    messages: [{ role: 'user', content: userPrompt }],
    output_config: { format: { type: 'json_schema', schema: PAIRING_SCHEMA } }
  };
}

export function parsePairingResponse(payload, wines) {
  if (payload?.stop_reason === 'refusal') {
    throw new SommelierError('Sommelieren avböjde frågan.', { code: 'refusal' });
  }
  if (payload?.stop_reason === 'max_tokens') {
    throw new SommelierError('Svaret blev för långt för att tolkas.', { code: 'max_tokens', retryable: true });
  }

  const textBlock = (payload?.content || []).find(block => block?.type === 'text');
  if (!textBlock) throw new SommelierError('Kunde inte tolka svaret från AI-tjänsten.', { code: 'parse' });

  let parsed;
  try { parsed = JSON.parse(textBlock.text); }
  catch (_) { throw new SommelierError('Kunde inte tolka svaret från AI-tjänsten.', { code: 'parse' }); }

  const byId = new Map(wines.map(wine => [wine.id, wine]));
  let dropped = 0;
  const recommendations = [];
  for (const item of parsed.recommendations || []) {
    const wine = byId.get(item.wine_id);
    if (!wine) { dropped += 1; continue; }
    recommendations.push({ wine, motivation: item.motivation, servingAdvice: item.serving_advice });
  }
  if (!recommendations.length) {
    throw new SommelierError('Sommelieren hittade inget som matchar — prova den lokala listan.');
  }
  return { recommendations, generalNote: parsed.general_note || '', dropped };
}

function wait(ms, sleepImpl) {
  return sleepImpl ? sleepImpl(ms) : new Promise(resolve => setTimeout(resolve, ms));
}

export async function askSommelier({
  apiKey,
  model,
  foodText,
  occasion,
  locationLabel,
  wines,
  fetchImpl = (...args) => globalThis.fetch(...args),
  signal,
  sleepImpl
}) {
  const userPrompt = buildPairingPrompt({ foodText, occasion, locationLabel, wines });
  const body = buildRequestBody({ model, userPrompt });
  const requestSignal = signal || AbortSignal.timeout(120000);
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true'
  };

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal });
    } catch (error) {
      if (error instanceof TypeError) throw new SommelierError('Ingen kontakt med AI-tjänsten — är du offline?', { code: 'offline' });
      throw error;
    }

    if (response.status === 401) {
      throw new SommelierError('API-nyckeln är ogiltig — kontrollera den under Inställningar', { code: 'auth' });
    }
    if (response.status === 429) {
      const retryAfter = response.headers?.get?.('retry-after');
      throw new SommelierError(`Många förfrågningar — vänta ${retryAfter ? `${retryAfter} sekunder` : 'en stund'}`, { code: 'rate_limit' });
    }
    if (response.status === 529 || response.status >= 500) {
      lastError = new SommelierError('AI-tjänsten svarar inte just nu', { code: 'server', retryable: true });
      if (attempt === 1) { await wait(2000, sleepImpl); continue; }
      throw lastError;
    }
    if (!response.ok) {
      throw new SommelierError('Kunde inte hämta ett förslag just nu. Försök igen.', { code: 'http' });
    }

    const payload = await response.json();
    try {
      const parsed = parsePairingResponse(payload, wines);
      return { ...parsed, usage: payload.usage, model };
    } catch (error) {
      if (error instanceof SommelierError && error.code === 'max_tokens' && attempt === 1) {
        lastError = error;
        await wait(2000, sleepImpl);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new SommelierError('AI-tjänsten svarar inte just nu', { code: 'server' });
}
