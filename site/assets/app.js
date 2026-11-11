/* Victor's Laptop Finder — all logic in one file, no build step. Data: data/laptops.json + data/reference.json */
(() => {
  'use strict';
  const CFG = window.SITE_CONFIG || {};
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const money = (n) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
  const money2 = (n) => (n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const pct = (x) => (x >= 0 ? '+' : '') + Math.round(x * 100) + '%';
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const performanceGap = (a, b) => a > 0 && b > 0 ? Math.sign(a - b) * (Math.max(a, b) / Math.min(a, b) - 1) : 0;
  const available = (l) => bestOffer(l).in_stock === true && !bestOffer(l).marketplace_only;
  const freshPrice = (l) => { const o = bestOffer(l); const age = Date.now() - new Date(o.checked_at).getTime(); return !o.stale && !o.manual && Number.isFinite(age) && age >= 0 && age <= 48 * 36e5; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('vlf:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('vlf:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem('vlf:' + k); } catch (e) { /* ignore */ } },
  };

  // ------------------------------------------------------------------ settings
  const CATS = [
    { key: 'gaming', label: 'Gaming' },
    { key: 'work', label: 'Work & school' },
    { key: 'display', label: 'Screen' },
    { key: 'portability', label: 'Portability' },
    { key: 'upgrade', label: 'Upgradeability' },
    { key: 'value', label: 'Value for money' },
  ];
  const PRESETS = [
    { id: 'balanced', label: 'Balanced', w: { gaming: 35, work: 25, display: 10, portability: 15, upgrade: 5, value: 10 } },
    { id: 'gamer', label: 'Max gaming per $', w: { gaming: 45, work: 10, display: 5, portability: 5, upgrade: 5, value: 30 } },
    { id: 'carry', label: 'Carry it daily', w: { gaming: 25, work: 25, display: 10, portability: 30, upgrade: 0, value: 10 } },
    { id: 'work', label: 'Work first', w: { gaming: 15, work: 40, display: 15, portability: 15, upgrade: 5, value: 10 } },
    { id: 'future', label: 'Future-proof', w: { gaming: 35, work: 20, display: 10, portability: 5, upgrade: 20, value: 10 } },
  ];
  const MUSTS = [
    { id: 'stock', label: 'Last confirmed in stock', test: available },
    { id: 'fresh', label: 'Price confirmed in the last 48 hours', test: freshPrice },
    { id: 'dgpu', label: 'Dedicated NVIDIA graphics', test: (l) => /^RTX/.test(l.gpu_key) },
    { id: 'ram32', label: '32GB+ RAM', test: (l) => (l.ram_gb || 0) >= 32 },
    { id: 'vram12', label: '12GB+ graphics memory', test: (l) => (l.vram_gb || 0) >= 12 },
    { id: 'oled', label: 'OLED or Mini-LED screen', test: (l) => ['OLED', 'Mini-LED'].includes((l.display || {}).panel) },
    { id: 'light', label: 'Under 5 lb', test: (l) => (l.weight_lb || 9) < 5 },
    { id: 'upg', label: 'Upgradeable RAM', test: (l) => !l.ram_soldered },
    { id: 'tb', label: 'Thunderbolt or USB4', test: (l) => (l.ports || {}).tb > 0 || (l.ports || {}).usb4 },
  ];
  const TIERS = [
    { id: 'budget', label: 'Under $1,200', min: 0, max: 1199.99 },
    { id: 'mid', label: '$1,200 – $1,799', min: 1200, max: 1799.99 },
    { id: 'upper', label: '$1,800 – $2,599', min: 1800, max: 2599.99 },
    { id: 'high', label: '$2,600 and up', min: 2600, max: 1e9 },
  ];
  const SHORT = { fit: 'Victor fit', gaming: 'Gaming', work: 'Work', display: 'Screen', portability: 'Portable', upgrade: 'Upgrades', value: 'Value' };
  const DEFAULT_PREFS = { preset: 'balanced', budget: 2500, weights: { ...PRESETS[0].w }, musts: { stock: true, fresh: true, dgpu: true } };
  const state = {
    prefs: Object.assign({}, DEFAULT_PREFS, store.get('prefs', {})),
    compare: store.get('compare', { a: null, b: null }),
    browse: { sort: 'fit', dir: -1, q: '', gpu: '', brand: '', size: '', maxWeight: '', inBudget: false, stockOnly: true },
    market: { q: '', gpu: '', stock: true, sort: 'price', dir: 1 },
    yAxis: 'gaming',
  };
  state.prefs.weights = Object.assign({}, DEFAULT_PREFS.weights, state.prefs.weights || {});
  state.prefs.musts = Object.assign({}, DEFAULT_PREFS.musts, state.prefs.musts || {});

  let DATA = null; let REF = null; let L = []; let BYID = {};
  const MAX = { gpu: 202, cpu: 2350 };

  // ------------------------------------------------------------------ scoring
  function gpuPerf(l) {
    const g = REF.gpus[l.gpu_key]; if (!g) return 0;
    const f = l.tgp_w && g.ref_tgp ? clamp(Math.pow(l.tgp_w / g.ref_tgp, 0.3), 0.72, 1.02) : 1;
    return g.perf * f;
  }
  const cpuRef = (l) => REF.cpus[l.cpu_key] || { mt: 800, st: 110, cores: '?', class: '?' };
  function displayScore(l) {
    const d = l.display || {}; const px = (d.w || 1920) * (d.h || 1080);
    const res = px >= 3840 * 2160 * 0.95 ? 45 : px >= 2880 * 1800 * 0.95 ? 40 : px >= 2560 * 1440 * 0.95 ? 34 : px >= 1920 * 1200 * 0.95 ? 20 : 16;
    const panel = d.panel === 'OLED' ? 25 : d.panel === 'Mini-LED' ? 23 : 9;
    const hz = d.hz >= 240 ? 15 : d.hz >= 165 ? 11 : d.hz >= 144 ? 9 : 6;
    const nits = clamp((d.nits || 300) / 1100, 0, 1) * 15;
    return clamp(res + panel + hz + nits, 0, 100);
  }
  const ramScore = (gb) => (gb >= 64 ? 1 : gb >= 32 ? 0.85 : gb >= 24 ? 0.72 : gb >= 16 ? 0.55 : 0.25);
  function portability(l) {
    const w = clamp((8 - (l.weight_lb || 5.5)) / 5, 0, 1);
    const t = clamp((1.25 - (l.thickness_in || 0.95)) / 0.7, 0, 1);
    const b = clamp(((l.battery_wh || 70) - 50) / 49.9, 0, 1);
    return 100 * (0.6 * w + 0.2 * t + 0.2 * b);
  }
  function upgrade(l) {
    let s = l.ram_soldered ? 0 : l.ram_slots >= 2 ? 50 : 30;
    s += l.m2 >= 2 ? 35 : l.m2 === 1 ? 15 : 0;
    s += ((l.ports || {}).tb > 0 || (l.ports || {}).usb4) ? 15 : 0;
    return clamp(s, 0, 100);
  }
  function gamingScore(l) {
    let s = (100 * gpuPerf(l)) / MAX.gpu;
    if (cpuRef(l).st < 105) s *= 0.95;
    if ((l.vram_gb || 0) >= 12) s += 2;
    return clamp(s, 0, 100);
  }
  function workScore(l) {
    return clamp(100 * (0.5 * cpuRef(l).mt / MAX.cpu + 0.2 * ramScore(l.ram_gb || 16) + 0.15 * gpuPerf(l) / MAX.gpu + 0.15 * displayScore(l) / 100), 0, 100);
  }
  function computeAll() {
    L.forEach((l) => {
      l.s = { gaming: gamingScore(l), work: workScore(l), display: displayScore(l), portability: portability(l), upgrade: upgrade(l) };
      l.perf = gpuPerf(l);
      l.valueRaw = l.price ? ((0.65 * l.s.gaming + 0.35 * l.s.work) / l.price) * 1000 : 0;
    });
    const maxV = Math.max(...L.map((l) => l.valueRaw));
    L.forEach((l) => { l.s.value = maxV ? clamp((100 * l.valueRaw) / maxV, 0, 100) : 0; });
    recomputeFit();
  }
  function recomputeFit() {
    const w = state.prefs.weights; const total = CATS.reduce((a, c) => a + (+w[c.key] || 0), 0) || 1;
    L.forEach((l) => { l.fit = CATS.reduce((a, c) => a + (l.s[c.key] * (+w[c.key] || 0)), 0) / total; });
  }
  const passesMusts = (l) => MUSTS.every((m) => !state.prefs.musts[m.id] || m.test(l));
  const inBudget = (l) => l.price != null && l.price <= state.prefs.budget;

  // ------------------------------------------------------------------ text helpers
  const shortName = (l) => `${l.brand} ${l.name}`;
  const gpuLabel = (l) => (l.gpu_key || '?') + (l.vram_gb ? ` ${l.vram_gb}GB` : '');
  const resLabel = (d) => (d && d.w ? `${d.w}×${d.h}` : '');
  const storageLabel = (gb) => (gb >= 1000 ? `${Math.round(gb / 1000)}TB` : `${gb}GB`);
  function configLine(l) {
    return [gpuLabel(l), l.cpu_key, `${l.ram_gb}GB RAM`, storageLabel(l.storage_gb || 0)].filter(Boolean).join(' · ');
  }
  function screenLine(l) {
    const d = l.display || {};
    return [d.size ? `${d.size}"` : '', resLabel(d), d.hz ? `${d.hz}Hz` : '', d.panel || ''].filter(Boolean).join(' ');
  }
  function tgpNote(l) {
    const g = REF.gpus[l.gpu_key]; if (!g || !l.tgp_w || g.kind !== 'dGPU') return '';
    const maxW = g.tgp_range[1]; const ratio = l.tgp_w / maxW;
    const est = l.tgp_estimated ? ' (est.)' : '';
    if (ratio >= 0.95) return `full power, ~${l.tgp_w}W${est}`;
    const loss = Math.round((1 - clamp(Math.pow(l.tgp_w / g.ref_tgp, 0.3), 0.72, 1.02)) * 100);
    return `~${l.tgp_w}W of ${maxW}W max${est}${loss > 2 ? `, about ${loss}% slower than full power` : ''}`;
  }
  function capability(perf) {
    if (perf >= 170) return '4K or 1440p at max settings, heavy ray tracing';
    if (perf >= 135) return '1440p ultra, high-refresh 1440p';
    if (perf >= 100) return '1440p high, 1080p ultra';
    if (perf >= 80) return '1080p high/ultra, 1440p with DLSS';
    if (perf >= 60) return '1080p medium–high';
    return 'Esports and older games at 1080p';
  }
  function strengths(l) {
    const out = [];
    const sorted = [...L].filter((x) => x.price);
    const rankIn = (key) => sorted.filter((x) => x.s[key] > l.s[key]).length;
    if (l.s.gaming >= 70) out.push(`${l.gpu_key} at ${tgpNote(l) || 'full power'}`);
    else if (l.s.value >= 75) out.push('Lots of performance per dollar');
    if ((l.vram_gb || 0) >= 12 && l.gpu_key !== 'RTX 5090') out.push(`${l.vram_gb}GB of graphics memory`);
    if (cpuRef(l).mt >= 1700) out.push(`${l.cpu_key}: strong for heavy work`);
    if ((l.display || {}).panel === 'OLED' || (l.display || {}).panel === 'Mini-LED') out.push(`${(l.display || {}).panel} ${l.display.hz}Hz screen`);
    if ((l.weight_lb || 9) < 4.3) out.push(`Only ${l.weight_lb} lb`);
    if ((l.ram_gb || 0) >= 32) out.push(`${l.ram_gb}GB RAM`);
    if (l.regular && l.price && l.regular - l.price >= 100) out.push(`${money(l.regular - l.price)} off right now`);
    if (rankIn('value') < 5) out.push('Top-5 value in the list');
    return out.slice(0, 3);
  }
  function stockChip(l) {
    if (l.price_status === 'unavailable') return '<span class="chip bad">Sold out</span>';
    if (l.price_status === 'manual') return '<span class="chip warn" title="Configured price, tracked by hand">Est. price</span>';
    if (!available(l)) return '<span class="chip warn">Stock unconfirmed</span>';
    if (l.price_status === 'stale' && !lastRunFailed()) { const o = (l.offers || []).find((x) => x.retailer_name === l.price_retailer) || {}; return `<span class="chip warn" title="The last scrape couldn't refresh this ${esc(l.price_retailer || '')} price">${esc(l.price_retailer || 'Price')} price from ${esc(new Date(o.checked_at || pricesAsOf()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</span>`; }
    return '';
  }

  // ------------------------------------------------------------------ small components
  function scoreBars(l, keys = ['gaming', 'work', 'portability']) {
    return `<div class="mini-scores">${keys.map((k) => {
      const c = { label: SHORT[k] || k };
      const v = k === 'fit' ? l.fit : l.s[k];
      const cls = k === 'portability' || k === 'upgrade' ? 'cool' : k === 'fit' ? 'ink' : '';
      return `<div class="mscore"><span>${esc(c.label)}</span><div class="bar ${cls}"><span style="width:${v.toFixed(0)}%"></span></div><b>${v.toFixed(0)}</b></div>`;
    }).join('')}</div>`;
  }
  function priceBlock(l, size = '') {
    const save = l.regular && l.price && l.regular > l.price ? l.regular - l.price : 0;
    return `<div class="price-row"><span class="price ${size}">${money2(l.price)}</span>${save >= 1 ? `<span class="was">${money2(l.regular)}</span><span class="save">save ${money(save)}</span>` : ''}${stockChip(l)}</div>`;
  }
  function cmpToggle(l) {
    const a = state.compare.a === l.id; const b = state.compare.b === l.id;
    return `<span class="cmp-toggle" role="group" aria-label="Compare slot"><button type="button" data-cmp="a" data-id="${l.id}" class="${a ? 'is-on' : ''}" aria-pressed="${a}" title="Compare as A">A</button><button type="button" data-cmp="b" data-id="${l.id}" class="${b ? 'is-on' : ''}" aria-pressed="${b}" title="Compare as B">B</button></span>`;
  }
  function lcard(l, opts = {}) {
    const why = opts.why ?? strengths(l);
    return `<article class="lcard ${opts.cls || ''}">
      <div class="lcard-head"><div>
        ${opts.rank ? `<div class="rank">#${opts.rank} for ${esc(CFG.owner || 'you')} · fit ${l.fit.toFixed(0)}</div>` : ''}
        ${opts.tierLabel ? `<div class="tier-label">${esc(opts.tierLabel)}</div>` : ''}
        <button class="lcard-title" type="button" data-open="${l.id}">${esc(shortName(l))}</button>
        <div class="lcard-config">${esc(configLine(l))}</div>
      </div></div>
      ${priceBlock(l)}
      <div class="chips"><span class="chip">${esc(screenLine(l))}</span>${l.weight_lb ? `<span class="chip">${l.weight_lb} lb</span>` : ''}${(l.awards || []).slice(0, 1).map((a) => `<span class="chip accent" title="${esc(a.source)}">${esc(a.label)}</span>`).join('')}</div>
      ${why.length ? `<div class="why">${why.map(esc).join(' · ')}</div>` : ''}
      ${scoreBars(l, opts.scoreKeys || ['gaming', 'work', 'portability', 'value'])}
      <div class="lcard-foot"><button class="btn btn-sm" type="button" data-open="${l.id}">Details</button>${cmpToggle(l)}<a class="btn btn-sm btn-ghost" href="${esc(bestOffer(l).url)}" target="_blank" rel="noopener">${esc(l.price_retailer || 'Store')} ↗</a></div>
    </article>`;
  }
  const bestOffer = (l) => (l.offers || []).find((o) => o.retailer_name === l.price_retailer) || (l.offers || [])[0] || {};

  // ------------------------------------------------------------------ PICKS
  function renderPrefs() {
    const p = state.prefs;
    $('#presets').innerHTML = PRESETS.map((pr) => `<button type="button" class="preset ${p.preset === pr.id ? 'is-on' : ''}" data-preset="${pr.id}">${esc(pr.label)}</button>`).join('');
    const b = $('#budget-max'); b.value = p.budget; $('#budget-out').textContent = money(p.budget);
    $('#weights').innerHTML = '<legend>How much each thing matters</legend>' + CATS.map((c) => `<div class="weight-row"><label for="w-${c.key}">${esc(c.label)}</label><input type="range" id="w-${c.key}" min="0" max="50" step="5" value="${p.weights[c.key]}" data-weight="${c.key}"><output for="w-${c.key}">${p.weights[c.key]}</output></div>`).join('');
    $('#musts').innerHTML = '<legend>Must-haves</legend>' + MUSTS.map((m) => `<label class="must-row"><input type="checkbox" id="m-${m.id}" data-must="${m.id}" ${p.musts[m.id] ? 'checked' : ''}> ${esc(m.label)}</label>`).join('');
  }
  function renderPicks() {
    const pool = L.filter((l) => l.price && passesMusts(l));
    const within = pool.filter(inBudget).sort((a, b) => b.fit - a.fit);
    const top = within.slice(0, 3);
    $('#picks-sub').textContent = `${within.length} of ${L.length} laptops fit a ${money(state.prefs.budget)} budget and your must-haves. Ranked by "fit": your priority sliders applied to each laptop's scores.`;
    $('#top-picks').innerHTML = top.length ? top.map((l, i) => lcard(l, { rank: i + 1, cls: i === 0 ? 'rank-1' : '' })).join('')
      : '<p class="empty">Nothing matches. Raise the budget or turn off a must-have.</p>';
    $('#tier-grid').innerHTML = TIERS.map((t) => {
      const inTier = pool.filter((l) => l.price >= t.min && l.price <= t.max);
      if (!inTier.length) return `<div class="lcard tier-card"><div class="tier-label">${esc(t.label)}</div><p class="empty">No laptops match the must-haves here.</p></div>`;
      const best = [...inTier].sort((a, b) => b.fit - a.fit)[0];
      const value = [...inTier].sort((a, b) => b.s.value - a.s.value)[0];
      const second = value.id !== best.id ? `<div class="cell-sub">Best value here: <button class="lcard-title" style="font-size:0.85rem" type="button" data-open="${value.id}">${esc(shortName(value))}</button> · ${esc(value.gpu_key)} · ${money(value.price)}</div>` : '';
      return lcard(best, { tierLabel: `${t.label} · best fit of ${inTier.length}`, cls: 'tier-card', scoreKeys: ['fit', 'gaming', 'work'] }).replace('</article>', `${second}</article>`);
    }).join('');
    $('#market-context').innerHTML = marketContext();
  }
  function marketContext() {
    return `<h3>Before you buy: the 2026 price picture</h3>
      <ul>
        <li>A global memory shortage pushed laptop prices up this year. MSI told investors it would raise gaming laptop prices 15–30%, and TrendForce projected mainstream laptops could climb close to 40%. <a href="https://www.notebookcheck.net/MSI-to-raise-gaming-laptop-and-GPU-prices-by-as-much-as-30-with-memory-shortage-ongoing.1250534.0.html" target="_blank" rel="noopener">Notebookcheck</a> · <a href="https://www.club386.com/laptop-prices-risin/" target="_blank" rel="noopener">Club386</a></li>
        <li>There were no new laptop GPUs this year; 2026 models mostly add faster CPUs (Core Ultra 9 290HX Plus, Panther Lake, Ryzen AI 400) and brighter OLEDs. An RTX 50 laptop from 2025 is not outdated.</li>
        <li>Black Friday is close. Best Buy's own "comparable value" prices are often far above what these laptops actually sell for, so judge by the price history here rather than the "save $X" badge.</li>
        <li>Marketplace sellers on Best Buy sometimes undercut Best Buy's price. Those offers show up in each laptop's details, but returns and warranty can be messier.</li>
      </ul>`;
  }

  // ------------------------------------------------------------------ BROWSE
  const BROWSE_COLS = [
    { key: 'name', label: 'Laptop', sort: (l) => shortName(l) },
    { key: 'price', label: 'Price', sort: (l) => l.price ?? 1e9, cls: 'r' },
    { key: 'gpu', label: 'Graphics', sort: (l) => l.perf },
    { key: 'cpu', label: 'Processor', sort: (l) => cpuRef(l).mt },
    { key: 'mem', label: 'RAM / SSD', sort: (l) => (l.ram_gb || 0) * 10000 + (l.storage_gb || 0) },
    { key: 'screen', label: 'Screen', sort: (l) => l.s.display },
    { key: 'weight', label: 'Weight', sort: (l) => l.weight_lb || 99, cls: 'r' },
    { key: 'gaming', label: 'Gaming', sort: (l) => l.s.gaming, cls: 'r' },
    { key: 'work', label: 'Work', sort: (l) => l.s.work, cls: 'r' },
    { key: 'value', label: 'Value', sort: (l) => l.s.value, cls: 'r' },
    { key: 'fit', label: 'Fit', sort: (l) => l.fit, cls: 'r' },
    { key: 'cmp', label: 'Compare' },
  ];
  function renderFilters() {
    const gpus = [...new Set(L.map((l) => l.gpu_key))].sort((a, b) => (REF.gpus[b] || {}).perf - (REF.gpus[a] || {}).perf);
    const brands = [...new Set(L.map((l) => l.brand))].sort();
    const f = state.browse;
    $('#filters').innerHTML = `
      <div class="f"><label for="f-q">Search</label><input type="search" id="f-q" placeholder="e.g. Legion, OLED, 5070 Ti" value="${esc(f.q)}"></div>
      <div class="f"><label for="f-gpu">Graphics</label><select id="f-gpu"><option value="">Any</option>${gpus.map((g) => `<option ${f.gpu === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div>
      <div class="f"><label for="f-brand">Brand</label><select id="f-brand"><option value="">Any</option>${brands.map((b) => `<option ${f.brand === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></div>
      <div class="f"><label for="f-size">Screen</label><select id="f-size"><option value="">Any</option><option value="14" ${f.size === '14' ? 'selected' : ''}>14" and smaller</option><option value="15" ${f.size === '15' ? 'selected' : ''}>15–15.9"</option><option value="16" ${f.size === '16' ? 'selected' : ''}>16"</option><option value="18" ${f.size === '18' ? 'selected' : ''}>17–18"</option></select></div>
      <div class="f"><label for="f-weight">Max weight</label><select id="f-weight"><option value="">Any</option>${[4, 4.5, 5, 5.5, 6].map((w) => `<option value="${w}" ${String(f.maxWeight) === String(w) ? 'selected' : ''}>${w} lb</option>`).join('')}</select></div>
      <label class="check"><input type="checkbox" id="f-budget" ${f.inBudget ? 'checked' : ''}> Within ${money(state.prefs.budget)}</label>
      <label class="check"><input type="checkbox" id="f-stock" ${f.stockOnly ? 'checked' : ''}> Last confirmed in stock</label>`;
  }
  function browseRows() {
    const f = state.browse; const q = f.q.trim().toLowerCase();
    let rows = L.filter((l) => {
      if (q && !(`${shortName(l)} ${configLine(l)} ${screenLine(l)} ${l.form} ${l.model}`.toLowerCase().includes(q))) return false;
      if (f.gpu && l.gpu_key !== f.gpu) return false;
      if (f.brand && l.brand !== f.brand) return false;
      const sz = (l.display || {}).size || 0;
      if (f.size === '14' && sz > 14.6) return false;
      if (f.size === '15' && (sz < 15 || sz >= 16)) return false;
      if (f.size === '16' && (sz < 16 || sz >= 17)) return false;
      if (f.size === '18' && sz < 17) return false;
      if (f.maxWeight && (l.weight_lb || 99) > +f.maxWeight) return false;
      if (f.inBudget && !inBudget(l)) return false;
      if (f.stockOnly && !available(l)) return false;
      return true;
    });
    const col = BROWSE_COLS.find((c) => c.key === f.sort) || BROWSE_COLS[1];
    rows.sort((a, b) => { const x = col.sort(a); const y = col.sort(b); return (x > y ? 1 : x < y ? -1 : 0) * f.dir; });
    return rows;
  }
  function pill(v) { return `<span class="score-pill ${v >= 75 ? 'hi' : v >= 55 ? 'mid' : ''}">${v.toFixed(0)}</span>`; }
  function renderBrowse() {
    const rows = browseRows();
    $('#browse-sub').textContent = `${rows.length} of ${L.length} configurations · scores are 0–100 and update with the priorities on the Picks tab · click a row for full specs and part analysis.`;
    const thead = $('#browse-table thead');
    thead.innerHTML = '<tr>' + BROWSE_COLS.map((c) => c.key === 'cmp' ? `<th>${c.label}</th>` : `<th class="${c.cls || ''}" aria-sort="${state.browse.sort === c.key ? (state.browse.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${c.key}">${c.label}</button></th>`).join('') + '</tr>';
    $('#browse-table tbody').innerHTML = rows.map((l) => `<tr class="is-clickable" data-open="${l.id}" tabindex="0" aria-label="Details for ${esc(shortName(l))}, ${esc(configLine(l))}">
      <td><div class="cell-title">${esc(shortName(l))}</div><div class="cell-sub">${esc(l.form || '')} · ${esc(l.year || '')}</div></td>
      <td class="r"><div class="num">${money2(l.price)}</div>${l.regular && l.regular > l.price ? `<div class="cell-sub was">${money2(l.regular)}</div>` : ''}${stockChip(l)}</td>
      <td><div>${esc(gpuLabel(l))}</div><div class="cell-sub">${esc(tgpNote(l) || (REF.gpus[l.gpu_key] || {}).kind || '')}</div></td>
      <td><div>${esc(l.cpu_key)}</div><div class="cell-sub">${esc(cpuRef(l).cores)}</div></td>
      <td><div>${l.ram_gb}GB / ${storageLabel(l.storage_gb || 0)}</div><div class="cell-sub">${l.ram_soldered ? 'soldered' : `${l.ram_slots} slots`}</div></td>
      <td><div>${esc(screenLine(l))}</div><div class="cell-sub">${(l.display || {}).nits ? `${l.display.nits} nits` : ''}</div></td>
      <td class="r num">${l.weight_lb ?? '—'}</td>
      <td class="r">${pill(l.s.gaming)}</td><td class="r">${pill(l.s.work)}</td><td class="r">${pill(l.s.value)}</td><td class="r">${pill(l.fit)}</td>
      <td>${cmpToggle(l)}</td></tr>`).join('');
    $('#browse-cards').innerHTML = rows.map((l) => lcard(l, { why: [] })).join('');
  }

  // ------------------------------------------------------------------ DETAIL DRAWER
  function sparkline(hist, w = 260, h = 56) {
    if (!hist || hist.length < 2) return `<p class="chart-note">Price history starts ${hist && hist[0] ? esc(hist[0][0]) : 'with the next scrape'}. Each scrape adds a point, so this chart fills in over time.</p>`;
    const ps = hist.map((x) => x[1]); const lo = Math.min(...ps); const hi = Math.max(...ps); const span = hi - lo || 1;
    const X = (i) => 4 + (i * (w - 8)) / (hist.length - 1); const Y = (p) => h - 6 - ((p - lo) * (h - 14)) / span;
    const d = hist.map((x, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(x[1]).toFixed(1)}`).join(' ');
    const last = hist[hist.length - 1];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Price history from ${esc(hist[0][0])} to ${esc(last[0])}: low ${money(lo)}, high ${money(hi)}"><path class="area" d="${d} L${X(hist.length - 1)},${h} L${X(0)},${h} Z"/><path class="line" d="${d}"/><circle cx="${X(hist.length - 1)}" cy="${Y(last[1])}" r="3"/></svg><div class="cell-sub">Low ${money(lo)} · High ${money(hi)} · ${hist.length} scrapes since ${esc(hist[0][0])}</div>`;
  }
  function partNotes(l) {
    const g = REF.gpus[l.gpu_key] || {}; const c = cpuRef(l); const notes = [];
    notes.push(`<b>Graphics:</b> ${esc(l.gpu_key)}${l.vram_gb ? ` with ${l.vram_gb}GB VRAM` : ' (shares system memory)'}${tgpNote(l) ? `, ${esc(tgpNote(l))}` : ''}. Good for: ${esc(capability(l.perf))}. ${esc(g.note || '')}`);
    const cls = { HX: 'a high-power desktop-class chip, best for heavy multi-core work like video exports and compiling', H: 'a balanced chip: plenty for school, office work and gaming', HS: 'an efficient chip with good battery life', V: 'a low-power chip that is great on battery but weak at heavy multi-core work', Max: 'a big APU with workstation-class graphics on the same chip' }[c.class] || '';
    notes.push(`<b>Processor:</b> ${esc(l.cpu_key)} (${esc(c.cores)}) is ${cls}. Multi-core score ≈ ${c.mt} (Cinebench 2024 scale).`);
    const ram = l.ram_gb || 0;
    notes.push(`<b>Memory:</b> ${ram}GB ${esc(l.ram_type || '')}${l.ram_speed ? `-${l.ram_speed}` : ''}. ${ram < 16 ? '8GB is not enough for modern games plus Discord and a browser; budget for an upgrade.' : ram < 32 ? '16GB is fine for gaming today; 32GB helps with heavy multitasking or creative apps.' : 'Plenty for gaming plus heavy work.'} ${l.ram_soldered ? 'It is soldered, so buy the amount you will need for the laptop\'s whole life.' : `Upgradeable (${l.ram_slots} slots${l.ram_max_gb ? `, up to ${l.ram_max_gb}GB` : ''}).`}`);
    notes.push(`<b>Storage:</b> ${storageLabel(l.storage_gb || 0)}${l.m2 ? ` with ${l.m2} M.2 slot${l.m2 > 1 ? 's' : ''}` : ''}. ${(l.storage_gb || 0) < 1000 ? 'New AAA games take 100–150GB each, so 512GB fills fast.' : ''}`);
    const d = l.display || {};
    notes.push(`<b>Screen:</b> ${esc(screenLine(l))}${d.nits ? `, ${d.nits} nits` : ''}. ${d.panel === 'OLED' ? 'OLED gives perfect blacks and fast response; avoid leaving static windows up for hours.' : d.panel === 'Mini-LED' ? 'Mini-LED gets very bright for HDR without OLED burn-in risk.' : (d.nits || 0) <= 300 ? 'A 300-nit IPS panel is fine indoors but dim near windows.' : 'Solid IPS panel.'}`);
    if ((l.vram_gb || 0) && l.vram_gb <= 8 && l.perf >= 95) notes.push('<b>Heads-up:</b> 8GB of VRAM can limit texture settings in the newest games at 1440p, even when the GPU itself is fast enough.');
    return notes.map((n) => `<p>${n}</p>`).join('');
  }
  function specRows(l) {
    const d = l.display || {}; const p = l.ports || {};
    const rows = [
      ['Model number', l.model], ['Release year', l.year], ['Form factor', l.form],
      ['Processor', `${l.cpu_key} · ${cpuRef(l).cores}`], ['Graphics', `${gpuLabel(l)}${tgpNote(l) ? ` · ${tgpNote(l)}` : ''}`],
      ['Memory', `${l.ram_gb}GB ${l.ram_type || ''}${l.ram_speed ? `-${l.ram_speed}` : ''} · ${l.ram_soldered ? 'soldered' : `${l.ram_slots} slots${l.ram_max_gb ? `, max ${l.ram_max_gb}GB` : ''}`}`],
      ['Storage', `${storageLabel(l.storage_gb || 0)} SSD${l.m2 ? ` · ${l.m2} M.2 slots` : ''}`],
      ['Screen', `${screenLine(l)}${d.nits ? ` · ${d.nits} nits` : ''}${d.touch ? ' · touch' : ''}`],
      ['Weight / thickness', `${l.weight_lb ?? '—'} lb · ${l.thickness_in ?? '—'}"`],
      ['Battery', `${l.battery_wh ? `${l.battery_wh} Wh` : '—'}${l.battery_claim_h ? ` · maker claims up to ${l.battery_claim_h} h (light use)` : ''}`],
      ['Ports', [p.tb ? `${p.tb}× Thunderbolt` : '', p.usb4 ? 'USB4' : '', p.usb, p.hdmi ? `${p.hdmi}× HDMI` : '', p.eth ? 'Ethernet' : ''].filter(Boolean).join(' · ')],
      ['Wireless', l.wifi], ['Number pad', l.numpad == null ? null : l.numpad ? 'Yes' : 'No'],
    ];
    return rows.filter((r) => r[1]).map((r) => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('');
  }
  function offersHtml(l) {
    return (l.offers || []).map((o) => `<div class="offer">
      <div><b>${esc(o.retailer_name)}</b>${o.sku ? ` <span class="cell-sub">SKU ${esc(o.sku)}</span>` : ''}<div class="cell-sub">${o.checked_at ? `Price checked ${esc(fmtDate(o.checked_at))}` : 'Price not checked yet'}${o.stale ? ' · <span class="chip warn">price not reconfirmed, showing last known price</span>' : ''}${o.manual ? ' · price tracked by hand' : ''}${o.availability_checked_at ? `<br>Stock checked ${esc(fmtDate(o.availability_checked_at))}` : ''}</div>
        ${o.open_box ? `<div class="cell-sub">Open-box from ${money2(o.open_box)}</div>` : ''}
        ${o.marketplace ? `<div class="cell-sub">Marketplace seller ${esc(o.marketplace.seller)}: ${money2(o.marketplace.price)} (third-party, check returns)</div>` : ''}
        ${o.rating ? `<div class="cell-sub">${o.rating}★ from ${(o.reviews || 0).toLocaleString()} reviews</div>` : ''}</div>
      <div style="text-align:right"><div class="price sm">${money2(o.price)}</div>${o.in_stock === false ? '<span class="chip bad">Sold out</span>' : ''}<div><a class="btn btn-sm" href="${esc(o.url)}" target="_blank" rel="noopener">Open ↗</a></div></div></div>`).join('');
  }
  function openDrawer(id) {
    const l = BYID[id]; if (!l) return;
    const dr = $('#drawer');
    if (dr.hidden) drawerTrigger = document.activeElement;
    dr.innerHTML = `<button class="btn btn-sm drawer-close" type="button" data-close-drawer>Close ✕</button>
      <div class="drawer-head"><div class="cell-sub">${esc(l.form || '')} · ${esc(l.year || '')}</div><h2 id="drawer-title">${esc(shortName(l))}</h2><div class="lcard-config">${esc(configLine(l))}</div>
      ${priceBlock(l)}<div class="chips">${(l.awards || []).map((a) => `<a class="chip accent" href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.source)}">${esc(a.label)} · ${esc(a.source)}</a>`).join('')}</div>
      <div class="lcard-foot"><button class="btn btn-sm btn-accent" type="button" data-cmp-set="a" data-id="${l.id}">Compare as A</button><button class="btn btn-sm" type="button" data-cmp-set="b" data-id="${l.id}">Compare as B</button></div></div>
      <div class="panel"><h3>Scores</h3>${scoreBars(l, ['fit', 'gaming', 'work', 'display', 'portability', 'upgrade', 'value'])}<p class="hint">${esc(scoreAssumptions(l))}</p></div>
      <div class="panel"><h3>Part analysis</h3><div class="partnote">${partNotes(l)}</div></div>
      <div class="panel pc"><div class="pros"><h4>Pros</h4><ul>${(l.pros || []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div><div class="cons"><h4>Cons</h4><ul>${(l.cons || []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div></div>
      <div class="panel"><h3>Where to buy</h3>${offersHtml(l)}</div>
      <div class="panel"><h3>Price history</h3>${sparkline(l.history)}</div>
      <div class="panel"><h3>Specs</h3><table class="spec-table"><tbody>${specRows(l)}</tbody></table>${(l.estimates || []).length ? `<p class="hint">Estimated: ${esc(l.estimates.map((e) => ({ tgp: 'GPU power', battery_wh: 'battery size' }[e] || e)).join(', '))}. Makers rarely publish these per configuration.</p>` : ''}</div>`;
    dr.hidden = false; $('#drawer-backdrop').hidden = false; dr.scrollTop = 0; $('.drawer-close', dr).focus();
  }
  let drawerTrigger = null; let modalTrigger = null;
  function closeDrawer() { const wasOpen = !$('#drawer').hidden; $('#drawer').hidden = true; $('#drawer-backdrop').hidden = true; if (wasOpen && drawerTrigger?.isConnected) drawerTrigger.focus(); }
  function scoreAssumptions(l) {
    const missing = [l.m2 == null ? 'SSD slot count (no upgrade points awarded)' : '', l.display?.nits == null ? 'brightness (300 nits assumed)' : '', l.display?.panel == null ? 'panel type (IPS assumed)' : '', l.battery_wh == null ? 'battery size (70 Wh assumed)' : ''].filter(Boolean);
    return [l.tgp_estimated ? 'GPU power is estimated.' : '', missing.length ? `Unconfirmed: ${missing.join('; ')}.` : '', 'Scores are approximate; battery capacity is not measured runtime.'].filter(Boolean).join(' ');
  }

  // ------------------------------------------------------------------ COMPARE
  function setCompare(slot, id) {
    const other = slot === 'a' ? 'b' : 'a';
    if (state.compare[slot] === id) state.compare[slot] = null;
    else { if (state.compare[other] === id) state.compare[other] = state.compare[slot]; state.compare[slot] = id; }
    store.set('compare', state.compare);
    updateCompareUi();
  }
  function updateCompareUi() {
    const n = ['a', 'b'].filter((k) => state.compare[k] && BYID[state.compare[k]]).length;
    const cc = $('#compare-count'); cc.hidden = !n; cc.textContent = n;
    $$('[data-cmp]').forEach((b) => { const on = state.compare[b.dataset.cmp] === b.dataset.id; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on); });
    const tray = $('#compare-tray');
    if (n && currentView() !== 'compare') {
      const a = BYID[state.compare.a]; const b = BYID[state.compare.b];
      tray.innerHTML = `<span><b>A</b> ${a ? esc(shortName(a)) : '—'} &nbsp; <b>B</b> ${b ? esc(shortName(b)) : '—'}</span><a class="btn btn-sm" href="#compare">${n === 2 ? 'Compare now' : 'Pick one more'}</a><button class="x" type="button" data-clear-compare aria-label="Clear comparison">✕</button>`;
      tray.hidden = false;
    } else tray.hidden = true;
    if (currentView() === 'compare') renderCompare();
  }
  function pickerHtml(slot) {
    const sel = state.compare[slot];
    const groups = TIERS.map((t) => `<optgroup label="${esc(t.label)}">${L.filter((l) => (l.price || 0) >= t.min && (l.price || 0) <= t.max).sort((a, b) => a.price - b.price).map((l) => `<option value="${l.id}" ${sel === l.id ? 'selected' : ''}>${esc(shortName(l))} · ${esc(l.gpu_key)} · ${l.ram_gb}GB · ${money(l.price)}</option>`).join('')}</optgroup>`).join('');
    const l = BYID[sel];
    return `<span class="slot">LAPTOP ${slot.toUpperCase()}</span><label class="cell-sub" for="pick-${slot}">Choose a laptop</label><select id="pick-${slot}" data-pick="${slot}"><option value="">—</option>${groups}</select>${l ? `${priceBlock(l, 'sm')}<div class="cell-sub">${esc(configLine(l))}</div>` : '<p class="cell-sub">Or use the A/B buttons on any card or table row.</p>'}`;
  }
  function renderCompare() {
    $$('.picker').forEach((p) => { p.innerHTML = pickerHtml(p.dataset.slot); });
    const a = BYID[state.compare.a]; const b = BYID[state.compare.b];
    const body = $('#compare-body');
    if (!a || !b) {
      const sug = suggestions();
      body.innerHTML = `<div class="panel"><h3>Pick two laptops to compare</h3><p class="sub">Some matchups people usually weigh up:</p><div class="chips" style="margin-top:8px">${sug.map(([x, y, label]) => `<button class="btn btn-sm" type="button" data-pair="${x.id}|${y.id}">${esc(label)}</button>`).join('')}</div></div>`;
      return;
    }
    body.innerHTML = verdictHtml(a, b) + catBarsHtml(a, b) + specCompareHtml(a, b);
  }
  function suggestions() {
    const pool = L.filter((l) => l.price && available(l));
    const byFit = [...pool].filter(inBudget).sort((x, y) => y.fit - x.fit);
    const out = [];
    if (byFit[0] && byFit[1]) out.push([byFit[0], byFit[1], `Top two picks: ${shortName(byFit[0])} vs ${shortName(byFit[1])}`]);
    const thin = pool.filter((l) => l.gpu_key === 'RTX 5070 Ti').sort((x, y) => x.weight_lb - y.weight_lb);
    if (thin.length > 1) out.push([thin[0], [...thin].sort((x, y) => x.price - y.price)[0], 'Lightest vs cheapest RTX 5070 Ti']);
    const v = [...pool].sort((x, y) => y.s.value - x.s.value);
    const prem = [...pool].filter((l) => l.price > 2500).sort((x, y) => y.fit - x.fit);
    if (v[0] && prem[0]) out.push([v[0], prem[0], 'Best value vs best premium']);
    const g5060 = pool.filter((l) => l.gpu_key === 'RTX 5060').sort((x, y) => x.price - y.price)[0];
    const g5070ti = pool.filter((l) => l.gpu_key === 'RTX 5070 Ti').sort((x, y) => x.price - y.price)[0];
    if (g5060 && g5070ti) out.push([g5060, g5070ti, 'Is the RTX 5070 Ti worth the jump from a 5060?']);
    return out.filter(([x, y]) => x.id !== y.id);
  }
  function verdictHtml(a, b) {
    const pa = []; const pb = [];
    const g = performanceGap(a.perf, b.perf);
    if (Math.abs(g) >= 0.05) (g > 0 ? pa : pb).push(`About ${Math.round(Math.abs(g) * 100)}% faster in games (${esc(g > 0 ? a.gpu_key : b.gpu_key)}${(g > 0 ? a : b).tgp_w ? ` at ~${(g > 0 ? a : b).tgp_w}W` : ''})`);
    const c = performanceGap(cpuRef(a).mt, cpuRef(b).mt);
    if (Math.abs(c) >= 0.1) (c > 0 ? pa : pb).push(`About ${Math.round(Math.abs(c) * 100)}% faster at heavy multi-core work (${esc(c > 0 ? a.cpu_key : b.cpu_key)})`);
    if ((a.vram_gb || 0) !== (b.vram_gb || 0) && Math.max(a.vram_gb || 0, b.vram_gb || 0) >= 12) ((a.vram_gb || 0) > (b.vram_gb || 0) ? pa : pb).push(`${Math.max(a.vram_gb, b.vram_gb)}GB of graphics memory vs ${Math.min(a.vram_gb || 0, b.vram_gb || 0) || 'shared'}${Math.min(a.vram_gb || 0, b.vram_gb || 0) ? 'GB' : ''}`);
    if (a.ram_gb !== b.ram_gb) (a.ram_gb > b.ram_gb ? pa : pb).push(`${Math.max(a.ram_gb, b.ram_gb)}GB RAM vs ${Math.min(a.ram_gb, b.ram_gb)}GB`);
    if (a.ram_soldered !== b.ram_soldered) (a.ram_soldered ? pb : pa).push('RAM can be upgraded later (the other is soldered)');
    const dw = (a.weight_lb || 0) - (b.weight_lb || 0);
    if (Math.abs(dw) >= 0.3) (dw < 0 ? pa : pb).push(`${Math.abs(dw).toFixed(1)} lb lighter (${Math.min(a.weight_lb, b.weight_lb)} lb)`);
    const ds = a.s.display - b.s.display;
    if (Math.abs(ds) >= 8) { const w = ds > 0 ? a : b; (ds > 0 ? pa : pb).push(`Better screen: ${esc(screenLine(w))}${w.display.nits ? `, ${w.display.nits} nits` : ''}`); }
    const db = (a.battery_wh || 0) - (b.battery_wh || 0);
    if (Math.abs(db) >= 10 && a.battery_wh && b.battery_wh) (db > 0 ? pa : pb).push(`Bigger battery (${Math.max(a.battery_wh, b.battery_wh)} Wh vs ${Math.min(a.battery_wh, b.battery_wh)} Wh)`);
    const tbA = (a.ports || {}).tb > 0 || (a.ports || {}).usb4; const tbB = (b.ports || {}).tb > 0 || (b.ports || {}).usb4;
    if (tbA !== tbB) (tbA ? pa : pb).push('Thunderbolt/USB4 for docks and fast external drives');
    const dp = (a.price || 0) - (b.price || 0);
    if (Math.abs(dp) >= 25) (dp < 0 ? pa : pb).push(`${money(Math.abs(dp))} cheaper`);
    // Headline
    const fitW = a.fit >= b.fit ? a : b; const fitL = fitW === a ? b : a;
    let costLine = '';
    const exp = a.price > b.price ? a : b; const chp = exp === a ? b : a;
    const gain = chp.perf ? exp.perf / chp.perf - 1 : 0;
    if (exp.price && chp.price && exp.price !== chp.price) {
      costLine = gain > 0.03
        ? `${esc(shortName(exp))} costs ${money(exp.price - chp.price)} more (${pct(exp.price / chp.price - 1)}) for about ${Math.round(gain * 100)}% more gaming performance: ${money((exp.price - chp.price) / (gain * 100))} per extra 1%.`
        : `${esc(shortName(exp))} costs ${money(exp.price - chp.price)} more but is not faster in games; the extra money buys ${exp.s.portability > chp.s.portability + 5 ? 'portability' : exp.s.display > chp.s.display + 5 ? 'a better screen' : exp.s.work > chp.s.work + 5 ? 'work performance' : 'brand or build'} instead.`;
    }
    const gameW = a.perf >= b.perf ? a : b; const portW = a.s.portability >= b.s.portability ? a : b; const workW = a.s.work >= b.s.work ? a : b;
    const sameName = shortName(a) === shortName(b);
    const nm = (l) => (sameName ? `${shortName(l)} (${l === a ? 'A' : 'B'})` : shortName(l));
    return `<div class="verdict">
      <div class="panel"><p class="headline"><b>For ${esc(CFG.owner || 'your')}'s priorities: ${esc(nm(fitW))}</b> (fit ${fitW.fit.toFixed(0)} vs ${fitL.fit.toFixed(0)}). Better for gaming: <b>${esc(nm(gameW))}</b>. Better for work: <b>${esc(nm(workW))}</b>. Easier to carry: <b>${esc(nm(portW))}</b>.</p>${costLine ? `<p class="sub" style="margin-top:6px">${costLine}</p>` : ''}</div>
      <div class="verdict-grid">
        <div class="verdict-box a"><h4>Why pick A: ${esc(shortName(a))}</h4>${pa.length ? `<ul>${pa.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<p class="cell-sub">No clear advantages over B.</p>'}</div>
        <div class="verdict-box b"><h4>Why pick B: ${esc(shortName(b))}</h4>${pb.length ? `<ul>${pb.map((x) => `<li>${x}</li>`).join('')}</ul>` : '<p class="cell-sub">No clear advantages over A.</p>'}</div>
      </div></div>`;
  }
  function catBarsHtml(a, b) {
    const rows = [{ key: 'fit', label: 'Victor fit' }, ...CATS].map((c) => {
      const va = c.key === 'fit' ? a.fit : a.s[c.key]; const vb = c.key === 'fit' ? b.fit : b.s[c.key];
      return `<div class="cat-row"><span class="${va === vb ? '' : 'win'}">${esc(c.label)}</span>
        <div class="side a"><div class="bar"><span style="width:${va.toFixed(0)}%"></span></div><b class="${va > vb ? 'win' : ''}">${va.toFixed(0)}</b></div>
        <div class="side b"><div class="bar"><span style="width:${vb.toFixed(0)}%"></span></div><b class="${vb > va ? 'win' : ''}">${vb.toFixed(0)}</b></div></div>`;
    }).join('');
    return `<div class="panel"><h3>Scores side by side <span class="cell-sub">(A left, B right)</span></h3><div class="cat-bars">${rows}</div></div>`;
  }
  function specCompareHtml(a, b) {
    const R = (label, fa, fb, better) => {
      const va = fa(a); const vb = fb ? fb(b) : fa(b);
      let wa = false; let wb = false;
      if (better) { const x = better(a); const y = better(b); if (x != null && y != null && x !== y) { wa = x > y; wb = y > x; } }
      return `<tr><td class="k">${esc(label)}</td><td class="a ${wa ? 'is-win' : ''}">${va ?? '—'}</td><td class="b ${wb ? 'is-win' : ''}">${vb ?? '—'}</td></tr>`;
    };
    const G = (label) => `<tr class="grp"><td colspan="3">${esc(label)}</td></tr>`;
    const id = (f) => f;
    const rows = [
      G('Price'),
      R('Best price', (l) => `${money2(l.price)} <span class="cell-sub">${esc(l.price_retailer || '')}</span>`, null, (l) => (l.price ? -l.price : null)),
      R('Open-box / marketplace', (l) => { const o = bestOffer(l); return [o.open_box ? `open-box ${money(o.open_box)}` : '', o.marketplace ? `${esc(o.marketplace.seller)} ${money(o.marketplace.price)}` : ''].filter(Boolean).join(' · ') || '—'; }),
      R('Gaming per $1,000', (l) => (l.price ? (l.s.gaming / l.price * 1000).toFixed(1) : '—'), null, (l) => (l.price ? l.s.gaming / l.price : null)),
      G('Performance'),
      R('Graphics', (l) => esc(gpuLabel(l)), null, (l) => l.perf),
      R('GPU power', (l) => esc(tgpNote(l) || '—'), null, (l) => l.tgp_w),
      R('Gaming index', (l) => `${l.perf.toFixed(0)} <span class="cell-sub">${esc(capability(l.perf))}</span>`, null, (l) => l.perf),
      R('Processor', (l) => `${esc(l.cpu_key)} <span class="cell-sub">${esc(cpuRef(l).cores)}</span>`, null, (l) => cpuRef(l).mt),
      R('Multi-core (≈CB2024)', (l) => cpuRef(l).mt, null, (l) => cpuRef(l).mt),
      R('Single-core (≈CB2024)', (l) => cpuRef(l).st, null, (l) => cpuRef(l).st),
      G('Memory & storage'),
      R('RAM', (l) => `${l.ram_gb}GB ${esc(l.ram_type || '')}`, null, (l) => l.ram_gb),
      R('RAM upgrades', (l) => (l.ram_soldered ? 'Soldered' : `${l.ram_slots} slots${l.ram_max_gb ? `, up to ${l.ram_max_gb}GB` : ''}`), null, (l) => (l.ram_soldered ? 0 : l.ram_max_gb || 32)),
      R('Storage', (l) => storageLabel(l.storage_gb || 0), null, (l) => l.storage_gb),
      R('M.2 slots', (l) => l.m2 ?? '—', null, (l) => l.m2 ?? null),
      G('Screen'),
      R('Size & resolution', (l) => `${(l.display || {}).size || '?'}" ${resLabel(l.display)}`, null, (l) => (l.display || {}).w * (l.display || {}).h),
      R('Panel', (l) => esc((l.display || {}).panel || '—'), null, (l) => ({ OLED: 3, 'Mini-LED': 3, IPS: 1 }[(l.display || {}).panel] || 0)),
      R('Refresh rate', (l) => ((l.display || {}).hz ? `${l.display.hz}Hz` : '—'), null, (l) => (l.display || {}).hz),
      R('Brightness', (l) => ((l.display || {}).nits ? `${l.display.nits} nits` : '—'), null, (l) => (l.display || {}).nits),
      G('Portability'),
      R('Weight', (l) => (l.weight_lb ? `${l.weight_lb} lb` : '—'), null, (l) => (l.weight_lb ? -l.weight_lb : null)),
      R('Thickness', (l) => (l.thickness_in ? `${l.thickness_in}"` : '—'), null, (l) => (l.thickness_in ? -l.thickness_in : null)),
      R('Battery', (l) => (l.battery_wh ? `${l.battery_wh} Wh` : '—'), null, (l) => l.battery_wh),
      G('Connectivity'),
      R('Thunderbolt / USB4', (l) => [((l.ports || {}).tb ? `${l.ports.tb}× TB` : ''), ((l.ports || {}).usb4 ? 'USB4' : '')].filter(Boolean).join(' · ') || 'No', null, (l) => ((l.ports || {}).tb || 0) + ((l.ports || {}).usb4 ? 1 : 0)),
      R('Other ports', (l) => esc([(l.ports || {}).usb, (l.ports || {}).hdmi ? 'HDMI' : '', (l.ports || {}).eth ? 'Ethernet' : ''].filter(Boolean).join(' · ') || '—')),
      R('Wi-Fi', (l) => esc(l.wifi || '—'), null, (l) => ({ 'Wi-Fi 7': 3, 'Wi-Fi 6E': 2, 'Wi-Fi 6': 1 }[l.wifi] || null)),
      G('Reputation'),
      R('Customer rating', (l) => (l.rating ? `${l.rating}★ (${(l.reviews || 0).toLocaleString()})` : '—'), null, (l) => ((l.reviews || 0) >= 10 ? l.rating : null)),
      R('Expert picks', (l) => (l.awards || []).map((x) => esc(`${x.label} (${x.source})`)).join('<br>') || '—'),
    ];
    void id;
    return `<div class="table-wrap"><table class="grid-table spec-compare"><thead><tr><th></th><th style="color:var(--accent)">A · ${esc(shortName(a))}</th><th style="color:var(--cool)">B · ${esc(shortName(b))}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  // ------------------------------------------------------------------ COSTS
  const GPU_COLORS = { 'RTX 5090': '#7b2cbf', 'RTX 5080': '#b5179e', 'RTX 5070 Ti': '#d9481f', 'RTX 5070': '#f08c00', 'RTX 5060': '#2b9348', 'RTX 5050': '#1b7385', 'RTX 4050': '#5c7cfa', 'RTX 3050': '#868e96', 'Radeon 8060S': '#c92a2a', 'Arc B390': '#4263eb' };
  function frontier(points) {
    const s = [...points].sort((p, q) => p.x - q.x || q.y - p.y); const out = []; let best = -Infinity;
    s.forEach((p) => { if (p.y > best) { out.push(p); best = p.y; } });
    return out;
  }
  function renderScatter() {
    const key = state.yAxis; const pts = L.filter((l) => l.price && available(l)).map((l) => ({ l, x: l.price, y: key === 'fit' ? l.fit : l.s[key] }));
    const W = 980; const H = 420; const m = { l: 56, r: 20, t: 16, b: 46 };
    if (!pts.length) { $('#scatter').innerHTML = '<p class="empty">No confirmed in-stock prices to chart.</p>'; $('#scatter-legend').innerHTML = ''; return; }
    const xmin = Math.floor(Math.min(...pts.map((p) => p.x)) / 500) * 500; const xmax = Math.max(xmin + 500, Math.ceil(Math.max(...pts.map((p) => p.x)) / 500) * 500);
    const ymin = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)) / 10) * 10); const ymax = Math.max(ymin + 10, Math.min(100, Math.ceil(Math.max(...pts.map((p) => p.y)) / 10) * 10));
    const X = (v) => m.l + ((v - xmin) * (W - m.l - m.r)) / (xmax - xmin); const Y = (v) => H - m.b - ((v - ymin) * (H - m.t - m.b)) / (ymax - ymin);
    let g = '';
    for (let v = xmin; v <= xmax; v += 500) g += `<line class="grid" x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${H - m.b}"/><text x="${X(v)}" y="${H - m.b + 16}" text-anchor="middle">${money(v)}</text>`;
    for (let v = ymin; v <= ymax; v += 10) g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`;
    const fr = frontier(pts);
    const fpath = fr.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    const label = { gaming: 'Gaming score', work: 'Work score', fit: 'Victor fit score' }[key];
    const dots = pts.map((p) => `<circle class="dot ${(REF.gpus[p.l.gpu_key] || {}).kind === 'iGPU' ? 'igpu' : ''}" tabindex="0" r="6.5" cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" fill="${GPU_COLORS[p.l.gpu_key] || '#888'}" stroke="${(REF.gpus[p.l.gpu_key] || {}).kind === 'iGPU' ? GPU_COLORS[p.l.gpu_key] : ''}" data-open="${p.l.id}" data-tip="${esc(`${shortName(p.l)} · ${p.l.gpu_key} · ${money(p.l.price)} · ${label} ${p.y.toFixed(0)}`)}"><title>${esc(shortName(p.l))} ${money(p.l.price)}</title></circle>`).join('');
    const placed = []; const dotsXY = pts.map((p) => [X(p.x), Y(p.y)]);
    const labels = fr.map((p) => {
      const txt = p.l.name.replace(/\s*\(.*\)/, ''); const w = txt.length * 6.4 + 4; const h = 13;
      const cands = [[9, -9], [9, 16], [-w - 9, -9], [-w - 9, 16]];
      for (const [dx, dy] of cands) {
        const x = X(p.x) + dx; const y = Y(p.y) + dy; const box = [x, y - h + 3, x + w, y + 3];
        if (box[0] < m.l || box[2] > W - m.r || box[1] < m.t) continue;
        const hit = placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3])) || dotsXY.some(([cx, cy]) => cx > box[0] - 5 && cx < box[2] + 5 && cy > box[1] - 5 && cy < box[3] + 5);
        if (!hit) { placed.push(box); return `<text class="dot-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${esc(txt)}</text>`; }
      }
      return '';
    }).join('');
    $('#scatter').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter plot of price versus ${label} for ${pts.length} laptops">${g}<text class="axis-title" x="${(W + m.l) / 2}" y="${H - 6}" text-anchor="middle">Price (USD, current)</text><text class="axis-title" transform="translate(14 ${(H - m.b) / 2}) rotate(-90)" text-anchor="middle">${label}</text><path class="frontier" d="${fpath}"/>${dots}${labels}</svg>`;
    const used = [...new Set(pts.map((p) => p.l.gpu_key))].sort((a, b) => (REF.gpus[b] || {}).perf - (REF.gpus[a] || {}).perf);
    $('#scatter-legend').innerHTML = used.map((gk) => `<span><i style="${(REF.gpus[gk] || {}).kind === 'iGPU' ? `border:2.5px solid ${GPU_COLORS[gk]};background:transparent` : `background:${GPU_COLORS[gk] || '#888'}`}"></i>${esc(gk)}${(REF.gpus[gk] || {}).kind === 'iGPU' ? ' (built-in)' : ''}</span>`).join('') + '<span><i style="background:transparent;border:2px dashed var(--accent);border-radius:0;height:0;width:16px"></i>Best-value line</span>';
  }
  function renderCosts() {
    renderScatter();
    const pool = L.filter((l) => l.price && available(l));
    const v = [...pool].sort((a, b) => b.s.gaming / b.price - a.s.gaming / a.price).slice(0, 12);
    $('#value-table').innerHTML = `<div class="table-wrap" style="box-shadow:none"><table class="grid-table"><thead><tr><th>Laptop</th><th class="r">Price</th><th>GPU</th><th class="r">Gaming pts per $1k</th><th class="r">Work pts per $1k</th></tr></thead><tbody>${v.map((l) => `<tr class="is-clickable" data-open="${l.id}" tabindex="0"><td><div class="cell-title">${esc(shortName(l))}</div><div class="cell-sub">${esc(l.cpu_key)} · ${l.ram_gb}GB</div></td><td class="r num">${money(l.price)}</td><td>${esc(l.gpu_key)}</td><td class="r num">${(l.s.gaming / l.price * 1000).toFixed(1)}</td><td class="r num">${(l.s.work / l.price * 1000).toFixed(1)}</td></tr>`).join('')}</tbody></table></div>`;
    // GPU ladder
    const gpus = Object.keys(REF.gpus).filter((g) => pool.some((l) => l.gpu_key === g)).sort((a, b) => REF.gpus[a].perf - REF.gpus[b].perf);
    let prev = null;
    const ladder = gpus.map((gk) => {
      const ls = pool.filter((l) => l.gpu_key === gk); const cheapest = ls.reduce((a, b) => (b.price < a.price ? b : a));
      const med = median(ls.map((l) => l.price)); const perf = REF.gpus[gk].perf;
      const row = { gk, n: ls.length, cheapest, med, perf, step: prev ? { cost: cheapest.price - prev.cheapest.price, gain: perf / prev.perf - 1 } : null };
      prev = row; return row;
    });
    $('#gpu-ladder').innerHTML = `<div class="table-wrap" style="box-shadow:none"><table class="grid-table"><thead><tr><th>GPU</th><th class="r">Index</th><th class="r">From</th><th class="r">Median</th><th class="r">$ per index pt</th><th>Step up from the tier below</th></tr></thead><tbody>${ladder.map((r) => `<tr><td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${GPU_COLORS[r.gk] || '#888'};margin-right:6px"></span>${esc(r.gk)} <span class="cell-sub">(${r.n})</span></td><td class="r num">${r.perf}</td><td class="r num"><button class="lcard-title num" style="font-size:0.86rem;font-family:var(--font-mono)" type="button" data-open="${r.cheapest.id}">${money(r.cheapest.price)}</button></td><td class="r num">${money(r.med)}</td><td class="r num">${money(r.cheapest.price / r.perf)}</td><td class="cell-sub">${r.step ? `${r.step.cost >= 0 ? '+' : '−'}${money(Math.abs(r.step.cost))} for ${pct(r.step.gain)} performance` : 'Entry point'}</td></tr>`).join('')}</tbody></table></div>`;
    // thin premium
    const thinRows = gpus.map((gk) => {
      const ls = pool.filter((l) => l.gpu_key === gk && l.thickness_in);
      const thin = ls.filter((l) => l.thickness_in < 0.8); const thick = ls.filter((l) => l.thickness_in >= 0.8);
      if (!thin.length || !thick.length) return null;
      const mt = median(thin.map((l) => l.price)); const mk = median(thick.map((l) => l.price));
      const pt = median(thin.map((l) => l.perf)); const pk = median(thick.map((l) => l.perf));
      return `<tr><td>${esc(gk)}</td><td class="r num">${money(mt)} <span class="cell-sub">(${thin.length})</span></td><td class="r num">${money(mk)} <span class="cell-sub">(${thick.length})</span></td><td class="r num">${pct(mt / mk - 1)}</td><td class="r num">${pct(pt / pk - 1)}</td></tr>`;
    }).filter(Boolean);
    $('#thin-premium').innerHTML = thinRows.length ? `<div class="table-wrap" style="box-shadow:none"><table class="grid-table"><thead><tr><th>GPU</th><th class="r">Slim median</th><th class="r">Regular median</th><th class="r">Price gap</th><th class="r">Speed gap</th></tr></thead><tbody>${thinRows.join('')}</tbody></table></div><p class="chart-note" style="margin-top:8px">Slim laptops usually run the same GPU at lower power, so you often pay more for less speed in exchange for weight and looks.</p>` : '<p class="empty">Not enough data.</p>';
    // deals
    const deals = pool.map((l) => {
      const o = bestOffer(l); const off = l.regular && l.regular > l.price ? l.regular - l.price : 0;
      const alt = [o.open_box ? { kind: 'Open-box', p: o.open_box } : null, o.marketplace && o.marketplace.price < l.price ? { kind: o.marketplace.seller, p: o.marketplace.price } : null].filter(Boolean).sort((a, b) => a.p - b.p)[0];
      return { l, off, alt };
    }).filter((d) => d.off >= 50 || d.alt).sort((a, b) => Math.max(b.off, b.alt ? b.l.price - b.alt.p : 0) - Math.max(a.off, a.alt ? a.l.price - a.alt.p : 0)).slice(0, 12);
    $('#deal-table').innerHTML = `<div class="table-wrap" style="box-shadow:none"><table class="grid-table"><thead><tr><th>Laptop</th><th class="r">Price</th><th class="r">Listed discount</th><th>Cheaper option</th></tr></thead><tbody>${deals.map((d) => `<tr class="is-clickable" data-open="${d.l.id}" tabindex="0"><td><div class="cell-title">${esc(shortName(d.l))}</div><div class="cell-sub">${esc(d.l.gpu_key)}</div></td><td class="r num">${money(d.l.price)}</td><td class="r num">${d.off ? `−${money(d.off)}` : '—'}</td><td class="cell-sub">${d.alt ? `${esc(d.alt.kind)} ${money(d.alt.p)}` : '—'}</td></tr>`).join('')}</tbody></table></div><p class="chart-note" style="margin-top:8px">"Listed discount" is Best Buy's own comparable-value claim. Open-box units come with Best Buy's return policy; marketplace sellers are third parties.</p>`;
    $('#cost-context').innerHTML = marketContext();
  }

  // ------------------------------------------------------------------ PARTS
  function renderParts() {
    $('#explainers').innerHTML = [
      ['The GPU decides gaming', 'Every game frame is drawn by the graphics card. Going up one tier (5060 → 5070 Ti → 5080) matters far more than the CPU, brand or RAM speed.', ''],
      ['Same GPU, different speed', 'Laptops run the same GPU at different power limits (TGP). A 140W RTX 5070 Ti in a thick laptop beats a 100W one in a thin laptop by 10% or more. The site adjusts every gaming score for this.', ''],
      ['8GB vs 12GB VRAM', 'RTX 5050/5060/5070 have 8GB of graphics memory. It works today at 1080p, but new games at 1440p increasingly want 12GB+. The 5070 Ti is the cheapest 12GB card.', ''],
      ['HX vs H processors', 'HX chips (e.g. Core Ultra 9 275HX, Ryzen 9 8940HX) are desktop-class: great for video editing, coding builds and streaming. H chips are fine for school and office work and run cooler.', 'cool'],
      ['Soldered vs upgradeable RAM', 'Thin laptops solder RAM to the board (LPDDR5X), so 16GB stays 16GB forever. Thicker ones use SO-DIMM slots, so you can buy 16GB now and add more later.', 'cool'],
      ['The screen is half the experience', 'OLED and Mini-LED look dramatically better than a 300-nit IPS panel, and 16:10 screens (1200p/1600p) give more room for work.', 'cool'],
    ].map(([h, p, c]) => `<div class="explainer ${c}"><h4>${esc(h)}</h4><p>${esc(p)}</p></div>`).join('');
    const present = (gk) => L.filter((l) => l.gpu_key === gk && l.price);
    const gpus = Object.entries(REF.gpus).sort((a, b) => b[1].perf - a[1].perf);
    $('#gpu-table').innerHTML = `<div class="table-wrap" style="box-shadow:none"><table class="grid-table"><thead><tr><th>GPU</th><th style="min-width:200px">Relative speed (5060 = 100)</th><th>VRAM</th><th>Power range</th><th>What it handles</th><th class="r">Laptops / from</th><th>Notes</th></tr></thead><tbody>${gpus.map(([k, g]) => {
      const ls = present(k); const from = ls.length ? Math.min(...ls.map((l) => l.price)) : null;
      return `<tr><td><b>${esc(k)}</b><div class="cell-sub">${esc(g.gen)} · ${esc(g.tier)}</div></td><td><div class="tierbar"><div class="bar"><span style="width:${(g.perf / 2.1).toFixed(0)}%;background:${GPU_COLORS[k] || 'var(--accent)'}"></span></div><b class="num">${g.perf}</b></div></td><td class="num">${g.vram ? `${g.vram}GB` : 'shared'}</td><td class="num">${g.tgp_range[0]}–${g.tgp_range[1]}W</td><td class="cell-sub">${esc(capability(g.perf))}</td><td class="r num">${ls.length ? `${ls.length} · <button class="lcard-title num" style="font-size:0.86rem;font-family:var(--font-mono)" type="button" data-gpu-filter="${esc(k)}">${money(from)}</button>` : '—'}</td><td class="cell-sub">${esc(g.note)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
    const cpus = Object.entries(REF.cpus).filter(([k]) => L.some((l) => l.cpu_key === k)).sort((a, b) => b[1].mt - a[1].mt);
    const classLabel = { HX: 'HX · high power', H: 'H · balanced', HS: 'HS · efficient', V: 'V · low power', Max: 'Max · big APU' };
    $('#cpu-table').innerHTML = `<div class="table-wrap" style="box-shadow:none"><table class="grid-table"><thead><tr><th>Processor</th><th style="min-width:200px">Multi-core (≈ Cinebench 2024)</th><th class="r">Single-core</th><th>Cores</th><th>Class</th><th class="r">Laptops</th></tr></thead><tbody>${cpus.map(([k, c]) => `<tr><td><b>${esc(k)}</b><div class="cell-sub">${c.year}</div></td><td><div class="tierbar"><div class="bar cool"><span style="width:${(c.mt / 24).toFixed(0)}%"></span></div><b class="num">${c.mt}</b></div></td><td class="r num">${c.st}</td><td class="num">${esc(c.cores)}</td><td class="cell-sub">${esc(classLabel[c.class] || c.class)}</td><td class="r num">${L.filter((l) => l.cpu_key === k).length}</td></tr>`).join('')}</tbody></table></div>`;
    $('#ref-sources').innerHTML = `<p>${esc(REF._about)}</p><ul>${(REF.sources || []).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a></li>`).join('')}</ul>`;
  }

  // ------------------------------------------------------------------ MARKET
  function renderMarket() {
    const M = (DATA.market || {}).items || [];
    const f = state.market;
    const gpus = [...new Set(M.map((m) => m.gpu_key).filter(Boolean))].sort((a, b) => ((REF.gpus[b] || {}).perf || 0) - ((REF.gpus[a] || {}).perf || 0));
    $('#market-sub').textContent = M.length ? `Saved snapshot of gaming laptops sold and shipped by Best Buy: ${M.length} listings, captured ${fmtDate((DATA.market || {}).generated_at)}. Tracked ones are in the comparison set; the rest are here so nothing gets missed.` : 'No market scan yet.';
    $('#market-filters').innerHTML = `<div class="f"><label for="m-q">Search</label><input type="search" id="m-q" value="${esc(f.q)}" placeholder="Brand, CPU, GPU…"></div><div class="f"><label for="m-gpu">Graphics</label><select id="m-gpu"><option value="">Any</option>${gpus.map((g) => `<option ${f.gpu === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></div><label class="check"><input type="checkbox" id="m-stock" ${f.stock ? 'checked' : ''}> In stock only</label>`;
    const q = f.q.toLowerCase();
    let rows = M.filter((m) => (!q || m.title.toLowerCase().includes(q)) && (!f.gpu || m.gpu_key === f.gpu) && (!f.stock || m.status === 'in_stock'));
    const cols = [
      { k: 'title', l: 'Listing', s: (m) => m.title },
      { k: 'gpu', l: 'GPU', s: (m) => (REF.gpus[m.gpu_key] || {}).perf || 0 },
      { k: 'cpu', l: 'CPU', s: (m) => (REF.cpus[m.cpu_key] || {}).mt || 0 },
      { k: 'price', l: 'Price', s: (m) => m.price ?? 1e9, c: 'r' },
      { k: 'rating', l: 'Rating', s: (m) => m.rating || 0, c: 'r' },
      { k: 'status', l: 'Status', s: (m) => m.status },
    ];
    const col = cols.find((c) => c.k === f.sort) || cols[3];
    rows.sort((a, b) => { const x = col.s(a); const y = col.s(b); return (x > y ? 1 : x < y ? -1 : 0) * f.dir; });
    $('#market-table thead').innerHTML = '<tr>' + cols.map((c) => `<th class="${c.c || ''}" aria-sort="${f.sort === c.k ? (f.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-msort="${c.k}">${c.l}</button></th>`).join('') + '</tr>';
    $('#market-table tbody').innerHTML = rows.map((m) => `<tr><td><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a> ${m.tracked ? '<span class="chip accent">tracked</span>' : ''}</td><td>${esc(m.gpu_key || '—')}</td><td>${esc(m.cpu_key || '—')}</td><td class="r num">${money2(m.price)}${m.regular && m.regular > m.price ? `<div class="cell-sub was">${money2(m.regular)}</div>` : ''}</td><td class="r num">${m.rating ? `${m.rating}★ <span class="cell-sub">${m.reviews}</span>` : '—'}</td><td>${m.status === 'in_stock' ? '<span class="chip good">In stock</span>' : m.status === 'sold_out' ? '<span class="chip bad">Sold out</span>' : '<span class="chip">Unknown</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No listings match.</td></tr>';
  }

  // ------------------------------------------------------------------ RE-SCRAPE (GitHub Actions)
  const GH = 'https://api.github.com';
  const ghHeaders = (tok) => Object.assign({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, tok ? { Authorization: `Bearer ${tok}` } : {});
  const actionsUrl = () => `https://github.com/${CFG.repo}/actions/workflows/${CFG.workflow}`;
  function fmtDate(iso) { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function ago(iso) { const s = (Date.now() - new Date(iso).getTime()) / 1000; if (!isFinite(s)) return ''; if (s < 90) return 'just now'; if (s < 5400) return `${Math.round(s / 60)} min ago`; if (s < 129600) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} days ago`; }
  const RUNNERS = { 'github-actions': 'GitHub Actions', local: 'a computer (run by hand)', 'browser (seed)': 'first collection, in a web browser', 'browser (manual update)': 'a manual update, read in a web browser' };
  const runnerLabel = (r) => RUNNERS[r] || r || '—';
  const pricesAsOf = () => DATA.prices_as_of || DATA.generated_at;
  function lastRunFailed() { const sc = DATA.scrape || {}; return ['live', 'manual'].includes(sc.mode) && !sc.ok && !!sc.failed; }
  function renderFreshness() {
    const sc = DATA.scrape || {}; const iso = pricesAsOf(); const hours = (Date.now() - new Date(iso).getTime()) / 36e5;
    const failed = lastRunFailed();
    const el = $('#freshness'); el.classList.remove('is-fresh', 'is-aging', 'is-stale');
    el.classList.add(failed ? (hours < 96 ? 'is-aging' : 'is-stale') : hours < 36 ? 'is-fresh' : hours < 96 ? 'is-aging' : 'is-stale');
    $('#freshness-text').textContent = `Oldest price ${ago(iso)} · ${L.length} laptops${failed ? ' · last refresh failed' : sc.failed ? ` · ${sc.failed} not refreshed` : ''}`;
    el.title = `Prices confirmed ${fmtDate(iso)}. Last scrape attempt ${fmtDate(DATA.generated_at)} on ${runnerLabel(sc.runner)}.`;
    sizeHeader();
  }
  function modal(html) { if ($('#modal-backdrop').hidden) modalTrigger = document.activeElement; $('#modal').innerHTML = html; $('#modal-backdrop').hidden = false; const f = $('#modal [autofocus], #modal button, #modal input'); if (f) f.focus(); }
  function closeModal() { const wasOpen = !$('#modal-backdrop').hidden; $('#modal-backdrop').hidden = true; if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } if (wasOpen && modalTrigger?.isConnected) modalTrigger.focus(); }
  let pollTimer = null;
  function statusHtml() {
    const sc = DATA.scrape || {};
    const names = {}; L.forEach((l) => l.offers.forEach((o) => { names[o.retailer] = o.retailer_name || o.retailer; }));
    const per = Object.entries(sc.by_retailer || {}).map(([r, v]) => `${esc(names[r] || r)}: ${v.ok} ok${v.failed ? `, ${v.failed} failed` : ''}`).join(' · ');
    const sameTime = pricesAsOf() === DATA.generated_at;
    return `<dl class="kv"><dt>Prices confirmed</dt><dd>${esc(fmtDate(pricesAsOf()))} (${esc(ago(pricesAsOf()))})</dd>${sameTime ? '' : `<dt>Last attempt</dt><dd>${esc(fmtDate(DATA.generated_at))} (${esc(ago(DATA.generated_at))})</dd>`}<dt>Ran on</dt><dd>${esc(runnerLabel(sc.runner))}</dd><dt>Offers confirmed</dt><dd>${sc.ok ?? '—'} of ${sc.tracked_offers ?? '—'}${per ? ` · ${per}` : ''}</dd><dt>Automatic runs</dt><dd>${esc(CFG.schedule || 'daily')}</dd>${(sc.notes || []).length ? `<dt>Notes</dt><dd>${sc.notes.map(esc).join('<br>')}</dd>` : ''}</dl>`;
  }
  function openRescrape() {
    const tok = store.get('ghToken', '');
    modal(`<h3 id="modal-title">Re-scrape all prices</h3>${statusHtml()}
      <p class="sub">Re-scraping runs the price scraper on GitHub (about 5–10 minutes), saves the new prices and republishes this site. Prices also refresh on their own ${esc(CFG.schedule || 'every day')}.</p>
      ${tok ? `<div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-accent" type="button" id="go-scrape" autofocus>Start re-scrape now</button><button class="btn btn-ghost btn-sm" type="button" id="forget-token">Forget saved key</button></div>`
      : `<p class="sub">Starting it needs a re-scrape key${CFG.maintainer ? ` from ${esc(CFG.maintainer)}` : ''}. Paste it once; it's saved in this browser only.</p>
        <label class="cell-sub" for="tok-in">Re-scrape key</label><input type="password" id="tok-in" autocomplete="off" placeholder="github_pat_…">
        <div class="modal-actions" style="justify-content:flex-start"><button class="btn btn-accent" type="button" id="save-go">Save key and re-scrape</button></div>
        <details class="cell-sub"><summary>Making a key (repo owner)</summary><ol><li>On GitHub, open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Settings → Developer settings → Fine-grained tokens</a>.</li><li>Repository access: only <b>${esc(CFG.repo)}</b>. Permissions: <b>Actions: Read and write</b>. Nothing else.</li><li>Paste it above, or send it to whoever should be able to re-scrape. The key grants Actions read/write access on this repository. Use a short expiry and forget the key on shared computers.</li></ol><p>Or skip the key: <a href="${esc(actionsUrl())}" target="_blank" rel="noopener">open the workflow on GitHub</a> and press "Run workflow".</p></details>`}
      <div class="status-list" id="run-status"></div>
      <div class="modal-actions"><button class="btn" type="button" id="reload-data">Reload latest data</button><button class="btn" type="button" data-close-modal>Close</button></div>`);
    showLastRun(tok);
  }
  async function showLastRun(tok) {
    try {
      const r = await fetch(`${GH}/repos/${CFG.repo}/actions/workflows/${CFG.workflow}/runs?per_page=1`, { headers: ghHeaders(tok) });
      if (!r.ok) return;
      const run = ((await r.json()).workflow_runs || [])[0]; if (!run) return;
      const el = $('#run-status'); if (!el || el.dataset.busy) return;
      el.innerHTML = `<div class="status-step ${run.status !== 'completed' ? 'run' : run.conclusion === 'success' ? 'done' : 'fail'}"><span class="s"></span>Latest workflow run: ${esc(run.status === 'completed' ? run.conclusion : run.status)} · ${esc(ago(run.created_at))} · <a href="${esc(run.html_url)}" target="_blank" rel="noopener">view log</a></div>`;
    } catch (e) { /* offline or blocked: ignore */ }
  }
  async function dispatchScrape(tok) {
    const el = $('#run-status'); el.dataset.busy = '1';
    const step = (cls, text) => { el.insertAdjacentHTML('beforeend', `<div class="status-step ${cls}"><span class="s"></span>${text}</div>`); };
    const t0 = new Date(Date.now() - 60000).toISOString();
    const before = DATA.generated_at;
    try {
      const r = await fetch(`${GH}/repos/${CFG.repo}/actions/workflows/${CFG.workflow}/dispatches`, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(tok)), body: JSON.stringify({ ref: CFG.branch || 'main' }) });
      if (r.status === 401 || r.status === 403) { step('fail', 'GitHub refused the key. It needs Actions: Read and write on this repository, and it may have expired.'); return; }
      if (r.status === 404) { step('fail', 'Workflow not found. Make sure the repo has been pushed and the key can see it.'); return; }
      if (!r.ok) { step('fail', `GitHub returned ${r.status}.`); return; }
      step('done', 'Re-scrape requested.');
    } catch (e) {
      step('fail', `Couldn't reach GitHub from this page (${esc(e.message)}). If you're viewing a preview, use the hosted site: <a href="${esc(CFG.siteUrl)}" target="_blank" rel="noopener">${esc(CFG.siteUrl)}</a>`);
      return;
    }
    el.insertAdjacentHTML('beforeend', '<div class="status-step run" id="live-step"><span class="s"></span><span>Waiting for the run to start…</span></div>');
    const live = $('#live-step');
    const poll = async () => {
      try {
        const r = await fetch(`${GH}/repos/${CFG.repo}/actions/workflows/${CFG.workflow}/runs?per_page=5&event=workflow_dispatch`, { headers: ghHeaders(tok) });
        const runs = ((await r.json()).workflow_runs || []).filter((x) => x.created_at >= t0);
        const run = runs[0];
        if (run) {
          live.lastChild.innerHTML = `Run ${esc(run.status === 'completed' ? run.conclusion : run.status.replace('_', ' '))} · <a href="${esc(run.html_url)}" target="_blank" rel="noopener">watch on GitHub</a>`;
          if (run.status === 'completed') {
            live.className = `status-step ${run.conclusion === 'success' ? 'done' : 'fail'}`;
            if (run.conclusion === 'success') { step('run', 'Publishing new data…'); waitForData(before, step); } else step('fail', 'The run failed. Open the log to see which step broke; the old prices stay up meanwhile.');
            return;
          }
        }
      } catch (e) { /* keep polling */ }
      pollTimer = setTimeout(poll, 8000);
    };
    pollTimer = setTimeout(poll, 5000);
  }
  async function waitForData(before, step, tries = 0) {
    try {
      const d = await (await fetch(`data/laptops.json?ts=${Date.now()}`, { cache: 'no-store' })).json();
      if (d.generated_at !== before) {
        DATA = d; boot(true); const s = $$('.status-step.run').pop();
        const sc = d.scrape || {};
        if (lastRunFailed()) { if (s) s.className = 'status-step fail'; step('fail', `The scraper ran but couldn't read any prices (the stores may be refusing automated requests). Prices from ${esc(fmtDate(pricesAsOf()))} stay up. See the README for fixes.`); return; }
        if (s) s.className = 'status-step done';
        step('done', `New data loaded: ${sc.ok} offers confirmed${sc.failed ? `, ${sc.failed} couldn't be read (last known price kept)` : ''}.`);
        return;
      }
    } catch (e) { /* retry */ }
    if (tries < 30) pollTimer = setTimeout(() => waitForData(before, step, tries + 1), 10000);
    else step('fail', 'The run finished but the site hasn\'t updated yet. GitHub Pages can lag a few minutes; reload later.');
  }

  // ------------------------------------------------------------------ routing + events
  const VIEWS = ['picks', 'browse', 'compare', 'costs', 'parts', 'market'];
  const currentView = () => { const h = (location.hash || '').replace('#', ''); return VIEWS.includes(h) ? h : 'picks'; };
  function route() {
    const v = currentView();
    VIEWS.forEach((x) => { $(`#view-${x}`).hidden = x !== v; });
    $$('.tabs a').forEach((a) => a.classList.toggle('is-active', a.dataset.view === v));
    ({ picks: renderPicks, browse: () => { renderFilters(); renderBrowse(); }, compare: renderCompare, costs: renderCosts, parts: renderParts, market: renderMarket })[v]();
    updateCompareUi();
  }
  function savePrefs() { store.set('prefs', state.prefs); recomputeFit(); }
  function sizeHeader() {
    const inner = $('.topbar-inner');
    document.documentElement.style.setProperty('--topbar-hide', `${window.matchMedia('(max-width: 760px)').matches && inner ? inner.offsetHeight : 0}px`);
  }
  function bind() {
    sizeHeader(); window.addEventListener('resize', sizeHeader); if (document.fonts) document.fonts.ready.then(sizeHeader);
    window.addEventListener('hashchange', () => { closeDrawer(); route(); window.scrollTo(0, 0); });
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-open],[data-cmp],[data-cmp-set],[data-sort],[data-msort],[data-preset],[data-close-drawer],[data-close-modal],[data-clear-compare],[data-pair],[data-gpu-filter],.seg-btn,#swap-btn,#rescrape-btn,#freshness,#theme-btn,#go-scrape,#save-go,#forget-token,#reload-data');
      if (!t) return;
      if (t.matches('[data-cmp]')) { e.stopPropagation(); setCompare(t.dataset.cmp, t.dataset.id); return; }
      if (t.matches('[data-cmp-set]')) { setCompare(t.dataset.cmpSet, t.dataset.id); closeDrawer(); if (state.compare.a && state.compare.b) location.hash = '#compare'; return; }
      if (t.matches('[data-open]')) { openDrawer(t.dataset.open); return; }
      if (t.matches('[data-sort]')) { const k = t.dataset.sort; state.browse.dir = state.browse.sort === k ? -state.browse.dir : (['name', 'price', 'weight'].includes(k) ? 1 : -1); state.browse.sort = k; renderBrowse(); return; }
      if (t.matches('[data-msort]')) { const k = t.dataset.msort; state.market.dir = state.market.sort === k ? -state.market.dir : (k === 'price' || k === 'title' ? 1 : -1); state.market.sort = k; renderMarket(); return; }
      if (t.matches('[data-preset]')) { const p = PRESETS.find((x) => x.id === t.dataset.preset); state.prefs.preset = p.id; state.prefs.weights = { ...p.w }; savePrefs(); renderPrefs(); route(); return; }
      if (t.matches('[data-close-drawer]')) { closeDrawer(); return; }
      if (t.matches('[data-close-modal]')) { closeModal(); return; }
      if (t.matches('[data-clear-compare]')) { state.compare = { a: null, b: null }; store.set('compare', state.compare); updateCompareUi(); return; }
      if (t.matches('[data-pair]')) { const [a, b] = t.dataset.pair.split('|'); state.compare = { a, b }; store.set('compare', state.compare); renderCompare(); updateCompareUi(); return; }
      if (t.matches('[data-gpu-filter]')) { state.browse.gpu = t.dataset.gpuFilter; state.browse.stockOnly = true; location.hash = '#browse'; return; }
      if (t.matches('.seg-btn')) { state.yAxis = t.dataset.y; $$('.seg-btn').forEach((b) => b.classList.toggle('is-on', b === t)); renderScatter(); return; }
      if (t.id === 'swap-btn') { state.compare = { a: state.compare.b, b: state.compare.a }; store.set('compare', state.compare); renderCompare(); return; }
      if (t.id === 'rescrape-btn' || t.id === 'freshness') { openRescrape(); return; }
      if (t.id === 'theme-btn') { const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); const nx = cur === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = nx; store.set('theme', nx); return; }
      if (t.id === 'go-scrape') { t.disabled = true; dispatchScrape(store.get('ghToken', '')); return; }
      if (t.id === 'save-go') { const v = ($('#tok-in').value || '').trim(); if (!v) { $('#tok-in').focus(); return; } store.set('ghToken', v); t.disabled = true; dispatchScrape(v); return; }
      if (t.id === 'forget-token') { store.del('ghToken'); closeModal(); openRescrape(); return; }
      if (t.id === 'reload-data') { reloadData(); return; }
    });
    document.addEventListener('input', (e) => {
      const t = e.target;
      if (t.id === 'budget-max') { state.prefs.budget = +t.value; $('#budget-out').textContent = money(+t.value); savePrefs(); renderPicks(); return; }
      if (t.dataset.weight) { state.prefs.weights[t.dataset.weight] = +t.value; t.nextElementSibling.textContent = t.value; state.prefs.preset = 'custom'; $$('.preset').forEach((p) => p.classList.remove('is-on')); savePrefs(); renderPicks(); return; }
      if (t.id === 'f-q') { state.browse.q = t.value; renderBrowse(); return; }
      if (t.id === 'm-q') { state.market.q = t.value; renderMarket(); $('#m-q').focus(); const v = $('#m-q').value; $('#m-q').setSelectionRange(v.length, v.length); return; }
    });
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.must) { state.prefs.musts[t.dataset.must] = t.checked; savePrefs(); renderPicks(); return; }
      const map = { 'f-gpu': 'gpu', 'f-brand': 'brand', 'f-size': 'size', 'f-weight': 'maxWeight' };
      if (map[t.id]) { state.browse[map[t.id]] = t.value; renderBrowse(); return; }
      if (t.id === 'f-budget') { state.browse.inBudget = t.checked; renderBrowse(); return; }
      if (t.id === 'f-stock') { state.browse.stockOnly = t.checked; renderBrowse(); return; }
      if (t.id === 'm-gpu') { state.market.gpu = t.value; renderMarket(); return; }
      if (t.id === 'm-stock') { state.market.stock = t.checked; renderMarket(); return; }
      if (t.dataset.pick) { state.compare[t.dataset.pick] = t.value || null; store.set('compare', state.compare); renderCompare(); updateCompareUi(); }
    });
    document.addEventListener('keydown', (e) => {
      const dialog = !$('#modal-backdrop').hidden ? $('#modal') : !$('#drawer').hidden ? $('#drawer') : null;
      if (e.key === 'Tab' && dialog) {
        const focusable = $$('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]', dialog).filter((el) => el.getClientRects().length);
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (first && (e.shiftKey ? document.activeElement === first || !dialog.contains(document.activeElement) : document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      }
      if (e.key === 'Escape') { if (!$('#modal-backdrop').hidden) closeModal(); else if (!$('#drawer').hidden) closeDrawer(); }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('circle.dot,tr[data-open]')) { e.preventDefault(); openDrawer(e.target.dataset.open); }
    });
    $('#drawer-backdrop').addEventListener('click', closeDrawer);
    $('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });
    // chart tooltip
    let tip = null;
    document.addEventListener('mouseover', (e) => { const d = e.target.closest('circle.dot'); if (!d) return; tip = tip || Object.assign(document.createElement('div'), { className: 'tooltip' }); tip.textContent = d.dataset.tip; document.body.appendChild(tip); });
    document.addEventListener('mousemove', (e) => { if (tip && tip.isConnected) { tip.style.left = Math.min(e.clientX + 14, innerWidth - 270) + 'px'; tip.style.top = e.clientY + 14 + 'px'; } });
    document.addEventListener('mouseout', (e) => { if (tip && e.target.closest('circle.dot')) tip.remove(); });
  }
  async function reloadData() {
    try { DATA = await (await fetch(`data/laptops.json?ts=${Date.now()}`, { cache: 'no-store' })).json(); boot(true); closeModal(); }
    catch (e) { const el = $('#run-status'); if (el) el.insertAdjacentHTML('beforeend', `<div class="status-step fail"><span class="s"></span>Couldn't load data: ${esc(e.message)}</div>`); }
  }
  function boot(isReload) {
    L = DATA.laptops.filter((l) => l.gpu_key && l.cpu_key); BYID = Object.fromEntries(L.map((l) => [l.id, l]));
    computeAll();
    if (!isReload) renderPrefs();
    renderFreshness();
    $('#footer-text').innerHTML = `Prices scraped from retailer product pages (confirmed ${esc(fmtDate(pricesAsOf()))}) and can change at any time; check the retailer before buying. Scores are estimates built from published benchmarks. Source code and data: <a href="https://github.com/${esc(CFG.repo)}" target="_blank" rel="noopener">github.com/${esc(CFG.repo)}</a>.`;
    route();
  }
  async function init() {
    const th = store.get('theme', null); if (th) document.documentElement.dataset.theme = th;
    bind();
    try {
      const [d, r] = await Promise.all([fetch(`data/laptops.json?ts=${Date.now()}`, { cache: 'no-store' }).then((x) => x.json()), fetch('data/reference.json').then((x) => x.json())]);
      DATA = d; REF = r;
    } catch (e) {
      const b = $('#banner'); b.hidden = false; b.textContent = `Couldn't load the laptop data (${e.message}). If you opened index.html directly from disk, serve the folder instead, e.g. "python -m http.server" inside site/.`;
      return;
    }
    boot(false);
  }
  init();
})();
