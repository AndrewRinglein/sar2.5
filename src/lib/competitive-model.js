import { extractProgram, summarizePublishedProgram } from './competitive-program.js';
import { miles } from './competitive-markets.js';

// Scout V2 scenario assumptions, not measured effects or promises.
export const FEATURES = {
  ecommerce: { label: 'Presales / ecommerce', low: .03, mid: .07, high: .12, ramp: 3 },
  cards: { label: 'Accept credit cards', low: .10, mid: .20, high: .40, ramp: 2 },
  qr: { label: 'QR ordering', low: .02, mid: .03, high: .05, ramp: 2 },
  loyaltyMin: { label: 'Basic loyalty', low: .02, mid: .05, high: .08, ramp: 6 },
  loyaltyAdv: { label: 'Advanced loyalty', low: .15, mid: .35, high: .50, ramp: 14 },
  sms: { label: 'SMS marketing', low: .03, mid: .06, high: .12, ramp: 1 },
  social: { label: 'Active social media', low: .04, mid: .08, high: .14, ramp: 4 },
  website: { label: 'Website', low: .08, mid: .18, high: .35, ramp: 3 },
  phone: { label: 'Listed phone', low: .01, mid: .02, high: .04, ramp: 1 },
};
export const SEASONAL = [1.08,1.10,1.08,1.05,1,.93,.88,.90,.98,1.03,1,.92];
export const defaults = () => ({ payout: '', sessions: '', ratio: 80, fill: 100, margin: '', months: 24,
  preset: 'mid', cap: 60, seasonal: false, startMonth: new Date().toISOString().slice(0,7), features: {}, evidence: null });
export function evidenceFor(hall, messages = []) {
  const published = (hall.publishedPrograms || []).map((p, i) => ({
    id: `web:${hall.id}:${i}`, title: p.title, channel: 'website', date: p.checkedAt, url: p.sourceUrl,
    body: p.notes, buyIns: p.buyIns || [], groups: p.gameGroups || [],
    subtotal: summarizePublishedProgram(p).fixedSubtotal, advertisedTotal: p.advertisedTotal || null,
    label: 'Published program · review scope and date',
  }));
  const seen = new Set();
  for (const [day, session] of Object.entries(hall.scout?.schedule || {})) {
    const parsed=extractProgram(session.program || '');
    published.push({id:`scout:${hall.id}:${day}`,title:`Scout reference · ${day} ${session.session || ''}`,
      channel:'scout reference',date:hall.scout.importedAt,url:hall.website,
      body:`${session.program || ''}\nBuy-in reference: ${hall.scout.buyIn || 'unknown'}`,
      buyIns:parsed.buyIns.map(b=>b.value),groups:parsed.prizes.map(g=>({count:g.count,prize:g.payout,label:g.evidence})),
      subtotal:parsed.advertisedSubtotal,advertisedTotal:null,label:'Bingo Scout V2 reference · import date, not verification date; may be historical'});
  }
  for (const m of messages) {
    if (seen.has(m.id) || m.kind === 'procedural' || m.kind === 'operational') continue;
    if (m.hallId !== hall.id && !(m.hallIds || []).includes(hall.id)) continue;
    seen.add(m.id);
    const p = extractProgram(m.body || '');
    published.push({ id: m.id, title: m.subject || (m.channel === 'email' ? 'Email update' : 'Text update'),
      channel: m.channel || 'sms', date: m.receivedAt, url: m.sourceUrl, body: m.body,
      buyIns: p.buyIns.map(b => b.value), groups: p.prizes.map(g => ({ count: g.count, prize: g.payout, label: g.evidence })),
      subtotal: p.advertisedSubtotal, advertisedTotal: null,
      label: 'Automatic extraction · partial program, needs review' });
  }
  return published.sort((a,b) => String(b.date || '').localeCompare(String(a.date || '')));
}
export function business(cfg) {
  const payout = Number(cfg.payout), sessions = Number(cfg.sessions), ratio = Number(cfg.ratio) / 100, fill = Number(cfg.fill) / 100;
  if (![payout, sessions, ratio, fill].every(Number.isFinite) || payout <= 0 || sessions <= 0 || sessions > 50 || ratio <= 0 || ratio > 1 || fill <= 0 || fill > 1) return null;
  const weeklyPayout = payout * sessions * fill, weeklyGross = weeklyPayout / ratio;
  const margin = cfg.margin === '' || cfg.margin == null ? null : Number(cfg.margin) / 100;
  if (margin !== null && (!Number.isFinite(margin) || margin < -1 || margin > 1)) return null;
  return { weeklyPayout, weeklyGross, annualGross: weeklyGross * 52, annualPayout: weeklyPayout * 52,
    weeklyContribution: weeklyGross - weeklyPayout, monthlyGross: weeklyGross * 52 / 12,
    annualProfit: margin === null ? null : weeklyGross * 52 * margin, margin, ratio };
}
export function projection(cfg) {
  const base = business(cfg), months = Number(cfg.months), cap = Number(cfg.cap) / 100;
  if (!base || !Number.isInteger(months) || months < 1 || months > 60 || !Number.isFinite(cap) || cap < 0 || cap > 2 || !['low','mid','high'].includes(cfg.preset) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(cfg.startMonth)) return [];
  const [year, month] = cfg.startMonth.split('-').map(Number);
  return Array.from({ length: months }, (_, i) => {
    const date = new Date(Date.UTC(year, month - 1 + i, 1));
    const contributions = {};
    for (const [key, f] of Object.entries(FEATURES)) {
      const setting = cfg.features[key];
      if (!setting?.enabled || key === 'loyaltyMin' && cfg.features.loyaltyAdv?.enabled) continue;
      const elapsed = i - (Number(setting.start) || 0);
      contributions[key] = f[cfg.preset] * (elapsed <= 0 ? 0 : 1 - Math.exp(-elapsed / Math.max(.5, f.ramp / 2.3)));
    }
    const rawLift = Object.values(contributions).reduce((a,b) => a+b, 0), lift = Math.min(rawLift, cap);
    const seasonal = cfg.seasonal ? SEASONAL[date.getUTCMonth()] : 1;
    const baseline = base.monthlyGross * seasonal, gross = baseline * (1 + lift);
    return { month: date.toISOString().slice(0,7), baseline, gross, payout: gross * base.ratio,
      contribution: gross * (1-base.ratio), profit: base.margin === null ? null : gross * base.margin,
      lift, capped: rawLift > cap, contributions };
  });
}
export function proximity(origin, hall) {
  if (!origin?.location || !hall.location) return null;
  const a = [origin.location.lat, origin.location.lng], b = [hall.location.lat, hall.location.lng];
  if (![...a,...b].every(Number.isFinite)) return null;
  const distance = miles(a,b);
  // Scout's piecewise speed assumptions can be discontinuous. Label as a heuristic.
  return { miles: distance, minutes: distance < 3 ? distance * 3.2 : distance < 10 ? distance * 2.1 : distance < 30 ? distance * 1.55 : 8 + distance * 1.2,
    overlap: Math.exp(-.15 * distance) * 100 };
}
export function safeUrl(value) {
  try { const u = new URL(value); return ['http:','https:'].includes(u.protocol) ? u.href : null; } catch { return null; }
}
export function payoutBand(value) {
  if (!Number.isFinite(value) || value <= 0) return 'Unknown';
  return value >= 74000 ? 'Major' : value >= 50000 ? 'Large' : value >= 24000 ? 'Medium' : value >= 10000 ? 'Small' : 'Very small';
}
