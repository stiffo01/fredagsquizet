// Optional DOM-only end-to-end test. Uses system Chromium; never captures pixels.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
const temp = await mkdtemp(path.join(tmpdir(), 'quizpop-browser-'));
const local = createApp({dataDir:path.join(temp,'data'), hostUsername:'test', hostPassword:'test', startCountdownMs:0, firstPreviewMs:1500});
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
    const target=await fetch(`${debugOrigin.origin}/json/new?${encodeURIComponent('about:blank')}`,{method:'PUT'}).then(r=>r.json());
    const socket=new WebSocket(target.webSocketDebuggerUrl);sockets.push(socket);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let id=0;const pending=new Map();const exceptions=[];
    socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}if(m.method==='Runtime.exceptionThrown')exceptions.push(m.params.exceptionDetails);};
    const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params}));});
    const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error(`Wait failed: ${expression}\nURL: ${await evaluate('location.href')}\n${await evaluate('document.body.innerText')}`);};
    const click=async selector=>{await wait(`!!document.querySelector(${JSON.stringify(selector)})`);await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);};
    await call('Runtime.enable'); await call('Network.enable'); if (hash.startsWith('host')) await call('Network.setExtraHTTPHeaders',{headers:{Authorization:'Basic '+Buffer.from('test:test').toString('base64')}}); await call('Page.navigate',{url:origin+'/'+hash}); await wait('document.readyState === "complete" && !!document.querySelector("#app")');
    return {evaluate,wait,click,call,exceptions};
  }
  const host=await page('host#create');
  await host.wait('!!document.querySelector("#quiz-title")');
  await host.evaluate(`document.querySelector('#quiz-title').value='Map browser test'; document.querySelector('[data-question]').value='Find zero'; document.querySelector('[data-type]').value='map-pin'; document.querySelector('[data-type]').dispatchEvent(new Event('change'));`);
  await host.wait('!!document.querySelector(".leaflet-container")');
  await host.evaluate(`quizMaps[0].map.fire('click',{latlng:L.latLng(0,0)}); document.querySelector('[data-map-distance]').value=1000; document.querySelector('#editor-form').requestSubmit();`);
  await host.wait('!!document.querySelector("[data-host]")');
  await host.evaluate(`Array.from(document.querySelectorAll('.quiz-card')).find(el=>el.textContent.includes('Map browser test')).querySelector('[data-host]').click()`);
  await host.wait('!!document.querySelector(".pin-display strong")');
  const pin=await host.evaluate('document.querySelector(".pin-display strong").textContent');
  async function join(name) {
    const p=await page('#join/'+pin);
    await p.wait('!!document.querySelector("#join-form")');
    await p.evaluate(`document.querySelector('#join-form').requestSubmit(); document.querySelector('#nickname').value=${JSON.stringify(name)}; document.querySelector('#nickname-form').requestSubmit()`);
    await p.wait('document.body.innerText.includes("Your host will start")'); return p;
  }
  const alice=await join('Alice'), bob=await join('Bob');
  await host.click('[data-action=start]'); await host.wait('!!document.querySelector(".preview-note")');
  assert.equal(await alice.evaluate('document.querySelector("#answer-map")'),null);
  await alice.wait('!!document.querySelector("#map-answer-form")'); await bob.wait('!!document.querySelector("#map-answer-form")');
  await alice.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await alice.evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  await alice.evaluate(`quizMaps[0].map.fire('click',{latlng:L.latLng(0,1)}); quizMaps[0].map.setView([0,1],6,{animate:false}); void 0;`);
  await bob.evaluate(`quizMaps[0].map.fire('click',{latlng:L.latLng(0,0)}); document.querySelector('#map-answer-form').requestSubmit()`);
  await alice.wait('document.querySelector(".answer-count").textContent.includes("1 / 2")');
  assert.equal(await alice.evaluate('document.querySelector("[data-lng]").value'),'1');
  assert.equal(await alice.evaluate('quizMaps[0].map.getZoom()'),6);
  await alice.evaluate(`document.querySelector('#map-answer-form').requestSubmit()`);
  await alice.wait('document.body.innerText.includes("+889 points")');
  await bob.wait('document.body.innerText.includes("+1000 points")');
  assert.equal(await alice.evaluate('document.querySelectorAll(".quiz-map-pin").length'),2);
  for (const p of [host,alice,bob]) assert.deepEqual(p.exceptions,[]);
  console.log('PASS: Map editor, saving, preview secrecy, two players, pending pin and zoom preservation, distance reveal, mobile layout. No screenshots captured.');
} catch (error) {
  console.error(error); throw error;
} finally {
  for(const socket of sockets)socket.close();
  browser.kill('SIGTERM');await new Promise(resolve=>{if(browser.exitCode!==null)return resolve();browser.once('exit',resolve);setTimeout(resolve,3000).unref();});
  await local.close();await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
