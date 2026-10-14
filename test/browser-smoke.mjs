// Optional DOM-only end-to-end test. Uses system Chromium; never captures pixels.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
const temp = await mkdtemp(path.join(tmpdir(), 'quizpop-browser-'));
const local = createApp({dataDir:path.join(temp,'data')});
await new Promise(resolve=>local.server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${local.server.address().port}`;
const browser = spawn(process.env.CHROMIUM || 'chromium',['--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${temp}/profile`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']});
const sockets=[];
let endpoint;
try {
  endpoint=await new Promise((resolve,reject)=>{
    let output=''; const timeout=setTimeout(()=>reject(new Error(`Chromium startup timed out: ${output.slice(-1000)}`)),15000);
    browser.on('error',e=>{clearTimeout(timeout);reject(e);});
    browser.stderr.on('data',chunk=>{output+=chunk;const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
    browser.on('exit',code=>{clearTimeout(timeout);reject(new Error(`Chromium exited ${code}: ${output.slice(-1000)}`));});
  });
  const debugOrigin=new URL(endpoint);debugOrigin.protocol='http:';
  async function page(hash='') {
    const target=await fetch(`${debugOrigin.origin}/json/new?${encodeURIComponent(origin+'/'+hash)}`,{method:'PUT'}).then(r=>r.json());
    const socket=new WebSocket(target.webSocketDebuggerUrl);sockets.push(socket);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let id=0;const pending=new Map();const exceptions=[];
    socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);};
    const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));});
    const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error(`Wait failed: ${expression}\n${await evaluate('document.body.innerText')}`);};
    const click=async selector=>{await wait(`!!document.querySelector(${JSON.stringify(selector)})`);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);};
    await call('Runtime.enable');await wait('document.readyState === "complete" && !!document.querySelector("#app")');
    return {evaluate,wait,click,call,exceptions};
  }
  const host=await page('#create');
  await host.wait('!!document.querySelector("#quiz-title")');
  await host.evaluate(`document.querySelector('#quiz-title').value='Browser smoke quiz';document.querySelector('[data-question]').value='Two plus two?';document.querySelectorAll('[data-answer]').forEach((el,i)=>el.value=['Four','Three','Two','One'][i]);document.querySelector('#editor-form').requestSubmit();`);
  await host.wait('!!document.querySelector("[data-host]:not([data-host=sample])")');
  await host.click('[data-host]:not([data-host=sample])');
  await host.wait('!!document.querySelector(".pin-display strong")');
  const pin=await host.evaluate('document.querySelector(".pin-display strong").textContent');
  async function join(name) {
    const p=await page(`#join/${pin}`);
    await p.wait('!!document.querySelector("#join-form")');
    await p.evaluate('document.querySelector("#join-form").requestSubmit()');
    await p.evaluate(`document.querySelector('#nickname').value=${JSON.stringify(name)};document.querySelector('#nickname-form').requestSubmit()`);
    await p.wait('document.body.innerText.includes("Your host will start")');
    return p;
  }
  const alice=await join('Alice'),bob=await join('Bob');
  await host.wait('document.querySelectorAll(".player-chip").length===2');
  await host.click('[data-action=start]');
  await alice.wait('!!document.querySelector("[data-answer-index]")');
  await bob.wait('!!document.querySelector("[data-answer-index]")');
  await alice.click('[data-answer-index="0"]');
  await alice.wait('document.body.innerText.includes("Answer locked in")');
  await bob.click('[data-answer-index="1"]');
  await alice.wait('document.body.innerText.includes("Correct!")');
  await bob.wait('document.body.innerText.includes("Not this time")');
  await host.wait('document.querySelectorAll(".rank-row").length===2');
  await host.click('[data-action=next]');
  await alice.wait('document.body.innerText.includes("Alice takes the crown!")');
  await host.call('Page.reload');
  await host.wait('document.body.innerText.includes("Alice takes the crown!")');
  await alice.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await alice.evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'mobile page must not overflow');
  for(const p of [host,alice,bob])assert.deepEqual(p.exceptions,[],'no uncaught browser exceptions');
  console.log('PASS: quiz creation → host → two players → answers → scores → podium → host refresh; mobile width; no browser exceptions. No screenshots captured.');
} finally {
  for(const socket of sockets)socket.close();
  browser.kill('SIGTERM');await new Promise(resolve=>{if(browser.exitCode!==null)return resolve();browser.once('exit',resolve);setTimeout(resolve,3000).unref();});
  await local.close();await rm(temp,{recursive:true,force:true});
}
