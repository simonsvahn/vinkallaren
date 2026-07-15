const requiredText = (value, fallback = '') => String(value ?? fallback).trim();

export function slug(value) {
  return requiredText(value, 'vin')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'vin';
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(candidate => candidate.some(value => value !== ''));
}

const categoryFromType = type => {
  const value = requiredText(type).toLowerCase();
  if (value.includes('spark') || value.includes('champ')) return 'Champagne';
  if (value.includes('ros')) return 'Rosé';
  if (value.includes('dessert') || value.includes('sweet') || value.includes('port')) return 'Sött';
  if (value.includes('white')) return 'Vitt';
  if (value.includes('red')) return 'Rött';
  return 'Övrigt';
};

const inferredPairing = category => {
  if (category === 'Champagne') return { foods: ['snacks', 'fish', 'poultry'], moods: ['bright', 'classic', 'grand'] };
  if (category === 'Vitt') return { foods: ['fish', 'poultry', 'cheese'], moods: ['bright', 'classic', 'curious'] };
  if (category === 'Rosé') return { foods: ['snacks', 'fish', 'pizza'], moods: ['bright', 'cozy'] };
  if (category === 'Rött') return { foods: ['pizza', 'meat', 'game', 'cheese'], moods: ['cozy', 'classic', 'grand'] };
  if (category === 'Sött') return { foods: ['dessert', 'cheese'], moods: ['grand', 'classic'] };
  return { foods: ['snacks'], moods: ['curious'] };
};

export function cellarTrackerCsvToMaster(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV-filen saknar inventarierader');
  const headers = rows[0].map(header => requiredText(header));
  if (!headers.includes('Wine') && !headers.includes('Producer')) throw new Error('Filen ser inte ut som en CellarTracker-export');
  const index = Object.fromEntries(headers.map((header, position) => [header, position]));
  const value = (row, key) => requiredText(row[index[key]]);
  const grouped = new Map();

  for (const row of rows.slice(1)) {
    const producer = value(row, 'Producer');
    const name = value(row, 'Wine');
    if (!producer && !name) continue;
    const vintage = value(row, 'Vintage');
    const location = value(row, 'Location') || 'Okänd plats';
    const bin = value(row, 'Bin');
    const size = value(row, 'Size') || '750';
    const iwine = value(row, 'iWine');
    const id = iwine
      ? `ct-${slug(iwine)}-${slug(location)}-${slug(bin || 'utan-fack')}`
      : slug([producer, name, vintage, size, location, bin].join('-'));
    const quantity = Number.parseInt(value(row, 'Quantity') || '1', 10) || 1;
    if (grouped.has(id)) { grouped.get(id).quantity += quantity; continue; }
    const category = categoryFromType(value(row, 'Type'));
    const pairing = inferredPairing(category);
    const begin = value(row, 'BeginConsume');
    const end = value(row, 'EndConsume');
    const currentYear = new Date().getFullYear();
    const beginYear = Number.parseInt(begin, 10);
    const ready = Number.isFinite(beginYear) && beginYear > currentYear ? 'cellar' : 'now';
    grouped.set(id, {
      id,
      iwine,
      category,
      vintage,
      producer,
      cuvee: name,
      region: value(row, 'Region') || value(row, 'Country'),
      varietal: value(row, 'Varietal') || value(row, 'MasterVarietal'),
      location,
      bin,
      quantity,
      size,
      window: begin || end ? `${begin || 'nu'}–${end || 'senare'}` : 'Drickfönster saknas',
      ready,
      tier: 2,
      priority: 0,
      serve: category === 'Rött' ? '16–18 °C' : category === 'Sött' ? '10–12 °C' : '9–12 °C',
      air: 'Bedöm vid öppning och följ i glaset.',
      description: 'Importerad från CellarTracker. Komplettera gärna den kuraterade informationen i masterfilen.',
      ...pairing
    });
  }
  return createMaster([...grouped.values()], { source: 'cellartracker-csv' });
}

export function createMaster(wines, { source = 'vinkallaren' } = {}) {
  return {
    schema_version: 1,
    app: 'Vinkällaren',
    exported_at: new Date().toISOString(),
    source,
    wines: wines.map((wine, position) => normalizeWine(wine, position))
  };
}

export function normalizeWine(wine, position = 0) {
  if (!wine || typeof wine !== 'object' || Array.isArray(wine)) throw new TypeError('Varje vin måste vara ett objekt');
  const producer = requiredText(wine.producer || wine.p);
  const cuvee = requiredText(wine.cuvee || wine.c);
  const vintage = requiredText(wine.vintage || wine.v);
  if (!producer || !cuvee) throw new Error('Vin saknar producent eller namn');
  const id = requiredText(wine.id) || slug([producer, cuvee, vintage, wine.location, position].join('-'));
  return {
    id,
    iwine: requiredText(wine.iwine),
    category: requiredText(wine.category || wine.cat, 'Övrigt'),
    vintage,
    producer,
    cuvee,
    region: requiredText(wine.region || wine.r),
    varietal: requiredText(wine.varietal),
    location: requiredText(wine.location, 'Okänd plats'),
    bin: requiredText(wine.bin),
    quantity: Number(wine.quantity ?? 1) || 1,
    size: requiredText(wine.size, wine.format === 'magnum' ? '1500' : '750'),
    window: requiredText(wine.window, 'Drickfönster saknas'),
    ready: ['now', 'air', 'cellar'].includes(wine.ready) ? wine.ready : 'now',
    tier: Math.max(1, Math.min(3, Number(wine.tier || 1))),
    priority: Number(wine.priority || 0),
    serve: requiredText(wine.serve, 'Följ vinets stil och temperatur.'),
    air: requiredText(wine.air, 'Bedöm vid öppning.'),
    description: requiredText(wine.description || wine.desc),
    foods: [...new Set(Array.isArray(wine.foods) ? wine.foods.map(String) : [])],
    moods: [...new Set(Array.isArray(wine.moods) ? wine.moods.map(String) : [])]
  };
}

export function validateMaster(master) {
  if (!master || master.schema_version !== 1 || master.app !== 'Vinkällaren' || !Array.isArray(master.wines)) {
    throw new Error('JSON-filen är inte en giltig Vinkällaren-master');
  }
  const wines = master.wines.map(normalizeWine);
  const ids = new Set();
  for (const wine of wines) {
    if (ids.has(wine.id)) throw new Error(`Dubblerat vin-id: ${wine.id}`);
    ids.add(wine.id);
  }
  return { ...master, wines };
}
