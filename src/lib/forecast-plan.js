// The editable business plan uses dollars and full calendar months. Historical
// slot forecasts use cents; conversion happens only when seeding the plan.
import { addMonths, prepare, sessionRows, buildForecast, todayIso, monthStartDay, monthEndDay, rosterSessions, hallMapFromLocations, resolveOwnerClosures } from './forecast-model.js';
import { dayNumber } from './managers.js';
import { OWNER_CLOSURES } from './config.js';

export const PLAN_STORAGE = 'sar2-12-month-plans-v1';
export const PLAN_FIELDS = Object.freeze({
  sessions: { label: 'Sessions / month', min: 0, max: 1000, step: 1 },
  attendance: { label: 'Attendance / session', min: 0, max: 100000, step: 1 },
  rpa: { label: 'RPA ($)', min: 0, max: 100000, step: 0.01 },
  margin: { label: 'Margin (%)', min: -100, max: 100, step: 0.1 },
  expenses: { label: 'Operating expenses / month ($)', min: 0, max: 100000000, step: 0.01 },
});
export const planMonths = start => Array.from({ length: 12 }, (_, i) => addMonths(start, i));
export function validPlanValue(key, value) {
  const f = PLAN_FIELDS[key]; const n = Number(value);
  return !!f && value !== '' && value !== null && Number.isFinite(n) && n >= f.min && n <= f.max && (key !== 'sessions' || Number.isInteger(n));
}
export function setPlanValue(plan, hallId, month, key, value) {
  const hall = plan.halls.find(h => h.id === hallId);
  if (!hall || !planMonths(plan.start).includes(month) || !PLAN_FIELDS[key]) throw Error('Choose a hall, month and metric.');
  hall.changes ??= {}; hall.changes[month] ??= {};
  if (value === '') delete hall.changes[month][key];
  else if (validPlanValue(key, value)) hall.changes[month][key] = Number(value);
  else throw Error(`Enter a valid ${PLAN_FIELDS[key].label.toLowerCase()}.`);
}
export function projectPlan(plan) {
  const months = planMonths(plan.start);
  const halls = plan.halls.map(h => {
    const carried = {}, origins = {};
    const rows = months.map(month => {
      for (const [key, value] of Object.entries(h.changes?.[month] || {})) {
        if (validPlanValue(key, value)) { carried[key] = Number(value); origins[key] = month; }
      }
      const values = { ...h.base, ...h.baselines?.[month], ...carried };
      const active = month >= h.opening;
      const sessions = active ? values.sessions : 0;
      const ready = ['sessions','attendance','rpa','margin'].every(key => validPlanValue(key, values[key]));
      const visits = !active ? 0 : ready ? sessions * values.attendance : null;
      const gross = visits === null ? null : visits * values.rpa;
      const net = gross === null ? null : gross * values.margin / 100;
      const expenses = !active ? 0 : validPlanValue('expenses', values.expenses) ? values.expenses : null;
      return { month, ...values, sessions, active, origins: { ...origins }, visits, gross, net,
        payout: gross === null ? null : gross - net, expenses,
        profit: net === null || expenses === null ? null : net - expenses };
    });
    return { ...h, rows };
  });
  const totals = months.map((month, i) => {
    const rows = halls.map(h => h.rows[i]); const sum = key => rows.some(r => r[key] === null || !Number.isFinite(r[key])) ? null : rows.reduce((n,r) => n+r[key],0);
    return Object.fromEntries([['month',month],...['sessions','visits','gross','payout','net','expenses','profit'].map(key=>[key,sum(key)])]);
  });
  return { halls, months: totals };
}
export function seedPlan(data, today = todayIso()) {
  const start = addMonths(today.slice(0,7),1), months = planMonths(start);
  const rows = sessionRows(data.events || [], data).filter(r=>r.day<=dayNumber(today));
  const prep = prepare(rows,{today:dayNumber(today)});
  const locations = data.locations || [];
  const roster = rosterSessions(data.schedule?.ok ? data.schedule.sessions || [] : [], {
    hallMap:hallMapFromLocations(locations).map, fromDay:monthStartDay(months[0]), toDay:monthEndDay(months.at(-1)), rows, cutoff:prep.cutoff,
  });
  const ownerClosed = resolveOwnerClosures(OWNER_CLOSURES,locations).map;
  return { version:1, name:'', start, createdAt:new Date().toISOString(), halls:locations.map(l=>{
    const f=buildForecast({rows,prep,months,hall:l.id,roster:roster.sessions,ownerClosed});
    const baselines = Object.fromEntries(f.months.map(m=>{
      const t=m.total; const complete=m.unprojectable===0 && t.sessions>0 && t.attendance>0;
      return [m.key,{sessions:t.sessions,attendance:complete?t.attendance/t.sessions:null,rpa:complete?t.gross/t.attendance/100:null,margin:complete&&t.gross>0?t.net/t.gross*100:null,expenses:null}];
    }));
    return {id:l.id,name:l.name,opening:start,source:'13-week slot baseline; scheduled sessions and holiday closures included. Incomplete baselines require manual inputs.',base:{},baselines,changes:{}};
  }) };
}
export function readPlans(store) {
  try { const s=JSON.parse(store?.getItem(PLAN_STORAGE)||'{}'); return {saved:Array.isArray(s.saved)?s.saved.filter(p=>p?.version===1&&Array.isArray(p.halls)&&/^\d{4}-\d{2}$/.test(p.start)):[],draft:s.draft?.version===1&&Array.isArray(s.draft.halls)?s.draft:null}; }
  catch { return {saved:[],draft:null}; }
}
export function writePlans(store, state) {
  try { if(!store) return false; store.setItem(PLAN_STORAGE,JSON.stringify(state)); return true; } catch { return false; }
}
