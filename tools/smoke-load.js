// Simulates the browser loading every script in index.html order inside one
// shared context, with minimal DOM/storage stubs. Catches load-time
// ReferenceErrors / TDZ issues introduced by the ui.js split.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = process.argv[2];
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map(m => m[1])
  .filter(s => !s.startsWith('http'));

const elStub = () => new Proxy({
  value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {},
  getAttribute: () => null, removeAttribute() {},
  querySelector: () => null, querySelectorAll: () => [],
}, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && k.startsWith('on') ? null : t.textContent)) });

const sandbox = {
  console,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: {
    getElementById: () => elStub(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => elStub(),
    addEventListener() {},
    body: elStub(),
    documentElement: elStub(),
  },
  fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
  setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
  Chart: function () {}, google: undefined, indexedDB: undefined,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let failed = false;
for (const src of srcs) {
  const code = fs.readFileSync(path.join(ROOT, src), 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: src });
    console.log(`OK   ${src}`);
  } catch (e) {
    console.error(`FAIL ${src}: ${e.message}`);
    failed = true;
  }
}

// Post-load sanity. window.ui/window.app are real window properties;
// cfg/sheets/compute are global *lexical* bindings (const), so they must be
// probed from inside the context, not read off the sandbox object.
const probe = (expr) => {
  try { return vm.runInContext(expr, sandbox) === true; } catch (e) { return false; }
};
const checks = [
  ['window.ui exists', !!sandbox.window.ui],
  ['window.app exists', !!sandbox.window.app],
  ['ui.renderStoreOverview', typeof (sandbox.window.ui || {}).renderStoreOverview === 'function'],
  ['ui.renderKeyMetrics', typeof (sandbox.window.ui || {}).renderKeyMetrics === 'function'],
  ['ui.renderIncentives', typeof (sandbox.window.ui || {}).renderIncentives === 'function'],
  ['ui.filterSupervisors', typeof (sandbox.window.ui || {}).filterSupervisors === 'function'],
  ['app.init', typeof (sandbox.window.app || {}).init === 'function'],
  ['app.refresh', typeof (sandbox.window.app || {}).refresh === 'function'],
  ['cfg.get (lexical)', probe('typeof cfg.get === "function"')],
  ['sheets.loadFromCache (lexical)', probe('typeof sheets.loadFromCache === "function"')],
  ['compute.computeWindowKpis (lexical)', probe('typeof compute.computeWindowKpis === "function"')],
  ['cross-file call resolution', probe('typeof _kmSnapshot === "function" && typeof _initTableSort === "function" && typeof _fmt === "function"')],
];
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
