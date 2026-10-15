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
  assert.deepEqual(await host.evaluate(`[
    localStorage.getItem('fredagsquizet-owner'),
    JSON.parse(localStorage.getItem('fredagsquizet-draft-migration-test')).title,
    sessionStorage.getItem('fredagsquizet-answer-view-123456'),
    [...Object.keys(localStorage),...Object.keys(sessionStorage)].some(key=>key.startsWith('quizpop-'))
  ]`),['legacy-browser-owner-token','Unsaved work','answers-only',false]);
  await host.evaluate(`document.querySelector('#quiz-title').value='Map browser test'; document.querySelector('[data-question]').value='Find zero'; document.querySelector('[data-type]').value='map-pin'; document.querySelector('[data-type]').dispatchEvent(new Event('change'));`);
  await host.wait('!!document.querySelector(".leaflet-container")');
  await host.wait(`quizMaps[0]?.map && Object.values(quizMaps[0].map._layers).some(layer=>layer.getMaplibreMap?.()?.loaded())`);
  assert.ok(await host.evaluate(`document.querySelector('.leaflet-control-attribution').textContent.includes('OpenFreeMap')`));
  if (liveMap) {
    await host.wait(`Object.values(quizMaps[0].map._layers).some(layer=>layer.getMaplibreMap?.()?.queryRenderedFeatures().length > 0)`);
    assert.ok(host.mapResponses.some(response=>response.url.includes('/planet') && response.status===200),'real vector source metadata loaded successfully');
    assert.ok(host.mapResponses.every(response=>response.status===200),'all received provider responses succeeded');
    assert.deepEqual(host.forbiddenRequests,[]);
    assert.deepEqual(host.exceptions,[]);
    console.log('PASS: Live OpenFreeMap style and vector tiles loaded and geographic features rendered; no OSM tile requests. No screenshots captured.');
    process.exitCode = 0;
  } else {

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
  for (const p of [host,alice,bob]) {
    assert.deepEqual(p.exceptions,[]);
    assert.ok(p.tileRequests.length > 0, 'browser must request map tiles');
    assert.deepEqual(p.forbiddenRequests,[], 'never request blocked OSM raster tiles');
    assert.ok(p.tileRequests.every(request=>request.url.startsWith('https://tiles.openfreemap.org/')));
  }
  const fallback = await host.evaluate(`(() => {
    const originalMap = maplibregl.Map;
    const container = document.createElement('section');
    container.innerHTML = '<div class="quiz-map"></div><p data-map-status></p>' + locationFields();
    document.body.append(container);
    try {
      maplibregl.Map = class { constructor() { throw new Error('WebGL unavailable in test'); } };
      const widget = mountQuizMap(container.firstElementChild,{key:'no-webgl',onSelect:point=>setLocationFields(container,point)});
      widget.select({lat:59,lng:18});
      const result = {point:readLocation(container),message:container.querySelector('[data-map-status]').textContent};
      clearQuizMaps();
      return result;
    } finally { maplibregl.Map = originalMap; container.remove(); }
  })()`);
  assert.deepEqual(fallback.point,{lat:59,lng:18});
  assert.match(fallback.message,/WebGL/);
  assert.equal((await fetch(origin)).headers.get('referrer-policy'),'no-referrer','other resources keep the existing privacy policy');
  console.log('PASS: Map editor, saving, preview secrecy, two players, pending pin and zoom preservation, distance reveal, mobile layout, OpenFreeMap provider and attribution. Styles mocked; no OSM tile requests or screenshots captured.');
  }
} catch (error) {
  console.error(error); throw error;
} finally {
  for(const socket of sockets)socket.close();
  browser.kill('SIGTERM');await new Promise(resolve=>{if(browser.exitCode!==null)return resolve();browser.once('exit',resolve);setTimeout(resolve,3000).unref();});
  await local.close();await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
