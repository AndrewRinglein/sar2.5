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

const hall={id:'vanguard',name:'Vanguard Santa Clara',city:'Santa Clara',address:'Santa Clara, CA',location:{lat:37.37,lng:-121.95},schedule:{days:['Friday']},publishedPrograms:[]};
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
