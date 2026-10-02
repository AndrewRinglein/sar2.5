import { esc, usd as centsUsd } from '../lib/fmt.js';
import { serverRequest } from '../lib/server-request.js';
import { markets, inMarket, enrollmentLabel, MARKET_RADIUS_MILES } from '../lib/competitive-markets.js';
import { coverage } from '../lib/competitive-coverage.js';
import { defaults, evidenceFor, business, projection, proximity, FEATURES, safeUrl, payoutBand } from '../lib/competitive-model.js';

const node = (tag, cls, html) => { const e = document.createElement(tag); e.className = cls || ''; if (html !== undefined) e.innerHTML = html; return e; };
// Scout/collector values are dollars; SAR's shared formatter accepts cents.
const usd = dollars => centsUsd(dollars * 100);
const link = (url, title) => safeUrl(url) ? `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${esc(title)} ↗</a>` : '';
const money = n => Number.isFinite(n) && n > 0 ? usd(n) : 'Unknown';
const STORE = 'sar2-competitive-scenarios-v1';
const categoryLabel=h=>(h.category||'Type not yet classified').replaceAll('_',' ');
const statusLabel=h=>/uncertain|confirmation|unresolved/.test(h.operatingStatus||'')?'Needs confirmation':(h.operatingStatus||'Current operation not verified').replaceAll('_',' ');
const timeLabel = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' Pacific' : 'unknown';
function saved() { try { const value=JSON.parse(localStorage.getItem(STORE) || '{}'); return value && typeof value==='object' && !Array.isArray(value) ? value : {}; } catch { return {}; } }

export function renderCompetition({ request = serverRequest, params = {}, onNavigate, setInspectorContent = () => {} } = {}) {
  const root = node('div', 'screen competition');
  const header = node('header', 'screen-head', '<h2>Bingo Scout</h2><p>Competitive programs, promotions and payout scenarios</p>');
  const status = node('p', 'dim', 'Loading the California collection…');
  const controls = node('div', 'scout-controls');
  const body = node('div');
  root.append(header, status, controls, body);
  let snapshot, selected = params.hall || '', tab = params.area ? 'map' : 'areas', market = markets.some(m=>m.id===params.area) ? params.area : 'bay-area', origin = '', query = '', day = '',
    maxMinutes = 120, minOverlap = 0, band = '', historical = false, map, mapGeneration = 0, loadGeneration = 0;
  const histories = new Map(), historyBusy = new Set(), historyError = new Map(), scenarios = saved();
  const maps = new Set();
  const clearMaps=()=>{for(const instance of maps)instance.remove();maps.clear();map=null;};
  let disposed = false;
  root.dispose = () => { disposed=true; mapGeneration++; clearMaps(); };
  const cfgFor = id => { const existing=scenarios[id]; return scenarios[id]={...defaults(),...(existing && typeof existing==='object'?existing:{}),features:existing?.features && typeof existing.features==='object'?existing.features:{}}; };
  const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(scenarios)); } catch { status.textContent = 'Scenario could not be saved in this browser. Export it to keep a copy.'; } };
  const halls = () => (snapshot?.halls || []).filter(h => !h.excludedFromCoverage && !h.duplicateOf);
  const allEvidence = hall => evidenceFor(hall, histories.get(hall.id)?.messages || snapshot?.summaries?.find(s => s.hallId === hall.id)?.latest && [snapshot.summaries.find(s => s.hallId === hall.id).latest] || []);
  const countFor = id => snapshot?.summaries?.find(s => s.hallId === id)?.count || 0;
  const sourceValue = h => {
    const cfg = scenarios[h.id];
    if (cfg?.payout && business(cfg)) return Number(cfg.payout);
    // Only a published explicit total can classify an unreviewed hall. A partial subtotal is not its program size.
    return allEvidence(h).find(e => e.advertisedTotal > 0)?.advertisedTotal ?? null;
  };
  function button(label, fn, active = false) { const b = node('button', active ? 'chip is-active' : 'chip'); b.textContent = label; b.type = 'button'; b.onclick = fn; return b; }
  function selectControl(label, values, value, change) {
    const l = node('label'); l.append(document.createTextNode(label));
    const s = node('select'); s.setAttribute('aria-label', label);
    for (const [v, name] of values) { const o = node('option'); o.value = v; o.textContent = name; s.append(o); }
    s.value = value; s.onchange = () => change(s.value); l.append(s); return l;
  }
  function input(label, value, change, { type = 'number', min, max, step = 'any' } = {}) {
    const l = node('label'); l.append(document.createTextNode(label)); const i = node('input');
    i.type = type; i.value = value; i.setAttribute('aria-label', label);
    if (type === 'number') { i.step = step; if (min !== undefined) i.min = min; if (max !== undefined) i.max = max; }
    let committed = String(value);
    const commit = () => { if (i.value !== committed) { committed=i.value; change(i.value); } };
    i.onchange = commit; i.onblur = commit; l.append(i); return l;
  }
  function choose(id) { selected = id; tab = 'evidence'; draw(); loadHistory(id); }
  function openArea(id) {
    if(onNavigate){onNavigate('competition',{area:id});return;}
    market=id;origin='';selected='';query='';day='';band='';maxMinutes=120;minOverlap=0;historical=false;tab='map';draw();
  }
  async function loadHistory(id, more = false) {
    if (historyBusy.has(id) || histories.has(id) && !more) return;
    const old = histories.get(id)?.messages || [];
    historyBusy.add(id); historyError.delete(id); draw();
    try {
      const page = await request(`/api/competitive?hall=${encodeURIComponent(id)}&offset=${more ? old.length : 0}`);
      histories.set(id, { messages: more ? [...old, ...page.messages] : page.messages, hasMore: page.hasMore });
    } catch { historyError.set(id, 'Message history is unavailable. Retry to load it.'); }
    finally { historyBusy.delete(id); if (selected === id) draw(); }
  }
  function draw() {
    if (!snapshot || disposed) return;
    mapGeneration++; clearMaps();
    controls.replaceChildren(); body.replaceChildren();
    const filters = node('div', 'scout-filters');
    filters.append(button('All area maps',()=>{tab='areas';draw();},tab==='areas'));
    filters.append(selectControl('Area', markets.map(m => [m.id,m.name]), market, openArea));
    filters.append(selectControl('Hall', [['','Choose a hall'], ...halls().filter(h => inMarket(h,market)).map(h => [h.id,h.name])], selected, choose));
    filters.append(button('Refresh collection', refresh));
    controls.append(filters);
    if(tab==='areas'){renderAreaMaps();return;}
    const tabs = node('nav', 'scout-tabs'); tabs.setAttribute('aria-label', 'Competitive views');
    for (const [id,title] of [['map','Map'],['evidence','Program evidence'],['business','Business model'],['projection','Projection']]) {
      tabs.append(button(title, () => { tab = id; draw(); if (selected && id === 'evidence') loadHistory(selected); }, id === tab));
    }
    controls.append(tabs);
    if (tab === 'map') return renderMap();
    const hall = halls().find(h => h.id === selected);
    if (!hall) { body.append(node('p', 'placeholder', 'Choose a hall to examine its evidence and model.')); return; }
    const intro = node('section', 'panel', `<h3>${esc(hall.name)}</h3><p>${esc(hall.address || 'Address not verified')}</p><p>${esc(categoryLabel(hall))} · ${esc(statusLabel(hall))}</p><p>${esc(hall.schedule?.days?.join(', ') || 'Days not verified')} · ${link(hall.website,'Website')}</p>`);
    body.append(intro);
    if (/vanguard/i.test(hall.name)) intro.insertAdjacentHTML('beforeend','<p><a href="#/venues">Compare recorded Vanguard results in SAR →</a></p>');
    setInspectorContent(`<h3>${esc(hall.name)}</h3><p>${esc(enrollmentLabel(hall))}</p><p>${countFor(hall.id)} promotional updates collected.</p><p>SMS and email are evidence of advertised offers, not actual sales or payouts.</p>`);
    if (tab === 'evidence') renderEvidence(hall);
    else renderModel(hall);
  }
  function renderAreaMaps() {
    body.append(node('h3','', 'Your competitive maps'));
    body.append(node('p','dim','Each map covers a 50-mile straight-line radius from its area center. Open a map to compare halls, review texts and emails, and model payouts. Overlapping areas can include the same hall.'));
    const grid=node('div','scout-area-grid');
    for(const id of ['salinas','north-bay','sacramento','hawaiian-gardens','bay-area']){
      const region=markets.find(m=>m.id===id);
      const rows=halls().filter(h=>inMarket(h,id)&&!/closed|historical|legacy|suspended/i.test(`${h.name} ${h.operatingStatus||''} ${h.researchStatus||''}`)).map(h=>({h,p:null}));
      const missing=rows.filter(({h})=>!h.location).length;
      const card=node('section','panel scout-area-card');card.setAttribute('aria-label',`${region.name} map`);
      const heading=node('div','scout-area-heading');heading.append(node('h3','',esc(region.name)),button(`Open ${region.name} map`,()=>openArea(id)));
      card.append(heading,node('p','dim',`${rows.length} program listings · ${missing} need coordinates · 50-mile radius`));
      card.append(coveragePanel(id,false));
      const host=node('div','scout-map scout-area-map');host.setAttribute('aria-label',`${region.name} competitive map`);card.append(host);
      if(id==='bay-area')card.append(node('p','dim','Includes Santa Clara Vanguard and Redwood City Vanguard as separate locations.'));
      grid.append(card);mountMap(host,rows,null,mapGeneration,id,true);
    }
    body.append(grid,node('p','dim','Maps use the current collected directory. Coverage is still being verified; halls without coordinates remain available in each area’s list.'));
  }
  function coveragePanel(id,expanded=true){
    const places=coverage.places.filter(p=>id==='california'||p.areas.includes(id));
    const searched=places.filter(p=>p.status==='discovery_searched').length;
    const google=places.filter(p=>p.googleStatus==='searched').length;
    const box=node(expanded?'details':'div','scout-coverage');
    box.append(node(expanded?'summary':'p','dim',`City discovery: ${searched} / ${places.length} places searched · ${google} on Google · ${places.length-searched} pending`));
    if(!expanded)return box;
    box.append(node('p','dim',`Checked ${coverage.checkedAt}. Includes cities and Census-designated communities whose representative point is within 50 miles. A search does not establish complete hall coverage. Remaining Google searches are pending; the Google tab is paused at a CAPTCHA and web search reached a rate limit.`));
    const table=node('table','cat-table');table.innerHTML='<thead><tr><th>City / community</th><th>Discovery</th><th>Google</th></tr></thead>';
    const tbody=node('tbody');
    for(const p of places.slice().sort((a,b)=>a.name.localeCompare(b.name))){
      tbody.append(node('tr','',`<td>${link(p.searchUrl,p.name)}<small>${esc(p.kind)}</small></td><td>${p.status==='discovery_searched'?'Initial query searched':'Pending'}</td><td>${p.googleStatus==='searched'?'Searched':'Pending'}</td>`));
    }
    table.append(tbody);const scroll=node('div','scout-coverage-list');scroll.append(table);box.append(scroll);return box;
  }
  function renderMap() {
    body.append(node('h3','scout-area-title',esc(markets.find(m=>m.id===market).name)+' competitive map'));
    if(market!=='california')body.append(node('p','dim','The dashed boundary is 50 straight-line miles from this area’s center. Listings without hall coordinates are included by city and are not pinned.'));
    body.append(coveragePanel(market));
    const filters = node('div', 'scout-filters');
    filters.append(selectControl('Comparison origin', [['','Area overview'],...halls().filter(h => h.location && inMarket(h,market)).map(h => [h.id,h.name])], origin, v => { origin=v; draw(); }));
    filters.append(input('Search halls', query, v => { query=v; draw(); }, { type: 'search' }));
    filters.append(selectControl('Operating day', [['','All days'],...['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(d => [d,d])], day, v => { day=v; draw(); }));
    filters.append(selectControl('Payout band', ['', 'Major','Large','Medium','Small','Very small','Unknown'].map(v => [v,v || 'All bands']), band, v => { band=v; draw(); }));
    if (origin) {
      filters.append(input('Max estimated drive (minutes)', maxMinutes, v => { maxMinutes=Number(v); draw(); }, { min: 1,max:240 }));
      filters.append(input('Min modeled crossover (%)', minOverlap, v => { minOverlap=Number(v); draw(); }, { min:0,max:100 }));
    }
    filters.append(button(historical ? 'Hide historical halls' : 'Include historical halls', () => { historical=!historical; draw(); }));
    body.append(filters);
    const center = halls().find(h => h.id === origin);
    const candidates = halls().filter(h => inMarket(h,market) && (!query || `${h.name} ${h.city}`.toLowerCase().includes(query.toLowerCase())) &&
      (!day || h.schedule?.days?.includes(day)) && (!band || payoutBand(sourceValue(h)) === band) &&
      (historical || !/closed|historical|legacy|suspended/i.test(`${h.name} ${h.operatingStatus || ''} ${h.researchStatus || ''}`)));
    const rows = candidates.map(h => ({ h, p: proximity(center,h) })).filter(r => !center || !r.p || r.p.minutes <= maxMinutes && r.p.overlap >= minOverlap);
    const missing = rows.filter(r => !r.h.location).length;
    body.append(node('p','dim',`${rows.length} program listings · ${missing} without map coordinates. Coverage is incomplete. Drive times and crossover are Scout distance-based assumptions, not traffic routes or measured shared players. Unknown locations stay in the list.`));
    const host = node('div','scout-map'); host.setAttribute('aria-label',markets.find(m=>m.id===market).name+' competitive map'); body.append(host);
    mountMap(host, rows, center, mapGeneration);
    const table = node('table','cat-table');
    table.innerHTML = '<thead><tr><th>Hall</th><th>Days</th><th>Program size</th><th>Updates</th><th>From origin</th><th>Collection / presales</th></tr></thead>';
    const tbody = node('tbody'); table.append(tbody);
    for (const { h,p } of rows.sort((a,b) => a.h.name.localeCompare(b.h.name))) {
      const tr = node('tr'); const name = node('td'); name.append(button(h.name, () => choose(h.id))); name.append(node('small','dim',esc(h.city)),node('small','dim',esc(categoryLabel(h))),node('small','dim',esc(statusLabel(h)))); tr.append(name);
      const value = sourceValue(h);
      const partial=allEvidence(h).find(e=>e.subtotal>0);
      tr.insertAdjacentHTML('beforeend', `<td>${esc(h.schedule?.days?.join(', ') || 'Unknown')}</td><td>${value ? money(value) : partial ? `${money(partial.subtotal)} partial` : 'Unknown'}<small>${value ? payoutBand(value)+' · advertised / modeled' : 'Full program unknown'}</small>${partial&&!value?`<small>${esc(partial.channel)} · ${esc(String(partial.date || '').slice(0,10))}</small>`:''}</td><td>${countFor(h.id)}</td><td>${p ? `${p.minutes.toFixed(0)} min est.<small>${p.overlap.toFixed(1)}% modeled</small>` : '—'}</td><td>${esc(enrollmentLabel(h))}<small>${esc(h.presales?.status === 'available' ? h.presales.platform || 'Presales available' : 'Presales not verified')}</small></td>`);
      tbody.append(tr);
    }
    const scroll = node('div','scout-table'); scroll.append(table); body.append(scroll);
  }
  async function mountMap(host, rows, center, generation, regionId=market, overview=false) {
    try {
      const { default:L } = await import('leaflet');
      if (generation !== mapGeneration || !host.isConnected) return;
      const region = markets.find(m => m.id === regionId);
      const instance = L.map(host,{scrollWheelZoom:!overview}).setView(center ? [center.location.lat,center.location.lng] : region.center, region.zoom);
      maps.add(instance);if(!overview)map=instance;
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom:19 }).addTo(instance);
      const style = getComputedStyle(root), accent=style.getPropertyValue('--accent').trim(), muted=style.getPropertyValue('--ink-4').trim();
      if(regionId!=='california'){
        const boundary=L.circle(region.center,{radius:MARKET_RADIUS_MILES*1609.344,color:accent,weight:2,dashArray:'6 6',fillOpacity:.035}).addTo(instance);
        L.circleMarker(region.center,{radius:4,color:accent,fillOpacity:1}).addTo(instance).bindTooltip(`${region.name} center · 50-mile radius`);
        if(!center)instance.fitBounds(boundary.getBounds(),{padding:[12,12]});
      }
      for (const {h,p} of rows) if (Number.isFinite(h.location?.lat) && Number.isFinite(h.location?.lng)) {
        const popup=node('div'); popup.append(button(h.name,()=>{market=regionId;choose(h.id);})); popup.append(node('p','',esc(h.address || '')));
        popup.append(node('p','',`${esc(categoryLabel(h))} · ${esc(statusLabel(h))}`));
        popup.append(node('p','',`${countFor(h.id)} updates${p ? ` · ${p.overlap.toFixed(1)}% modeled crossover` : ''}`));
        L.circleMarker([h.location.lat,h.location.lng],{radius:h.id===origin?11:7,color:countFor(h.id)?accent:muted,fillOpacity:.75}).addTo(instance).bindPopup(popup);
      }
      if(overview&&regionId==='california'){const points=rows.filter(({h})=>Number.isFinite(h.location?.lat)&&Number.isFinite(h.location?.lng)).map(({h})=>[h.location.lat,h.location.lng]);if(points.length)instance.fitBounds(points,{padding:[18,18],maxZoom:11});}
    } catch { host.textContent='Map could not load. All matching halls remain in the table below.'; }
  }
  function renderEvidence(hall) {
    body.append(node('p','dim',`${esc(hall.schedule?.details || '')} ${esc(hall.presales?.details || '')}`));
    const offers = allEvidence(hall);
    body.append(node('p','', `${offers.length} sources loaded. Each source is a separate dated offer. Partial prizes exclude conditional jackpots; never add different messages or session variants together.`));
    if (historyBusy.has(hall.id)) body.append(node('p','dim','Loading message history…'));
    if (historyError.has(hall.id)) { body.append(node('p','tone-neg',historyError.get(hall.id))); body.append(button('Retry history',()=>loadHistory(hall.id))); }
    for (const e of offers) {
      const card = node('article','panel scout-evidence');
      card.innerHTML=`<div class="scout-source">${esc(e.channel.toUpperCase())} · ${esc(e.date || 'Date unknown')}</div><h4>${esc(e.title)}</h4><p>${esc(e.label)}</p><p>${link(e.url,'Source')}</p><p class="scout-message">${esc(e.body || '')}</p><p>Buy-in: ${e.buyIns.length ? e.buyIns.map(usd).join(' / ') : 'Not extracted'} · Fixed prize subtotal: ${money(e.subtotal)}${e.advertisedTotal ? ` · Advertised total: ${usd(e.advertisedTotal)}` : ''}</p>`;
      if (e.groups.length) card.insertAdjacentHTML('beforeend', `<ul>${e.groups.map(g => `<li>${esc(g.label)}: ${g.count} × ${usd(g.prize)}${g.conditional ? ' · conditional; excluded' : ''}</li>`).join('')}</ul>`);
      if (e.subtotal > 0 || e.advertisedTotal > 0) card.append(button('Use this offer as a scenario starting point', () => {
        const cfg=cfgFor(hall.id); cfg.payout=e.advertisedTotal || e.subtotal; cfg.evidence={id:e.id,date:e.date,title:e.title,channel:e.channel,partial:!e.advertisedTotal}; persist(); tab='business'; draw();
      }));
      body.append(card);
    }
    if (histories.get(hall.id)?.hasMore) body.append(button('Load older texts and emails',()=>loadHistory(hall.id,true)));
    if (!offers.length && !historyBusy.has(hall.id)) body.append(node('p','placeholder','No program evidence collected for this hall yet. Zero messages does not establish that the hall is inactive.'));
  }
  function renderModel(hall) {
    const cfg=cfgFor(hall.id), form=node('div','scout-filters');
    body.append(button('Reset this scenario',()=>{scenarios[hall.id]=defaults();persist();draw();}));
    const change=(key,v)=>{cfg[key]=v;persist();draw();};
    body.append(node('p','scout-notice','Scenario estimates only. Advertised prizes are not actual payouts or revenue. Confirm that the selected offer represents the session being modeled; one-off events and progressive jackpots do not establish a recurring program.'));
    if (cfg.evidence) body.append(node('p','',`Starting source: ${esc(cfg.evidence.title)} · ${esc(cfg.evidence.date)}${cfg.evidence.partial ? ' · PARTIAL prize subtotal: review before modeling a whole session.' : ''}`));
    else body.append(node('p','dim','No source selected. Enter your assumptions or choose an offer from Program evidence.'));
    form.append(input('Payout per session ($)',cfg.payout,v=>change('payout',v),{min:1}),input('Sessions per week',cfg.sessions,v=>change('sessions',v),{min:.1,max:50}),
      input('Payout / revenue (%)',cfg.ratio,v=>change('ratio',v),{min:1,max:100}), input('Payout realization (%)',cfg.fill,v=>change('fill',v),{min:1,max:100}),
      input('Assumed profit margin (%) — optional',cfg.margin,v=>change('margin',v),{min:-100,max:100}));
    body.append(form);
    body.append(node('p','dim','Weekly advertised payout = payout × sessions × realization. Revenue = payout ÷ payout ratio. Revenue less prizes is before all other expenses; profit is shown only with an explicit margin assumption. Scenarios are saved in this browser.'));
    const base=business(cfg);
    if (!base) { body.append(node('p','placeholder','Enter valid payout and session assumptions to calculate this scenario.')); return; }
    const stats=node('div','scout-kpis');
    for (const [label,value] of [['Weekly revenue',base.weeklyGross],['Weekly prizes',base.weeklyPayout],['Weekly before expenses',base.weeklyContribution],['Annual revenue',base.annualGross],['Annual profit (assumed)',base.annualProfit]]) {
      stats.append(node('section','panel',`<small>${label}</small><strong>${value === null ? 'Not estimated' : usd(value)}</strong>`));
    }
    body.append(stats);
    if (tab==='projection') {
      const options=node('div','scout-filters');
      options.append(input('Start month',cfg.startMonth,v=>change('startMonth',v),{type:'month'}),input('Horizon (months)',cfg.months,v=>change('months',v),{min:1,max:60,step:1}),
        selectControl('Lift assumptions',[['low','Low'],['mid','Middle'],['high','High']],cfg.preset,v=>change('preset',v)),input('Combined lift cap (%)',cfg.cap,v=>change('cap',v),{min:0,max:200}),
        button(cfg.seasonal?'Seasonality: Scout assumptions':'Seasonality: flat',()=>change('seasonal',!cfg.seasonal)));
      body.append(options,node('p','dim','Scout V2 feature lifts are hypothetical. Enable only changes beyond the baseline, to avoid counting an existing feature twice. Month 0 is the start; lift ramps afterward. Basic and advanced loyalty are mutually exclusive.'));
      const features=node('div','scout-features');
      for (const [key,f] of Object.entries(FEATURES)) {
        const setting=cfg.features[key] || {enabled:false,start:0}; const row=node('div','panel');
        row.append(button(`${setting.enabled?'✓ ':''}${f.label} · ${Math.round(f[cfg.preset]*100)}%`,()=>{cfg.features[key]={...setting,enabled:!setting.enabled}; if (!setting.enabled && key.startsWith('loyalty')) cfg.features[key==='loyaltyMin'?'loyaltyAdv':'loyaltyMin']={enabled:false,start:0};persist();draw();},setting.enabled));
        if (setting.enabled) row.append(input('Starts after months',setting.start,v=>{cfg.features[key].start=Number(v);persist();draw();},{min:0,max:60,step:1})); features.append(row);
      }
      body.append(features);
      const series=projection(cfg);
      if (!series.length) body.append(node('p','tone-neg','Check the projection inputs.'));
      else {
        const max=Math.max(...series.map(m=>m.gross)), chart=node('div','scout-chart'); chart.setAttribute('aria-label','Monthly projected revenue');
        for (const m of series) {const col=node('div','scout-bar');col.style.height=`${Math.max(1,m.gross/max*100)}%`;col.title=`${m.month}: ${usd(m.gross)} revenue, ${(m.lift*100).toFixed(1)}% lift`;chart.append(col);} body.append(chart);
        const table=node('table','cat-table');table.innerHTML='<thead><tr><th>Month</th><th>Baseline revenue</th><th>Scenario revenue</th><th>Prizes</th><th>Before expenses</th><th>Modeled lift</th></tr></thead><tbody>'+series.map(m=>`<tr><td>${m.month}</td><td>${usd(m.baseline)}</td><td>${usd(m.gross)}</td><td>${usd(m.payout)}</td><td>${usd(m.contribution)}</td><td>${(m.lift*100).toFixed(1)}%${m.capped?' (capped)':''}</td></tr>`).join('')+'</tbody>';
        const scroll=node('div','scout-table');scroll.append(table);body.append(scroll);
      }
    }
    body.append(button('Export scenario and source',()=>{
      const blob=new Blob([JSON.stringify({schema:1,hall:{id:hall.id,name:hall.name},exportedAt:new Date().toISOString(),assumptions:cfg,business:base,projection:projection(cfg)},null,2)],{type:'application/json'});
      const a=node('a'),url=URL.createObjectURL(blob);a.href=url;a.download=`bingo-scout-${hall.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }));
  }
  async function refresh() {
    const generation=++loadGeneration;status.textContent='Refreshing the California collection…';
    try {
      const next=await request('/api/competitive'); if(generation!==loadGeneration)return;
      if(!Array.isArray(next.halls))throw Error('Invalid collection');snapshot=next;histories.clear();
      status.textContent=`${halls().length} California program listings · SMS sync ${timeLabel(snapshot.lastSync)} · email sync ${timeLabel(snapshot.lastEmailSync)}`;
      retry.hidden=true;
      draw();if(selected&&tab==='evidence')loadHistory(selected);
    } catch { if(generation===loadGeneration){status.textContent='Collection unavailable. Check the SAR server connection and retry. Previously loaded data, if shown, has not refreshed.';retry.hidden=false;} }
  }
  const retry=button('Retry connection',refresh);header.append(retry);
  refresh();
  return root;
}
