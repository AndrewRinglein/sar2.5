import { places } from './competitive-places.js';
export const MARKET_RADIUS_MILES = 50;
export const markets=[
 {id:'california',name:'All California',center:[37,-119.5],zoom:6,counties:[],cities:[]},
 {id:'bay-area',name:'Whole Bay Area',center:[37.78,-122.20],zoom:8,counties:['Alameda','Contra Costa','Marin','Napa','San Francisco','San Mateo','Santa Clara','Solano','Sonoma'],cities:['Santa Clara','Redwood City','San Jose','Milpitas','Concord','Pleasanton','San Francisco','Oakland','Hayward','Union City','Fremont','Sunnyvale','Cupertino','San Mateo','Livermore','Oakley','Antioch','Pittsburg','Brentwood','Morgan Hill','San Martin','Gilroy','South San Francisco','San Bruno','Daly City','Santa Rosa','Napa','Petaluma','Vallejo','Fairfield','Vacaville','San Rafael','Novato','Benicia','Richmond','San Pablo','Berkeley','Emeryville','San Leandro','Saratoga','Aptos']},
 {id:'salinas',name:'Salinas / Monterey Bay',center:[36.6777,-121.6555],zoom:9,counties:['Monterey','Santa Cruz','San Benito'],cities:['Salinas','Monterey','Marina','Seaside','Pacific Grove','Carmel','Watsonville','Santa Cruz','Scotts Valley','Aptos','Felton','Hollister','Gonzales','Soledad','Greenfield','King City','Castroville']},
 {id:'north-bay',name:'North Bay',center:[38.22,-122.50],zoom:9,counties:['Marin','Sonoma','Napa','Solano'],cities:['Santa Rosa','Rohnert Park','Cotati','Petaluma','Sebastopol','Healdsburg','Windsor','Guerneville','Sonoma','Napa','Calistoga','St. Helena','Vallejo','Benicia','Fairfield','Suisun City','Vacaville','Dixon','San Rafael','Novato','Mill Valley','Sausalito']},
 {id:'sacramento',name:'Greater Sacramento',center:[38.5816,-121.4944],zoom:9,counties:['Sacramento','Yolo','Placer','El Dorado'],cities:['Sacramento','West Sacramento','Citrus Heights','Rancho Cordova','North Highlands','Elk Grove','Roseville','Rocklin','Folsom','Fair Oaks','Orangevale','Carmichael','Antelope','Rio Linda','Davis','Woodland','Auburn','Lincoln','Placerville','Shingle Springs']},
 {id:'hawaiian-gardens',name:'Hawaiian Gardens area',center:[33.8314,-118.0728],zoom:10,counties:[],cities:['Hawaiian Gardens','Lakewood','Bellflower','Cypress','Long Beach','Los Alamitos','Cerritos','Norwalk','Downey','Artesia','Paramount','Buena Park','La Palma','Anaheim','Garden Grove','Stanton','Seal Beach','Huntington Beach','Westminster','La Mirada','Fullerton','Whittier','La Habra','Santa Fe Springs','Santa Ana','Orange','Placentia','Fountain Valley']},
];

export function inMarket(h,id){
 const m=markets.find(m=>m.id===id);
 if(id==='california'||!m)return true;
 const location=h.location;
 if(Number.isFinite(location?.lat)&&Number.isFinite(location?.lng))return miles(m.center,[location.lat,location.lng])<=MARKET_RADIUS_MILES;
 // Keep unlocated listings discoverable by their city's representative point. Do not place a hall marker here.
 const normalize=s=>(s||'').trim().toLowerCase().replace(/^carmel$/,'carmel-by-the-sea');
 return places.some(p=>normalize(p.name)===normalize(h.city)&&miles(m.center,[p.lat,p.lng])<=MARKET_RADIUS_MILES);
}
export function miles(a,b){const rad=Math.PI/180,dlat=(b[0]-a[0])*rad,dlng=(b[1]-a[1])*rad;const x=Math.sin(dlat/2)**2+Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(dlng/2)**2;return 3958.8*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
export function enrollmentLabel(h){if(!h.signup){if(h.emailSignup?.status==='confirmed')return 'Email subscribed';if(['form_submitted','request_sent'].includes(h.emailSignup?.status||''))return 'Email requested';return 'Text signup not found';}if(h.enrollmentStatus==='confirmed')return 'Subscribed';if(h.enrollmentStatus==='not_enrolled')return 'Signup not completed';return ({possibly_inactive_no_response:'No response',awaiting_confirmation:'Awaiting confirmation',needs_captcha:'Needs CAPTCHA',needs_birthdate:'Needs birthdate'})[h.enrollmentStatus]||h.enrollmentStatus.replaceAll('_',' ');}


