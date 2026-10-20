// Optional DOM-only end-to-end test. Uses system Chromium; never captures pixels.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
const temp = await mkdtemp(path.join(tmpdir(), 'fredagsquizet-browser-'));
const local = createApp({dataDir:path.join(temp,'data'), hostUsername:'test', hostPassword:'test', startCountdownMs:0, firstPreviewMs:1500});
await new Promise(resolve=>local.server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${local.server.address().port}`;
const browser = spawn(process.env.CHROMIUM || 'chromium',['--headless=new','--enable-unsafe-swiftshader','--use-angle=swiftshader','--no-first-run','--no-default-browser-check',`--user-data-dir=${temp}/profile`,'--remote-debugging-port=0','about:blank'],{stdio:['ignore','ignore','pipe']});
const sockets=[];
const liveMap = process.env.LIVE_MAP === '1';
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
    const target=await fetch(`${debugOrigin.origin}/json/new?${encodeURIComponent('about:blank')}`,{method:'PUT'}).then(r=>r.json());
    const socket=new WebSocket(target.webSocketDebuggerUrl);sockets.push(socket);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let id=0;const pending=new Map();const exceptions=[]; const tileRequests=[]; const mapResponses=[]; const networkFailures=[]; const requestUrls=new Map(); const forbiddenRequests=[];
    socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}if(m.method==='Network.requestWillBeSent') requestUrls.set(m.params.requestId,m.params.request.url);
    if(m.method==='Network.loadingFailed') networkFailures.push({url:requestUrls.get(m.params.requestId),error:m.params.errorText});
    if(m.method==='Network.requestWillBeSent' && new URL(m.params.request.url).hostname.endsWith('tile.openstreetmap.org')) forbiddenRequests.push(m.params.request.url);
    if(m.method==='Network.responseReceived' && m.params.response.url.startsWith('https://tiles.openfreemap.org/')) mapResponses.push({url:m.params.response.url,status:m.params.response.status});
    if(m.method==='Fetch.requestPaused') {
      tileRequests.push(m.params.request);
      const style = {version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#dcebf0'}}]};
      void call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Allow-Headers',value:'Authorization, Content-Type'},{name:'Access-Control-Allow-Methods',value:'GET, OPTIONS'}],body:Buffer.from(JSON.stringify(style)).toString('base64')});
    }if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);};
    const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));});
    const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const wait=async expression=>{for(let i=0;i<(liveMap?600:100);i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error(`Wait failed: ${expression}\nNetwork failures: ${JSON.stringify(networkFailures)}\nResponses: ${JSON.stringify(mapResponses)}\nURL: ${await evaluate('location.href')}\n${await evaluate('document.body.innerText')}`);};
    const click=async selector=>{await wait(`!!document.querySelector(${JSON.stringify(selector)})`);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);};
    await call('Page.enable');
    if (hash === 'host#create') await call('Page.addScriptToEvaluateOnNewDocument',{source:`
      localStorage.setItem('quizpop-owner','legacy-browser-owner-token');
      localStorage.setItem('quizpop-draft-migration-test',JSON.stringify({title:'Unsaved work'}));
      sessionStorage.setItem('quizpop-answer-view-123456','answers-only');
    `});
    if (!liveMap) await call('Fetch.enable',{patterns:[{urlPattern:'https://tiles.openfreemap.org/*',requestStage:'Request'}]}); await call('Runtime.enable'); await call('Network.enable'); if (hash.startsWith('host')) await call('Network.setExtraHTTPHeaders',{headers:{Authorization:'Basic '+Buffer.from('test:test').toString('base64')}}); await call('Page.navigate',{url:origin+'/'+hash}); await wait('document.readyState === "complete" && !!document.querySelector("#app")');
    if (hash.startsWith('host')) {
      await call('Network.setExtraHTTPHeaders',{headers:{}});
      await evaluate(`{
        const originalFetch=window.fetch;
        window.fetch=(url,options={})=>{
          if(new URL(url instanceof Request ? url.url : url,location.href).origin===location.origin) {
            const headers=new Headers(options.headers); headers.set('Authorization','Basic dGVzdDp0ZXN0');
            return originalFetch(url,{...options,headers});
          }
          return originalFetch(url,options);
        };
      }`);
    }
    return {evaluate,wait,click,call,exceptions,tileRequests,mapResponses,forbiddenRequests};
  }
  const host=await page('host#create');
  await host.wait('!!document.querySelector("#quiz-title")');
  await host.evaluate(`{document.querySelector('#quiz-title').value='Match browser test'; document.querySelector('[data-question]').value='Match the colour'; const type=document.querySelector('[data-type]'); type.value='match-3'; type.dispatchEvent(new Event('change'));}`);
  await host.wait('document.querySelectorAll(".match-inputs .picture-choice-edit").length === 3');
  assert.equal(await host.evaluate('document.querySelector(".question-editor .default-image").getAttribute("src")'),'/images/match-3.svg');
  for (const [j, colour] of [[0,'red'],[1,'green'],[2,'blue']]) {
    await host.evaluate(`document.querySelector('#match-text-0-${j}').value='${colour} text'; document.querySelector('#match-text-0-${j}').dispatchEvent(new Event('input',{bubbles:true}));`);
    await host.evaluate(`(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '${colour}'; ctx.fillRect(0,0,80,60);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([blob], '${colour}.png', {type:'image/png'}));
      const input = document.querySelector('[data-image="choice-0-${j}"]'); input.files = dt.files; input.dispatchEvent(new Event('change'));
    })()`);
    await host.wait(`document.querySelectorAll('.match-inputs .picture-choice-edit')[${j}].querySelector('img.editor-image')?.naturalWidth > 0`);
  }
  assert.deepEqual(await host.evaluate('[0,1,2].map(j => document.querySelector(`#match-text-0-${j}`).value)'),['red text','green text','blue text'],'texts survive picture uploads');
  await host.evaluate(`document.querySelector('#editor-form').requestSubmit();`);
  await host.wait('!!document.querySelector("[data-host]")');
  await host.evaluate(`Array.from(document.querySelectorAll('.quiz-card')).find(el=>el.textContent.includes('Match browser test')).querySelector('[data-edit]').click()`);
  await host.wait('document.querySelector("#quiz-title")?.value === "Match browser test" && document.querySelectorAll(".match-inputs img.editor-image").length === 3');
  const authored = await host.evaluate('draft.questions[0].answerImages');
  assert.equal(await host.evaluate('document.querySelector("#match-text-0-2").value'),'blue text');
  await host.evaluate(`location.hash='host'`);
  await host.wait('!!document.querySelector("[data-host]")');
  await host.evaluate(`Array.from(document.querySelectorAll('.quiz-card')).find(el=>el.textContent.includes('Match browser test')).querySelector('[data-host]').click()`);
  await host.wait('!!document.querySelector(".pin-display strong")');
  const pin=await host.evaluate('document.querySelector(".pin-display strong").textContent');
  async function join(name) {
    const p=await page('#join/'+pin);
    await p.wait('!!document.querySelector("#join-form")');
    await p.evaluate(`document.querySelector('#join-form').requestSubmit(); document.querySelector('#nickname').value=${JSON.stringify(name)}; document.querySelector('#nickname-form').requestSubmit()`);
    await p.wait('document.body.innerText.includes("Your host will start")'); return p;
  }
  const alice=await join('Alice'), bob=await join('Bob');
  await alice.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await host.click('[data-action=start]');
  await alice.wait('!!document.querySelector(".preview-note")');
  assert.equal(await alice.evaluate('document.querySelectorAll(".match-pictures img").length'),0,'pictures stay hidden in preview');
  await alice.wait('[...document.querySelectorAll(".match-pictures img")].filter(img => img.naturalWidth > 0).length === 3');
  assert.deepEqual(await alice.evaluate('[...document.querySelectorAll(".match-pictures figcaption")].map(f => f.textContent)'),['A','B','C']);
  assert.deepEqual(await alice.evaluate('[...document.querySelectorAll(".match-text")].map(t => t.textContent)'),['red text','green text','blue text']);
  assert.equal(await alice.evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'no horizontal scroll on a phone');
  const shown = await alice.evaluate('roomState.question.answerImages');
  const right = authored.map(image => shown.indexOf(image));
  assert.equal(await alice.evaluate('document.querySelector("[data-match-lock]").disabled'),true,'lock-in waits for all three');
  // Give text 1 and text 2 each other's letters first, then choose the same letter twice to check that picks swap.
  await alice.click(`[data-match="0-${right[1]}"]`); await alice.click(`[data-match="1-${right[0]}"]`); await alice.click(`[data-match="2-${right[2]}"]`);
  await alice.click(`[data-match="0-${right[0]}"]`);
  assert.deepEqual(await alice.evaluate('[0,1,2].map(i => [...document.querySelectorAll(`[data-match^="${i}-"]`)].findIndex(b => b.classList.contains("selected")))'),right,'taking a used letter swaps the two texts');
  await alice.click('[data-match-lock]:not([disabled])');
  await alice.wait('document.body.innerText.includes("Matches locked in")');
  await bob.wait('document.querySelectorAll("[data-match]").length === 9');
  await bob.click(`[data-match="0-${right[0]}"]`); await bob.click(`[data-match="1-${right[2]}"]`); await bob.click(`[data-match="2-${right[1]}"]`);
  await bob.click('[data-match-lock]:not([disabled])');
  await alice.wait('document.body.innerText.includes("Correct! +")');
  await bob.wait('document.body.innerText.includes("1 of 3 pairs right")');
  assert.equal(await bob.evaluate('document.querySelectorAll(".match-row.match-right").length'),1);
  await host.wait('document.querySelectorAll(".match-letter.correct").length === 3');
  assert.deepEqual([...host.exceptions, ...alice.exceptions, ...bob.exceptions],[]);
  console.log('PASS: 3 for 3 editor upload/save/reload, shuffled pictures, preview hiding, swapping picks, phone layout, partial scoring and reveal.');
} catch (error) {
  console.error(error); throw error;
} finally {
  for(const socket of sockets)socket.close();
  browser.kill('SIGTERM');await new Promise(resolve=>{if(browser.exitCode!==null)return resolve();browser.once('exit',resolve);setTimeout(resolve,3000).unref();});
  await local.close();await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
