import {
  beginDropboxLive,
  completeDropboxLive,
  disconnectDropbox,
  dropboxConfigured,
  hasActiveDropboxSession,
  isDropboxCallback,
  openLiveRepository,
  syncActiveDropboxSession,
  waitAndSyncDropbox
} from './dropbox-live.js?v=20260716-3';
import { fetchCellarCsv } from './ct-live.js';
import { mergeCellarImport } from './ct-merge.js';
import { cellarTrackerCsvToMaster, createMaster, validateMaster } from './importers.js';
import {
  CATEGORY_ORDER,
  PRESETS,
  UI_TEXT,
  URGENCY_LABELS,
  rankWines,
  readyNow,
  recommendationReason,
  uniqueLocations
} from './scoring.js';
import { appendUsage, clearSecret, loadDeviceSettings, saveDeviceSettings, usageSummary } from './settings-store.js';
import { SOMMELIER_MODELS, askSommelier } from './sommelier.js';

const app = document.getElementById('app');
const toast = document.getElementById('toast');
const SELECTION_KEY = 'vinkallaren:selection';
const VALID_VIEWS = new Set(['valj', 'oppna', 'kallaren', 'installningar']);

let repository;
let wines = [];
let syncState = 'local';
let syncLabel = 'Lokalt sparat';
let cellarFilter = { category: 'Alla', search: '' };
let selection = loadSelection();
let aiState = { status: 'idle', foodText: '', result: null, error: '' };
let ctState = { status: 'idle' };
let editingNowId = null;
let syncInFlight = false;
let liveSyncGeneration = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function loadSelection() {
  const fallback = { food: 'snacks', mood: 'bright', ambition: '1', readiness: 'now', guests: '2', location: 'Alla' };
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(SELECTION_KEY) || '{}') }; }
  catch (_) { return fallback; }
}

function saveSelection() {
  localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function currentView() {
  const value = location.hash.replace(/^#/, '').split('?')[0];
  return VALID_VIEWS.has(value) ? value : 'valj';
}

function setSyncStatus(state, label) {
  syncState = state;
  syncLabel = label;
  document.body.dataset.syncState = state;
  document.querySelectorAll('[data-connection-label]').forEach(node => { node.textContent = label; });
}

function updateNavigation(view) {
  document.querySelectorAll('[data-view-link]').forEach(link => {
    link.classList.toggle('active', link.dataset.viewLink === view);
    if (link.dataset.viewLink === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function refreshWines() {
  wines = repository.listEntities('wine')
    .map(entity => ({ ...entity.fields.data, id: entity.entity_id }))
    .filter(wine => wine.producer && wine.cuvee);
}

async function importMaster(master, { announce = true } = {}) {
  const checked = validateMaster(master);
  for (const wine of checked.wines) await repository.setField('wine', wine.id, 'data', wine);
  refreshWines();
  if (announce) showToast(`${checked.wines.length} viner importerade lokalt`);
  if (hasActiveDropboxSession()) await synchronize();
  render();
  return checked.wines.length;
}

async function loadPrivateSeedIfAvailable() {
  if (wines.length || !['localhost', '127.0.0.1'].includes(location.hostname)) return false;
  try {
    const response = await fetch('./private/vinkallaren-startdata.json', { cache: 'no-store' });
    if (!response.ok) return false;
    await importMaster(await response.json(), { announce: false });
    showToast('Privat startkällare laddad lokalt');
    return true;
  } catch (_) { return false; }
}

async function synchronize() {
  if (!hasActiveDropboxSession() || syncInFlight) return null;
  syncInFlight = true;
  setSyncStatus('syncing', 'Synkar…');
  try {
    const result = await syncActiveDropboxSession();
    refreshWines();
    setSyncStatus('synced', 'Synkad');
    render();
    return result;
  } catch (error) {
    setSyncStatus('action', 'Åtgärd krävs');
    throw error;
  } finally {
    syncInFlight = false;
  }
}

// Rendrar inte över ett kort som Simon just nu redigerar (fokus i ett fält inuti
// #app) — visar en toast istället så inget hackigt tas bort under fingrarna.
function isEditingInApp() {
  const active = document.activeElement;
  return Boolean(active) && app.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
}

function safeRender() {
  if (isEditingInApp()) { showToast('Källaren uppdaterades'); return; }
  render();
}

// Long-pollar Dropbox medan fliken är synlig och den här enheten har en aktiv
// anslutning. generation-räknaren gör att en tidigare loop tystnar av sig själv
// så fort fliken göms eller anslutningen kopplas från — det behövs ingen delete
// av ett pågående fetch-anrop, nästa varv av while-villkoret räcker.
//
// syncInFlight täcker medvetet INTE hela detta anrop: waitAndSyncDropbox ligger
// still i en longpoll upp till 30 s åt gången, vilket är loopens normalläge —
// om manuell "Synka nu" blockerades av det skulle knappen i praktiken aldrig
// göra något medan appen är ansluten. Den enda delen som faktiskt rör delat
// tillstånd (uppladdning/nedladdning) är kort och redan konflikt-säker: batch-
// uppladdning jämför innehåll vid 409 och fjärroperationer dedupliceras på
// op_id, så ett sällsynt sammanträffande med en manuell synk är ofarligt.
async function runLiveSyncLoop() {
  const generation = ++liveSyncGeneration;
  while (document.visibilityState === 'visible' && hasActiveDropboxSession() && generation === liveSyncGeneration) {
    try {
      const result = await waitAndSyncDropbox({ timeoutMs: 30000 });
      if (generation !== liveSyncGeneration) break;
      if (result?.changes) {
        refreshWines();
        safeRender();
        setSyncStatus('synced', 'Synkad');
      }
      if (result?.backoff) await sleep(result.backoff * 1000);
    } catch (_) {
      // Tyst stopp — manuell "Synka nu" finns kvar. Nästa synliggörande av fliken
      // startar loopen på nytt (se visibilitychange nedan).
      if (hasActiveDropboxSession()) setSyncStatus('action', 'Åtgärd krävs');
      break;
    }
  }
}

async function refreshFromCellarTracker({ silent = false } = {}) {
  const settings = loadDeviceSettings();
  if (!settings.ctWorkerUrl || !settings.ctUser || !settings.ctPassword) {
    if (!silent) showToast('Fyll i CellarTracker-uppgifterna under Inställningar');
    return;
  }
  ctState = { status: 'loading' };
  render();
  try {
    const csv = await fetchCellarCsv({
      workerUrl: settings.ctWorkerUrl,
      sharedSecret: settings.ctWorkerSecret,
      user: settings.ctUser,
      password: settings.ctPassword
    });
    const master = validateMaster(cellarTrackerCsvToMaster(csv));
    const { upserts, created, updated, zeroed, ambiguous } = mergeCellarImport(wines, master.wines);
    for (const upsert of upserts) await repository.setField('wine', upsert.id, 'data', upsert.data);
    refreshWines();
    localStorage.setItem('vinkallaren:ct-last-fetch', String(Date.now()));
    const ambiguousSuffix = ambiguous.length ? ` · ${ambiguous.length} tvetydiga` : '';
    showToast(`CT: ${created} nya · ${updated} uppdaterade · ${zeroed.length} nollade${ambiguousSuffix}`);
    if (hasActiveDropboxSession()) await synchronize();
  } catch (error) {
    if (!silent) showToast(error.message || 'CellarTracker-hämtningen misslyckades');
  } finally {
    ctState = { status: 'idle' };
    render();
  }
}

function selectorOptions(values, current) {
  return Object.entries(values).map(([value, label]) =>
    `<option value="${escapeHtml(value)}" ${String(current) === value ? 'selected' : ''}>${escapeHtml(label)}</option>`
  ).join('');
}

function wineCard(wine, index, state) {
  return `<article class="wine-card">
    <div class="badge">${escapeHtml(wine.window)}</div>
    <div class="rank">0${index + 1}</div>
    <div class="wine-meta">${escapeHtml(wine.vintage)} · ${escapeHtml(wine.category)}</div>
    <h3>${escapeHtml(wine.producer)}</h3>
    <div class="cuvee">${escapeHtml(wine.cuvee)}</div>
    <div class="region">${escapeHtml(wine.region)}${wine.location ? ` · ${escapeHtml(wine.location)}` : ''}</div>
    <p class="why">${escapeHtml(recommendationReason(wine, state, index))}</p>
    <div class="service">
      <div class="service-row"><span>Servera</span><span>${escapeHtml(wine.serve)}</span></div>
      <div class="service-row"><span>Luftning</span><span>${escapeHtml(wine.air)}</span></div>
      <div class="service-row"><span>Varför nu</span><span>${escapeHtml(wine.description || wine.window)}</span></div>
      <div class="service-row"><span>Finns</span><span>${escapeHtml(wine.quantity || 1)} fl · ${escapeHtml(wine.size || '750')} ml${wine.bin ? ` · fack ${escapeHtml(wine.bin)}` : ''}</span></div>
    </div>
  </article>`;
}

function resultsMarkup() {
  const ranked = rankWines(wines, selection, 3);
  if (!ranked.length) return '<div class="notice">Inga flaskor matchar det valda platsfiltret.</div>';
  return ranked.map(({ wine }, index) => wineCard(wine, index, selection)).join('');
}

function describeOccasion() {
  return `${UI_TEXT.ambition[selection.ambition]}, ${selection.guests} personer, ${UI_TEXT.readiness[selection.readiness]}`;
}

function winesForLocation(location) {
  return wines.filter(wine => {
    if (Number(wine.quantity ?? 1) <= 0) return false;
    if (location && location !== 'Alla' && wine.location !== location) return false;
    return true;
  });
}

function aiWinePlace(wine) {
  return wine.bin ? `${wine.location || ''} · fack ${wine.bin}` : (wine.location || '');
}

function aiRecommendationCard({ wine, motivation, servingAdvice }) {
  const place = aiWinePlace(wine);
  return `<article class="wine-card">
    <div class="wine-meta">${escapeHtml(wine.vintage)}${place ? ` · ${escapeHtml(place)}` : ''}</div>
    <h3>${escapeHtml(wine.producer)}</h3>
    <div class="cuvee">${escapeHtml(wine.cuvee)}</div>
    <p class="why">${escapeHtml(motivation)}</p>
    <div class="service">
      <div class="service-row"><span>Servera</span><span>${escapeHtml(servingAdvice)}</span></div>
    </div>
  </article>`;
}

function aiResultMarkup() {
  if (aiState.status === 'error') return `<div class="notice">${escapeHtml(aiState.error)}</div>`;
  if (aiState.status !== 'done' || !aiState.result) return '';
  const { recommendations, generalNote, dropped } = aiState.result;
  return `<div class="results" id="ai-results">${recommendations.map(aiRecommendationCard).join('')}</div>
    ${generalNote ? `<div class="chef-note">${escapeHtml(generalNote)}</div>` : ''}
    ${dropped > 0 ? `<div class="notice">(${dropped} förslag utan träff i källaren filtrerades bort)</div>` : ''}`;
}

function aiSommelierSection() {
  const settings = loadDeviceSettings();
  if (!settings.anthropicApiKey) return '';
  const loading = aiState.status === 'loading';
  return `<section class="section">
    <div class="section-heading">
      <div><p class="eyebrow">01b · Fråga sommelieren (AI)</p><h2>Beskriv maten med egna ord</h2></div>
      <p class="section-intro">Claude läser källaren – filtrerad på samma plats som ovan – och föreslår 1–3 flaskor med motivering och serveringsråd.</p>
    </div>
    <form class="selector-shell" id="ai-form">
      <div class="field"><label for="ai-food">Beskriv maten</label><textarea id="ai-food" name="foodText" placeholder="Beskriv maten — t.ex. 'grillade lammracks med rosmarin och svamp'">${escapeHtml(aiState.foodText)}</textarea></div>
      <div class="selector-actions">
        <div class="selector-hint">Sommelieren använder samma källarplats som redan är vald ovan.</div>
        <button class="primary" type="submit" ${loading ? 'disabled' : ''}>${loading ? 'Sommelieren tänker… (5–30 s)' : 'Fråga sommelieren'}</button>
      </div>
    </form>
    ${aiResultMarkup()}
  </section>`;
}

async function submitAiForm(form) {
  const foodText = String(new FormData(form).get('foodText') || '').trim();
  if (!foodText) { showToast('Beskriv maten först'); return; }
  const settings = loadDeviceSettings();
  aiState = { status: 'loading', foodText, result: null, error: '' };
  render();
  try {
    const locationLabel = selection.location && selection.location !== 'Alla' ? selection.location : 'Alla platser';
    const response = await askSommelier({
      apiKey: settings.anthropicApiKey,
      model: settings.anthropicModel,
      foodText,
      occasion: describeOccasion(),
      locationLabel,
      wines: winesForLocation(selection.location)
    });
    aiState = { status: 'done', foodText, result: response, error: '' };
    appendUsage({
      at: new Date().toISOString(),
      model: response.model,
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
      cacheCreation: response.usage?.cache_creation_input_tokens || 0,
      cacheRead: response.usage?.cache_read_input_tokens || 0
    });
  } catch (error) {
    aiState = { status: 'error', foodText, result: null, error: error.message || 'Sommelieren kunde inte svara just nu.' };
  }
  render();
}

function renderChoose() {
  const locations = uniqueLocations(wines);
  if (!locations.includes(selection.location)) selection.location = 'Alla';
  const context = `${UI_TEXT.food[selection.food]} · ${UI_TEXT.mood[selection.mood]} · ${UI_TEXT.ambition[selection.ambition]} · ${UI_TEXT.readiness[selection.readiness]}`;
  return `<div class="view">
    <section class="hero">
      <div>
        <p class="eyebrow">Privat vinbar · ${wines.length} flaskval</p>
        <h1>Välj inte vin.<em>Välj kväll.</em></h1>
        <p class="hero-copy">Menyn börjar med maten, stämningen och frågan som faktiskt spelar roll: <em>vad vore roligast att öppna just nu?</em></p>
      </div>
      <aside class="house-note">
        <strong>Husets filosofi</strong>
        <p>Högst tre förslag åt gången. Inga poäng och inga generiska svar. Bara flaskor som faktiskt finns, med servering och en konkret anledning att välja dem.</p>
      </aside>
    </section>

    <section class="section">
      <div class="section-heading">
        <div><p class="eyebrow">01 · Sommelieren</p><h2>Beställ efter kvällen</h2></div>
        <p class="section-intro">Väg ihop mat, temperament, ambitionsnivå, tid och antal personer. Platsen avgör vilka flaskor som över huvud taget får komma i fråga.</p>
      </div>
      <div class="preset-row" aria-label="Snabbval">
        <button class="pill" type="button" data-preset="fredag">Fredag vid köksön</button>
        <button class="pill" type="button" data-preset="sjotunga">Sjötunga meunière</button>
        <button class="pill" type="button" data-preset="alg">Älg, pommes &amp; béa</button>
        <button class="pill" type="button" data-preset="stor">Öppna något stort</button>
        <button class="pill" type="button" data-preset="random">Värdens överraskning</button>
      </div>
      <form class="selector-shell" id="selector-form">
        <div class="selector-grid">
          <div class="field"><label for="food">Vad äter vi?</label><select id="food" name="food">${selectorOptions(UI_TEXT.food, selection.food)}</select></div>
          <div class="field"><label for="mood">Vilken känsla?</label><select id="mood" name="mood">${selectorOptions(UI_TEXT.mood, selection.mood)}</select></div>
          <div class="field"><label for="ambition">Ambition</label><select id="ambition" name="ambition">${selectorOptions(UI_TEXT.ambition, selection.ambition)}</select></div>
          <div class="field"><label for="readiness">Hur mycket tid?</label><select id="readiness" name="readiness">${selectorOptions(UI_TEXT.readiness, selection.readiness)}</select></div>
          <div class="field"><label for="guests">Personer</label><select id="guests" name="guests">${selectorOptions({ 2: '2', 4: '4', 6: '6+' }, selection.guests)}</select></div>
        </div>
        <div class="selector-actions">
          <div class="field" style="min-width:220px"><label for="location">Källarplats</label><select id="location" name="location"><option value="Alla">Alla platser</option>${locations.map(location => `<option value="${escapeHtml(location)}" ${selection.location === location ? 'selected' : ''}>${escapeHtml(location)}</option>`).join('')}</select></div>
          <div class="selector-hint">Urvalet kommer endast från den privata källardatan på den här enheten och, när den är ansluten, Dropbox App Folder.</div>
          <button class="primary" type="submit">Visa kvällens tre</button>
        </div>
      </form>

      <div class="result-head"><h2>Sommelierens bord</h2><div class="result-context">${escapeHtml(context)}</div></div>
      <div class="results" id="results">${resultsMarkup()}</div>
      <div class="chef-note">Husets råd: öppna första förslaget om ni vill sluta välja. Tvåan är den mer klassiska vägen. Trean är den roliga avvikelsen.</div>
    </section>

    ${aiSommelierSection()}

    <section class="section">
      <div class="section-heading">
        <div><p class="eyebrow">02 · Fasta menyer</p><h2>Fyra kvällar som redan är lösta</h2></div>
        <p class="section-intro">Tryck på en meny för att fylla sommelierens bord. Samma urvalsmotor används, med den valda källarplatsen kvar.</p>
      </div>
      <div class="flight-grid">
        <button class="flight" type="button" data-preset="fredag"><small>Meny I · otvungen</small><h3>Fredag vid köksön</h3><p>Chips, mandlar, oliver och chark. Nerv, sälta och noll högtidlig tröskel.</p><span class="arrow">↗</span></button>
        <button class="flight" type="button" data-preset="sjotunga"><small>Meny II · klassisk</small><h3>Sjötunga meunière</h3><p>Smör, citron och fisk. Precision först, men tillräckligt mycket vin för hela rätten.</p><span class="arrow">↗</span></button>
        <button class="flight" type="button" data-preset="alg"><small>Meny III · generös</small><h3>Älg, pommes &amp; béa</h3><p>Mörkt kött, fett, örter och stekyta. Kraft med friskhet som mothåll.</p><span class="arrow">↗</span></button>
        <button class="flight" type="button" data-preset="stor"><small>Meny IV · högtidlig</small><h3>En flaska att minnas</h3><p>Tid, rätt glas och viljan att låta flaskan bli kvällens huvudperson.</p><span class="arrow">↗</span></button>
      </div>
    </section>
  </div>`;
}

function nowCard(wine) {
  const badgeText = wine.urgency > 0 ? URGENCY_LABELS[wine.urgency] : wine.window;
  const urgent = wine.urgency >= 3 || wine.ready === 'now';
  const note = wine.nowNote || wine.description || `${wine.region}. ${wine.location}.`;
  return `<article class="now-item">
    <div class="now-year">${escapeHtml(wine.vintage)}</div>
    <div><div class="now-name">${escapeHtml(wine.producer)} · ${escapeHtml(wine.cuvee)}</div><div class="now-note">${escapeHtml(note)}</div></div>
    <div class="now-actions">
      <div class="status ${urgent ? 'urgent' : ''}">${escapeHtml(badgeText)}</div>
      <button class="icon-button" type="button" data-edit-now="${escapeHtml(wine.id)}" aria-label="Redigera">✎</button>
    </div>
  </article>`;
}

function nowEditForm(wine) {
  const id = escapeHtml(wine.id);
  const urgencyOptions = [0, 1, 2, 3].map(value =>
    `<option value="${value}" ${Number(wine.urgency) === value ? 'selected' : ''}>${value === 0 ? 'Ingen märkning' : escapeHtml(URGENCY_LABELS[value])}</option>`
  ).join('');
  return `<form class="now-item now-item-editing" data-now-form="${id}">
    <div class="now-year">${escapeHtml(wine.vintage)}</div>
    <div class="now-edit-fields">
      <div class="now-name">${escapeHtml(wine.producer)} · ${escapeHtml(wine.cuvee)}</div>
      <div class="field"><label for="now-note-${id}">Anteckning</label><textarea id="now-note-${id}" name="nowNote" placeholder="Redaktionell notis om varför/när">${escapeHtml(wine.nowNote)}</textarea></div>
      <div class="field"><label for="now-urgency-${id}">Märkning</label><select id="now-urgency-${id}" name="urgency">${urgencyOptions}</select></div>
      <div class="panel-actions">
        <button class="primary" type="submit">Spara</button>
        <button class="secondary" type="button" data-cancel-now="${id}">Avbryt</button>
      </div>
    </div>
  </form>`;
}

function renderReady() {
  const candidates = readyNow(wines, 14);
  return `<div class="view">
    <header class="page-heading"><p class="eyebrow">Drickfönster</p><h1>Vad vore synd att glömma?</h1><p>En vänlig hylla längst fram: flaskor som är redo eller öppnar sig fint med luft, där mer väntan inte självklart gör kvällen bättre.</p></header>
    <div class="now-grid">${candidates.map(wine => wine.id === editingNowId ? nowEditForm(wine) : nowCard(wine)).join('') || '<div class="notice">Inga drickfönster finns i den importerade datan ännu.</div>'}</div>
  </div>`;
}

async function submitNowForm(form, id) {
  const wine = wines.find(item => item.id === id);
  editingNowId = null;
  if (!wine) { render(); return; }
  const data = new FormData(form);
  const nowNote = String(data.get('nowNote') || '').trim();
  const urgency = Math.max(0, Math.min(3, Math.round(Number(data.get('urgency'))) || 0));
  await repository.setField('wine', id, 'data', { ...wine, nowNote, urgency });
  refreshWines();
  if (hasActiveDropboxSession()) await synchronize();
  render();
  showToast('Ändringen sparad');
}

function renderCellar() {
  const categories = ['Alla', ...CATEGORY_ORDER.filter(category => wines.some(wine => wine.category === category))];
  const needle = cellarFilter.search.toLocaleLowerCase('sv');
  const visible = wines.filter(wine => {
    const categoryMatch = cellarFilter.category === 'Alla' || wine.category === cellarFilter.category;
    const haystack = [wine.producer, wine.cuvee, wine.vintage, wine.region, wine.location].join(' ').toLocaleLowerCase('sv');
    return categoryMatch && (!needle || haystack.includes(needle));
  });
  const grouped = categories.filter(category => category !== 'Alla').map(category => [category, visible.filter(wine => wine.category === category)]).filter(([, rows]) => rows.length);
  return `<div class="view">
    <header class="page-heading"><p class="eyebrow">Den tryckta vinmenyn</p><h1>Källaren</h1><p>Ett kuraterat restaurangurval ur den privata masterfilen. Unga framtidsflaskor finns kvar, men är tydligt markerade.</p></header>
    <div class="toolbar">
      <div class="field"><label for="cellar-search">Sök i källaren</label><input id="cellar-search" type="search" value="${escapeHtml(cellarFilter.search)}" placeholder="Producent, vin, årgång eller plats"></div>
      <button class="secondary" type="button" data-print>Skriv ut menyn</button>
    </div>
    <div class="filter-row">${categories.map(category => `<button class="filter-button ${cellarFilter.category === category ? 'active' : ''}" type="button" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`).join('')}</div>
    <div class="menu-columns">${grouped.map(([category, rows]) => `<section class="menu-category"><h2>${escapeHtml(category)}</h2>${rows.map(wine => `<div class="menu-row">
      <div class="menu-vintage">${escapeHtml(wine.vintage)}</div>
      <div class="menu-name"><strong>${escapeHtml(wine.producer)}</strong><br>${escapeHtml(wine.cuvee)}${wine.location ? ` · ${escapeHtml(wine.location)}` : ''}</div>
      <div class="menu-window">${escapeHtml(wine.window)}</div>
    </div>`).join('')}</section>`).join('') || '<div class="notice">Inga viner matchar sökningen.</div>'}</div>
  </div>`;
}

function aiSettingsPanel() {
  const settings = loadDeviceSettings();
  const usage = usageSummary();
  return `<section class="panel">
    <h2>AI-sommelier</h2>
    <p>Claude föreslår flaskor ur din egen källare direkt i webbläsaren. Anropet går från din enhet till Anthropics API.</p>
    <form id="ai-settings-form">
      <div class="field"><label for="ai-api-key">Anthropic API-nyckel</label><input id="ai-api-key" name="anthropicApiKey" type="password" autocomplete="off" placeholder="${settings.anthropicApiKey ? '•••• (sparad)' : 'Klistra in API-nyckel'}"></div>
      <div class="field"><label for="ai-model">Modell</label><select id="ai-model" name="anthropicModel">${selectorOptions(SOMMELIER_MODELS, settings.anthropicModel)}</select></div>
      <div class="panel-actions">
        <button class="primary" type="submit">Spara</button>
        <button class="secondary" type="button" data-clear-api-key>Rensa nyckel</button>
      </div>
    </form>
    <div class="stat-line"><span>AI-användning</span><strong>${usage.calls} anrop · ${usage.inputTokens}/${usage.outputTokens} tokens · ca ${usage.estimatedSek} kr (ungefärligt)</strong></div>
    <p class="notice">Nyckeln lagras endast på den här enheten. Den synkas aldrig till Dropbox, följer aldrig med JSON-exporten och publiceras aldrig.</p>
  </section>`;
}

function formatCtLastFetch() {
  const raw = Number(localStorage.getItem('vinkallaren:ct-last-fetch') || 0);
  return raw ? new Date(raw).toLocaleString('sv-SE') : 'aldrig';
}

function ctSettingsPanel() {
  const settings = loadDeviceSettings();
  const ready = Boolean(settings.ctWorkerUrl && settings.ctUser && settings.ctPassword);
  const loading = ctState.status === 'loading';
  return `<section class="panel">
    <h2>CellarTracker (live)</h2>
    <p>Hämta källardata direkt från CellarTracker via en egen Cloudflare Worker-proxy (se <code>worker/README.md</code>). Kuraterade fält som nivå, beskrivning och matkopplingar skrivs aldrig över.</p>
    <form id="ct-settings-form">
      <div class="field"><label for="ct-worker-url">Worker-URL</label><input id="ct-worker-url" name="ctWorkerUrl" type="text" value="${escapeHtml(settings.ctWorkerUrl)}" placeholder="https://vinkallaren-ct.ditt-konto.workers.dev"></div>
      <div class="field"><label for="ct-worker-secret">Delad hemlighet</label><input id="ct-worker-secret" name="ctWorkerSecret" type="password" autocomplete="off" placeholder="${settings.ctWorkerSecret ? '•••• (sparad)' : 'Valfri delad hemlighet'}"></div>
      <div class="field"><label for="ct-user">CT-användarnamn</label><input id="ct-user" name="ctUser" type="text" value="${escapeHtml(settings.ctUser)}" placeholder="CellarTracker-användarnamn"></div>
      <div class="field"><label for="ct-password">CT-lösenord</label><input id="ct-password" name="ctPassword" type="password" autocomplete="off" placeholder="${settings.ctPassword ? '•••• (sparad)' : 'CellarTracker-lösenord'}"></div>
      <label style="display:flex;align-items:center;gap:8px;margin:14px 0;font-size:13px;color:var(--ink);cursor:pointer">
        <input type="checkbox" name="ctAutoRefresh" ${settings.ctAutoRefresh ? 'checked' : ''} style="width:auto;min-height:auto">
        Uppdatera automatiskt vid appstart (äldre än 24 h)
      </label>
      <div class="panel-actions">
        <button class="primary" type="submit">Spara</button>
        <button class="secondary" type="button" data-ct-refresh ${!ready || loading ? 'disabled' : ''}>${loading ? 'Hämtar…' : 'Uppdatera från CellarTracker'}</button>
      </div>
    </form>
    <div class="stat-line"><span>Senast hämtad</span><strong>${formatCtLastFetch()}</strong></div>
    <p class="notice">CT-uppgifterna lagras endast på den här enheten och skickas bara till din egen worker.</p>
  </section>`;
}

function renderSettings() {
  const totalBottles = wines.reduce((sum, wine) => sum + Number(wine.quantity || 0), 0);
  const locations = uniqueLocations(wines);
  const configured = dropboxConfigured();
  return `<div class="view">
    <header class="page-heading"><p class="eyebrow">Lokal först · privat synk</p><h1>Inställningar</h1><p>Precis som Packa sparar Vinkällaren först på enheten. Den publika appen innehåller ingen privat vinlista.</p></header>
    <div class="settings-grid">
      <section class="panel">
        <h2>Dropbox</h2>
        <p>Synka oföränderliga operationer via en separat Dropbox App Folder. OAuth använder PKCE; ingen app-hemlighet lagras i appen. En refresh-token sparas lokalt på den här enheten så anslutningen håller sig inloggad över omladdningar.</p>
        <div class="stat-line"><span>Status</span><strong>${escapeHtml(syncLabel)}</strong></div>
        <div class="stat-line"><span>Appnyckel</span><strong>${configured ? 'Konfigurerad' : 'Återstår'}</strong></div>
        ${hasActiveDropboxSession() ? '<div class="stat-line"><span>Anslutning</span><strong>Ansluten — håller sig inloggad</strong></div>' : ''}
        <div class="panel-actions">
          ${hasActiveDropboxSession()
            ? '<button class="primary" type="button" data-dropbox-sync>Synka nu</button><button class="secondary" type="button" data-dropbox-disconnect>Koppla från</button>'
            : `<button class="primary" type="button" data-dropbox-connect ${configured ? '' : 'disabled'}>Anslut Dropbox</button>`}
        </div>
        ${configured ? '' : '<p class="notice">Skapa först Dropbox-appen Vinkällaren och lägg dess publika appnyckel i <code>src/dropbox-live.js</code>.</p>'}
      </section>
      ${aiSettingsPanel()}
      ${ctSettingsPanel()}
      <section class="panel">
        <h2>Privat data</h2>
        <p>Importera Vinkällarens JSON-master eller en CellarTracker-export i CSV-format. Importen sparas i IndexedDB och följer därefter Dropbox-synken.</p>
        <div class="stat-line"><span>Viner</span><strong>${wines.length}</strong></div>
        <div class="stat-line"><span>Flaskor</span><strong>${totalBottles}</strong></div>
        <div class="stat-line"><span>Platser</span><strong>${locations.length}</strong></div>
        <div class="panel-actions">
          <label class="secondary" for="data-file" style="display:inline-flex;align-items:center">Importera fil</label>
          <input class="file-input" id="data-file" type="file" accept=".json,.csv,application/json,text/csv">
          <button class="secondary" type="button" data-export>Exportera JSON</button>
        </div>
      </section>
      <section class="panel">
        <h2>Installera</h2>
        <p>När appen körs över HTTPS kan den läggas på hemskärmen på iPhone och installeras som app på Mac. Appskalet fungerar offline efter första besöket.</p>
        <p class="notice">Service Worker fungerar inte från <code>file://</code>. Kör appen via lokal webbserver eller den framtida HTTPS-adressen.</p>
      </section>
      <section class="panel">
        <h2>Datagräns</h2>
        <p>Publiceringsbygget stoppar JSON-master, kalkylblad, databaser, testfiler och hela <code>private/</code>-mappen. Bara appskalet får publiceras.</p>
        <div class="stat-line"><span>Lokal databas</span><strong>vinkallaren-live-v1</strong></div>
        <div class="stat-line"><span>Synkformat</span><strong>Fältvis LWW · HLC</strong></div>
      </section>
    </div>
  </div>`;
}

function renderEmpty() {
  return `<div class="view"><section class="panel empty-state">
    <p class="eyebrow">Privat och datafri från start</p>
    <h1>Källaren väntar på sin master</h1>
    <p>Importera den privata startfilen eller anslut Dropbox. Ingen vinlista följer med det publika appskalet.</p>
    <div class="empty-actions">
      <label class="primary" for="data-file-empty" style="display:inline-flex;align-items:center">Importera data</label>
      <input class="file-input" id="data-file-empty" type="file" accept=".json,.csv,application/json,text/csv">
      <a class="secondary" href="#installningar">Visa inställningar</a>
    </div>
  </section></div>`;
}

function render() {
  const view = currentView();
  updateNavigation(view);
  if (view !== 'oppna') editingNowId = null;
  if (!wines.length && view !== 'installningar') app.innerHTML = renderEmpty();
  else if (view === 'valj') app.innerHTML = renderChoose();
  else if (view === 'oppna') app.innerHTML = renderReady();
  else if (view === 'kallaren') app.innerHTML = renderCellar();
  else app.innerHTML = renderSettings();
}

function randomPreset() {
  const choices = Object.keys(PRESETS);
  return PRESETS[choices[Math.floor(Math.random() * choices.length)]];
}

function applyPreset(name) {
  selection = { ...selection, ...(name === 'random' ? randomPreset() : PRESETS[name]) };
  saveSelection();
  render();
  document.getElementById('results')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  showToast('Sommelierens bord är uppdaterat');
}

async function handleFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const master = file.name.toLowerCase().endsWith('.csv')
      ? cellarTrackerCsvToMaster(text)
      : validateMaster(JSON.parse(text));
    await importMaster(master);
  } catch (error) {
    showToast(error.message || 'Filen kunde inte importeras');
  }
}

function exportData() {
  const master = createMaster(wines, { source: 'indexeddb-export' });
  const blob = new Blob([`${JSON.stringify(master, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `vinkallaren-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

app.addEventListener('click', async event => {
  const preset = event.target.closest('[data-preset]');
  if (preset) return applyPreset(preset.dataset.preset);
  const category = event.target.closest('[data-category]');
  if (category) { cellarFilter.category = category.dataset.category; render(); return; }
  if (event.target.closest('[data-print]')) { window.print(); return; }
  if (event.target.closest('[data-export]')) { exportData(); return; }
  const editNow = event.target.closest('[data-edit-now]');
  if (editNow) { editingNowId = editNow.dataset.editNow; render(); return; }
  const cancelNow = event.target.closest('[data-cancel-now]');
  if (cancelNow) { editingNowId = null; render(); return; }
  if (event.target.closest('[data-clear-api-key]')) {
    clearSecret('anthropicApiKey');
    render();
    showToast('API-nyckeln borttagen');
    return;
  }
  if (event.target.closest('[data-dropbox-connect]')) {
    setSyncStatus('syncing', 'Ansluter…');
    try { await beginDropboxLive(); }
    catch (error) { setSyncStatus('action', 'Åtgärd krävs'); showToast(error.message); }
    return;
  }
  if (event.target.closest('[data-dropbox-disconnect]')) {
    liveSyncGeneration += 1;
    disconnectDropbox();
    setSyncStatus('local', 'Lokalt sparat');
    render();
    showToast('Dropbox frånkopplad');
    return;
  }
  if (event.target.closest('[data-dropbox-sync]')) {
    try {
      const result = await synchronize();
      showToast(result ? `Synkad · ${result.uploadedOps || 0} upp · ${result.downloadedOps || 0} ned` : 'Synkar redan…');
    }
    catch (error) { showToast(error.message || 'Synken misslyckades'); }
  }
  if (event.target.closest('[data-ct-refresh]')) {
    await refreshFromCellarTracker();
  }
});

app.addEventListener('submit', async event => {
  if (event.target.id === 'selector-form') {
    event.preventDefault();
    selection = { ...selection, ...Object.fromEntries(new FormData(event.target).entries()) };
    saveSelection();
    render();
    showToast('Tre flaskor valda');
    return;
  }
  if (event.target.id === 'ai-form') {
    event.preventDefault();
    await submitAiForm(event.target);
    return;
  }
  if (event.target.id === 'ai-settings-form') {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    const patch = { anthropicModel: data.anthropicModel };
    if (data.anthropicApiKey) patch.anthropicApiKey = data.anthropicApiKey.trim();
    saveDeviceSettings(patch);
    render();
    showToast('Inställningar sparade');
  }
  if (event.target.id === 'ct-settings-form') {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    const patch = {
      ctWorkerUrl: String(data.ctWorkerUrl || '').trim(),
      ctAutoRefresh: Boolean(data.ctAutoRefresh)
    };
    if (data.ctWorkerSecret) patch.ctWorkerSecret = data.ctWorkerSecret.trim();
    if (data.ctUser) patch.ctUser = data.ctUser.trim();
    if (data.ctPassword) patch.ctPassword = data.ctPassword.trim();
    saveDeviceSettings(patch);
    render();
    showToast('CellarTracker-inställningar sparade');
  }
  if (event.target.dataset.nowForm) {
    event.preventDefault();
    await submitNowForm(event.target, event.target.dataset.nowForm);
    return;
  }
});

app.addEventListener('input', event => {
  if (event.target.id === 'cellar-search') {
    cellarFilter.search = event.target.value;
    const caret = event.target.selectionStart;
    render();
    const input = document.getElementById('cellar-search');
    input?.focus();
    input?.setSelectionRange(caret, caret);
  }
});

app.addEventListener('change', event => {
  if (['data-file', 'data-file-empty'].includes(event.target.id)) handleFile(event.target.files?.[0]);
});

document.addEventListener('click', event => {
  if (event.target.closest('[data-sync-action]')) location.hash = '#installningar';
});

window.addEventListener('hashchange', render);

// Medan appen ligger i bakgrunden är det ingen idé att hålla en longpoll öppen.
// Så fort fliken blir synlig igen: kör en vanlig synk (fångar upp ändringar som
// hänt medan den var gömd) och starta om longpoll-loopen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && hasActiveDropboxSession()) {
    synchronize().catch(() => {});
    runLiveSyncLoop();
  } else {
    liveSyncGeneration += 1;
  }
});

async function boot() {
  try {
    repository = await openLiveRepository();
    refreshWines();
    const dropboxCallback = isDropboxCallback();
    if (dropboxCallback) {
      setSyncStatus('syncing', 'Hämtar från Dropbox…');
      await completeDropboxLive({ repository });
      refreshWines();
      setSyncStatus('synced', 'Synkad');
      showToast('Dropbox ansluten och synkad');
    } else if (hasActiveDropboxSession()) {
      // Anslutningen finns kvar sedan tidigare (lagrad refresh-token) — synchronize()
      // längre ned tar statusen vidare till 'Synkar…'/'Synkad'.
      setSyncStatus('local', 'Ansluten — synkar…');
    } else {
      setSyncStatus('local', dropboxConfigured() ? 'Dropbox ej ansluten' : 'Lokalt sparat');
    }
    await loadPrivateSeedIfAvailable();
    if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#valj`);
    render();
    if (hasActiveDropboxSession()) {
      // Efter en färsk OAuth-anslutning har completeDropboxLive redan synkat en gång —
      // hoppa bara över den extra synchronize() då, men starta longpoll-loopen i båda fallen.
      if (!dropboxCallback) synchronize().catch(() => {});
      runLiveSyncLoop();
    }
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js?v=20260716-3').catch(() => {});
    }
    const deviceSettings = loadDeviceSettings();
    const ctReady = Boolean(deviceSettings.ctWorkerUrl && deviceSettings.ctUser && deviceSettings.ctPassword);
    const ctStale = Date.now() - Number(localStorage.getItem('vinkallaren:ct-last-fetch') || 0) > 24 * 3600 * 1000;
    if (deviceSettings.ctAutoRefresh && ctReady && ctStale) {
      refreshFromCellarTracker({ silent: true }).catch(() => {});
    }
  } catch (error) {
    setSyncStatus('action', 'Åtgärd krävs');
    app.innerHTML = `<div class="view"><section class="panel empty-state"><h1>Appen kunde inte starta</h1><p>${escapeHtml(error.message)}</p></section></div>`;
  }
}

boot();
