// Conservative, source-local extraction. Never aggregate different messages or
// interpret a progressive jackpot as guaranteed money paid per session.
const amount=s=>Number(s.replace(/[$,\sK]/gi,''))*(/k/i.test(s)?1000:1);
export function extractProgram(body){
 const text=body.replace(/https?:\/\/\S+/g,'').replace(/str!pz/gi,'strips').replace(/strips\s+that\s+pay/gi,'strips pay');
 const buyIns=[];
 for(const m of text.matchAll(/(?:\$?([\d,]+(?:\.\d+)?)\s*(?:buy[ -]?in|bucks|to play)|buy[ -]?in\s*(?:from|starting at|:|only|of)?\s*\$([\d,]+(?:\.\d+)?))/gi)){
  const value=Number((m[1]||m[2]).replaceAll(',',''));if(value>0&&value<=5000&&!buyIns.some(x=>x.value===value))buyIns.push({value,evidence:m[0]});
 }
 const games=[...text.matchAll(/\b(\d{1,2})\s+(?:regular\s+)?games\b/gi)].map(m=>({count:Number(m[1]),evidence:m[0]}));
 const prizes=[];
 const re=/\b(\d{1,2})\s*(?:main\s*strips?|mains?|premium\s*strips?|premiums?|regular\s*strips?|strips?|games)?\s*(?:paying|pay|win|@|=|x|at)?\s*\$?([\d,]+(?:\.\d+)?\s*[kK]?)\s*(?:each|ea\b)?/gi;
 for(const m of text.matchAll(re)){
  // A word/operator must separate count from payout; exclude dates and bare numbers.
  if(!/(?:strips?|mains?|premiums?|games|paying|pay|win|@|=|\bx\b|\bat\b)/i.test(m[0]))continue;
  const count=Number(m[1]),payout=amount(m[2]);if(count<1||count>50||payout<100||payout>100000)continue;
  const around=text.slice(Math.max(0,m.index-35),m.index+m[0].length+65);
  if(/(?:up to|example|if you|or less|\d+\s*(?:numbers|#)|multiplier|progressive|jackpot|chance to|could win)/i.test(around))continue;
  if(prizes.some(p=>p.evidence===m[0]))continue;
  prizes.push({count,payout,subtotal:count*payout,evidence:m[0]});
 }
 // Bingo shorthand such as FOUR-5Ks and (4) 5Ks denotes multiple prizes.
 // Require plural Ks so a plain monetary range (4-5K) is not interpreted as a game count.
 const words={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
 for(const m of text.matchAll(/(?:\b(one|two|three|four|five|six|seven|eight|nine|ten|\d{1,2})\s*[-×]\s*|\((\d{1,2})\)\s*)\$?(\d+(?:\.\d+)?)\s*Ks\b/gi)){
  const count=words[m[1]?.toLowerCase()]||Number(m[1]||m[2]),payout=Number(m[3])*1000;
  const around=text.slice(Math.max(0,m.index-25),m.index+m[0].length+35);
  if(/up to|progressive|jackpot|chance to|if won/i.test(around)||count<1||count>50||payout>100000)continue;
  prizes.push({count,payout,subtotal:count*payout,evidence:m[0]});
 }
 return {buyIns,games,prizes,advertisedSubtotal:prizes.reduce((s,p)=>s+p.subtotal,0),hasEvidence:!!(buyIns.length||games.length||prizes.length)};
}
export function projectProgram({payout,sessions,payoutRatio}){
 if(!Number.isFinite(payout)||payout<=0||!Number.isFinite(sessions)||sessions<=0||!Number.isFinite(payoutRatio)||payoutRatio<=0||payoutRatio>1)return null;
 const weeklyPayout=payout*sessions,weeklyGross=weeklyPayout/payoutRatio;
 return {weeklyPayout,weeklyGross,annualGross:weeklyGross*52,weeklyRemainder:weeklyGross-weeklyPayout};
}
// Website groups belong to one published session/program. Never combine variants.
export function summarizePublishedProgram(program){
 const fixedGroups=(program.gameGroups||[]).filter(g=>!g.conditional&&Number.isInteger(g.count)&&g.count>0&&Number.isFinite(g.prize)&&g.prize>0);
 return {fixedGames:fixedGroups.reduce((n,g)=>n+g.count,0),fixedSubtotal:fixedGroups.reduce((n,g)=>n+g.count*g.prize,0)};
}
