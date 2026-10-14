import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';

const quiz = { title: 'Integration quiz', questions: [{ question: 'Two plus two?', answers: ['Four', 'Five'], correctIndex: 0, timeLimit: 10 }, { question: 'Blue or green?', answers: ['Blue', 'Green'], correctIndex: 1, timeLimit: 1 }] };
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'quiz-test-'));
  let app;
  const boot = async () => { app = createApp({ dataDir }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${app.server.address().port}`; };
  let base = await boot();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (url, { method = 'GET', token, body } = {}) => { const res = await fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  return { request, get base() { return base; }, restart: async () => { await app.close(); base = await boot(); } };
}

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
  assert.equal(state.status, 'question'); assert.equal(state.question.correctIndex, undefined);
  assert.equal((await request(`${route}/answer`, { method: 'POST', token: alice, body: { answerIndex: 0, questionIndex: 0 } })).status, 200);
  state = (await request(`${route}/state`, { token: bob })).data;
  assert.equal(state.answeredCount, 1); assert.equal(state.players.find(p => p.nickname === 'Alice').score, 0, 'score must not leak correct answers');
  assert.equal((await request(`${route}/answer`, { method: 'POST', token: alice, body: { answerIndex: 1, questionIndex: 0 } })).status, 409);
  await request(`${route}/answer`, { method: 'POST', token: bob, body: { answerIndex: 1, questionIndex: 0 } });
  state = (await request(`${route}/state`, { token: alice })).data;
  assert.equal(state.status, 'reveal'); assert.equal(state.question.correctIndex, 0); assert.equal(state.self.correct, true); assert.ok(state.self.points >= 500); assert.equal(state.leaderboard[0].nickname, 'Alice');
  state = (await request(`${route}/next`, { method: 'POST', token: room.hostToken })).data;
  assert.equal(state.status, 'question'); assert.equal(state.answeredCount, 0);
  assert.equal((await request(`${route}/answer`, { method: 'POST', token: alice, body: { answerIndex: 1, questionIndex: 0 } })).status, 409, 'a delayed answer cannot apply to the next question');
  assert.equal((await request(`${route}/answer`, { method: 'POST', token: alice, body: { answerIndex: 1 } })).status, 409, 'answers must identify their question');
  assert.equal((await request(`${route}/state`, { token: alice })).data.self.answered, false);
  await new Promise(resolve => setTimeout(resolve, 1100));
  state = (await request(`${route}/state`, { token: alice })).data;
  assert.equal(state.status, 'reveal'); assert.equal(state.self.points, 0);
  assert.equal((await request(`${route}/answer`, { method: 'POST', token: alice, body: { answerIndex: 1, questionIndex: 1 } })).status, 409);
  state = (await request(`${route}/next`, { method: 'POST', token: room.hostToken })).data;
  assert.equal(state.status, 'finished'); assert.equal(state.leaderboard[0].nickname, 'Alice');
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

test('saved quizzes survive restart and remain scoped to the browser owner', async t => {
  const f = await fixture(t); const token = 'owner-one-long-enough'; const other = 'owner-two-long-enough';
  assert.equal((await f.request('/api/quizzes')).data[0].id, 'sample');
  assert.equal((await f.request('/api/quizzes', { method: 'POST', body: quiz })).status, 401);
  assert.equal((await f.request('/api/quizzes', { method: 'POST', token, body: { title: 'Bad', questions: [] } })).status, 400);
  const saved = (await f.request('/api/quizzes', { method: 'POST', token, body: quiz })).data;
  await f.restart();
  assert.equal((await f.request('/api/quizzes', { token })).data.length, 2);
  assert.equal((await f.request('/api/quizzes', { token: other })).data.length, 1);
  assert.equal((await f.request(`/api/quizzes/${saved.id}`, { method: 'DELETE', token: other })).status, 404);
  assert.equal((await f.request('/api/rooms', { method: 'POST', token: other, body: { quizId: saved.id } })).status, 404);
  assert.equal((await f.request('/api/rooms', { method: 'POST', token, body: { quizId: saved.id } })).status, 201);
  const edited = await f.request(`/api/quizzes/${saved.id}`, { method: 'PUT', token, body: { ...quiz, title: 'Renamed' } });
  assert.equal(edited.data.title, 'Renamed');
  assert.equal((await f.request(`/api/quizzes/${saved.id}`, { method: 'DELETE', token })).status, 200);
  await f.restart(); assert.equal((await f.request('/api/quizzes', { token })).data.length, 1);
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
  assert.equal((await f.request(`${route}/state`, { token })).data.players.length, 1);
});
