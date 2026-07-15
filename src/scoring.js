export const CATEGORY_ORDER = ['Champagne', 'Vitt', 'Rosé', 'Rött', 'Sött'];

export const UI_TEXT = Object.freeze({
  food: {
    snacks: 'chark, chips, mandlar och oliver',
    fish: 'fisk eller skaldjur',
    pizza: 'pizza, pasta eller tomat',
    poultry: 'fågel eller ljust kött',
    meat: 'nötkött, pommes och béarnaise',
    game: 'lamm, älg eller annat vilt',
    cheese: 'ost och något salt',
    dessert: 'dessert eller efter maten'
  },
  mood: {
    bright: 'lätt och energisk',
    cozy: 'generös och avslappnad',
    classic: 'klassisk och elegant',
    curious: 'vild och nyfiken',
    grand: 'djup och högtidlig'
  },
  ambition: { 1: 'vardagslyx', 2: 'seriös middag', 3: 'öppna något stort' },
  readiness: { now: 'redo nu', air: 'med tid för luft', cellar: 'även unga framtidsflaskor' }
});

export const PRESETS = Object.freeze({
  fredag: { food: 'snacks', mood: 'bright', ambition: '1', readiness: 'now', guests: '2' },
  sjotunga: { food: 'fish', mood: 'classic', ambition: '2', readiness: 'air', guests: '2' },
  alg: { food: 'game', mood: 'grand', ambition: '2', readiness: 'air', guests: '4' },
  stor: { food: 'fish', mood: 'grand', ambition: '3', readiness: 'air', guests: '4' }
});

const list = value => Array.isArray(value) ? value : [];
const sizeMl = wine => Number(String(wine.size || '').replace(/[^0-9.]/g, '')) || (wine.format === 'magnum' ? 1500 : 750);

export function scoreWine(wine, state) {
  if (!wine || Number(wine.quantity ?? 1) <= 0) return Number.NEGATIVE_INFINITY;
  if (state.location && state.location !== 'Alla' && wine.location !== state.location) return Number.NEGATIVE_INFINITY;

  let score = 0;
  const foods = list(wine.foods);
  const moods = list(wine.moods);
  if (foods.includes(state.food)) score += 11;
  if (moods.includes(state.mood)) score += 7;

  const target = Number(state.ambition || 1);
  const tier = Number(wine.tier || 1);
  const difference = Math.abs(tier - target);
  score += difference === 0 ? 5 : difference === 1 ? 1 : -4;

  const ready = wine.ready || 'now';
  if (state.readiness === 'now') score += ready === 'now' ? 7 : ready === 'air' ? 0 : -14;
  else if (state.readiness === 'air') score += ready === 'air' ? 7 : ready === 'now' ? 4 : -7;
  else score += ready === 'cellar' ? 7 : 1;

  if (state.guests === '6' && sizeMl(wine) >= 1500) score += 8;
  if (state.guests !== '6' && sizeMl(wine) >= 1500) score -= 1;
  score += Number(wine.priority || 0);

  const sweet = wine.category === 'Sött';
  if (state.food === 'dessert' && !sweet) score -= 18;
  if (state.food !== 'dessert' && sweet) score -= 18;
  return score;
}

export function rankWines(wines, state, limit = 3) {
  return wines
    .map(wine => ({ wine, score: scoreWine(wine, state) }))
    .filter(item => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score || String(a.wine.producer).localeCompare(String(b.wine.producer), 'sv'))
    .slice(0, limit);
}

export function recommendationReason(wine, state, index) {
  const food = UI_TEXT.food[state.food] || 'maten';
  const mood = UI_TEXT.mood[state.mood] || 'valda';
  const foodMatch = list(wine.foods).includes(state.food);
  const moodMatch = list(wine.moods).includes(state.mood);
  const first = foodMatch
    ? `Strukturen och balansen sitter rätt till ${food}.`
    : `Det här leder ${food} i en mer oväntad riktning.`;
  const second = moodMatch
    ? `Samtidigt träffar det rätt ton för kvällen: ${mood}.`
    : `Kontrasten gör kvällens uttryck mer intressant: ${mood}.`;
  const ending = index === 0
    ? 'Sommelierens tydligaste val.'
    : index === 1
      ? 'Den mer klassiska vägen.'
      : 'Kvällens roliga avvikelse.';
  return `${first} ${second} ${ending}`;
}

export function readyNow(wines, limit = 10) {
  return wines
    .filter(wine => Number(wine.quantity ?? 1) > 0 && ['now', 'air'].includes(wine.ready))
    .sort((a, b) => {
      const readyOrder = (a.ready === 'now' ? 1 : 0) - (b.ready === 'now' ? 1 : 0);
      return -readyOrder || Number(b.priority || 0) - Number(a.priority || 0) || String(a.vintage).localeCompare(String(b.vintage));
    })
    .slice(0, limit);
}

export function uniqueLocations(wines) {
  return [...new Set(wines.map(wine => wine.location).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'sv'));
}
