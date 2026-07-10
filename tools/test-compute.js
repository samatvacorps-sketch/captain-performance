#!/usr/bin/env node
/**
 * test-compute.js — unit tests for the payroll- and SLA-grade logic in
 * js/compute.js. Plain node + assert, no framework, no build step.
 *
 *   node tools/test-compute.js
 *
 * Exits non-zero on any failure. Run after touching compute.js — this is
 * money math (incentives, attendance bonus) and merchant SLA math.
 */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/compute.js'), 'utf8'), sandbox);
const compute = vm.runInContext('compute', sandbox);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.message}`); }
}

const D = (s) => new Date(`${s}T12:00:00`);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ── Fill rate ─────────────────────────────────────────────────────────
test('computeFillRate: affected = union of PNA and missing orders', () => {
  const r = compute.computeFillRate(
    [{ order_id: 'A' }, { order_id: 'B' }, { order_id: 'B' }],
    [{ order_id: 'B' }, { order_id: 'C' }],
    10);
  assert.strictEqual(r.pnaOrders, 2);
  assert.strictEqual(r.missOrders, 2);
  assert.strictEqual(r.bothOrders, 1);
  assert.strictEqual(r.affected, 3);
  assert.strictEqual(r.inFull, 7);
  assert.strictEqual(r.pct, 70);
});

test('computeFillRate: zero orders → null pct', () => {
  assert.strictEqual(compute.computeFillRate([], [], 0).pct, null);
});

// ── In-store SLA ──────────────────────────────────────────────────────
test('computeInstoreSLA: 150s met, 151s breached, IPO>6 excluded', () => {
  const d = D('2026-07-02');
  const rows = [
    { ipo: 2, instore_seconds: 100, date: d, employee_id: 'X', hour: 10 },
    { ipo: 6, instore_seconds: 150, date: d, employee_id: 'X', hour: 10 },
    { ipo: 3, instore_seconds: 151, date: d, employee_id: 'Y', hour: 11 },
    { ipo: 7, instore_seconds: 50,  date: d, employee_id: 'Y', hour: 11 }, // excluded
  ];
  const r = compute.computeInstoreSLA(rows, null);
  assert.strictEqual(r.totals.denom, 3);
  assert.strictEqual(r.totals.met, 2);
  assert.strictEqual(r.totals.slaPct, 66.7);
});

// ── Picking incentives ────────────────────────────────────────────────
test('computePickingIncentives: weighted avg + slab bands + thresholds', () => {
  const wk = D('2026-06-01'); // Monday
  const mkRow = (id, name, orders, t, dayOffset = 0) => ({
    employee_id: id, employee_name: name,
    date: new Date(wk.getTime() + dayOffset * 86400000),
    checkout_orders: orders, total_time_per_order: t,
    flows: { is_picking: true },
  });
  const rows = [
    mkRow('P1', 'Slab three', 100, 60), mkRow('P1', 'Slab three', 350, 80, 1), // 450 @ 75.56s → <80 → ₹300
    mkRow('P2', 'Big band', 900, 70),                                          // 800+ @ 70s → <75 → ₹500
    mkRow('P3', 'Too small', 100, 60),                                         // <400 → ₹0
  ];
  const weekKeys = compute.getWeekKeysForMonth(rows, '2026-06');
  const r = compute.computePickingIncentives(rows, weekKeys);
  assert.strictEqual(r.get('P1').total, 300);
  const p1wk = [...r.get('P1').weeks.values()][0];
  assert.ok(Math.abs(p1wk.avgTime - 75.555) < 0.01, `weighted avg ${p1wk.avgTime}`);
  assert.strictEqual(r.get('P2').total, 500);
  assert.strictEqual(r.get('P3').total, 0);
});

// ── Audit incentives ──────────────────────────────────────────────────
test('computeAuditIncentives: cumulative tiers + 100-rack cap', () => {
  const codes = n => Array.from({ length: n }, (_, i) => `G-A-${i}`);
  const rows = [
    { employee_id: 'A1', employee_name: 'Century', date: D('2026-06-10'), audit_codes: codes(60) },
    { employee_id: 'A1', employee_name: 'Century', date: D('2026-06-11'), audit_codes: codes(60) },
    { employee_id: 'A2', employee_name: 'Starter', date: D('2026-06-12'), audit_codes: codes(35) },
  ];
  const r = compute.computeAuditIncentives(rows, '2026-06');
  // 120 racks → capped at 100 payable: 40×30 + 40×40 + 20×50 = 3800
  assert.strictEqual(r.get('A1').totalRacks, 120);
  assert.strictEqual(r.get('A1').payableRacks, 100);
  assert.strictEqual(r.get('A1').amount, 3800);
  assert.strictEqual(r.get('A2').amount, 35 * 30);
});

// ── Attendance bonus ──────────────────────────────────────────────────
function attendanceFixtures(empId, name, type, workDays, opts = {}) {
  const roster = [{ employee_id: empId, employee_name: name, shift: 'Morning',
    start: opts.start || '2026-05-01', end: opts.end || '', assigned_off: '', employment_type: type }];
  const daily = [];
  for (const day of workDays) {
    const date = D(`2026-06-${String(day).padStart(2, '0')}`);
    daily.push({ employee_id: empId, date, dateIsoStr: iso(date), total_active_time: 9 * 3600 });
  }
  return { roster, daily };
}

test('computeAttendanceBonus: FT full month → ₹1000', () => {
  const days = Array.from({ length: 30 }, (_, i) => i + 1);
  const { roster, daily } = attendanceFixtures('F1', 'Full Timer', 'FT', days);
  const r = compute.computeAttendanceBonus(daily, roster, '2026-06').get('F1');
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.bonus_amount, 1000);
});

test('computeAttendanceBonus: PT full month → ₹500', () => {
  const days = Array.from({ length: 30 }, (_, i) => i + 1);
  const { roster, daily } = attendanceFixtures('P1', 'Part Timer', 'PT', days);
  const r = compute.computeAttendanceBonus(daily, roster, '2026-06').get('P1');
  assert.strictEqual(r.bonus_amount, 500);
});

test('computeAttendanceBonus: mixed 15 FT + 15 PT days → ₹750', () => {
  const days = Array.from({ length: 30 }, (_, i) => i + 1);
  const daily = days.map(day => {
    const date = D(`2026-06-${String(day).padStart(2, '0')}`);
    return { employee_id: 'M1', date, dateIsoStr: iso(date), total_active_time: 9 * 3600 };
  });
  const roster = [
    { employee_id: 'M1', employee_name: 'Mixed', shift: 'Morning', start: '2026-06-01', end: '2026-06-15', assigned_off: '', employment_type: 'FT' },
    { employee_id: 'M1', employee_name: 'Mixed', shift: 'Morning', start: '2026-06-16', end: '', assigned_off: '', employment_type: 'PT' },
  ];
  const r = compute.computeAttendanceBonus(daily, roster, '2026-06').get('M1');
  assert.strictEqual(r.ft_days, 15);
  assert.strictEqual(r.pt_days, 15);
  assert.strictEqual(r.bonus_amount, 750);
});

test('computeAttendanceBonus: unplanned leave disqualifies', () => {
  const days = Array.from({ length: 30 }, (_, i) => i + 1);
  const { roster, daily } = attendanceFixtures('U1', 'Leaver', 'FT', days);
  const r = compute.computeAttendanceBonus(daily, roster, '2026-06', { 'U1_2026-06-05': 'Unplanned Leave' }).get('U1');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.bonus_amount, 0);
  assert.strictEqual(r.reason, 'Unplanned leave');
});

test('computeAttendanceBonus: under 7 active days → tenure gate', () => {
  const { roster, daily } = attendanceFixtures('T1', 'Newbie', 'FT', [26, 27, 28, 29, 30], { start: '2026-06-26' });
  const r = compute.computeAttendanceBonus(daily, roster, '2026-06').get('T1');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.reason, 'Minimum tenure not met');
});

test('computeAttendanceBonus: missing FT/PT type pays ₹0 with reason', () => {
  const days = Array.from({ length: 30 }, (_, i) => i + 1);
  const { roster, daily } = attendanceFixtures('N1', 'No Type', '', days);
  const r = compute.computeAttendanceBonus(daily, roster, '2026-06').get('N1');
  assert.strictEqual(r.bonus_amount, 0);
  assert.strictEqual(r.reason, 'Needs roster type');
});

// ── Pooled window KPIs ────────────────────────────────────────────────
test('computeWindowKpis: pooled, volume-weighted math', () => {
  const rows = [
    { checkout_orders: 100, total_time_per_order: 90, picker_active_time: 3600, putaway_qty: 0, putter_active_time: 0 },
    { checkout_orders: 300, total_time_per_order: 60, picker_active_time: 3600, putaway_qty: 0, putter_active_time: 0 },
    { checkout_orders: 0, total_time_per_order: 0, picker_active_time: 0, putaway_qty: 200, putter_active_time: 7200 },
  ];
  const k = compute.computeWindowKpis(rows);
  assert.strictEqual(k.totalOrders, 400);
  assert.strictEqual(k.avgTotalTimePerOrder, (100 * 90 + 300 * 60) / 400); // 67.5 — not (90+60)/2
  assert.strictEqual(k.pooledIph, 100); // 200 qty / 2h
});

// ── Cycle pace projection ─────────────────────────────────────────────
test('projectCyclePace: projects remaining days at recent form', () => {
  const p = compute.projectCyclePace(750, 1000, 80, 10, 5);
  assert.strictEqual(p.future, 500);
  assert.strictEqual(p.projected, +(((750 + 0.8 * 500) / 1500) * 100).toFixed(2)); // 76.67
});

test('projectCyclePace: unprojectable windows → null', () => {
  assert.strictEqual(compute.projectCyclePace(1, 0, null, 5, 5), null);
  assert.strictEqual(compute.projectCyclePace(1, 10, null, 0, 5), null);
});

// ── Robust captain scoring ────────────────────────────────────────────
test('computeCaptainScores: volume gate + direction-adjusted robust z', () => {
  const mk = (id, orders, t) => ({ employee_id: id, employee_name: id,
    checkout_orders: orders, total_time_per_order: t, picker_active_time: orders ? 3600 : 0,
    putaway_qty: 0, putter_active_time: 0, auditor_active_time: 0, racks_audited: 0,
    fnv_active_time: 0, audited_qty: 0 });
  const r = compute.computeCaptainScores([
    mk('A', 100, 70), mk('B', 100, 75), mk('C', 100, 80), mk('D', 100, 78),
    mk('SLOW', 120, 160), mk('TINY', 5, 300),
  ]);
  assert.strictEqual(r.captains.get('TINY').flows.picking.gated, false); // 5 orders < gate
  assert.strictEqual(r.captains.get('TINY').composite, 0);
  assert.ok(r.captains.get('SLOW').flows.picking.z > 1, 'slow picker flagged');
  assert.ok(r.captains.get('A').composite === 0, 'fast picker not penalized');
  assert.ok(r.captains.get('SLOW').reasons.length >= 1, 'reason string generated');
});

// ── Billing cycle boundaries ──────────────────────────────────────────
test('aggregateBillingMonthly: 25th stays, 26th rolls to next cycle', () => {
  const row = (d) => ({ date: D(d), dateStr: 'x', employee_id: 'E', checkout_orders: 1 });
  const r = compute.aggregateBillingMonthly([row('2026-06-25'), row('2026-06-26')]);
  // join() comparison — arrays from inside the vm have a foreign Array
  // prototype, which deepStrictEqual rejects.
  const keys = r.map(g => g.month_key).sort().join(',');
  assert.strictEqual(keys, '2026-06,2026-07');
});

// ── Week-to-month assignment (Monday rule) ────────────────────────────
test('getWeekKeysForMonth: week belongs to the month of its Monday', () => {
  const mar30 = D('2026-03-30'); // Monday; week spans into April
  assert.strictEqual(compute.getWeekKeysForMonth([{ date: mar30 }], '2026-03').length, 1);
  assert.strictEqual(compute.getWeekKeysForMonth([{ date: mar30 }], '2026-04').length, 0);
  const apr2 = D('2026-04-02'); // Thursday of that same week → still March's week
  assert.strictEqual(compute.getWeekKeysForMonth([{ date: apr2 }], '2026-04').length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
