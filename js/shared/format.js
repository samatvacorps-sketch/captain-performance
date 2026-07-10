/**
 * format.js — extracted verbatim from the former js/ui.js (Phase 0 split).
 *
 * Top-level declarations are intentionally global (classic scripts, no
 * build step): tab modules cross-call each other and the shared helpers
 * at runtime. The public `ui` API is assembled in js/ui-registry.js;
 * the orchestrator lives in js/app.js.
 */

  // ── Utility ────────────────────────────────────────────────────────────

  function _fmt(val, decimals = 0) {
    if (val === null || val === undefined || isNaN(val)) return '—';
    return Number(val).toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function _isoDateStr(date) {
    if (!date) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // Converts "YYYY-MM" month key to billing-cycle label: "Mar 26 – Apr 25, 2026"
  // Billing cycle: 26th of previous month → 25th of named month
  function _billingMonthLabel(monthKey) {
    const [y, mo] = monthKey.split('-').map(Number);
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const startDate = new Date(y, mo - 2, 26); // JS handles mo-2 < 0 → wraps to Dec of y-1
    const endDate   = new Date(y, mo - 1, 25);
    return `${MONTHS[startDate.getMonth()]} 26 \u2013 ${MONTHS[endDate.getMonth()]} 25, ${endDate.getFullYear()}`;
  }

  // Given a billing-cycle month key "YYYY-MM", set start/end date picker values
  function _applyBillingMonthDates(startElId, endElId, monthKey) {
    const [y, mo] = monthKey.split('-').map(Number);
    document.getElementById(startElId).value = _isoDateStr(new Date(y, mo - 2, 26));
    document.getElementById(endElId).value   = _isoDateStr(new Date(y, mo - 1, 25));
  }

  function _esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

