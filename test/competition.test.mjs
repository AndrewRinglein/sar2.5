import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { defaults, evidenceFor, business, projection, safeUrl, proximity, payoutBand } from '../src/lib/competitive-model.js';
import { readCompetitive, MONITOR_URL } from '../server/competitive.mjs';
import { renderCompetition } from '../src/screens/competition.js';
import { inMarket, markets } from '../src/lib/competitive-markets.js';

test('market membership follows the 50-mile hall radius and city fallback without county overreach',()=>{
  const region=markets.find(m=>m.id==='sacramento');
  assert.equal(inMarket({location:{lat:region.center[0],lng:region.center[1]}},'sacramento'),true);
  assert.equal(inMarket({city:'Sacramento',location:{lat:40,lng:-121.4944,county:'Sacramento County'}},'sacramento'),false);
  assert.equal(inMarket({city:'Davis'},'sacramento'),true);
  assert.equal(inMarket({city:'Los Angeles'},'sacramento'),false);
  assert.equal(inMarket({city:'Santa Clara'},'bay-area'),true);
  assert.equal(inMarket({city:'Redwood City'},'bay-area'),true);
  assert.equal(inMarket({city:'Unknown'},'bay-area'),false);
});

const hall={competitionEligibility:{status:'qualified'},id:'vanguard',name:'Vanguard Santa Clara',city:'Santa Clara',address:'Santa Clara, CA',location:{lat:37.37,lng:-121.95},schedule:{days:['Friday']},publishedPrograms:[]};
const msg=(id,body,extra={})=>({id,body,hallId:hall.id,channel:'sms',kind:'promotion',receivedAt:'2026-10-01T12:00:00Z',...extra});
test('evidence keeps two promotions separate and excludes unrelated and procedural messages',()=>{
  const rows=evidenceFor(hall,[msg('a','10 mains $2,500'),msg('b','4 premiums $5,000',{channel:'email'}),msg('a','duplicate'),msg('c','Welcome',{kind:'procedural'}),msg('d','2 games $100',{hallId:'other'})]);
  assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.subtotal),[25000,20000]);
  assert.equal(rows[1].channel,'email');assert.equal(rows[0].advertisedTotal,null);
});
test('conditional jackpots never become a fixed session payout',()=>{
  const [row]=evidenceFor(hall,[msg('a','2 games $50,000 progressive jackpot if won in 50 numbers')]);
  assert.equal(row.subtotal,0);
  const [web]=evidenceFor({...hall,publishedPrograms:[{title:'Friday',gameGroups:[{count:10,prize:2500},{count:1,prize:50000,conditional:true}]}]});
  assert.equal(web.subtotal,25000);
});
test('Vanguard shorthand yields regular prize groups, without adding hot balls or numeric ranges',()=>{
  assert.equal(evidenceFor(hall,[msg('a','30K House Hot Ball! 10 win 2.5K & FOUR-5Ks! 16K Mega HotBall Win & Spin!')])[0].subtotal,45000);
  assert.equal(evidenceFor(hall,[msg('a','10 str!pz that pay 2K + 500 2nd chance. (4) 5Ks & More!')])[0].subtotal,40000);
  assert.equal(evidenceFor(hall,[msg('a','10 = 2K w/ 500 2nd & 4-5Ks!')])[0].subtotal,40000);
  assert.equal(evidenceFor(hall,[msg('a','Prizes range from 4-5K')])[0].subtotal,0);
});
test('unknown payout and sessions stay unknown; contribution is not profit',()=>{
  assert.equal(business(defaults()),null);
  const b=business({...defaults(),payout:40000,sessions:2});
  assert.equal(b.weeklyGross,100000);assert.equal(b.weeklyPayout,80000);assert.equal(b.weeklyContribution,20000);assert.equal(b.annualProfit,null);
  for(const patch of [{ratio:0},{ratio:101},{sessions:-1},{payout:Infinity}])assert.equal(business({...defaults(),payout:40000,sessions:2,...patch}),null);
});
test('projection applies ramp, seasonality, cap, and exclusive loyalty without double counting',()=>{
  const c={...defaults(),payout:40000,sessions:2,startMonth:'2026-01',cap:10,features:{loyaltyMin:{enabled:true,start:0},loyaltyAdv:{enabled:true,start:0},sms:{enabled:true,start:2}}};
  const p=projection(c);assert.equal(p.length,24);assert.equal(p[0].lift,0);assert.equal(p[0].gross,p[0].baseline);
  assert.equal(p[1].contributions.sms,0);assert.equal(p[10].contributions.loyaltyMin,undefined);assert.equal(p[23].lift,.1);assert.equal(p[23].capped,true);
  assert.equal(projection({...c,months:0}).length,0);assert.equal(projection({...c,startMonth:'bad'}).length,0);
});
test('unmapped halls and unknown prize totals are not zero-sized competitors',()=>{
  assert.equal(proximity(hall,{id:'unknown'}),null);assert.equal(proximity(hall,hall).overlap,100);
  assert.equal(payoutBand(null),'Unknown');assert.equal(payoutBand(25000),'Medium');
  assert.equal(safeUrl('javascript:alert(1)'),null);
});
test('fixed upstream proxy forwards only validated hall pagination, without credentials or arbitrary URLs',async()=>{
  let call;
  await readCompetitive('/api/competitive?hall=vanguard&offset=50&url=https://evil.invalid',async(url,options)=>{call={url:String(url),options};return {ok:true,json:async()=>({messages:[],hasMore:false})};});
  assert.equal(call.url,MONITOR_URL+'?hall=vanguard&offset=50');assert.equal(call.options.headers,undefined);
  await assert.rejects(readCompetitive('/api/competitive?hall=../../&offset=0',()=>assert.fail('must not fetch')));
  await assert.rejects(readCompetitive('/api/competitive?hall=vanguard&offset=-1',()=>assert.fail('must not fetch')));
});
test('UI shows dollars correctly, escapes source HTML, and loads older messages',async()=>{
  const dom=new JSDOM('<div id="app"></div>',{url:'https://sar.test'});
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.localStorage=dom.window.localStorage;
  const calls=[];
  const request=async path=>{calls.push(path);if(!path.includes('?'))return {halls:[hall],summaries:[{hallId:hall.id,count:2,latest:msg('a','10 mains $2,500 <img src=x>')} ]};return {messages:[msg(path.includes('offset=1')?'b':'a',path.includes('offset=1')?'4 premiums $5,000':'10 mains $2,500 <img src=x>')],hasMore:!path.includes('offset=1')};};
  const root=renderCompetition({request});document.getElementById('app').append(root);
  const settle=()=>new Promise(r=>setTimeout(r,20));await settle();
  const select=root.querySelector('select[aria-label="Hall"]');select.value=hall.id;select.dispatchEvent(new window.Event('change'));await settle();
  assert.match(root.textContent,/\$25,000/);assert.equal(root.querySelector('img[src=x]'),null);
  [...root.querySelectorAll('button')].find(b=>b.textContent==='Load older texts and emails').click();await settle();
  assert.ok(calls.some(p=>p.endsWith('offset=1')));assert.equal(root.querySelectorAll('.scout-evidence').length,2);
  [...root.querySelectorAll('button')].find(b=>b.textContent==='Use this offer as a scenario starting point').click();
  const sessions=root.querySelector('input[aria-label="Sessions per week"]');sessions.value='2';sessions.dispatchEvent(new window.Event('change'));
  assert.match(root.textContent,/\$62,500/);assert.match(root.textContent,/PARTIAL/);root.dispose();dom.window.close();
});

/* ---- Bingo Monitor integration: inbox, directory, day view ---- */
import { inboxCards, historyRows, dayRows, cleanBody, isProcedural, validDay, locationCount, directoryRows } from '../src/lib/competitive-inbox.js';

const SC = 'scout-vanguard-bingo-santa-clara', RWC = 'scout-vanguard-bingo-redwood-city';
const dirHalls = [
  { id: SC, name: 'Vanguard Bingo – Santa Clara', city: 'Santa Clara', competitionEligibility: { status: 'qualified' }, location: { lat: 37.35, lng: -121.95 } },
  { id: RWC, name: 'Vanguard Bingo – Redwood City', city: 'Redwood City', competitionEligibility: { status: 'qualified' }, location: { lat: 37.48, lng: -122.22 } },
  { id: 'maybe', name: 'Maybe Hall', city: 'San Jose', competitionEligibility: { status: 'needs_verification', reason: 'A source-backed weekly bingo schedule is still needed.' }, location: { lat: 37.33, lng: -121.88 } },
  { id: 'alias', name: 'Old alias', duplicateOf: SC },
];
// Santa Clara on 2 Oct: 19 texts over three weeks and one email, all from the shared short code.
const scHistory = [
  ...Array.from({ length: 19 }, (_, i) => ({ id: `t${i}`, channel: 'sms', kind: 'promotion', sender: '70503', hallIds: [SC], hallId: SC,
    body: i % 2 ? 'Vanguard: Santa Clara Tonight!' : 'Vanguard: Santa Clara Tonight!',   // identical words, separate messages
    receivedAt: new Date(Date.parse('2026-10-02T19:02:00Z') - i * 86400000 * 1.1).toISOString() })),
  { id: 'e1', channel: 'email', kind: 'promotion', hallIds: [SC], hallId: SC, subject: '$30,000 House Hot Ball',
    body: 'The House Hot Ball has reached its cap!\r\n\r\n-- \r\nYou received this message because you are subscribed to the Google Groups "Texting" group.\r\nTo unsubscribe…',
    receivedAt: '2026-10-02T14:16:09.000Z' },
];
const snapshot = {
  halls: dirHalls,
  summaries: [
    { hallId: RWC, count: 15, smsCount: 15, emailCount: 0, latest: { id: 'r1', channel: 'sms', body: 'RWC tonight', receivedAt: '2026-09-30T19:00:00Z' } },
    { hallId: SC, count: 20, smsCount: 19, emailCount: 1, latest: scHistory[0] },
  ],
  messages: [], unassignedCount: 1, lastSync: '2026-10-03T04:45:01.000Z', lastEmailSync: '2026-10-03T04:44:01.902Z',
};

test('inbox: one card per hall ID, monitor counts, newest first', () => {
  const cards = inboxCards(snapshot);
  assert.deepEqual(cards.map((c) => c.hallId), [SC, RWC], 'Santa Clara updated most recently');
  const sc = cards[0];
  assert.equal(sc.total, 20); assert.equal(sc.sms, 19); assert.equal(sc.email, 1);
  assert.equal(sc.name, 'Vanguard Bingo – Santa Clara');
  assert.equal(sc.latest.channel, 'Text');
  assert.equal(sc.eligibility.status, 'qualified');
});

test('history: newest first, email in the same list with its subject, footer cut, identical texts kept', () => {
  const rows = historyRows([...scHistory].reverse(), SC, dirHalls);
  assert.equal(rows.length, 20);
  assert.equal(rows.filter((r) => r.channel === 'Email').length, 1);
  assert.equal(rows.filter((r) => r.channel === 'Text').length, 19);
  assert.ok(rows.every((r, i) => i === 0 || Date.parse(rows[i - 1].at) >= Date.parse(r.at)), 'newest first');
  const email = rows.find((r) => r.channel === 'Email');
  assert.equal(email.subject, '$30,000 House Hot Ball');
  assert.doesNotMatch(email.body, /Google Groups/);
  assert.equal(rows.indexOf(email), 1, 'the 14:16 email sits between the 19:02 text and the older ones');
  // a repeated page does not duplicate; two messages with the same words stay two
  assert.equal(historyRows([...scHistory, ...scHistory], SC, dirHalls).length, 20);
});

test('shared-list messages appear under each hall and name the others; procedural ones are hidden', () => {
  const shared = { id: 's1', channel: 'sms', kind: 'promotion', hallIds: [SC, RWC], body: 'Both halls tonight', receivedAt: '2026-10-01T18:00:00Z' };
  const welcome = { id: 'w1', channel: 'sms', kind: 'welcome', hallIds: [SC], body: 'Welcome to our VIP text club', receivedAt: '2026-10-01T18:00:00Z' };
  const unkinded = { id: 'w2', channel: 'sms', kind: '', hallIds: [SC], body: "You're now subscribed to Vanguard texts. Reply STOP to opt out", receivedAt: '2026-10-01T18:00:00Z' };
  const promo = { id: 'p1', channel: 'sms', kind: '', hallIds: [SC], body: 'Hot ball $30K tonight. Reply STOP to opt out', receivedAt: '2026-10-01T18:00:00Z' };
  assert.equal(isProcedural(welcome), true); assert.equal(isProcedural(unkinded), true); assert.equal(isProcedural(promo), false);
  const sc = historyRows([shared, welcome, unkinded, promo], SC, dirHalls);
  assert.deepEqual(sc.map((r) => r.id).sort(), ['p1', 's1']);
  assert.deepEqual(sc.find((r) => r.id === 's1').sharedWith, ['Vanguard Bingo – Redwood City']);
  assert.deepEqual(historyRows([shared], RWC, dirHalls)[0].sharedWith, ['Vanguard Bingo – Santa Clara']);
});

test('day view names the halls, keeps unmatched messages visible, and the proxy forwards only real dates', async () => {
  const rows = dayRows([{ id: 'u', channel: 'sms', body: 'Freaky Friday', hallIds: [], receivedAt: '2026-10-02T17:00:00Z' }, scHistory[0]], dirHalls);
  assert.equal(rows[0].halls[0], 'Vanguard Bingo – Santa Clara');
  assert.equal(rows[1].unassigned, true);
  assert.equal(validDay('2026-10-02'), '2026-10-02'); assert.equal(validDay('2026-02-30'), null); assert.equal(validDay('2026-10-2'), null);
  let call;
  await readCompetitive('/api/competitive?day=2026-10-02', async (url) => { call = String(url); return { ok: true, json: async () => ({ halls: [], messages: [] }) }; });
  assert.equal(call, `${MONITOR_URL}?day=2026-10-02`);
  for (const bad of ['2026-02-30', '2026-10-02T00:00', '../x', '1e9']) {
    await assert.rejects(readCompetitive(`/api/competitive?day=${encodeURIComponent(bad)}`, () => assert.fail('must not fetch')));
  }
});

test('directory is separate from map eligibility; programs are counted apart from locations', () => {
  assert.equal(directoryRows(dirHalls).length, 3, 'aliases are not listings');
  assert.deepEqual(directoryRows(dirHalls, { status: 'needs_verification' }).map((h) => h.id), ['maybe']);
  assert.equal(locationCount([{ id: 'a', location: { lat: 37.1, lng: -122.1 } }, { id: 'b', location: { lat: 37.10001, lng: -122.10001 } }, { id: 'c', address: '1 Main St' }]), 2,
    'two charities in one building are two programs at one location');
  assert.equal(cleanBody({ channel: 'sms', body: ' text ' }), 'text');
});

test('UI: the inbox opens on Santa Clara with 20 updates, loads its full history and pages older ones', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://sar.test' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage;
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (path.includes('day=')) return { ...snapshot, messages: [scHistory[0], scHistory[19]] };
    if (path.includes(`hall=${SC}`)) {
      const off = Number(new URL(path, 'https://x').searchParams.get('offset'));
      return { messages: scHistory.slice(off, off + 12), hasMore: off + 12 < scHistory.length };
    }
    return snapshot;
  };
  const root = renderCompetition({ request }); document.getElementById('app').append(root);
  const settle = () => new Promise((r) => setTimeout(r, 30)); await settle(); await settle();
  assert.ok(calls.some((p) => /day=\d{4}-\d{2}-\d{2}/.test(p)), 'the day view asks for one day');
  const cards = [...root.querySelectorAll('.scout-hall')];
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, /20 updates · 19 texts · 1 email/);
  cards[0].querySelector('.scout-hall-top').click(); await settle();
  assert.ok(calls.includes(`/api/competitive?hall=${SC}&offset=0`));
  let open = root.querySelector('.scout-hall.is-open');
  assert.equal(open.querySelectorAll('.scout-msg').length, 12);
  [...open.querySelectorAll('button')].find((b) => b.textContent === 'Load older texts and emails').click(); await settle();
  assert.ok(calls.includes(`/api/competitive?hall=${SC}&offset=12`));
  open = root.querySelector('.scout-hall.is-open');
  assert.equal(open.querySelectorAll('.scout-msg').length, 20);
  assert.equal(open.querySelectorAll('.scout-msg-email').length, 1);
  assert.match(open.textContent, /\$30,000 House Hot Ball/);
  assert.doesNotMatch(open.textContent, /Google Groups/);
  // Directory lists the hall the maps do not count.
  [...root.querySelectorAll('button')].find((b) => b.textContent === 'Directory').click(); await settle();
  assert.match(root.textContent, /Maybe Hall/); assert.match(root.textContent, /Schedule to verify/);
  root.dispose(); dom.window.close();
});
