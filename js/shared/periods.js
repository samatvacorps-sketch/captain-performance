/**
 * periods.js — shared period-picker helpers (Phase 0).
 *
 * Every tab's Quick Select implements the same moves: jump to T-1/T-2,
 * reset to the data's full span, and parse "W:<weekKey>" / "M:<monthKey>"
 * preset values. Those live here now; the per-tab handlers keep only their
 * tab-specific state (date-mode flags, cache busting, render call).
 * Deeper consolidation of the preset <select> builders lands with the
 * per-tab rebuilds in Phases 1–2.
 */

const periods = (() => {

  /** ISO date (YYYY-MM-DD, local) for today minus n days. */
  function isoDaysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return _isoDateStr(d);
  }

  /**
   * Point both of a tab's date pickers at a single day, `daysAgo` back
   * (T-1 = 1, T-2 = 2). Returns the ISO string applied.
   */
  function setDayPair(startId, endId, daysAgo) {
    const ds = isoDaysAgo(daysAgo);
    const s = document.getElementById(startId);
    const e = document.getElementById(endId);
    if (s) s.value = ds;
    if (e) e.value = ds;
    return ds;
  }

  /**
   * Set a tab's date pickers to the full span of `rows` (objects with a
   * .date). Returns true when the span was applied.
   */
  function setFullSpan(startId, endId, rows) {
    const dates = (rows || []).map(r => r.date).filter(Boolean).sort((a, b) => a - b);
    if (!dates.length) return false;
    const s = document.getElementById(startId);
    const e = document.getElementById(endId);
    if (s) s.value = _isoDateStr(dates[0]);
    if (e) e.value = _isoDateStr(dates[dates.length - 1]);
    return true;
  }

  /** Split a "W:2026-W23" / "M:2026-06" preset value into { type, key }. */
  function parsePreset(val) {
    const s = String(val || '');
    const i = s.indexOf(':');
    return i < 0 ? { type: s, key: null } : { type: s.slice(0, i), key: s.slice(i + 1) };
  }

  return { isoDaysAgo, setDayPair, setFullSpan, parsePreset };
})();
