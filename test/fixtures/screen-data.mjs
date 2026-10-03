/* ============================================================================
   Screen fixtures — data shaped exactly like production

   Shared by the screen QA harness (screens.test.mjs) and the XSS regression
   suite (xss.test.mjs), so both render the same realistic bundles. Every
   builder returns a fresh object; callers may mutate what they get.
   ========================================================================== */

import { indexMetrics } from '../../src/lib/model.js';
import { buildManagerModel } from '../../src/lib/managers.js';
import { makeValuesOf } from '../../src/screens/managers.js';

export const CATEGORIES = [
  { key: 'flash', display_name: 'Flash', show_rpa: true, show_margin: true,
    revenue_keys: ['flash'], payout_keys: ['flash_payout', 'special_game_5'] },
  { key: 'strip', display_name: 'Strip', show_rpa: true, show_margin: true,
    revenue_keys: ['strips'], payout_keys: ['strips_payout', 'gremlin_hotball'] },
  { key: 'other', display_name: 'Other', show_rpa: false, show_margin: false,
    revenue_keys: ['merch'], payout_keys: ['refund_other'] },
];

export const METRIC_DEFS = [
  'flash', 'strips', 'merch', 'flash_payout', 'special_game_5', 'strips_payout',
  'gremlin_hotball', 'refund_other', 'attendance',
  'hotball_total', 'hotball_carryover', 'hotball_payout', 'hotball_participation_cost',
  'mega_hotball_total', 'mega_hotball_carryover', 'mega_hotball_payout',
].map((k, i) => ({ id: `m${i}`, key: k, canonical_key: k, is_active: true }));

export const idx = indexMetrics(METRIC_DEFS);
export const byKey = Object.fromEntries(METRIC_DEFS.map((d) => [d.key, d.id]));

export const LOCS = [
  { id: 'LR', name: 'Redwood City' },
  { id: 'LS', name: 'Santa Clara' },
];

export const CONFIG = {
  name: 'Vanguard Charity Bingo',
  settings: {
    jackpots: [
      { name: 'Hotball', scope: 'per_location', cap: 5000,
        balanceKey: 'hotball_total', collectedKey: 'hotball_carryover',
        paidKey: 'hotball_payout', participationCost: 500,
        participationCostKey: 'hotball_participation_cost' },
      { name: 'Mega Hotball', scope: 'org_wide', cap: 15000,
        balanceKey: 'mega_hotball_total', collectedKey: 'mega_hotball_carryover',
        paidKey: 'mega_hotball_payout', participationCost: 1000 },
    ],
  },
};

/** 40 sessions, newest first, with realistic spread across halls and weekdays. */
export function makeData({ degenerate = false } = {}) {
  const events = [];
  const metrics = {};
  const start = new Date('2026-08-13T00:00:00Z');

  for (let i = 0; i < 40; i++) {
    const d = new Date(start.getTime() - i * 2 * 86400000);
    const date = d.toISOString().slice(0, 10);
    const loc = i % 3 === 0 ? 'LR' : 'LS';
    const type = i % 7 === 0 ? 'late' : 'regular';
    const id = `e${i}`;
    events.push({ id, location_id: loc, event_date: date, event_type: type,
                  customer_id: 'vanguard' });

    // Degenerate mode: zeros and missing values everywhere, to prove the
    // screens never render NaN or a misleading $0.
    const scale = degenerate ? 0 : (1 + (i % 5) * 0.2);
    metrics[id] = {
      [byKey.flash]: Math.round(3300000 * scale),
      [byKey.strips]: Math.round(5000000 * scale),
      [byKey.merch]: Math.round(7600 * scale),
      [byKey.flash_payout]: Math.round(1590000 * scale),
      [byKey.special_game_5]: Math.round(710000 * scale),
      [byKey.strips_payout]: Math.round(3900000 * scale),
      [byKey.gremlin_hotball]: i === 5 ? 134640 : 0,
      [byKey.refund_other]: Math.round(20400 * scale),
      [byKey.hotball_total]: Math.round(1200000 * scale),
      [byKey.hotball_carryover]: Math.round(1130000 * scale),
      [byKey.hotball_payout]: i === 11 ? 81500 : 0,
      [byKey.hotball_participation_cost]: 500,
      [byKey.mega_hotball_total]: Math.round(7500000 * scale),
      [byKey.mega_hotball_carryover]: Math.round(7400000 * scale),
      [byKey.mega_hotball_payout]: 0,
    };
    // attendance deliberately ABSENT on one session, to prove "not recorded"
    // is distinguishable from zero.
    if (i !== 3) metrics[id][byKey.attendance] = degenerate ? 0 : 150 + (i % 40);
  }

  return { events, metrics, idx, categories: CATEGORIES, locations: LOCS,
           config: CONFIG, metricDefs: METRIC_DEFS };
}

export function withRunners(base = makeData()) {
  const runners = [
    { id: 'r1', name: 'Alice', is_active: true },
    { id: 'r2', name: 'Bob', is_active: true },
  ];
  const runnerEvents = [];
  base.events.slice(0, 12).forEach((e, i) => {
    runnerEvents.push({
      id: `re${i}a`, runner_id: 'r1', event_id: e.id, location_id: e.location_id,
      event_date: e.event_date, event_type: e.event_type, is_flash_desk: false,
      tickets_checked_out: 100 + i * 10, tickets_sold: 80 + i * 9,
      tickets_returned: 15, tickets_unsold: 5,
      cash_returned: 40000, credit_cards: 12000, revenue: 52000 + i * 500,
      restock_count: i % 3,
    });
    runnerEvents.push({
      id: `re${i}b`, runner_id: 'r2', event_id: e.id, location_id: e.location_id,
      event_date: e.event_date, event_type: e.event_type, is_flash_desk: true,
      tickets_checked_out: 40, tickets_sold: 20,
      tickets_returned: 18, tickets_unsold: 2,
      cash_returned: 9000, credit_cards: 3000, revenue: 12000,
      restock_count: 0,
    });
  });
  return { ...base, runners, runnerEvents };
}

/**
 * A year of Mondays at Santa Clara plus a roster, so the baselines are real.
 *
 * `makeData` spreads 40 sessions across every weekday, which leaves no slot
 * with the eight sessions a baseline needs — useful for testing the refusal,
 * useless for testing a score. This fixture supplies both.
 */
export function withManagers({ sessions = 30, roster = true } = {}) {
  const events = [];
  const metrics = {};
  for (let i = 0; i < sessions; i += 1) {
    const date = new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10);
    const id = `mg${i}`;
    events.push({ id, location_id: 'LS', event_date: date, event_type: 'regular',
                  customer_id: 'vanguard' });
    const scale = 1 + ((i * 7) % 11) * 0.05;
    metrics[id] = {
      [byKey.flash]: Math.round(3300000 * scale),
      [byKey.strips]: Math.round(5000000 * scale),
      [byKey.merch]: 7600,
      [byKey.flash_payout]: Math.round(1590000 * scale),
      [byKey.strips_payout]: Math.round(3900000 * scale),
      [byKey.attendance]: 150 + (i % 30),
    };
  }
  events.reverse();                                  // newest first, as production

  const opsSessions = events.map((e, i) => ({
    id: `os${i}`, hall_id: 'sc', session_date: e.event_date, part: 'PM',
  }));
  const roles = [{ id: 'R1', name: 'MOD' }, { id: 'R2', name: 'Paymaster' },
                 { id: 'R3', name: 'Flash Manager' }];
  const staff = [{ id: 'S1', name: 'Sagit' }, { id: 'S2', name: 'Gina' }];
  const assignments = roster ? opsSessions.flatMap((o, i) => ([
    { session_id: o.id, role_id: 'R1', staff_id: i % 3 === 0 ? 'S2' : 'S1' },
    { session_id: o.id, role_id: 'R2', staff_id: 'S1' },
  ])) : [];

  const base = {
    events, metrics, idx, categories: CATEGORIES,
    locations: [{ id: 'LS', name: 'Santa Clara' }, { id: 'LR', name: 'Redwood City' }],
    config: CONFIG, metricDefs: METRIC_DEFS,
  };
  base.managers = buildManagerModel({
    events, locations: base.locations,
    schedule: { sessions: opsSessions, assignments, staff, roles },
    valuesOf: makeValuesOf(base),
  });
  return base;
}

/** Two years of monthly data, so year-over-year and YTD both have something. */
export function withMonths({ months = 26, hallB = true } = {}) {
  const events = []; const metrics = {};
  const start = new Date(Date.UTC(2024, 6, 5));
  let k = 0;
  for (let m = 0; m < months; m += 1) {
    for (let s = 0; s < 3; s += 1) {
      const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 4 + s * 9));
      const date = d.toISOString().slice(0, 10);
      for (const loc of hallB ? ['LS', 'LR'] : ['LS']) {
        const id = `d${k++}`;
        events.push({ id, location_id: loc, event_date: date,
                      event_type: s === 2 ? 'late' : 'regular', customer_id: 'vanguard' });
        const sc = 1 + (m % 6) * 0.08 + (loc === 'LS' ? 0.4 : 0);
        metrics[id] = {
          [byKey.flash]: Math.round(3300000 * sc),
          [byKey.strips]: Math.round(5000000 * sc),
          [byKey.merch]: 7600,
          [byKey.flash_payout]: Math.round(1590000 * sc),
          [byKey.strips_payout]: Math.round(3900000 * sc),
          [byKey.attendance]: 150 + (m % 30),
          [byKey.hotball_total]: 1200000, [byKey.hotball_carryover]: 1130000,
          [byKey.hotball_participation_cost]: 500,
          [byKey.mega_hotball_total]: 7500000, [byKey.mega_hotball_carryover]: 7400000,
        };
      }
    }
  }
  events.reverse();
  return { events, metrics, idx, categories: CATEGORIES, locations: LOCS,
           config: CONFIG, metricDefs: METRIC_DEFS };
}

/** The harness fixture has no metric_type; the sheet groups rows by it. */
export const TYPED_DEFS = METRIC_DEFS.map((d) => ({
  ...d,
  display_name: d.key,
  metric_type: /payout|gremlin|refund|special/.test(d.key) ? 'payout'
    : d.key === 'attendance' ? 'attendance'
    : /hotball/.test(d.key) ? 'hotball' : 'sales',
}));

export function withInventory({ boxes = null } = {}) {
  const products = [
    { id: 'p1', name: 'Lucky 7s', type: 'flash', cost: '191.96', tickets: 1795,
      price_per_ticket: '1.00', active: true, vendor_id: 'v1' },
    { id: 'p2', name: 'Old Faithful', type: 'paper', cost: '64.60', tickets: 500,
      price_per_ticket: '0.50', active: false, vendor_id: 'v1' },
  ];
  const defaultBoxes = [
    // Santa Clara: two on hand, one sold out, one on order.
    { id: 'b1', hall_id: 'sc', product_id: 'p1', state: 'in_inventory', cost: '191.96' },
    { id: 'b2', hall_id: 'sc', product_id: 'p1', state: 'in_inventory', cost: '191.96' },
    { id: 'b3', hall_id: 'sc', product_id: 'p1', state: 'sold_out', cost: '191.96' },
    { id: 'b4', hall_id: 'sc', product_id: 'p2', state: 'on_order', cost: '64.60' },
    // Redwood City: one opened with tickets left, one missing, one with no cost.
    { id: 'b5', hall_id: 'rwc', product_id: 'p1', state: 'opened', cost: '428.00',
      tickets_remaining: 5751 },
    { id: 'b6', hall_id: 'rwc', product_id: 'p2', state: 'missing', cost: '64.60' },
    { id: 'b7', hall_id: 'rwc', product_id: 'p1', state: 'in_inventory', cost: null },
  ];
  const gameUsage = [
    { hall_id: 'sc', session_date: '2026-08-01', product_id: 'p1', game: 'Lucky 7s',
      category: 'flash', still_stocked: true, qty: 2 },
    { hall_id: 'sc', session_date: '2026-08-08', product_id: 'p1', game: 'Lucky 7s',
      category: 'flash', still_stocked: true, qty: 1 },
    { hall_id: 'rwc', session_date: '2026-08-04', product_id: 'p2', game: 'Old Faithful',
      category: 'paper', still_stocked: false, qty: 1 },
    { hall_id: 'rwc', session_date: '2026-08-11', product_id: 'p2', game: 'Old Faithful',
      category: 'paper', still_stocked: false, qty: 1 },
    { hall_id: 'rwc', session_date: '2026-08-13', product_id: 'p2', game: 'Old Faithful',
      category: 'paper', still_stocked: true, qty: 1 },
  ];
  const purchaseOrders = [
    { id: 'o1', num: 'PO-1', hall_id: 'sc', vendor_id: 'v1', status: 'sent',
      subtotal: '1000.00', tax: '80.00', total: '1080.00', sent_at: '2026-08-01T00:00:00Z' },
  ];
  return { ...makeData(), schedule: {
    ok: true, products, boxes: boxes ?? defaultBoxes, gameUsage, purchaseOrders,
  } };
}

export function withCommission({ testRow = true } = {}) {
  const sessions = [
    { id: 's1', hall_id: 'sc', part: 'AM', session_date: '2026-08-01',
      total_sales: '3600.00', attendance: 200, comm_rate: '0.1500', target_rpa: null },
  ];
  const payouts = [
    { session_id: 's1', staff_id: 'a', session_date: '2026-08-01', shares: '1.0',
      total_shares: '3.0', commission_pool: '540.00', payout_amount: '180.00',
      confirmed_at: '2026-08-02T00:00:00Z' },
    { session_id: 's1', staff_id: 'b', session_date: '2026-08-01', shares: '1.0',
      total_shares: '3.0', commission_pool: '540.00', payout_amount: '180.00',
      confirmed_at: '2026-08-02T00:00:00Z' },
    { session_id: 's1', staff_id: 'c', session_date: '2026-08-01', shares: '1.0',
      total_shares: '3.0', commission_pool: '540.00', payout_amount: '180.00',
      confirmed_at: '2026-08-02T00:00:00Z' },
  ];
  if (testRow) {
    // The real seeded row: attendance 5555, sales $5,000,005, $39,473.72 each.
    sessions.push({ id: 's2', hall_id: 'sc', part: 'PM', session_date: '2026-08-10',
      total_sales: '5000005.00', attendance: 5555, comm_rate: '0.1500', target_rpa: null });
    payouts.push({ session_id: 's2', staff_id: 'a', session_date: '2026-08-10',
      shares: '1.0', total_shares: '19.0', commission_pool: '750000.75',
      payout_amount: '39473.72', confirmed_at: '2026-08-11T00:00:00Z' });
  }
  const staff = [{ id: 'a', name: 'Sagit' }, { id: 'b', name: 'Gina' }, { id: 'c', name: 'Paolo' }];
  return { ...makeData(), schedule: { ok: true, sessions, staff, commissionPayouts: payouts } };
}

export function withStaff() {
  const staff = [
    { id: 's1', name: 'Sagit', active: true },
    { id: 's2', name: 'Gina', active: true },
    { id: 's3', name: 'Newbie', active: true },
    { id: 's4', name: 'Departed', active: false },
  ];
  const roles = [{ id: 'r1', name: 'MOD' }, { id: 'r2', name: 'Paymaster' }];
  const sessions = [
    { id: 'x1', session_date: '2026-08-01' }, { id: 'x2', session_date: '2026-08-08' },
  ];
  const assignments = [
    { staff_id: 's1', session_id: 'x1', role_id: 'r1' },
    { staff_id: 's1', session_id: 'x2', role_id: 'r1' },
    { staff_id: 's2', session_id: 'x1', role_id: 'r2' },
  ];
  const capability = [
    { staff_id: 's1', role_id: 'r1', can_do: true },
    { staff_id: 's2', role_id: 'r2', can_do: true },
    { staff_id: 's3', role_id: 'r2', can_do: false },
  ];
  const timeEntries = [
    { staff_id: 's1', hall_id: 'sc', work_date: '2026-08-01', hours_worked: '6.5' },
    { staff_id: 's1', hall_id: 'sc', work_date: '2026-08-08', hours_worked: null },
    { staff_id: 's2', hall_id: 'rwc', work_date: '2026-08-01', hours_worked: '4', is_walk_up: true },
  ];
  return { ...makeData(), schedule: { ok: true, staff, roles, sessions, assignments,
                                      capability, timeEntries } };
}

export function withPromoNotes() {
  const d = makeData();
  d.events[0].promotion_notes = 'Double points night';
  d.events[2].promotion_notes = '  ';          // whitespace only — not a note
  d.events[4].promotion_notes = 'Free dauber with a $40 pack';
  return d;
}

export function withNotifications() {
  const notifications = [
    { id: 'n1', event_type: 'sar.jackpot_hit', severity: 'success',
      title: 'Hotball hit', body: '$815 paid', created_at: '2026-08-14T07:15:00Z',
      entity_type: 'event', entity_id: 'e0' },
    { id: 'n2', event_type: 'sar.reconciliation_mismatch', severity: 'alert',
      title: 'Deposit does not match', created_at: '2026-08-13T07:15:00Z' },
    { id: 'n3', event_type: 'sar.new_high_water', severity: 'info',
      title: 'Best Friday on record', created_at: '2026-08-12T07:15:00Z' },
    { id: 'n4', event_type: 'auth.role_granted', severity: 'info',
      title: 'Role granted', created_at: '2026-08-11T07:15:00Z' },
    { id: 'n5', event_type: 'sar.ingestion_error', severity: 'warning',
      title: 'A sheet failed to import', created_at: '2026-08-10T07:15:00Z' },
    { id: 'n6', event_type: 'sar.stale_location', severity: 'warning',
      title: 'Redwood City has not reported', created_at: '2026-08-09T07:15:00Z' },
  ];
  const reads = [
    { user_id: 'u1', notification_id: 'n3', read_at: '2026-08-12T09:00:00Z' },
    { user_id: 'u1', notification_id: 'n6', archived_at: '2026-08-09T09:00:00Z' },
    { user_id: 'u2', notification_id: 'n1', read_at: '2026-08-14T08:00:00Z' },
  ];
  return { ...makeData(), notifications, notificationReads: reads, userId: 'u1' };
}
