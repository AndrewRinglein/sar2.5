import { safeUrl } from './competitive-model.js';

export function hallPopup(hall, summary = {}, onMessages) {
  const root = document.createElement('div');
  root.className = 'scout-popup';
  const website = safeUrl(hall.website);
  const title = document.createElement(website ? 'a' : 'strong');
  title.textContent = hall.name;
  if (website) {
    title.href = website; title.target = '_blank'; title.rel = 'noopener noreferrer';
    title.className = 'scout-website-link';
  }
  root.append(title);
  const line = text => { const p = document.createElement('p'); p.textContent = text; root.append(p); };
  line(website || 'Website not verified');
  if (hall.address) line(hall.address);
  const sms = Number.isFinite(Number(summary.smsCount)) ? Math.max(0, Number(summary.smsCount)) : 0;
  line(sms > 0 ? `Texting: yes · ${sms} collected texts`
    : hall.signup ? 'Texting: signup found · no texts collected yet' : 'Texting: not yet verified');
  const messages = document.createElement('a');
  messages.href = '#/competition?tab=messages&hall=' + encodeURIComponent(hall.id);
  messages.textContent = 'View texts and emails';
  messages.className = 'scout-website-link';
  if (onMessages) messages.addEventListener('click', event => { event.preventDefault(); onMessages(hall.id); });
  root.append(messages);
  return root;
}
