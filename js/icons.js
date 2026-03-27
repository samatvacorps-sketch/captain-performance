/**
 * icons.js — Monochrome SVG icon library
 *
 * All icons use stroke="currentColor" so they inherit the parent's
 * color and remain monochrome. ViewBox 0 0 16 16, stroke-width 1.5,
 * round caps/joins — geometric minimal style matching Samatva logo.
 */

const ICONS = (() => {
  const base = (content, w = 14, h = 14) =>
    `<svg width="${w}" height="${h}" viewBox="0 0 16 16" fill="none" ` +
    `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ` +
    `style="display:inline-block;vertical-align:middle;flex-shrink:0">${content}</svg>`;

  return {
    // ── Tab navigation ──────────────────────────────────────────────
    trending:
      base('<polyline points="1,12 5,7 9,10 15,4"/><polyline points="11,4 15,4 15,8"/>'),

    searchGlass:
      base('<circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14.5" y2="14.5"/>'),

    flag:
      base('<line x1="4" y1="1" x2="4" y2="15"/><path d="M4 2h8l-3 4 3 4H4"/>'),

    person:
      base('<circle cx="8" cy="5" r="2.5"/><path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5"/>'),

    layers:
      base('<polygon points="8,2 15,5.5 8,9 1,5.5"/><polyline points="1,10 8,13.5 15,10"/>'),

    sliders:
      base('<line x1="4" y1="2" x2="4" y2="14"/><circle cx="4" cy="9" r="2"/>' +
           '<line x1="12" y1="2" x2="12" y2="14"/><circle cx="12" cy="5" r="2"/>'),

    // ── Stat card icons (slightly larger) ───────────────────────────
    box:
      base('<path d="M2 5.5L8 2l6 3.5v6L8 14 2 11.5z"/>' +
           '<line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="5.5" x2="14" y2="5.5"/>', 17, 17),

    clock:
      base('<circle cx="8" cy="8" r="6"/><polyline points="8,5 8,8 10.5,10"/>', 17, 17),

    barChart:
      base('<rect x="1.5" y="9" width="3" height="6" rx="0.5"/>' +
           '<rect x="6.5" y="5" width="3" height="10" rx="0.5"/>' +
           '<rect x="11.5" y="2" width="3" height="13" rx="0.5"/>', 17, 17),

    alertTriangle:
      base('<path d="M8 1.5L1.5 13.5h13z"/>' +
           '<line x1="8" y1="6" x2="8" y2="9.5"/>' +
           '<circle cx="8" cy="11.5" r="0.5" fill="currentColor"/>', 17, 17),

    check:
      base('<polyline points="2.5,8.5 6,12 13.5,4.5"/>'),

    // ── Flow section headers ─────────────────────────────────────────
    flowPicking:
      base('<path d="M2 5.5L8 2l6 3.5v6L8 14 2 11.5z"/>' +
           '<line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="5.5" x2="14" y2="5.5"/>'),

    flowPutting:
      base('<path d="M2 4.5h12v7a1 1 0 01-1 1H3a1 1 0 01-1-1v-7z"/>' +
           '<path d="M5 4.5V3a1 1 0 011-1h4a1 1 0 011 1v1.5"/>'),

    flowAudit:
      base('<rect x="3" y="2" width="10" height="12" rx="1.5"/>' +
           '<polyline points="6,8 7.5,9.5 10.5,6.5"/>' +
           '<line x1="5" y1="5" x2="11" y2="5"/>'),

    flowFNV:
      base('<circle cx="8" cy="8" r="6"/><polyline points="5,8 7,10.5 11.5,5.5"/>'),

    // ── Refresh button ───────────────────────────────────────────────
    refresh:
      base('<path d="M13.5 8A5.5 5.5 0 112.5 8"/><polyline points="13.5,3.5 13.5,8 9,8"/>', 13, 13),

    // ── Small inline flag (flagged metric indicator) ─────────────────
    flagSm:
      base('<line x1="4" y1="1" x2="4" y2="15"/><path d="M4 2h8l-3 4 3 4H4"/>', 10, 10),

    // ── Config direction indicators ──────────────────────────────────
    arrowUp:
      base('<line x1="8" y1="13" x2="8" y2="3"/><polyline points="4,7 8,3 12,7"/>', 12, 12),

    arrowDown:
      base('<line x1="8" y1="3" x2="8" y2="13"/><polyline points="4,9 8,13 12,9"/>', 12, 12),
  };
})();
