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
  await host.evaluate(`document.querySelector('#quiz-title').value='Browser smoke quiz';document.querySelector('[data-question]').value='Two plus two?';document.querySelectorAll('[data-answer]').forEach((el,i)=>el.value=['Four','Three','Two','One'][i]);`);
  await host.evaluate(`
    const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'),c=>c.charCodeAt(0));
    const transfer=new DataTransfer(); transfer.items.add(new File([bytes],'pixel.png',{type:'image/png'}));
    const input=document.querySelector('[data-image]');input.files=transfer.files;input.dispatchEvent(new Event('change'));
  `);
  await host.wait('!!document.querySelector(".editor-image")');
  await host.evaluate(`document.querySelector('[data-image-alt]').value='Example picture';`);
  for (const [index,type,heading] of [[1,'true-false','Earth is a planet.'],[2,'type-answer','Name the capital of Sweden.'],[3,'poll','Choose a color.']]) {
    await host.click('#add-question');
    await host.evaluate(`document.querySelector('#type-${index}').value=${JSON.stringify(type)};document.querySelector('#type-${index}').dispatchEvent(new Event('change'));`);
    await host.evaluate(`document.querySelector('#question-${index}').value=${JSON.stringify(heading)};`);
    if(type==='type-answer') await host.evaluate(`document.querySelector('[data-accepted]').value='Stockholm';`);
    if(type==='poll') await host.evaluate(`document.querySelectorAll('.question-editor')[3].querySelectorAll('[data-answer]').forEach((el,i)=>el.value=['Red','Blue','Green','Yellow'][i]);`);
  }
  assert.equal(await host.evaluate('document.title'),'Fredagsquizet — Play together');
  assert.equal(await host.evaluate('document.querySelectorAll(".default-image").length'),3);
  const pastePicture = async () => host.evaluate(`(async () => {
    const source=document.querySelector('.editor-image').src;
    const blob=await fetch(source).then(r=>r.blob());
    const transfer=new DataTransfer();transfer.items.add(new File([blob],'pasted.png',{type:'image/png'}));
    document.querySelectorAll('.paste-target')[1].dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  })()`);
  await pastePicture();
  await host.wait('document.querySelectorAll(".editor-image").length===2');
  await host.click('[data-remove-image="1"]');
  assert.equal(await host.evaluate('document.querySelectorAll(".default-image").length'),3,'removing custom image restores artwork');
  await pastePicture();
  await host.wait('document.querySelectorAll(".editor-image").length===2');
  assert.equal(await host.evaluate(`
    const clipboard=new DataTransfer();clipboard.setData('text/plain','Ordinary text');
    document.querySelector('#question-1').dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));
  `),true,'ordinary text paste is not intercepted');
  await host.evaluate(`document.querySelector('#editor-form').requestSubmit()`);
  await host.wait('!!document.querySelector("[data-host]:not([data-host=sample])")');
  await host.click('[data-edit]:not([data-edit=sample])');
  await host.wait('document.querySelectorAll(".question-editor").length===4');
  await host.call('Page.reload');
  await host.wait('document.querySelectorAll(".editor-image").length===2');
  assert.equal(await host.evaluate('document.querySelector("[data-image-alt]").value'),'Example picture');
  assert.deepEqual(await host.evaluate('[...document.querySelectorAll("[data-type]")].map(el=>el.value)'),['quiz','true-false','type-answer','poll']);
  await host.evaluate(`location.hash='host'`);
  await host.wait('!!document.querySelector("[data-host]:not([data-host=sample])")');
  await host.click('[data-host]:not([data-host=sample])');
  await host.wait('!!document.querySelector(".pin-display strong")');
  await host.wait('document.querySelector(".qr-invite img")?.naturalWidth > 0');
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
  await alice.wait('!!document.querySelector(".preview-note")');
  await host.wait('!!document.querySelector(".question-picture img")');
  await alice.wait('document.querySelector(".question-picture img")?.naturalWidth > 0');
  assert.equal(await alice.evaluate('document.querySelectorAll("[data-answer-index], #timer").length'),0);
  await alice.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await alice.evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'question image preview fits a phone');
  await host.call('Page.reload');
  await host.wait('!!document.querySelector("[data-action=open]")');
  await host.click('[data-action=open]');
  await alice.wait('!!document.querySelector("[data-answer-index]")');
  await bob.wait('!!document.querySelector("[data-answer-index]")');
  await alice.click('[data-answer-index="0"]');
  await alice.wait('document.body.innerText.includes("Answer locked in")');
  await bob.click('[data-answer-index="1"]');
  await alice.wait('document.body.innerText.includes("Correct!")');
  await bob.wait('document.body.innerText.includes("Not this time")');
  await host.wait('document.querySelectorAll(".rank-row").length===2');
  await host.click('[data-action=next]');
  // True/false round has exactly the two fixed choices.
  await host.wait('!!document.querySelector("[data-action=open]")');
  await host.click('[data-action=open]');
  await alice.wait('document.querySelectorAll(".true-false .answer").length===2');
  await bob.wait('document.querySelectorAll(".true-false .answer").length===2');
  await alice.click('[data-answer-index="0"]');await bob.click('[data-answer-index="1"]');
  await host.wait('document.querySelectorAll(".rank-row").length===2');
  await host.click('[data-action=next]');
  await host.wait('!!document.querySelector("[data-action=open]")');await host.click('[data-action=open]');
  await alice.wait('!!document.querySelector("#typed-answer")');await bob.wait('!!document.querySelector("#typed-answer")');
  await alice.wait('document.querySelector(".question-picture img")?.naturalWidth > 0');
  assert.ok(await alice.evaluate('document.querySelector(".question-picture img").src.endsWith("/images/type-answer.svg")'));
  await alice.evaluate(`document.querySelector('#typed-answer').value='  STOCKHOLM  ';document.querySelector('#typed-answer').focus();`);
  await bob.evaluate(`document.querySelector('#typed-answer').value='Paris';document.querySelector('#typed-answer-form').requestSubmit();`);
  await alice.wait('document.querySelector(".answer-count").textContent.includes("1 / 2")');
  assert.equal(await alice.evaluate('document.querySelector("#typed-answer").value'),'  STOCKHOLM  ','SSE must preserve typed drafts');
  assert.equal(await alice.evaluate('document.activeElement.id'),'typed-answer');
  await alice.evaluate(`document.querySelector('#typed-answer-form').requestSubmit()`);
  await alice.wait('document.body.innerText.includes("Correct!")');
  await host.wait('document.querySelectorAll(".rank-row").length===2');
  await host.click('[data-action=next]');
  await host.wait('!!document.querySelector("[data-action=open]")');await host.click('[data-action=open]');
  await alice.wait('!!document.querySelector("[data-answer-index]")');await bob.wait('!!document.querySelector("[data-answer-index]")');
  await alice.click('[data-answer-index="0"]');await bob.click('[data-answer-index="1"]');
  await alice.wait('document.body.innerText.includes("Thanks for voting!")');
  assert.equal(await alice.evaluate('document.querySelectorAll(".rank-row").length'),0,'poll results omit leaderboard');
  await host.wait('document.body.innerText.includes("votes)")');
  await host.click('[data-action=next]');
  await alice.wait('document.body.innerText.includes("Alice takes the crown!")');
  await host.call('Page.reload');
  await host.wait('document.body.innerText.includes("Alice takes the crown!")');
  await alice.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await alice.evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'mobile page must not overflow');
  for(const p of [host,alice,bob])assert.deepEqual(p.exceptions,[],'no uncaught browser exceptions');
  console.log('PASS: Fredagsquizet branding; image upload, clipboard paste, removal fallback and saved editor reload; heading/image preview; four question types; two players; typed draft survives SSE; poll results; podium and host refresh; mobile width. No screenshots captured.');
} catch (error) {
  console.error(error); throw error;
} finally {
  for(const socket of sockets)socket.close();
  browser.kill('SIGTERM');await new Promise(resolve=>{if(browser.exitCode!==null)return resolve();browser.once('exit',resolve);setTimeout(resolve,3000).unref();});
  await local.close();await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
