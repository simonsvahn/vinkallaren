import {
  beginDropboxLive,
  completeDropboxLive,
  dropboxConfigured,
  hasActiveDropboxSession,
  isDropboxCallback,
  openLiveRepository,
  syncActiveDropboxSession
} from './dropbox-live.js?v=20260715-4';
import { cellarTrackerCsvToMaster, createMaster, validateMaster } from './importers.js';
import {
  CATEGORY_ORDER,
  PRESETS,
  UI_TEXT,
  rankWines,
  readyNow,
  recommendationReason,
  uniqueLocations
} from './scoring.js';

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
  if (!hasActiveDropboxSession()) return null;
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

function renderReady() {
  const candidates = readyNow(wines, 14);
  return `<div class="view">
    <header class="page-heading"><p class="eyebrow">Drickfönster</p><h1>Vad vore synd att glömma?</h1><p>En vänlig hylla längst fram: flaskor som är redo eller öppnar sig fint med luft, där mer väntan inte självklart gör kvällen bättre.</p></header>
    <div class="now-grid">${candidates.map(wine => `<article class="now-item">
      <div class="now-year">${escapeHtml(wine.vintage)}</div>
      <div><div class="now-name">${escapeHtml(wine.producer)} · ${escapeHtml(wine.cuvee)}</div><div class="now-note">${escapeHtml(wine.description || `${wine.region}. ${wine.location}.`)}</div></div>
      <div class="status ${wine.ready === 'now' ? 'urgent' : ''}">${escapeHtml(wine.window)}</div>
    </article>`).join('') || '<div class="notice">Inga drickfönster finns i den importerade datan ännu.</div>'}</div>
  </div>`;
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

function renderSettings() {
  const totalBottles = wines.reduce((sum, wine) => sum + Number(wine.quantity || 0), 0);
  const locations = uniqueLocations(wines);
  const configured = dropboxConfigured();
  return `<div class="view">
    <header class="page-heading"><p class="eyebrow">Lokal först · privat synk</p><h1>Inställningar</h1><p>Precis som Packa sparar Vinkällaren först på enheten. Den publika appen innehåller ingen privat vinlista.</p></header>
    <div class="settings-grid">
      <section class="panel">
        <h2>Dropbox</h2>
        <p>Synka oföränderliga operationer via en separat Dropbox App Folder. OAuth använder PKCE; ingen app-hemlighet eller långlivad token lagras i appen.</p>
        <div class="stat-line"><span>Status</span><strong>${escapeHtml(syncLabel)}</strong></div>
        <div class="stat-line"><span>Appnyckel</span><strong>${configured ? 'Konfigurerad' : 'Återstår'}</strong></div>
        <div class="panel-actions">
          ${hasActiveDropboxSession()
            ? '<button class="primary" type="button" data-dropbox-sync>Synka nu</button>'
            : `<button class="primary" type="button" data-dropbox-connect ${configured ? '' : 'disabled'}>Anslut Dropbox</button>`}
        </div>
        ${configured ? '' : '<p class="notice">Skapa först Dropbox-appen Vinkällaren och lägg dess publika appnyckel i <code>src/dropbox-live.js</code>.</p>'}
      </section>
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
  if (event.target.closest('[data-dropbox-connect]')) {
    setSyncStatus('syncing', 'Ansluter…');
    try { await beginDropboxLive(); }
    catch (error) { setSyncStatus('action', 'Åtgärd krävs'); showToast(error.message); }
    return;
  }
  if (event.target.closest('[data-dropbox-sync]')) {
    try { const result = await synchronize(); showToast(`Synkad · ${result?.uploadedOps || 0} upp · ${result?.downloadedOps || 0} ned`); }
    catch (error) { showToast(error.message || 'Synken misslyckades'); }
  }
});

app.addEventListener('submit', event => {
  if (event.target.id !== 'selector-form') return;
  event.preventDefault();
  selection = { ...selection, ...Object.fromEntries(new FormData(event.target).entries()) };
  saveSelection();
  render();
  showToast('Tre flaskor valda');
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

async function boot() {
  try {
    repository = await openLiveRepository();
    refreshWines();
    if (isDropboxCallback()) {
      setSyncStatus('syncing', 'Hämtar från Dropbox…');
      await completeDropboxLive({ repository });
      refreshWines();
      setSyncStatus('synced', 'Synkad');
      showToast('Dropbox ansluten och synkad');
    } else {
      setSyncStatus('local', dropboxConfigured() ? 'Dropbox ej ansluten' : 'Lokalt sparat');
    }
    await loadPrivateSeedIfAvailable();
    if (!location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#valj`);
    render();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('./sw.js?v=20260715-4').catch(() => {});
    }
  } catch (error) {
    setSyncStatus('action', 'Åtgärd krävs');
    app.innerHTML = `<div class="view"><section class="panel empty-state"><h1>Appen kunde inte starta</h1><p>${escapeHtml(error.message)}</p></section></div>`;
  }
}

boot();
