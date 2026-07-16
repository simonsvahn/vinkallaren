// Kurateringssäker sammanslagning av en CellarTracker-import mot den befintliga
// källaren. Skriver ALDRIG över Simons kuraterade fält (beskrivning, nivå, mat-
// kopplingar etc.) — bara de fält som CT faktiskt äger (antal, plats, fack, ...).
// Ren modul: inga sidoeffekter, inga repository-anrop. app.js applicerar `upserts`.

import { canonicalStringify } from './domain/canonical.js';
import { slug } from './importers.js';

// Fält som alltid kommer från CellarTracker och skrivs över vid varje import.
export const CT_OWNED_FIELDS = ['iwine', 'quantity', 'location', 'bin', 'size', 'window', 'ready', 'vintage', 'producer', 'cuvee', 'region', 'varietal'];

// Fält Simon kuraterar för hand och som en import aldrig får röra.
// nowNote/urgency finns inte i normalizeWine ännu (kommer i M3) — pick() hoppar
// naturligt över fält som saknas på objektet.
export const CURATED_FIELDS = ['category', 'tier', 'priority', 'description', 'serve', 'air', 'foods', 'moods', 'nowNote', 'urgency'];

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

// Samma slug-normalisering som importers.js (gemener, diakritik-strippning,
// icke-alfanumeriskt -> bindestreck), återanvänd rakt av.
function adoptionKey(wine) {
  return `${slug(wine.producer)}::${String(wine.vintage ?? '').trim()}`;
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function mergeCellarImport(existingWines, importedWines) {
  const existingById = new Map(existingWines.map(wine => [wine.id, wine]));
  const importedIdSet = new Set(importedWines.map(wine => wine.id));
  const matchedExistingIds = new Set();

  const upserts = [];
  const zeroed = [];
  const ambiguous = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  // Skriver bara upsert när det faktiskt skiljer sig från utgångsläget (noll op-churn).
  function upsertIfChanged(id, data, base) {
    if (canonicalStringify(data) === canonicalStringify(base)) return false;
    upserts.push({ id, data });
    return true;
  }

  function zeroExisting(existing) {
    if (upsertIfChanged(existing.id, { ...existing, quantity: 0 }, existing)) zeroed.push(existing.id);
  }

  // Steg 1: samma id -> uppdatera CT-fälten på den befintliga entiteten, behåll kurateringen.
  const afterStep1 = [];
  for (const row of importedWines) {
    const existing = existingById.get(row.id);
    if (!existing) { afterStep1.push(row); continue; }
    matchedExistingIds.add(existing.id);
    const merged = { ...existing, ...pick(row, CT_OWNED_FIELDS) };
    if (upsertIfChanged(existing.id, merged, existing)) updated += 1;
    else unchanged += 1;
  }

  // Steg 2: samma iwine hos en befintlig entitet vars id inte längre förekommer i
  // importen -> flaskan har bytt plats/fack i CT. Ny entitet med nytt ct-id, gammal nollad.
  const afterStep2 = [];
  for (const row of afterStep1) {
    if (!row.iwine) { afterStep2.push(row); continue; }
    const candidates = existingWines.filter(wine =>
      wine.iwine === row.iwine && !matchedExistingIds.has(wine.id) && !importedIdSet.has(wine.id)
    );
    if (candidates.length !== 1) { afterStep2.push(row); continue; }
    const donor = candidates[0];
    matchedExistingIds.add(donor.id);
    const merged = { ...donor, ...pick(row, CT_OWNED_FIELDS), id: row.id };
    upserts.push({ id: row.id, data: merged });
    created += 1;
    zeroExisting(donor);
  }

  // Steg 3: unik adoption. En importrad utan id/iwine-träff kopplas till en enda
  // befintlig entitet UTAN iwine som delar nyckeln producent+årgång. Vid flera
  // kandidater åt något håll: ambiguous + faller vidare till steg 4 (ny entitet).
  const remainingExisting = existingWines.filter(wine => !matchedExistingIds.has(wine.id) && !wine.iwine);
  const existingByKey = groupBy(remainingExisting, adoptionKey);
  const importedByKey = groupBy(afterStep2, adoptionKey);

  const afterStep3 = [];
  for (const [key, rows] of importedByKey) {
    const candidates = existingByKey.get(key) || [];
    if (rows.length === 1 && candidates.length === 1) {
      const [row] = rows;
      const [existing] = candidates;
      matchedExistingIds.add(existing.id);
      const merged = { ...existing, ...pick(row, CT_OWNED_FIELDS) };
      if (upsertIfChanged(existing.id, merged, existing)) updated += 1;
      else unchanged += 1;
      continue;
    }
    if (candidates.length > 0) {
      for (const row of rows) ambiguous.push({ importedId: row.id, reason: `flera kandidater för ${key}` });
    }
    afterStep3.push(...rows);
  }

  // Steg 4: ingen match alls -> ny entitet precis som den importerades.
  for (const row of afterStep3) {
    upserts.push({ id: row.id, data: row });
    created += 1;
  }

  // Efteråt: befintliga CT-spårade entiteter som inte matchades av någon importrad
  // (flaskan finns inte kvar i källaren) nollas. Entiteter utan iwine som inte
  // adopterades lämnas helt orörda.
  for (const wine of existingWines) {
    if (matchedExistingIds.has(wine.id)) continue;
    if (!wine.iwine) continue;
    if (Number(wine.quantity) <= 0) continue;
    zeroExisting(wine);
  }

  return { upserts, created, updated, unchanged, zeroed, ambiguous };
}
