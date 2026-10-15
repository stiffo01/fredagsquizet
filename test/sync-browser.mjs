// Optional DOM-only end-to-end test. Uses system Chromium; never captures pixels.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
const temp = await mkdtemp(path.join(tmpdir(), 'fredagsquizet-browser-'));
const local = createApp({dataDir:path.join(temp,'data'), hostUsername:'test', hostPassword:'test', startCountdownMs:0, firstPreviewMs:60000});
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
    await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument',{source:`
      sessionStorage.setItem('fredagsquizet-player-${room.pin}',${JSON.stringify(JSON.stringify({pin:room.pin,role:'player',token:playerToken}))});
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.testStream=this; setTimeout(()=>this.onopen?.(),0); }
        close() {}
      };
      const originalFetch=window.fetch;
      window.fetch=async (...args)=>{
        const response=await originalFetch(...args);
        if(window.holdNextState && String(args[0]).endsWith('/state')) {
          window.holdNextState=false;
          window.heldState=await response.clone().json();
          await new Promise(resolve=>window.releaseState=resolve);
        }
        return response;
      };
    `});
    await call('Runtime.enable'); await call('Network.enable'); if (hash.startsWith('host')) await call('Network.setExtraHTTPHeaders',{headers:{Authorization:'Basic '+Buffer.from('test:test').toString('base64')}}); await call('Page.navigate',{url:origin+'/'+hash}); await wait('document.readyState === "complete" && !!document.querySelector("#app")');
    return {evaluate,wait,click,call,exceptions};
  }
  const request = async (action, body) => {
    const response = await fetch(origin+action,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:'Basic '+Buffer.from('test:test').toString('base64'),...(typeof room !== 'undefined' ? {'X-Quiz-Host-Token':room.hostToken} : {})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.ok(response.ok,await response.clone().text()); return response.json();
  };
  let room;
  room = await request('/api/rooms',{quiz:{title:'Sync test',questions:[0,1,2].map(i=>({question:'Question '+i,answers:['Yes','No'],correctIndex:0,timeLimit:120}))}});
  const route='/api/rooms/'+room.pin;
  const {playerToken}=await request(route+'/join',{nickname:'Work computer'});
  const player=await page('#room/player/'+room.pin);
  await player.wait('roomState?.status === "lobby"');
  const lobby=await player.evaluate('structuredClone(roomState)');
  await request(route+'/start',{}); await request(route+'/open',{});
  // A stream that keeps sending old heartbeats must not disable polling.
  await player.evaluate(`window.oldHeartbeat=setInterval(()=>testStream.dispatchEvent(new MessageEvent('ping',{data:'{}'})),50);`);
  await player.wait('roomState?.status === "question" && roomState.questionIndex === 0');
  const question=await player.evaluate('structuredClone(roomState)');
  await player.evaluate('window.holdNextState=true');
  await player.wait('!!window.releaseState');
  await player.click('[data-answer-index="0"]');
  await player.wait('roomState?.status === "reveal"');
  const revealRevision=await player.evaluate('roomState.revision');
  assert.ok(Number.isInteger(revealRevision) && revealRevision > question.revision);
  // The held polling response arrives after the answer response has revealed results.
  await player.evaluate('window.releaseState();');
  await player.evaluate('new Promise(resolve=>setTimeout(resolve,100))');
  assert.equal(await player.evaluate('roomState.revision'),revealRevision);
  assert.equal(await player.evaluate('roomState.status'),'reveal');
  await request(route+'/next',{}); await request(route+'/open',{});
  await request(route+'/next',{}); await request(route+'/next',{}); await request(route+'/open',{});
  await player.wait('roomState?.questionIndex === 2 && roomState.status === "question"');
  await player.evaluate(`window.renderedHeadings=[]; new MutationObserver(()=>renderedHeadings.push(document.querySelector('.room h1')?.textContent)).observe(document.querySelector('#app'),{childList:true,subtree:true});`);
  for (const old of [lobby,question,lobby,question]) {
    await player.evaluate(`testStream.dispatchEvent(new MessageEvent('state',{data:${JSON.stringify(JSON.stringify(old))}}));`);
    await player.evaluate('new Promise(resolve=>setTimeout(resolve,75))');
  }
  assert.equal(await player.evaluate('roomState.questionIndex'),2);
  assert.deepEqual(await player.evaluate('renderedHeadings.filter(heading=>heading!=="Question 2")'),[],'buffered events never replay old questions');
  await request(route+'/end',{});
  await player.evaluate(`window.dispatchEvent(new Event('focus'));`);
  await player.wait('roomState?.status === "finished"');
  await player.evaluate('location.hash=""');
  await player.wait('!!document.querySelector("#join-form")');
  await player.evaluate(`testStream.dispatchEvent(new MessageEvent('state',{data:${JSON.stringify(JSON.stringify(question))}}));`);
  assert.equal(await player.evaluate('!!document.querySelector("#join-form")'),true,'old room events cannot change a new route');
  assert.deepEqual(player.exceptions,[]);
  console.log('PASS: polling with buffered heartbeats, stale response rejection, delayed question replay prevention, focus refresh, route cleanup. No screenshots captured.');
} catch (error) {
  console.error(error); throw error;
} finally {
  for(const socket of sockets)socket.close();
  browser.kill('SIGTERM');await new Promise(resolve=>{if(browser.exitCode!==null)return resolve();browser.once('exit',resolve);setTimeout(resolve,3000).unref();});
  await local.close();await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
