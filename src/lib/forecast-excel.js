import ExcelJS from 'exceljs';
import { projectPlan, PLAN_FIELDS } from './forecast-plan.js';

export async function forecastWorkbook(plan) {
  const book=new ExcelJS.Workbook();book.creator='SAR';book.title=plan.name||'12-month forecast';book.calcProperties.fullCalcOnLoad=true;
  const notes=book.addWorksheet('Read me');
  for(const line of [plan.name||'12-month forecast',`Start month: ${plan.start}; 12 full months. Exported ${new Date().toISOString()}`,
    'All money is USD. Attendance means attendees per session. RPA means revenue per attendee.',
    'Revenue = sessions × attendance × RPA. Net after prizes = revenue × margin. Profit = net after prizes − operating expenses.',
    'Margin is after prizes and before operating expenses. Blank operating expenses mean unknown profit, not zero expense.',
    'These are scenario assumptions, not confidence intervals. New halls are assumptions only.',
    'Hall sheets contain editable inputs and formulas. Inherited changes reference the prior month; later explicit changes override them.',
    'Historical baselines are frozen at the time this forecast was created. Named forecasts and drafts are stored only in the browser.',
    'Expense history has not been recovered. Enter a complete operating budget before relying on profit.'])notes.addRow([line]);
  notes.getColumn(1).width=120;notes.eachRow(row=>{row.alignment={wrapText:true};row.height=32;});
  const result=projectPlan(plan);const sheets=[];
  const cash='$#,##0.00;[Red]($#,##0.00)';
  for(const [index,hall] of result.halls.entries()){
    const sheet=book.addWorksheet(`Hall ${index+1}`);sheets.push(sheet.name);
    sheet.addRow([hall.name]);sheet.addRow([hall.source]);sheet.addRow([`Opens ${hall.opening}; input values in blue. Inherited overrides use formulas.`]);
    sheet.addRow(['Month','Sessions','Attendance / session','RPA ($)','Margin','Total attendance','Revenue','Prizes','Net after prizes','Operating expenses','Profit']);
    for(const [i,row]of hall.rows.entries()){
      const n=i+5;sheet.addRow([row.month,row.sessions,row.attendance,row.rpa,Number.isFinite(row.margin)?row.margin/100:null,null,null,null,null,row.expenses,null]);
      const formula=(col,formula,value)=>{sheet.getCell(`${col}${n}`).value={formula,result:value??''};};
      for(const [key,col]of [['sessions','B'],['attendance','C'],['rpa','D'],['margin','E'],['expenses','J']]){
        if(row.active && i>0 && hall.rows[i-1].active && row.origins[key] && row.origins[key]!==row.month){formula(col,`${col}${n-1}`,key==='margin'?row[key]/100:row[key]);}
        else sheet.getCell(`${col}${n}`).font={color:{argb:'FF1756B3'}};
      }
      formula('F',`IF(COUNT(B${n}:C${n})=2,B${n}*C${n},"")`,row.visits);
      formula('G',`IF(COUNT(D${n},F${n})=2,D${n}*F${n},"")`,row.gross);
      formula('I',`IF(COUNT(E${n},G${n})=2,E${n}*G${n},"")`,row.net);
      formula('H',`IF(COUNT(G${n},I${n})=2,G${n}-I${n},"")`,row.payout);
      formula('K',`IF(COUNT(I${n},J${n})=2,I${n}-J${n},"")`,row.profit);
      if(!row.active)for(const col of ['F','G','H','I','J','K'])sheet.getCell(`${col}${n}`).value=0;
      for(const [key,col]of [['sessions','B'],['attendance','C'],['rpa','D'],['margin','E'],['expenses','J']]){const f=PLAN_FIELDS[key];sheet.getCell(`${col}${n}`).dataValidation={type:key==='sessions'?'whole':'decimal',operator:'between',allowBlank:true,formulae:[key==='margin'?f.min/100:f.min,key==='margin'?f.max/100:f.max],showErrorMessage:true,error:'Enter a valid nonnegative assumption; margin must be between -100% and 100%.'};}
    }
    sheet.getColumn(1).width=15;for(let c=2;c<=11;c++)sheet.getColumn(c).width=22;
    for(const col of ['D','G','H','I','J','K'])sheet.getColumn(col).numFmt=cash;sheet.getColumn('E').numFmt='0.0%';sheet.getColumn('C').numFmt='0.0';sheet.getColumn('F').numFmt='#,##0';
    sheet.views=[{state:'frozen',ySplit:4,xSplit:1}];sheet.autoFilter='A4:K16';sheet.getRow(4).font={bold:true};
  }
  const summary=book.addWorksheet('All halls');summary.addRow(['Month','Sessions','Attendance','Revenue','Prizes','Net after prizes','Expenses','Profit']);
  for(const [i,m]of result.months.entries()){
    const n=i+2;summary.addRow([m.month]);
    for(const [col,source,key]of [['B','B','sessions'],['C','F','visits'],['D','G','gross'],['E','H','payout'],['F','I','net'],['G','J','expenses'],['H','K','profit']]){
      const refs=sheets.map(name=>`'${name}'!${source}${i+5}`).join(',');summary.getCell(`${col}${n}`).value=sheets.length?{formula:`IF(COUNT(${refs})=${sheets.length},SUM(${refs}),"")`,result:m[key]??''}:0;
    }
  }
  summary.addRow(['12-month total']);for(const col of ['B','C','D','E','F','G','H'])summary.getCell(`${col}14`).value={formula:`IF(COUNT(${col}2:${col}13)=12,SUM(${col}2:${col}13),"")`,result:result.months.some(m=>m[{B:'sessions',C:'visits',D:'gross',E:'payout',F:'net',G:'expenses',H:'profit'}[col]]===null)?'':result.months.reduce((s,m)=>s+m[{B:'sessions',C:'visits',D:'gross',E:'payout',F:'net',G:'expenses',H:'profit'}[col]],0)};
  for(let c=1;c<=8;c++)summary.getColumn(c).width=22;for(const col of ['D','E','F','G','H'])summary.getColumn(col).numFmt=cash;summary.getRow(1).font={bold:true};summary.getRow(14).font={bold:true};summary.views=[{state:'frozen',ySplit:1}];
  const changes=book.addWorksheet('Changes');changes.addRow(['Hall','Starting month','Metric','New value','Unit']);for(const hall of plan.halls)for(const [month,fields]of Object.entries(hall.changes||{}))for(const [key,value]of Object.entries(fields))changes.addRow([hall.name,month,PLAN_FIELDS[key]?.label||key,value,key==='margin'?'percentage points (absolute margin %)':key==='rpa'||key==='expenses'?'USD':'count']);for(let c=1;c<=5;c++)changes.getColumn(c).width=30;
  return book;
}
export async function downloadForecastPlan(plan) {
  const book=await forecastWorkbook(plan);const buffer=await book.xlsx.writeBuffer();
  const url=URL.createObjectURL(new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  const a=document.createElement('a');a.href=url;a.download=`${(plan.name||'SAR 12-month forecast').replace(/[<>:"/\\|?*\x00-\x1F]/g,'-')}.xlsx`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
