/**
 * config-store.js — effective business config resolution
 *
 * Business config lives in a `Config` tab of the main spreadsheet
 * (columns: key | value | notes) so every device sees the same values.
 * localStorage remains a per-browser fallback, and code defaults sit
 * underneath both. Resolution order at each call site:
 *
 *   sheet Config tab  >  localStorage  >  CONFIG/code defaults
 *
 * Keys are dotted paths. A value may be either:
 *   • a scalar leaf         e.g.  slaTargets.2026-07.instore.baseline | 99.2
 *   • a JSON blob           e.g.  complaintSlaCategories | ["item_missing", ...]
 * Use one style per subtree — an exact key match wins over dotted leaves
 * beneath it.
 *
 * sheets.fetchConfigData() parses the tab into a flat {key: value} map and
 * hands it to cfg.setSheetConfig(); consumers read via cfg.get(path, fallback).
 */

const cfg = (() => {
  let _flat = {}; // dotted key → parsed value (sheet rows)

  function setSheetConfig(flatMap) {
    _flat = flatMap && typeof flatMap === 'object' ? flatMap : {};
  }

  /** True when any sheet config was loaded. */
  function hasSheetConfig() { return Object.keys(_flat).length > 0; }

  /** Number of keys loaded from the sheet (for the Config panel). */
  function keyCount() { return Object.keys(_flat).length; }

  /** All loaded sheet keys, sorted (for the Config panel). */
  function keys() { return Object.keys(_flat).sort(); }

  /**
   * Resolve a dotted path against the sheet config.
   * Checks, in order: exact key → drill into an ancestor JSON blob →
   * assemble an object from dotted descendant leaves.
   * Returns fallback when the sheet has nothing for the path.
   */
  function get(path, fallback = undefined) {
    const v = _resolve(String(path || ''));
    return v === undefined ? fallback : v;
  }

  /** True when the sheet provides a value for this path (for provenance). */
  function has(path) { return _resolve(String(path || '')) !== undefined; }

  function _resolve(path) {
    if (!path) return undefined;
    if (Object.prototype.hasOwnProperty.call(_flat, path)) return _flat[path];

    // Ancestor blob: slaTargets = {...} answers slaTargets.2026-07.instore
    const parts = path.split('.');
    for (let i = parts.length - 1; i > 0; i--) {
      const anc = parts.slice(0, i).join('.');
      if (Object.prototype.hasOwnProperty.call(_flat, anc)) {
        let v = _flat[anc];
        for (let j = i; j < parts.length && v != null && typeof v === 'object'; j++) {
          v = v[parts[j]];
        }
        if (v !== undefined && typeof v !== 'object') return v;
        if (v !== undefined) return v;
      }
    }

    // Descendant leaves: slaTargets.2026-07.instore.baseline rows answer
    // a get('slaTargets.2026-07.instore') with an assembled object.
    const prefix = path + '.';
    let found = false;
    const out = {};
    for (const k of Object.keys(_flat)) {
      if (!k.startsWith(prefix)) continue;
      found = true;
      const rest = k.slice(prefix.length).split('.');
      let node = out;
      for (let j = 0; j < rest.length - 1; j++) {
        node = (node[rest[j]] = node[rest[j]] || {});
      }
      node[rest[rest.length - 1]] = _flat[k];
    }
    return found ? out : undefined;
  }

  return { setSheetConfig, hasSheetConfig, keyCount, keys, get, has };
})();
