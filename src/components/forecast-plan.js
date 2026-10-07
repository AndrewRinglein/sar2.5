import { PLAN_FIELDS, planMonths, seedPlan, projectPlan, setPlanValue, validPlanValue, readPlans, writeDraft, savePlan } from '../lib/forecast-plan.js';
import { monthFull } from '../lib/charts.js';
import { esc } from '../lib/fmt.js';
import { play } from '../lib/sound.js';

const el=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls||'';if(text!==undefined)e.textContent=text;return e;};
const dollars=v=>v===null||!Number.isFinite(v)?'Not set':v.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
const option=(text,value)=>{const o=el('option','',text);o.value=value;return o;};
const copy=value=>JSON.parse(JSON.stringify(value));
export function renderForecastPlan({data,today,store}) {
  const root=el('section','panel fc-plan');
  const memory=readPlans(store); let plan=memory.draft||seedPlan(data,today), hallId=plan.halls[0]?.id||'', notice='';
  const persist=()=>{memory.draft=copy(plan);if(!writeDraft(store,plan))notice='Browser storage is unavailable. Download Excel to keep this forecast.';};
  const button=(label,fn)=>{const b=el('button','chip',label);b.type='button';b.onclick=fn;return b;};
  function draw(){
    memory.saved=readPlans(store).saved;
    root.replaceChildren(el('h3','panel-title','12-month forecast'));
    root.append(el('p','muted','Attendance × RPA = revenue. Revenue × Margin = net after prizes. Operating expenses are subtracted separately to calculate profit. Pick a month and edit any input; it carries forward until a later explicit change. Clear an input to restore its inherited value.'));
    const saving=el('div','filter-bar');const name=el('input');name.type='text';name.maxLength=80;name.value=plan.name;name.placeholder='Forecast name';name.setAttribute('aria-label','12-month forecast name');name.onchange=()=>{plan.name=name.value.trim();persist();};
    saving.append(name,button('Save forecast',()=>{plan.name=name.value.trim();if(!plan.name){notice='Give this forecast a name first.';draw();return;}
      plan.id ||= globalThis.crypto?.randomUUID?.()||`plan-${Date.now()}`;
      plan.savedAt=new Date().toISOString();notice=savePlan(store,plan)?`Saved “${plan.name}” in this browser.`:'Browser storage is unavailable. Download Excel to keep this forecast.';persist();play('success');draw();
    }),button('Save as copy',()=>{plan.name=name.value.trim();if(!plan.name){notice='Give the copy a name first.';draw();return;}plan.id=globalThis.crypto.randomUUID();plan.savedAt=new Date().toISOString();notice=savePlan(store,plan)?`Saved copy “${plan.name}”.`:'Browser storage is unavailable. Download Excel to keep this forecast.';persist();draw();}),button('New forecast',()=>{plan=seedPlan(data,today);hallId=plan.halls[0]?.id||'';notice='New forecast seeded from current data. Saved forecasts are unchanged.';persist();draw();}));
    const exportButton=button('Download Excel',async()=>{exportButton.disabled=true;exportButton.textContent='Preparing Excel…';try{plan.name=name.value.trim();persist();const {downloadForecastPlan}=await import('../lib/forecast-excel.js');await downloadForecastPlan(plan);notice='Excel downloaded, including inputs, carried-forward changes and formulas.';}catch{notice='Excel could not be downloaded. Try again.';}draw();});saving.append(exportButton);
    if(memory.saved.length){const select=el('select');select.setAttribute('aria-label','Saved 12-month forecasts');select.append(option('Load a saved forecast…',''));for(const s of memory.saved)select.append(option(s.name,s.id));select.onchange=()=>{const saved=memory.saved.find(s=>s.id===select.value);if(saved){plan=copy(saved);hallId=plan.halls[0]?.id||'';notice=`Loaded “${plan.name}”.`;persist();draw();}};saving.append(select);}
    root.append(saving,el('p','dim',`${monthFull(plan.start)} through ${monthFull(planMonths(plan.start).at(-1))} · 12 full months · draft and named forecasts saved in this browser only.`));
    if(!plan.baselineVersion && plan.halls.some(h=>h.baselines)) root.append(el('p','mg-notice','This forecast uses an older saved baseline that may omit sessions with sparse history. Review Sessions / month, or choose New forecast to use the corrected schedule. Your saved assumptions have been preserved.'));
    if(notice){const status=el('p','mg-notice',notice);status.setAttribute('role','status');root.append(status);}
    const projected=projectPlan(plan);const summary=el('table','rn-table');summary.innerHTML='<thead><tr><th class="name">Month · all halls</th><th>Attendance</th><th>Revenue</th><th>Net after prizes</th><th>Operating expenses</th><th>Profit</th></tr></thead>';
    const tbody=el('tbody');for(const m of projected.months){const tr=el('tr');for(const [i,value] of [monthFull(m.month),m.visits===null?'Not set':Math.round(m.visits).toLocaleString(),dollars(m.gross),dollars(m.net),dollars(m.expenses),dollars(m.profit)].entries())tr.append(el('td',i===0?'name':'',value));tbody.append(tr);}const annual={};for(const key of ['visits','gross','net','expenses','profit'])annual[key]=projected.months.some(m=>m[key]===null)?null:projected.months.reduce((sum,m)=>sum+m[key],0);
    const totalRow=el('tr','rn-total');for(const [i,value]of ['12-month total',annual.visits===null?'Not set':Math.round(annual.visits).toLocaleString(),dollars(annual.gross),dollars(annual.net),dollars(annual.expenses),dollars(annual.profit)].entries())totalRow.append(el('td',i===0?'name':'',value));tbody.append(totalRow);
    summary.append(tbody);const wrap=el('div','so-scroll');wrap.append(summary);root.append(wrap);
    root.append(el('p','mg-notice','Expense history has not been recovered. Enter each hall’s full operating budget below; blank expense inputs mean profit is unknown, not zero. Margin here is after prizes, before operating expenses. These are editable planning assumptions, not a statistical confidence forecast.'));
    const selector=el('div','filter-bar');for(const hall of plan.halls)selector.append(button(hall.name,()=>{hallId=hall.id;draw();}));root.append(selector);
    const hall=plan.halls.find(h=>h.id===hallId);const output=projected.halls.find(h=>h.id===hallId);
    if(hall){root.append(el('h4','',hall.name),el('p','dim',hall.source));
      if(hall.isNew){const opening=el('label','','Opening month '),select=el('select');select.setAttribute('aria-label','Opening month');for(const month of planMonths(plan.start))select.append(option(monthFull(month),month));select.value=hall.opening;select.onchange=()=>{hall.opening=select.value;persist();draw();};opening.append(select);root.append(opening,button('Remove planned hall',()=>{plan.halls=plan.halls.filter(h=>h.id!==hallId);hallId=plan.halls[0]?.id||'';persist();draw();}));}
      const table=el('table','rn-table fc-plan-inputs');table.innerHTML='<thead><tr><th class="name">Change starting in</th>'+Object.values(PLAN_FIELDS).map(f=>`<th>${esc(f.label)}</th>`).join('')+'<th>Revenue</th><th>Net</th></tr></thead>';const body=el('tbody');
      for(const row of output.rows){const tr=el('tr');tr.append(el('td','name',monthFull(row.month)+(row.active?'':' · not open')));
        for(const [key,f] of Object.entries(PLAN_FIELDS)){const td=el('td');const input=el('input');input.type='number';input.min=f.min;input.max=f.max;input.step=f.step;input.setAttribute('aria-label',`${hall.name} ${row.month} ${f.label}`);
          const own=hall.changes?.[row.month]?.[key];input.value=own??'';input.placeholder=row[key]===null||row[key]===undefined?'Not set':String(Number(Number(row[key]).toFixed(2)));input.title=own!==undefined?'Explicit change; carries forward':row.origins[key]?`Inherited from ${monthFull(row.origins[key])}`:'Historical baseline; enter a value to override from this month';input.dataset.explicit=String(own!==undefined);
          let committed=input.value;const commit=()=>{if(input.value===committed)return;if(!input.checkValidity()){input.reportValidity();return;}try{setPlanValue(plan,hall.id,row.month,key,input.value);committed=input.value;notice='';persist();draw();}catch(e){input.setCustomValidity(e.message);input.reportValidity();}};input.onchange=commit;input.onblur=commit;td.append(input);tr.append(td);}
        tr.append(el('td','',dollars(row.gross)),el('td','',dollars(row.net)));body.append(tr);
      }table.append(body);const sw=el('div','so-scroll');sw.append(table);root.append(sw,el('p','dim','Gray placeholder values are inherited or historical baselines. Filled inputs mark explicit changes. Changes to Attendance, RPA, and Margin carry independently; they do not compound each month.'));
    }
    const adding=el('details','fc-plan-add');adding.append(el('summary','panel-title','Add a hall'));
    const form=el('form','filter-bar');form.innerHTML='<label>Hall name <input name="hallName" required maxlength="80" aria-label="New hall name"></label>';
    const opening=el('label','','Opening month '),sel=el('select');sel.name='opening';sel.setAttribute('aria-label','New hall opening month');for(const month of planMonths(plan.start))sel.append(option(monthFull(month),month));opening.append(sel);form.append(opening);
    for(const [key,f]of Object.entries(PLAN_FIELDS)){const label=el('label','',f.label+' ');const input=el('input');input.name=key;input.type='number';input.min=f.min;input.max=f.max;input.step=f.step;input.required=key!=='expenses';input.setAttribute('aria-label',`New hall ${f.label}`);label.append(input);form.append(label);}
    const submit=el('button','primary','Add hall');submit.type='submit';form.append(submit);form.onsubmit=e=>{e.preventDefault();if(!form.reportValidity())return;const base={};for(const key of Object.keys(PLAN_FIELDS)){const value=form.elements.namedItem(key).value;base[key]=value===''?null:Number(value);if(value!==''&&!validPlanValue(key,value))return;}
      hallId=globalThis.crypto?.randomUUID?.()||`hall-${Date.now()}`;plan.halls.push({id:hallId,name:form.elements.namedItem('hallName').value.trim(),opening:sel.value,isNew:true,base,changes:{},source:'Planned hall — user-entered assumptions; no historical attendance or revenue.'});notice='Hall added. Use monthly changes to model its ramp-up.';persist();draw();};adding.append(form);root.insertBefore(adding,wrap);
  }
  draw();return root;
}
