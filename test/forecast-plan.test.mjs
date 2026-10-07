import {test} from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {JSDOM} from 'jsdom';
import {projectPlan,setPlanValue,readPlans,writePlans,PLAN_STORAGE,seedPlan} from '../src/lib/forecast-plan.js';
import {forecastWorkbook} from '../src/lib/forecast-excel.js';
import {renderForecastPlan} from '../src/components/forecast-plan.js';
import {makeData} from './fixtures/screen-data.mjs';
const fixture=()=>({version:1,start:'2026-11',name:'Expansion',halls:[{id:'h1',name:'Existing',opening:'2026-11',base:{sessions:12,attendance:100,rpa:200,margin:30,expenses:10000},changes:{}}]});
test('HAND: independent attendance, RPA and margin changes carry through year boundary, with later override and reset',()=>{
  const p=fixture();setPlanValue(p,'h1','2026-12','attendance',150);setPlanValue(p,'h1','2027-01','rpa',220);setPlanValue(p,'h1','2027-02','margin',35);setPlanValue(p,'h1','2027-03','attendance',180);
  let rows=projectPlan(p).halls[0].rows;
  assert.equal(rows.length,12);assert.equal(rows[0].gross,240000);assert.equal(rows[0].net,72000);assert.equal(rows[0].profit,62000);
  assert.equal(rows[1].gross,360000);assert.equal(rows[2].gross,396000);assert.equal(rows[3].net,138600);assert.equal(rows[4].gross,475200);assert.equal(rows[11].gross,475200);
  setPlanValue(p,'h1','2027-03','attendance','');rows=projectPlan(p).halls[0].rows;assert.equal(rows[11].attendance,150);assert.equal(rows[11].rpa,220);assert.equal(rows[11].margin,35);
  assert.throws(()=>setPlanValue(p,'h1','2026-12','margin',101));assert.throws(()=>setPlanValue(p,'h1','2026-12','attendance',-2));
});
test('new hall starts in opening month; unknown expenses keep combined profit unknown; zero is explicit',()=>{
  const p=fixture();p.halls.push({id:'h2',name:'New',opening:'2027-01',base:{sessions:8,attendance:50,rpa:100,margin:25,expenses:null},changes:{}});
  let r=projectPlan(p);assert.equal(r.months[0].gross,240000);assert.equal(r.months[2].gross,280000);assert.equal(r.months[0].profit,62000);assert.equal(r.months[2].profit,null);
  setPlanValue(p,'h2','2027-01','expenses',0);r=projectPlan(p);assert.equal(r.months[2].profit,72000);
});
test('named snapshot round trips without subsequent draft mutations and blocked storage reports failure',()=>{
  const p=fixture();const mem=new Map();const store={getItem:k=>mem.get(k),setItem:(k,v)=>mem.set(k,v)};assert.equal(writePlans(store,{saved:[p],draft:p}),true);p.halls[0].base.rpa=999;assert.equal(readPlans(store).saved[0].halls[0].base.rpa,200);assert.ok(mem.get(PLAN_STORAGE));assert.equal(writePlans({setItem(){throw Error();}},{saved:[]}),false);
});
test('Excel round trip preserves formulas, cached totals, carry-forward references and missing expenses',async()=>{
  const p=fixture();setPlanValue(p,'h1','2026-12','attendance',150);setPlanValue(p,'h1','2027-02','attendance',180);p.halls[0].base.expenses=null;
  const book=await forecastWorkbook(p);const loaded=new ExcelJS.Workbook();await loaded.xlsx.load(await book.xlsx.writeBuffer());
  const h=loaded.getWorksheet('Hall 1');assert.equal(h.getCell('G5').result,240000);assert.equal(h.getCell('I5').result,72000);assert.equal(h.getCell('C7').formula,'C6');assert.equal(h.getCell('C8').value,180);assert.equal(h.getCell('J5').value,null);assert.match(h.getCell('K5').formula,/COUNT/);assert.equal(loaded.getWorksheet('All halls').getCell('D2').result,240000);assert.equal(loaded.getWorksheet('Changes').rowCount,3);
});
test('UI adds a planned hall, saves and reloads it with independently carried changes',()=>{
  const dom=new JSDOM('<body></body>',{url:'https://sar.test'});globalThis.document=dom.window.document;globalThis.window=dom.window;
  const store=dom.window.localStorage;const data=makeData();const root=renderForecastPlan({data,today:'2026-08-14',store});document.body.append(root);
  const form=root.querySelector('.fc-plan-add form');form.elements.hallName.value='New Test Hall';for(const[k,v]of Object.entries({sessions:12,attendance:100,rpa:200,margin:30}))form.elements[k].value=v;
  form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));assert.match(root.textContent,/Hall added/);
  const input=root.querySelector('input[aria-label="New Test Hall 2026-10 Attendance / session"]');input.value=150;input.dispatchEvent(new window.Event('change'));
  const name=root.querySelector('[aria-label="12-month forecast name"]');name.value='Ramp up';[...root.querySelectorAll('button')].find(b=>b.textContent==='Save forecast').click();
  assert.equal(readPlans(store).saved[0].name,'Ramp up');const p=readPlans(store).saved[0];assert.equal(projectPlan(p).halls.at(-1).rows[11].attendance,150);
  const second=renderForecastPlan({data,today:'2026-08-14',store});assert.equal(second.querySelector('[aria-label="12-month forecast name"]').value,'Ramp up');
  dom.window.close();
});
test('seeding converts cents once and freezes the historical monthly model',()=>{
  const data=makeData();data.locations=data.locations.filter(l=>l.id==='LS');data.events.forEach((e,i)=>{e.location_id='LS';e.event_type='regular';e.event_date=new Date(Date.UTC(2026,7,13)-i*7*86400000).toISOString().slice(0,10);});const p=seedPlan(data,'2026-08-14');assert.equal(p.start,'2026-09');assert.ok(p.halls.length>0);const projected=projectPlan(p);const h=projected.halls[0];assert.ok(h.rows[0].rpa>0&&h.rows[0].rpa<2000);assert.equal(h.rows[0].expenses,null);
});
