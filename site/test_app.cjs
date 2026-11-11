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
