// Shared by the website and Gemini backend. All scores are estimates, on a 0–100 scale.
export const CATEGORIES = ['gaming', 'work', 'display', 'portability', 'upgrade', 'value'];
export const DEFAULT_WEIGHTS = { gaming: 35, work: 25, display: 10, portability: 15, upgrade: 5, value: 10 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function createScoring(REF) {
  const MAX = { gpu: 202, cpu: 2350 };
  const CATS = CATEGORIES.map(key => ({ key }));
  let L = [];
  const state = { prefs: { weights: DEFAULT_WEIGHTS } };
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
  return {
    gpuPerf, cpuRef, displayScore, portability, upgrade, gamingScore, workScore,
    compute(laptops, weights = DEFAULT_WEIGHTS) {
      L = laptops; state.prefs.weights = weights; computeAll(); return L;
    },
    fit(laptops, weights) { L = laptops; state.prefs.weights = weights; recomputeFit(); },
  };
}

export const bestOffer = l => (l.offers || []).find(o => o.retailer_name === l.price_retailer) || (l.offers || [])[0] || {};
export function priceEvidence(l, now = Date.now()) {
  const o = bestOffer(l);
  const age = now - new Date(o.checked_at).getTime();
  const fresh = !o.stale && !o.manual && !['page-reader', 'unconfirmed'].includes(o.verification_method) && Number.isFinite(age) && age >= 0 && age <= 48 * 36e5;
  const available = o.in_stock === true && !o.marketplace_only;
  const status = o.verification_method === 'page-reader' ? 'page-snapshot-unconfirmed'
    : o.verification_method === 'user-report' ? 'user-reported'
    : o.manual ? 'manual-estimate'
    : fresh && ['retailer-api', 'browser-rendered'].includes(o.verification_method) ? 'retailer-confirmed-at-check'
    : 'unconfirmed-or-old';
  return { status, fresh, available, checked_at: o.checked_at || null,
    retailer: o.retailer_name || null, url: o.url || null,
    verified_discount: fresh && available && o.on_sale === true && ['retailer-api', 'browser-rendered'].includes(o.verification_method) && o.regular > l.price ? o.regular - l.price : 0 };
}
export function matchesMusts(l, musts, now = Date.now()) {
  const e = priceEvidence(l, now);
  const tests = { stock: e.available, fresh: e.fresh, dgpu: /^RTX/.test(l.gpu_key), ram32: (l.ram_gb || 0) >= 32,
    vram12: (l.vram_gb || 0) >= 12, oled: ['OLED', 'Mini-LED'].includes(l.display?.panel),
    light: (l.weight_lb || 9) < 5, upg: !l.ram_soldered, tb: (l.ports || {}).tb > 0 || !!(l.ports || {}).usb4 };
  return Object.keys(tests).every(k => !musts[k] || tests[k]);
}
