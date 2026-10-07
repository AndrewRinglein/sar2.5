import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {renderAsk,conversation,resetConversation} from '../src/screens/ask.js';
import {makeData} from './fixtures/screen-data.mjs';
for(const mode of ['reset','dispose'])test(`late Ask response ignored after ${mode}`,async()=>{
  const dom=new JSDOM('<body></body>',{url:'https://sar.test'});globalThis.window=dom.window;globalThis.document=dom.window.document;
  resetConversation();let release;
  const root=renderAsk({data:makeData(),params:{},request:()=>new Promise(resolve=>{release=resolve;})});
  document.body.append(root);root.querySelector('#q').value='What is our revenue?';
  root.querySelector('form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  assert.equal(conversation.length,1);
  if(mode==='dispose')root.dispose();else resetConversation();
  assert.equal(conversation.length,0);
  release({ok:true,text:'Stale answer'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(conversation.length,0);dom.window.close();
});
