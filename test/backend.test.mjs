import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { distanceKm } from '../lib/quiz.mjs';

const quiz = { title: 'Integration quiz', questions: [{ question: 'Two plus two?', answers: ['Four', 'Five'], correctIndex: 0, timeLimit: 10 }, { question: 'Blue or green?', answers: ['Blue', 'Green'], correctIndex: 1, timeLimit: 1 }] };
async function fixture(t, timing = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiz-test-'));
  let app;
  const boot = async () => { app = createApp({ dataDir, hostUsername: 'test-host', hostPassword: 'test-password', startCountdownMs: 0, firstPreviewMs: 60_000, ...timing }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${app.server.address().port}`; };
  let base = await boot();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (url, { method = 'GET', token, body } = {}) => { const res = await fetch(base + url, { method, headers: { Authorization: `Basic ${Buffer.from('test-host:test-password').toString('base64')}`, ...(token ? { 'X-Quiz-Host-Token': token, 'X-Quiz-Owner': token } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  return { request, get base() { return base; }, restart: async () => { await app.close(); base = await boot(); } };
}

test('a live room provides a scannable player-join QR image', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiz-qr-test-'));
  const app = createApp({ dataDir, hostUsername: 'test-host', hostPassword: 'test-password' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const roomResponse = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from('test-host:test-password').toString('base64')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ quiz }) });
  const room = await roomResponse.json();
  assert.equal(roomResponse.status, 201);
  const response = await fetch(`${base}/api/rooms/${room.pin}/qr`, { headers: { 'x-forwarded-host': 'quiz.example.test', 'x-forwarded-proto': 'https' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^image\/png/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const png = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 240);
  assert.equal(png.readUInt32BE(20), 240);
});

test('host game manager lists active quizzes, exposes final scoreboards, and can stop or clear rooms', async t => {
  const f = await fixture(t);
  const room = (await f.request('/api/rooms',{method:'POST',body:{quiz}})).data;
  const unauthenticated = await fetch(`${f.base}/api/rooms`);
  assert.equal(unauthenticated.status,401,'game management requires host basic auth');
  let games = (await f.request('/api/rooms')).data;
  assert.equal(games.length,1);assert.equal(games[0].quizTitle,quiz.title);assert.ok(games[0].quizId);assert.equal(games[0].status,'lobby');
  assert.equal(games[0].scoreboardAvailable,false);
  assert.equal((await f.request(`/api/rooms/${room.pin}/start`,{method:'POST'})).status,401,'regular host sign-in alone does not control live gameplay');
  await f.request(`/api/rooms/${room.pin}/end`,{method:'POST'});
  games = (await f.request('/api/rooms')).data;
  assert.equal(games[0].status,'finished');assert.equal(games[0].scoreboardAvailable,true);
  assert.equal((await fetch(`${f.base}/api/rooms/${room.pin}/clear-scoreboard`,{method:'POST'})).status,401,'only signed-in hosts can clear a scoreboard');
  await f.request(`/api/rooms/${room.pin}/clear-scoreboard`,{method:'POST'});
  games = (await f.request('/api/rooms')).data;
  assert.equal(games[0].scoreboardAvailable,false);assert.equal(games[0].scoreboardDeleted,true);
});

test('starting a quiz counts down, previews the first question, then opens answers automatically', async t => {
  const f = await fixture(t, { startCountdownMs: 100, firstPreviewMs: 120 });
  const viewQuiz = { ...quiz, questions: quiz.questions.map(question => ({ ...question, answers: ['Four', 'Five', 'Six', 'Seven'] })) };
  const room = (await f.request('/api/rooms', { method: 'POST', body: { quiz: viewQuiz } })).data;
  const route = `/api/rooms/${room.pin}`;
  const player = (await f.request(`${route}/join`, { method: 'POST', body: { nickname: 'Ready' } })).data.playerToken;
  const starting = (await f.request(`${route}/start`, { method: 'POST', token: room.hostToken })).data;
  assert.equal(starting.status, 'countdown');
  assert.equal(starting.question, undefined);
  const state = async token => (await f.request(`${route}/state`, { token })).data;
  const waitFor = async (token, status) => {
    const until = Date.now() + 1000;
    while (Date.now() < until) {
      const value = await state(token);
      if (value.status === status) return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Room did not reach ${status}.`);
  };
  const preview = await waitFor(player, 'preview');
  assert.equal(preview.question.question, quiz.questions[0].question);
  assert.equal(preview.question.answers, undefined);
  assert.ok(preview.previewEndsAt > Date.now());
  const question = await waitFor(player, 'question');
  assert.deepEqual(question.question.answers, viewQuiz.questions[0].answers);
  assert.equal(question.answerOnly, undefined, 'answer layout is a per-player preference');
  assert.equal((await f.request(`${route}/toggle-view`, { method: 'POST', token: room.hostToken })).status, 404, 'there is no host-wide layout switch');
  assert.equal((await state(player)).answerOnly, undefined, 'player layout changes are not shared with the room');
  await f.request(`${route}/next`, { method: 'POST', token: room.hostToken });
  await f.request(`${route}/next`, { method: 'POST', token: room.hostToken });
  const secondPreview = await waitFor(player, 'preview');
  assert.equal(secondPreview.question.question, viewQuiz.questions[1].question);
  assert.equal(secondPreview.question.answers, undefined);
  assert.ok(secondPreview.previewEndsAt > Date.now(), 'the next question also gets a timed preview');
  const secondQuestion = await waitFor(player, 'question');
  assert.deepEqual(secondQuestion.question.answers, viewQuiz.questions[1].answers);
});

test('multiplayer flow enforces authorization, secrecy, one answer, scoring and final ranking', async t => {
  const { request } = await fixture(t);
  const room = (await request('/api/rooms', { method: 'POST', body: { quiz } })).data;
  const route = `/api/rooms/${room.pin}`;
  const join = async nickname => (await request(`${route}/join`, { method: 'POST', body: { nickname } })).data.playerToken;
  const alice = await join('Alice'); const bob = await join('Bob');
  assert.equal((await request(`${route}/join`, { method: 'POST', body: { nickname: 'alice' } })).status, 409);
  assert.equal((await request(`${route}/state`)).status, 401);
  assert.equal((await request(`${route}/start`, { method: 'POST', token: alice })).status, 403);
  let state = (await request(`${route}/start`, { method: 'POST', token: room.hostToken })).data;
  assert.equal(state.status, 'preview'); assert.equal(state.question.answers, undefined);
  assert.equal(state.question.correctIndex, undefined); assert.equal(state.question.deadline, undefined);
  assert.equal((await request(`${route}/answer`, { method: 'POST', token: alice, body: { answerIndex: 0, questionIndex: 0 } })).status, 409);
  assert.equal((await request(`${route}/open`, { method: 'POST', token: alice })).status, 403);
  state = (await request(`${route}/open`, { method: 'POST', token: room.hostToken })).data;
  assert.equal(state.status, 'question'); assert.equal(state.question.correctIndex, undefined);
  assert.equal((await request(`${route}/answer`, { method: 'POST', token: alice, body: { answerIndex: 0, questionIndex: 0 } })).status, 200);
  state = (await request(`${route}/state`, { token: bob })).data;
  assert.equal(state.answeredCount, 1); assert.equal(state.players.find(p => p.nickname === 'Alice').score, 0, 'score must not leak correct answers');
  assert.equal((await request(`${route}/answer`, { method: 'POST', token: alice, body: { answerIndex: 1, questionIndex: 0 } })).status, 409);
  await request(`${route}/answer`, { method: 'POST', token: bob, body: { answerIndex: 1, questionIndex: 0 } });
  state = (await request(`${route}/state`, { token: alice })).data;
  assert.equal(state.status, 'reveal'); assert.equal(state.question.correctIndex, 0); assert.equal(state.self.correct, true); assert.ok(state.self.points >= 500); assert.equal(state.leaderboard[0].nickname, 'Alice');
  assert.equal(state.leaderboard.find(player => player.nickname === 'Alice').correctAnswers, 1);
  assert.equal(state.leaderboard.find(player => player.nickname === 'Bob').correctAnswers, 0);
  state = (await request(`${route}/next`, { method: 'POST', token: room.hostToken })).data;
  assert.equal(state.status, 'preview'); assert.equal(state.answeredCount, 0);
  state = (await request(`${route}/open`, { method: 'POST', token: room.hostToken })).data;
  assert.equal(state.status, 'question');
  assert.equal((await request(`${route}/answer`, { method: 'POST', token: alice, body: { answerIndex: 1, questionIndex: 0 } })).status, 409, 'a delayed answer cannot apply to the next question');
  assert.equal((await request(`${route}/answer`, { method: 'POST', token: alice, body: { answerIndex: 1 } })).status, 409, 'answers must identify their question');
  assert.equal((await request(`${route}/state`, { token: alice })).data.self.answered, false);
  await new Promise(resolve => setTimeout(resolve, 1100));
  state = (await request(`${route}/state`, { token: alice })).data;
  assert.equal(state.status, 'reveal'); assert.equal(state.self.points, 0);
  assert.equal((await request(`${route}/answer`, { method: 'POST', token: alice, body: { answerIndex: 1, questionIndex: 1 } })).status, 409);
  state = (await request(`${route}/next`, { method: 'POST', token: room.hostToken })).data;
  assert.equal(state.status, 'finished'); assert.equal(state.leaderboard[0].nickname, 'Alice');
  assert.equal(state.scoreboardVisible, false);
  state = (await request(`${route}/show-scoreboard`, { method: 'POST', token: room.hostToken })).data;
  assert.equal(state.scoreboardVisible, true);
  assert.ok(state.scoreboardShownAt > 0);
  assert.equal((await request(`${route}/state`, { token: alice })).data.scoreboardVisible, true, 'the final scoreboard is shared with players');
  state = (await request(`${route}/clear-scoreboard`, { method: 'POST', token: room.hostToken })).data;
  assert.equal(state.scoreboardDeleted, true);
  assert.deepEqual(state.leaderboard, []);
  assert.ok(state.players.every(player => player.score === 0));
});

test('a join whose body finishes after the host starts is rejected', async t => {
  const f = await fixture(t);
  const room = (await f.request('/api/rooms', { method: 'POST', body: { quiz } })).data;
  const route = `/api/rooms/${room.pin}`;
  await f.request(`${route}/join`, { method: 'POST', body: { nickname: 'First' } });
  let pending;
  const completed = new Promise((resolve, reject) => {
    pending = http.request(`${f.base}${route}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    pending.on('error', reject);
    pending.write('{"nickname":');
  });
  t.after(() => pending.destroy());
  // The incomplete body keeps the handler awaiting input while the host starts.
  await new Promise(resolve => setTimeout(resolve, 30));
  await f.request(`${route}/start`, { method: 'POST', token: room.hostToken });
  pending.end('"Late player"}');
  assert.equal(await completed, 409);
  assert.equal((await f.request(`${route}/state`, { token: room.hostToken })).data.players.length, 1);
});

test('finished games are kept in the leaderboard history across restarts until removed', async t => {
  const f = await fixture(t);
  const room = (await f.request('/api/rooms',{method:'POST',body:{quiz}})).data;
  const route = `/api/rooms/${room.pin}`;
  await f.request(`${route}/join`,{method:'POST',body:{nickname:'Alice'}});
  const host = action => f.request(`${route}/${action}`,{method:'POST',token:room.hostToken});
  await host('start'); await host('open');
  assert.deepEqual((await f.request('/api/history')).data,[]);
  await host('end');
  assert.equal((await fetch(`${f.base}/api/history`)).status,401,'history requires host sign-in');
  const empty = (await f.request('/api/rooms',{method:'POST',body:{quiz}})).data;
  await f.request(`/api/rooms/${empty.pin}/end`,{method:'POST'});
  await f.restart();
  let history = (await f.request('/api/history')).data;
  assert.equal(history.length,1,'games ended before anyone played are not kept');
  assert.equal(history[0].quizTitle,quiz.title);assert.equal(history[0].pin,room.pin);assert.equal(history[0].playerCount,1);
  assert.equal(history[0].leaderboard[0].nickname,'Alice');assert.equal(history[0].leaderboard[0].id,undefined);
  assert.equal((await f.request(`/api/history/${history[0].id}`,{method:'DELETE'})).status,200);
  assert.deepEqual((await f.request('/api/history')).data,[]);
});

test('test runs are hidden from the game list and never saved to the leaderboard history', async t => {
  const f = await fixture(t, {startCountdownMs:10_000});
  const room = (await f.request('/api/rooms',{method:'POST',body:{quiz,test:true}})).data;
  const route = `/api/rooms/${room.pin}`;
  const player = (await f.request(`${route}/join`,{method:'POST',body:{nickname:'Test player'}})).data.playerToken;
  assert.deepEqual((await f.request('/api/rooms')).data,[]);
  const host = action => f.request(`${route}/${action}`,{method:'POST',token:room.hostToken});
  await host('start');
  assert.equal((await f.request(`${route}/state`,{token:player})).data.status,'preview','test runs skip the start countdown');
  await host('open');
  await f.request(`${route}/answer`,{method:'POST',token:player,body:{questionIndex:0,answerIndex:0}});
  const state = (await f.request(`${route}/state`,{token:player})).data;
  assert.equal(state.status,'reveal');assert.equal(state.players[0].id,state.self.id);assert.ok(state.players[0].score>=500);assert.equal(state.players[0].rank,1);
  await host('next'); await host('open'); await host('next'); await host('next');
  assert.equal((await f.request(`${route}/state`,{token:player})).data.status,'finished');
  assert.deepEqual((await f.request('/api/history')).data,[]);
});

test('saved quizzes survive restart and remain scoped to the browser owner', async t => {
  const f = await fixture(t); const token = 'owner-one-long-enough'; const other = 'owner-two-long-enough';
  assert.equal((await f.request('/api/quizzes')).data[0].id, 'sample');
  assert.equal((await f.request('/api/quizzes', { method: 'POST', body: quiz })).status, 401);
  assert.equal((await f.request('/api/quizzes', { method: 'POST', token, body: { title: 'Bad', questions: [] } })).status, 400);
  const saved = (await f.request('/api/quizzes', { method: 'POST', token, body: quiz })).data;
  await f.restart();
  assert.equal((await f.request('/api/quizzes', { token })).data.length, 3);
  assert.equal((await f.request('/api/quizzes', { token: other })).data.length, 3);
  assert.equal((await f.request(`/api/quizzes/${saved.id}`, { token: other })).status, 200, 'the shared quiz is visible to every host');
  assert.equal((await f.request('/api/rooms', { method: 'POST', token: other, body: { quizId: saved.id } })).status, 201, 'every host can run a shared quiz');
  assert.equal((await f.request('/api/rooms', { method: 'POST', token, body: { quizId: saved.id } })).status, 201);
  const edited = await f.request(`/api/quizzes/${saved.id}`, { method: 'PUT', token, body: { ...quiz, title: 'Renamed' } });
  assert.equal(edited.data.title, 'Renamed');
  assert.equal((await f.request(`/api/quizzes/${saved.id}`, { method: 'DELETE', token })).status, 200);
  await f.restart(); assert.equal((await f.request('/api/quizzes', { token })).data.length, 2);
});

test('SSE sends authorized state and reconnects using the same player token', async t => {
  const f = await fixture(t);
  const room = (await f.request('/api/rooms', { method: 'POST', body: {} })).data;
  const route = `/api/rooms/${room.pin}`;
  const token = (await f.request(`${route}/join`, { method: 'POST', body: { nickname: 'Returning player' } })).data.playerToken;
  for (let i = 0; i < 2; i++) {
    const controller = new AbortController();
    const response = await fetch(`${f.base}${route}/events?token=${token}`, { signal: controller.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const { value } = await response.body.getReader().read();
    const text = new TextDecoder().decode(value); assert.match(text, /event: state/); assert.match(text, /Returning player/); assert.doesNotMatch(text, /correctIndex/); controller.abort();
  }
  const controller = new AbortController();
  const response = await fetch(`${f.base}${route}/events?token=${token}`, { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  const heartbeat = new TextDecoder().decode((await reader.read()).value);
  assert.match(heartbeat, /event: ping/, 'the client can detect a stalled event stream');
  controller.abort();
  assert.equal((await f.request(`${route}/state`, { token })).data.players.length, 1);
});

test('mixed question types validate, preserve preview secrecy, and score typed answers and polls', async t => {
  const f = await fixture(t);
  const mixed = {title:'Mixed quiz',questions:[
    {type:'true-false',question:'The sky is blue.',correctIndex:0,revealImage:'/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',revealImageAlt:'Earth from space',revealImageTitle:'  Seen from orbit  ',showRevealImage:true,timeLimit:1},
    {type:'type-answer',question:'Name the city.',acceptedAnswers:['New York','NYC'],timeLimit:30},
    {type:'poll',question:'Pick a color.',answers:['Red','Blue'],timeLimit:30}
  ]};
  const room = (await f.request('/api/rooms',{method:'POST',body:{quiz:mixed}})).data;
  const route = `/api/rooms/${room.pin}`;
  const alice = (await f.request(`${route}/join`,{method:'POST',body:{nickname:'Alice'}})).data.playerToken;
  const bob = (await f.request(`${route}/join`,{method:'POST',body:{nickname:'Bob'}})).data.playerToken;
  const host = action => f.request(`${route}/${action}`,{method:'POST',token:room.hostToken});
  const answer = (token,body) => f.request(`${route}/answer`,{method:'POST',token,body});
  await host('start');
  await new Promise(resolve=>setTimeout(resolve,1100));
  let state = (await f.request(`${route}/state`,{token:alice})).data;
  assert.equal(state.status,'preview','preview does not consume the answer timer');
  assert.deepEqual(Object.keys(state.question).sort(),['type','question','image','imageAlt','timeLimit'].sort());
  assert.equal(state.question.revealImage,undefined,'the explanation image stays hidden during preview');
  assert.equal((await host('next')).status,409);
  state = (await host('open')).data;
  assert.deepEqual(state.question.answers,['True','False']);
  const reopened = await host('open');
  assert.equal(reopened.status,200,'opening an already open question is safe');
  assert.equal(reopened.data.status,'question');
  assert.equal(reopened.data.question.deadline,state.question.deadline,'opening twice must not restart the timer');
  assert.equal((await host('toggle-view')).status,404,'layout preference is a local player control');
  await answer(alice,{questionIndex:0,answerIndex:0});await answer(bob,{questionIndex:0,answerIndex:1});
  state = (await f.request(`${route}/state`,{token:alice})).data;
  assert.equal(state.status,'reveal');assert.equal(state.question.revealImage,'/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png');
  assert.equal(state.question.revealImageAlt,'Earth from space');
  assert.equal(state.question.revealImageTitle,'Seen from orbit');
  state = (await host('next')).data;
  assert.equal(state.status,'preview'); assert.equal(state.question.acceptedAnswers,undefined);
  await host('open');
  state = (await f.request(`${route}/state`,{token:alice})).data;
  assert.equal(state.question.acceptedAnswers,undefined);
  assert.equal((await answer(alice,{questionIndex:0,answerText:'NYC'})).status,409);
  assert.equal((await answer(alice,{questionIndex:1,answerText:'   '})).status,400);
  await answer(alice,{questionIndex:1,answerText:'  NEW    york  '});
  assert.equal((await answer(alice,{questionIndex:1,answerText:'NYC'})).status,409);
  state = (await f.request(`${route}/state`,{token:bob})).data;
  assert.equal(state.question.acceptedAnswers,undefined);assert.equal(state.self.answerText,undefined);
  await answer(bob,{questionIndex:1,answerText:'Paris'});
  state = (await f.request(`${route}/state`,{token:alice})).data;
  assert.equal(state.self.correct,true); assert.ok(state.self.points>=500);
  assert.deepEqual(state.question.acceptedAnswers,['New York','NYC']);
  const before = state.players.map(p=>p.score);
  await host('next');await host('open');
  await answer(alice,{questionIndex:2,answerIndex:0});await answer(bob,{questionIndex:2,answerIndex:1});
  state = (await f.request(`${route}/state`,{token:alice})).data;
  assert.deepEqual(state.answerCounts,[1,1]);assert.equal(state.self.points,0);
  assert.equal(state.question.correctIndex,undefined);assert.deepEqual(state.players.map(p=>p.score),before);
  assert.equal((await host('next')).data.status,'finished');
  const pollRoom = (await f.request('/api/rooms',{method:'POST',body:{quiz:{title:'Poll only',questions:[mixed.questions[2]]}}})).data;
  const pollToken = (await f.request(`/api/rooms/${pollRoom.pin}/join`,{method:'POST',body:{nickname:'Voter'}})).data.playerToken;
  const pollState = (await f.request(`/api/rooms/${pollRoom.pin}/state`,{token:pollToken})).data;
  assert.equal(pollState.hasScoredQuestions,false,'poll-only games do not declare a points winner');
  for (const bad of [{type:'unknown'}, {type:'type-answer',acceptedAnswers:[]}, {type:'true-false',correctIndex:2}, {type:'quiz',image:'javascript:alert(1)'}]) {
    const q = {...quiz.questions[0],...bad};
    assert.equal((await f.request('/api/rooms',{method:'POST',body:{quiz:{title:'Invalid',questions:[q]}}})).status,400);
  }
});

test('pixelated picture questions require a picture and score typed guesses', async t => {
  const f = await fixture(t);
  const image = '/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg';
  const pixel = {type:'pixel-reveal',question:'What is in the picture?',image,acceptedAnswers:['Eiffel Tower','Eiffeltornet'],timeLimit:30};
  assert.equal((await f.request('/api/rooms',{method:'POST',body:{quiz:{title:'No picture',questions:[{...pixel,image:''}]}}})).status,400);
  assert.equal((await f.request('/api/rooms',{method:'POST',body:{quiz:{title:'No answers',questions:[{...pixel,acceptedAnswers:[]}]}}})).status,400);
  assert.equal((await f.request('/api/rooms',{method:'POST',body:{quiz:{title:'Bad reveal',questions:[{...pixel,pixelRevealAt:-1}]}}})).status,400);
  assert.equal((await f.request('/api/rooms',{method:'POST',body:{quiz:{title:'Bad speed',questions:[{...pixel,pixelSpeed:'warp'}]}}})).status,400);
  const defaults = (await f.request('/api/rooms',{method:'POST',body:{quiz:{title:'Defaults',questions:[pixel]}}})).data;
  await f.request(`/api/rooms/${defaults.pin}/join`,{method:'POST',body:{nickname:'Dana'}});
  await f.request(`/api/rooms/${defaults.pin}/start`,{method:'POST',token:defaults.hostToken});
  const defaultState = (await f.request(`/api/rooms/${defaults.pin}/state`,{token:defaults.hostToken})).data;
  assert.equal(defaultState.question.pixelRevealAt,2);assert.equal(defaultState.question.pixelSpeed,'normal');
  const room = (await f.request('/api/rooms',{method:'POST',body:{quiz:{title:'Pixel quiz',questions:[{...pixel,pixelRevealAt:5,pixelSpeed:'fast'}]}}})).data;
  const route = `/api/rooms/${room.pin}`;
  const alice = (await f.request(`${route}/join`,{method:'POST',body:{nickname:'Alice'}})).data.playerToken;
  const bob = (await f.request(`${route}/join`,{method:'POST',body:{nickname:'Bob'}})).data.playerToken;
  const host = action => f.request(`${route}/${action}`,{method:'POST',token:room.hostToken});
  await host('start');
  let state = (await f.request(`${route}/state`,{token:alice})).data;
  assert.equal(state.question.type,'pixel-reveal');assert.equal(state.question.image,image);assert.equal(state.question.acceptedAnswers,undefined);
  assert.equal(state.question.pixelRevealAt,5);assert.equal(state.question.pixelSpeed,'fast');
  await host('open');
  assert.equal((await f.request(`${route}/answer`,{method:'POST',token:alice,body:{questionIndex:0,answerText:'  eiffeltornet '}})).status,200);
  assert.equal((await f.request(`${route}/answer`,{method:'POST',token:bob,body:{questionIndex:0,answerText:'Big Ben'}})).status,200);
  state = (await f.request(`${route}/state`,{token:alice})).data;
  assert.equal(state.status,'reveal');assert.equal(state.self.correct,true);assert.ok(state.self.points>=500);
  assert.deepEqual(state.question.acceptedAnswers,['Eiffel Tower','Eiffeltornet']);
  state = (await f.request(`${route}/state`,{token:bob})).data;
  assert.equal(state.self.correct,false);assert.equal(state.self.points,0);
});

test('uploaded images are bounded, saved with quizzes, served safely, and survive restart', async t => {
  const f = await fixture(t), token='image-owner-long-enough';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
  const upload = (body,auth=token) => fetch(`${f.base}/api/images`,{method:'POST',headers:{Authorization:`Basic ${Buffer.from('test-host:test-password').toString('base64')}`,...(auth?{'X-Quiz-Owner':auth}:{})},body});
  assert.equal((await upload(png,null)).status,401);
  assert.equal((await upload('<svg onload="alert(1)"></svg>')).status,400);
  assert.equal((await upload(Buffer.alloc(50*1024*1024+1))).status,413);
  const uploaded = await upload(png);assert.equal(uploaded.status,201);const {image} = await uploaded.json();
  const saved = (await f.request('/api/quizzes',{method:'POST',token,body:{title:'Image quiz',questions:[{...quiz.questions[0],image,imageAlt:'A test pixel'}]}})).data;
  await f.restart();
  const read = await f.request(`/api/quizzes/${saved.id}`,{token});assert.equal(read.data.questions[0].image,image);
  const picture = await fetch(f.base+image);assert.equal(picture.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await picture.arrayBuffer()),png);
  const room = (await f.request('/api/rooms',{method:'POST',token,body:{quizId:saved.id}})).data;
  await f.request(`/api/rooms/${room.pin}/join`,{method:'POST',body:{nickname:'Viewer'}});
  const preview = (await f.request(`/api/rooms/${room.pin}/start`,{method:'POST',token:room.hostToken})).data;
  assert.equal(preview.status,'preview');assert.equal(preview.question.image,image);assert.equal(preview.question.imageAlt,'A test pixel');assert.equal(preview.question.answers,undefined);
});

test('picture choice questions need two pictures and score the chosen picture', async t => {
  const f = await fixture(t);
  const images = ['/media/' + 'a'.repeat(64) + '.png', '/media/' + 'b'.repeat(64) + '.jpg'];
  const question = {type:'picture-choice', question:'Which is the Eiffel Tower?', answerImages:images, answers:['Paris',''], correctIndex:1, timeLimit:20};
  for (const invalid of [{...question,answerImages:[images[0]]}, {...question,answerImages:[images[0],'https://example.com/x.png']}, {...question,correctIndex:2}, {...question,answers:['x'.repeat(201),'']}]) {
    assert.equal((await f.request('/api/quizzes',{method:'POST',token:'picture-owner-token',body:{title:'Invalid pictures',questions:[invalid]}})).status,400);
  }
  const saved = (await f.request('/api/quizzes',{method:'POST',token:'picture-owner-token',body:{title:'Pictures',questions:[question]}})).data;
  assert.deepEqual(saved.questions[0].answerImages,images); assert.deepEqual(saved.questions[0].answers,['Paris','']);
  const room = (await f.request('/api/rooms',{method:'POST',token:'picture-owner-token',body:{quiz:{title:'Pictures',questions:[question]}}})).data;
  const route = `/api/rooms/${room.pin}`;
  const players = [];
  for (const nickname of ['Right','Wrong']) players.push((await f.request(`${route}/join`,{method:'POST',body:{nickname}})).data.playerToken);
  const action = name => f.request(`${route}/${name}`,{method:'POST',token:room.hostToken});
  const state = token => f.request(`${route}/state`,{token}).then(r=>r.data);
  await action('start');
  assert.equal((await state(players[0])).question.answerImages,undefined);
  await action('open');
  const open = await state(players[0]);
  assert.deepEqual(open.question.answerImages,images); assert.equal(open.question.correctIndex,undefined);
  assert.equal((await f.request(`${route}/answer`,{method:'POST',token:players[0],body:{questionIndex:0,answerIndex:2}})).status,400);
  assert.equal((await f.request(`${route}/answer`,{method:'POST',token:players[0],body:{questionIndex:0,answerIndex:1}})).status,200);
  assert.equal((await f.request(`${route}/answer`,{method:'POST',token:players[1],body:{questionIndex:0,answerIndex:0}})).status,200);
  const right = await state(players[0]), wrong = await state(players[1]);
  assert.equal(right.status,'reveal'); assert.equal(right.question.correctIndex,1); assert.deepEqual(right.answerCounts,[1,1]);
  assert.equal(right.self.correct,true); assert.ok(right.self.points > 500);
  assert.equal(wrong.self.correct,false); assert.equal(wrong.self.points,0);
});

test('map pins can start zoomed near the target without revealing it', async t => {
  const f = await fixture(t);
  const question = {type:'map-pin', question:'Find the target', target:{lat:59.3293,lng:18.0686}, maxDistanceKm:1000, timeLimit:30};
  const room = (await f.request('/api/rooms',{method:'POST',token:'map-test-owner-token',body:{quiz:{title:'Zoom quiz',questions:[{...question,zoomNearTarget:true},question]}}})).data;
  const route = `/api/rooms/${room.pin}`;
  const player = (await f.request(`${route}/join`,{method:'POST',body:{nickname:'Zoomer'}})).data.playerToken;
  const action = name => f.request(`${route}/${name}`,{method:'POST',token:room.hostToken});
  const state = token => f.request(`${route}/state`,{token}).then(r=>r.data);
  await action('start'); await action('open');
  const first = await state(player);
  assert.equal(first.question.target,undefined);
  assert.equal(first.question.startView.zoom,4);
  const offKm = distanceKm(first.question.startView.center, question.target);
  assert.ok(offKm > 150 && offKm < 700, `start view should be near but not on the target (${offKm} km)`);
  assert.deepEqual((await state(player)).question.startView, first.question.startView);
  await action('next');
  assert.equal((await state(player)).question.startView,undefined);
  await action('next'); await action('open');
  assert.equal((await state(player)).question.startView,undefined);
});

test('placed map pins count without lock-in and can be moved until locked', async t => {
  const f = await fixture(t);
  const question = {type:'map-pin', question:'Find the target', target:{lat:0,lng:0}, maxDistanceKm:1000, timeLimit:30};
  const room = (await f.request('/api/rooms',{method:'POST',token:'map-test-owner-token',body:{quiz:{title:'Unlocked pins',questions:[question,{type:'quiz',question:'Pick',answers:['A','B'],correctIndex:0,timeLimit:20}]}}})).data;
  const route = `/api/rooms/${room.pin}`;
  const players = [];
  for (const nickname of ['Mover','Locker','Idle']) players.push((await f.request(`${route}/join`,{method:'POST',body:{nickname}})).data.playerToken);
  const action = name => f.request(`${route}/${name}`,{method:'POST',token:room.hostToken});
  const state = token => f.request(`${route}/state`,{token}).then(r=>r.data);
  const pin = (token,lng) => f.request(`${route}/pin`,{method:'POST',token,body:{questionIndex:0,answerLocation:{lat:0,lng}}});
  assert.equal((await pin(players[0],0)).status,409);
  await action('start'); await action('open');
  assert.equal((await f.request(`${route}/pin`,{method:'POST',token:room.hostToken,body:{questionIndex:0,answerLocation:{lat:0,lng:0}}})).status,403);
  assert.equal((await pin(players[0],181)).status,400);
  assert.equal((await pin(players[0],5)).status,200);
  assert.equal((await pin(players[0],1)).status,200);
  const moved = await state(players[0]);
  assert.equal(moved.self.answered,false); assert.deepEqual(moved.self.pendingLocation,{lat:0,lng:1}); assert.equal(moved.answeredCount,0);
  assert.equal((await pin(players[1],20)).status,200);
  assert.equal((await f.request(`${route}/answer`,{method:'POST',token:players[1],body:{questionIndex:0,answerLocation:{lat:0,lng:0}}})).status,200);
  assert.equal((await pin(players[1],20)).status,409);
  assert.equal((await state(players[1])).self.pendingLocation,undefined);
  await action('next');
  const mover = await state(players[0]), locker = await state(players[1]), idle = await state(players[2]);
  assert.equal(mover.self.points,889); assert.equal(mover.self.score,889); assert.deepEqual(mover.self.answerLocation,{lat:0,lng:1});
  assert.equal(locker.self.points,1000); assert.equal(locker.self.correct,true);
  assert.equal(idle.self.points,0); assert.equal(idle.self.answerLocation,undefined);
  await action('next'); await action('open');
  assert.equal((await f.request(`${route}/pin`,{method:'POST',token:players[0],body:{questionIndex:1,answerLocation:{lat:0,lng:0}}})).status,400);
});

test('map pins validate, hide the target, and award distance-based points once', async t => {
  const f = await fixture(t);
  const question = {type:'map-pin', question:'Find the target', target:{lat:0,lng:0}, maxDistanceKm:1000, timeLimit:30};
  for (const invalid of [{...question,target:{lat:91,lng:0}}, {...question,target:{lat:0,lng:'0'}}, {...question,maxDistanceKm:0}, {...question,target:null}]) {
    assert.equal((await f.request('/api/quizzes',{method:'POST',token:'map-test-owner-token',body:{title:'Invalid map',questions:[invalid]}})).status,400);
  }
  const room = (await f.request('/api/rooms',{method:'POST',token:'map-test-owner-token',body:{quiz:{title:'Map quiz',questions:[question,question]}}})).data;
  const route = `/api/rooms/${room.pin}`;
  const players = [];
  for (const nickname of ['Exact','Near','Far','Missed']) players.push((await f.request(`${route}/join`,{method:'POST',body:{nickname}})).data.playerToken);
  const action = name => f.request(`${route}/${name}`,{method:'POST',token:room.hostToken});
  const state = token => f.request(`${route}/state`,{token}).then(r=>r.data);
  await action('start');
  assert.equal((await state(players[0])).question.target,undefined);
  await action('open');
  assert.equal((await state(room.hostToken)).question.target,undefined);
  assert.equal((await f.request(`${route}/answer`,{method:'POST',token:players[0],body:{questionIndex:0,answerLocation:{lat:0,lng:181}}})).status,400);
  for (const [i,lng] of [0,1,20].entries()) {
    assert.equal((await f.request(`${route}/answer`,{method:'POST',token:players[i],body:{questionIndex:0,answerLocation:{lat:0,lng},points:999999}})).status,200);
  }
  assert.equal((await state(players[0])).self.points,undefined);
  assert.equal((await state(players[1])).self.distanceKm,undefined);
  assert.deepEqual((await state(players[1])).self.answerLocation,{lat:0,lng:1});
  assert.equal((await f.request(`${route}/answer`,{method:'POST',token:players[0],body:{questionIndex:0,answerLocation:{lat:0,lng:0}}})).status,409);
  await action('next');
  const exact = await state(players[0]), near = await state(players[1]), far = await state(players[2]);
  assert.deepEqual(exact.question.target,question.target);
  assert.equal(exact.self.points,1000); assert.equal(exact.self.score,1000);
  assert.equal(near.self.points,889); assert.ok(Math.abs(near.self.distanceKm-111.195)<0.001);
  assert.equal(far.self.points,0); assert.equal((await state(players[3])).self.points,0);
  await action('next'); await action('open');
  assert.equal((await state(players[1])).self.answerLocation,undefined);
  assert.equal((await f.request(`${route}/answer`,{method:'POST',token:players[0],body:{questionIndex:0,answerLocation:{lat:0,lng:0}}})).status,409);
});

test('great-circle map distance handles the date line and poles', async () => {
  const {distanceKm,mapPoints} = await import('../lib/quiz.mjs');
  assert.ok(Math.abs(distanceKm({lat:0,lng:179},{lat:0,lng:-179})-222.39)<0.01);
  assert.ok(distanceKm({lat:90,lng:0},{lat:90,lng:180})<0.00001);
  assert.equal(mapPoints(500,1000),500);
  assert.equal(mapPoints(1000,1000),0);
  assert.equal(mapPoints(2000,1000),0);
});

test('gamble questions take bets blind, use fixed points, and never push a score below 0', async t => {
  const f = await fixture(t);
  const warmup = { question: 'Warm-up', answers: ['Right', 'Wrong'], correctIndex: 0, timeLimit: 30 };
  const gamble = { question: 'Secret gamble heading', answers: ['Right', 'Wrong'], correctIndex: 0, timeLimit: 30, gamble: true, gamblePoints: 1000 };
  assert.equal((await f.request('/api/quizzes',{method:'POST',token:'gamble-owner-token',body:{title:'Bad gamble',questions:[{...gamble,gamblePoints:50}]}})).status,400);
  const saved = (await f.request('/api/quizzes',{method:'POST',token:'gamble-owner-token',body:{title:'Poll gamble',questions:[{type:'poll',question:'Vote',answers:['A','B'],gamble:true}]}})).data;
  assert.equal(saved.questions[0].gamble,undefined,'polls cannot be gambled on');
  const room = (await f.request('/api/rooms',{method:'POST',body:{quiz:{title:'Gamble quiz',questions:[warmup,gamble]}}})).data;
  const route = `/api/rooms/${room.pin}`;
  const players = [];
  for (const nickname of ['BetRight','BetWrong','Safe','BetMissed']) players.push((await f.request(`${route}/join`,{method:'POST',body:{nickname}})).data.playerToken);
  const action = name => f.request(`${route}/${name}`,{method:'POST',token:room.hostToken});
  const state = token => f.request(`${route}/state`,{token}).then(r=>r.data);
  const answer = (i, answerIndex, questionIndex) => f.request(`${route}/answer`,{method:'POST',token:players[i],body:{answerIndex,questionIndex}});
  await action('start');
  assert.equal((await f.request(`${route}/bet`,{method:'POST',token:players[0],body:{bet:true,questionIndex:0}})).status,400,'normal questions take no bets');
  await action('open');
  await answer(0,0,0); await answer(1,0,0); await answer(2,0,0); await answer(3,1,0);
  await action('next');
  const warm = await state(players[1]);
  assert.ok(warm.self.score >= 500);
  await action('next');
  let preview = await state(players[0]);
  assert.equal(preview.status,'preview');
  assert.equal(preview.question.question,'','the heading stays hidden while bets are placed');
  assert.equal(preview.question.gamble,true); assert.equal(preview.question.gamblePoints,1000);
  assert.equal((await f.request(`${route}/bet`,{method:'POST',token:room.hostToken,body:{bet:true,questionIndex:1}})).status,403);
  assert.equal((await f.request(`${route}/bet`,{method:'POST',token:players[0],body:{bet:'yes',questionIndex:1}})).status,400);
  assert.equal((await f.request(`${route}/bet`,{method:'POST',token:players[0],body:{bet:true,questionIndex:1}})).status,200);
  assert.equal((await f.request(`${route}/bet`,{method:'POST',token:players[0],body:{bet:false,questionIndex:1}})).status,409,'bets are final');
  await f.request(`${route}/bet`,{method:'POST',token:players[1],body:{bet:true,questionIndex:1}});
  await f.request(`${route}/bet`,{method:'POST',token:players[2],body:{bet:false,questionIndex:1}});
  preview = await state(room.hostToken);
  assert.equal(preview.betCount,3); assert.equal(preview.status,'preview');
  assert.equal((await state(players[0])).self.bet,true);
  await f.request(`${route}/bet`,{method:'POST',token:players[3],body:{bet:true,questionIndex:1}});
  const open = await state(players[0]);
  assert.equal(open.status,'question','answers open once everyone has chosen');
  assert.equal(open.question.question,'Secret gamble heading');
  const before = (await state(room.hostToken)).players;
  const scoreOf = nickname => before.find(p => p.nickname === nickname).score;
  await answer(0,0,1); await answer(1,1,1); await answer(2,0,1);
  await action('next');
  const [right, wrong, safe, missed] = await Promise.all(players.map(state));
  assert.equal(right.self.points,2000); assert.equal(right.self.score,scoreOf('BetRight')+2000);
  assert.equal(wrong.self.points,-1000); assert.equal(wrong.self.score,Math.max(0,scoreOf('BetWrong')-1000));
  assert.equal(safe.self.points,1000,'no speed bonus');
  assert.equal(scoreOf('BetMissed'),0);
  assert.equal(missed.self.points,0,'a lost bet cannot go below 0'); assert.equal(missed.self.score,0);
});
