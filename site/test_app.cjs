// Run with node site/test_app.cjs. Exercises the production calculations without a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const site = __dirname;
const source = fs.readFileSync(path.join(site, 'assets/app.js'), 'utf8');
const elements = new Map();
const handlers = new Map();
const element = (selector) => {
  if (!elements.has(selector)) elements.set(selector, {
    innerHTML: '', textContent: '', hidden: true, isConnected: true,
    addEventListener() {}, querySelector: element, querySelectorAll: () => [],
    getClientRects: () => [{}], contains: () => false,
    focus() { context.document.activeElement = this; },
  });
  return elements.get(selector);
};
const context = vm.createContext({
  window: { SITE_CONFIG: { owner: 'Victor' }, matchMedia: () => ({ matches: false }), addEventListener() {} },
  document: { querySelector: element, querySelectorAll: () => [], documentElement: { style: { setProperty() {} } }, addEventListener: (name, fn) => handlers.set(name, fn) },
  localStorage: { getItem: () => null },
  console,
});
assert(source.includes('  init();'), 'test hook must replace the startup call');
vm.runInContext(source.replace('  init();', `
  globalThis.app = {
    load(data, ref) { DATA = data; REF = ref; L = data.laptops; BYID = Object.fromEntries(L.map(l => [l.id, l])); computeAll(); },
    state, verdictHtml, renderBrowse, renderScatter, renderMarket, upgrade, available, freshPrice, scoreAssumptions,
    passesMusts, renderPicks, browseRows, verifiedDiscount, priceBlock, renderCosts,
    bind, openDrawer, closeDrawer, modal, closeModal,
  };`), context);
new vm.Script(fs.readFileSync(path.join(site, 'assets/config.js'), 'utf8'));
const data = JSON.parse(fs.readFileSync(path.join(site, 'data/laptops.json'), 'utf8'));
const ref = JSON.parse(fs.readFileSync(path.join(site, 'data/reference.json'), 'utf8'));
const { app } = context;
app.load(data, ref);

let checks = 0;
function check(label, fn) { fn(); console.log('PASS ' + label); checks++; }
check('generated configurations have unique IDs and known component references', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(site, 'data/catalog.json'), 'utf8'));
  assert.equal(data.laptops.length, catalog.laptops.length);
  assert.equal(new Set(data.laptops.map(l => l.id)).size, data.laptops.length);
  for (const l of data.laptops) { assert(ref.cpus[l.cpu_key], l.id); assert(ref.gpus[l.gpu_key], l.id); }
});
check('gaming and CPU advantages are unchanged when comparison slots swap', () => {
  const a = data.laptops.find(l => l.gpu_key === 'RTX 5060');
  const b = data.laptops.find(l => l.gpu_key === 'RTX 5090');
  const claims = (x, y) => app.verdictHtml(x, y).match(/About \d+% faster[^<]*/g).sort();
  assert.deepEqual(claims(a, b), claims(b, a));
  const expected = Math.round((Math.max(a.perf, b.perf) / Math.min(a.perf, b.perf) - 1) * 100);
  assert(app.verdictHtml(a, b).includes(`About ${expected}% faster in games`));
});
check('unknown stock and marketplace-only offers do not pass the stock filter', () => {
  const l = { offers: [{ in_stock: null }] };
  assert.equal(app.available(l), false);
  l.offers[0].in_stock = true;
  assert.equal(app.available(l), true);
  l.offers[0].marketplace_only = true;
  assert.equal(app.available(l), false);
});
check('missing SSD slot counts receive no invented upgrade points', () => {
  assert.equal(app.upgrade({ ram_soldered: false, ram_slots: 2, ports: {} }), 50);
  assert(app.scoreAssumptions({ display: {} }).includes('SSD slot count'));
});
check('recent-price filtering rejects failed checks, estimates and older quotes', () => {
  const offer = { checked_at: new Date().toISOString() };
  const l = { offers: [offer] };
  assert.equal(app.freshPrice(l), true);
  offer.stale = true;
  assert.equal(app.freshPrice(l), false);
  offer.stale = false;
  offer.manual = true;
  assert.equal(app.freshPrice(l), false);
  offer.manual = false;
  offer.checked_at = new Date(Date.now() - 49 * 3600000).toISOString();
  assert.equal(app.freshPrice(l), false);
});
check('recent-price filtering is optional and migrates previously forced settings', () => {
  assert.equal(app.state.prefs.musts.fresh, false);
  for (const version of [undefined, 2]) {
    const saved = { musts: { fresh: true, ram32: true }, filterVersion: version };
    const ctx = vm.createContext({ window: {}, localStorage: { getItem: () => JSON.stringify(saved), setItem() {} } });
    vm.runInContext(source.replace('  init();', '  globalThis.prefs = state.prefs;'), ctx);
    assert.equal(ctx.prefs.musts.fresh, version === 2);
    assert.equal(ctx.prefs.musts.ram32, true);
  }
});
check('unchecking recent prices adds matches and every matched laptop is reachable', () => {
  const saved = JSON.parse(JSON.stringify(app.state.prefs));
  app.state.prefs.budget = 6000;
  app.state.prefs.musts = { fresh: true };
  const recent = data.laptops.filter(l => app.passesMusts(l));
  app.state.prefs.musts.fresh = false;
  const all = data.laptops.filter(l => app.passesMusts(l));
  assert.equal(all.length, data.laptops.length);
  assert(recent.every(l => all.includes(l)));
  app.renderPicks();
  const markup = element('#top-picks').innerHTML + element('#more-picks').innerHTML;
  for (const l of all) assert(markup.includes(`data-open="${l.id}"`), l.id);
  assert.equal(app.browseRows().length, data.laptops.length);
  app.state.prefs = saved;
});
check('a reference price or snapshot cannot create a deal badge', () => {
  const offer = { price: 2479.99, regular: 2849.99, checked_at: new Date().toISOString(), in_stock: true, verification_method: 'page-reader' };
  const l = { price: offer.price, regular: offer.regular, offers: [offer] };
  assert.equal(app.verifiedDiscount(l), 0);
  assert(!app.priceBlock(l).includes('class="save"'));
  offer.verification_method = 'retailer-api'; offer.on_sale = true;
  assert.equal(app.verifiedDiscount(l), 370);
  offer.on_sale = false; assert.equal(app.verifiedDiscount(l), 0);
  offer.on_sale = true; offer.stale = true; assert.equal(app.verifiedDiscount(l), 0);
});
check('a user-reported MSI quote never inherits a snapshot discount', () => {
  const sample = data.laptops.find(l => l.id === 'msi-raider-16-hx-6679954');
  const l = { ...sample, price: 2849.99, regular: 2849.99, offers: [{ ...sample.offers[0], price: 2849.99, regular: 2849.99, verification_method: 'user-report', on_sale: false, checked_at: new Date().toISOString() }] };
  app.load({ laptops: [l] }, ref);
  assert.equal(app.verifiedDiscount(l), 0);
  assert(!app.priceBlock(l).includes('class="save"'));
  app.renderCosts();
  assert(!element('#deal-table').innerHTML.includes(l.id));
  app.load(data, ref);
});
check('browse rows support keyboard access and column headers expose sorting', () => {
  app.renderBrowse();
  assert(element('#browse-table tbody').innerHTML.includes('tabindex="0"'));
  assert.match(element('#browse-table thead').innerHTML, /<th[^>]*aria-sort="descending"/);
  assert(!/<button[^>]*aria-sort=/.test(element('#browse-table thead').innerHTML));
});
check('scores remain finite and bounded across the catalog', () => {
  for (const l of data.laptops) {
    for (const value of [...Object.values(l.s), l.fit]) assert(Number.isFinite(value) && value >= 0 && value <= 100);
  }
});
check('dialogs contain Tab navigation and restore focus when closed', () => {
  app.bind();
  const trigger = element('trigger'); trigger.focus();
  app.openDrawer(data.laptops[0].id);
  assert.notEqual(context.document.activeElement, trigger);
  app.closeDrawer();
  assert.equal(context.document.activeElement, trigger);
  app.modal('<button>Close</button>');
  const dialog = element('#modal'); const first = element('first'); const last = element('last');
  dialog.querySelectorAll = () => [first, last];
  dialog.contains = el => el === first || el === last;
  let prevented = false;
  const tab = { key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } };
  last.focus(); handlers.get('keydown')(tab);
  assert(prevented); assert.equal(context.document.activeElement, first);
  prevented = false; tab.shiftKey = true; handlers.get('keydown')(tab);
  assert(prevented); assert.equal(context.document.activeElement, last);
  app.closeModal();
  assert.equal(context.document.activeElement, trigger);
});
check('zero priority weights still produce valid scatter coordinates', () => {
  app.state.prefs.weights = Object.fromEntries(Object.keys(app.state.prefs.weights).map(k => [k, 0]));
  app.load(data, ref);
  app.state.yAxis = 'fit';
  app.renderScatter();
  assert(!/NaN|Infinity/.test(element('#scatter').innerHTML));
});
check('a catalog with no available offers renders an empty chart', () => {
  app.load({ laptops: [] }, ref);
  app.renderScatter();
  assert(element('#scatter').innerHTML.includes('No confirmed in-stock prices'));
});
console.log(`${checks} site checks passed.`);
