import http from 'node:http';
import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleQuiz, validateQuiz, normalizeAnswer, mediaPathPattern } from './lib/quiz.mjs';

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const secret = () => randomBytes(24).toString('base64url');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const ownerHash = token => createHash('sha256').update(token).digest('hex');

export function createApp({ dataDir = process.env.DATA_DIR || path.join(baseDir, 'data'), publicDir = path.join(baseDir, 'public'), roomTtlMs = 6 * 60 * 60 * 1000, hostUsername = process.env.HOST_USERNAME, hostPassword = process.env.HOST_PASSWORD } = {}) {
  if (!hostUsername || !hostPassword) throw new Error('Set HOST_USERNAME and HOST_PASSWORD before starting Fredagsquizet.');
  const equalSecret = (provided, expected) => timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(expected).digest());
  const authorizeHost = req => {
    const header = req.headers.authorization || '';
    const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(header)?.[1];
    let username = '', password = '';
    if (encoded) {
      const credentials = Buffer.from(encoded, 'base64').toString('utf8');
      const colon = credentials.indexOf(':');
      if (colon >= 0) { username = credentials.slice(0, colon); password = credentials.slice(colon + 1); }
    }
    if (!encoded || !equalSecret(username, hostUsername) || !equalSecret(password, hostPassword)) {
      throw Object.assign(new Error('Sign in to access quiz hosting.'), {status:401, basicAuth:true});
    }
  };
  mkdirSync(dataDir, { recursive: true });
  const mediaDir = path.join(dataDir, 'media');
  mkdirSync(mediaDir, { recursive: true });
  const storePath = path.join(dataDir, 'quizzes.json');
  let saved = [];
  try { saved = JSON.parse(readFileSync(storePath, 'utf8')); if (!Array.isArray(saved)) throw new Error('Invalid quiz store'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rooms = new Map();
  const persist = next => { writeFileSync(`${storePath}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 }); renameSync(`${storePath}.tmp`, storePath); saved = next; };
  const bearer = req => /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || req.headers['x-quiz-owner'];
  const owner = req => { const token = bearer(req); if (!token || token.length < 16 || token.length > 256) fail(401, 'A browser owner token is required.'); return ownerHash(token); };
  const publicQuiz = ({ owner: ignored, ...quiz }) => quiz;
  const rank = room => [...room.players.values()].map(p => ({ id: p.id, nickname: p.nickname, score: p.score })).sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname)).map((p, i) => ({ ...p, rank: i + 1 }));
  const identity = (room, token) => token && token === room.hostToken ? { host: true } : room.players.get(token);
  const state = (room, who) => {
    const question = room.quiz.questions[room.index];
    const result = { pin: room.pin, status: room.status, quizTitle: room.quiz.title, hasScoredQuestions: room.quiz.questions.some(q => q.type !== 'poll'), questionIndex: room.index, questionCount: room.quiz.questions.length, players: rank(room), leaderboard: rank(room), answeredCount: [...room.players.values()].filter(p => p.answer !== undefined).length, host: !!who.host };
    if (question && room.status !== 'lobby') {
      result.question = { type: question.type ?? 'quiz', question: question.question, image: question.image || '', imageAlt: question.imageAlt || '', timeLimit: question.timeLimit };
      if (room.status !== 'preview') {
        result.question.answers = question.answers;
        result.question.startedAt = room.startedAt;
        result.question.deadline = room.deadline;
      }
      if (room.status === 'reveal' || room.status === 'finished') {
        result.question.acceptedAnswers = question.acceptedAnswers;
        result.question.correctIndex = question.correctIndex;
        result.answerCounts = question.answers?.map((_, i) => [...room.players.values()].filter(p => p.answer === i).length);
      }
    }
    if (!who.host) {
      result.self = { id: who.id, nickname: who.nickname, score: who.score, answered: who.answer !== undefined, ...(typeof who.answer === 'number' ? {answerIndex: who.answer} : {answerText: who.answer}) };
      if (room.status === 'reveal' || room.status === 'finished') { result.self.correct = who.answer !== undefined && who.correct === true; result.self.points = who.points || 0; }
    }
    return result;
  };
  const broadcast = room => { for (const client of room.clients) client.res.write(`event: state\ndata: ${JSON.stringify(state(room, client.who))}\n\n`); };
  const reveal = room => { if (room.status !== 'question') return; clearTimeout(room.timer); for (const p of room.players.values()) p.score += p.points || 0; room.status = 'reveal'; broadcast(room); };
  const advance = room => {
    clearTimeout(room.timer);
    room.index++;
    if (room.index >= room.quiz.questions.length) { room.index = room.quiz.questions.length - 1; room.status = 'finished'; broadcast(room); return; }
    for (const p of room.players.values()) { p.answer = undefined; p.points = 0; p.correct = false; }
    room.status = 'preview'; room.startedAt = undefined; room.deadline = undefined; broadcast(room);
  };
  const openAnswers = room => {
    room.status = 'question'; room.startedAt = Date.now(); room.deadline = room.startedAt + room.quiz.questions[room.index].timeLimit * 1000;
    room.timer = setTimeout(() => reveal(room), room.deadline - Date.now()); room.timer.unref(); broadcast(room);
  };
  const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const body = async req => {
    const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; if (bytes > 128 * 1024) fail(413, 'Request too large.'); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString('utf8');
    try { const parsed = text ? JSON.parse(text) : {}; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Expected a JSON object.'); return parsed; } catch { fail(400, 'Invalid JSON object.'); }
  };
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });
      if (req.method === 'POST' && url.pathname === '/api/images') {
        authorizeHost(req);
        owner(req);
        const chunks = []; let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 50 * 1024 * 1024) fail(413, 'Images must be 50 MB or smaller.');
          chunks.push(chunk);
        }
        const image = Buffer.concat(chunks);
        let ext;
        if (image.length >= 24 && image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ext = 'png';
        else if (image.length >= 4 && image[0] === 255 && image[1] === 216 && image[2] === 255) ext = 'jpg';
        else if (image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP') ext = 'webp';
        else if (image.length >= 13 && ['GIF87a', 'GIF89a'].includes(image.toString('ascii', 0, 6))) ext = 'gif';
        else fail(400, 'Upload a PNG, JPEG, WebP or GIF image.');
        const filename = `${createHash('sha256').update(image).digest('hex')}.${ext}`;
        writeFileSync(path.join(mediaDir, filename), image);
        return send(res, 201, { image: `/media/${filename}` });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && mediaPathPattern.test(url.pathname)) {
        let image;
        try { image = await readFile(path.join(mediaDir, path.basename(url.pathname))); } catch { fail(404, 'Image not found.'); }
        const ext = path.extname(url.pathname).slice(1);
        res.writeHead(200, { 'Content-Type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'" });
        return res.end(req.method === 'HEAD' ? undefined : image);
      }
      if (parts[0] === 'api' && parts[1] === 'quizzes') {
        authorizeHost(req);
        const id = parts[2];
        if (req.method === 'GET') {
          const hash = bearer(req) ? owner(req) : null;
          const quizzes = [sampleQuiz, ...saved.filter(q => q.owner === hash).map(publicQuiz)];
          if (id) { const quiz = quizzes.find(q => q.id === id); if (!quiz) fail(404, 'Quiz not found.'); return send(res, 200, quiz); }
          return send(res, 200, quizzes);
        }
        const hash = owner(req);
        if (req.method === 'POST' && !id) { if (saved.filter(q => q.owner === hash).length >= 100) fail(409, 'Quiz library limit reached.'); const quiz = validateQuiz(await body(req)); persist([...saved, { ...quiz, owner: hash }]); return send(res, 201, quiz); }
        const existing = saved.find(q => q.id === id && q.owner === hash);
        if (!existing) fail(404, 'Quiz not found.');
        if (req.method === 'PUT') { const quiz = validateQuiz(await body(req), id); persist(saved.map(q => q === existing ? { ...quiz, owner: hash } : q)); return send(res, 200, quiz); }
        if (req.method === 'DELETE') { persist(saved.filter(q => q !== existing)); return send(res, 200, { ok: true }); }
      }
      if (parts[0] === 'api' && parts[1] === 'rooms') {
        if (req.method === 'POST' && parts.length === 2) {
          authorizeHost(req);
          if (rooms.size >= 1000) fail(503, 'Room limit reached. Try again later.');
          const input = await body(req);
          let quiz;
          if (input.quiz) quiz = validateQuiz(input.quiz);
          else if (!input.quizId || input.quizId === 'sample') quiz = sampleQuiz;
          else { const token = bearer(req) || input.ownerToken; quiz = saved.find(q => q.id === input.quizId && token && q.owner === ownerHash(token)); }
          if (!quiz) fail(404, 'Quiz not found.');
          let pin; do { pin = String(randomInt(100000, 1000000)); } while (rooms.has(pin));
          const room = { pin, quiz: structuredClone(quiz), hostToken: secret(), players: new Map(), clients: new Set(), status: 'lobby', index: -1, touchedAt: Date.now() };
          rooms.set(pin, room); return send(res, 201, { pin, hostToken: room.hostToken });
        }
        const room = rooms.get(parts[2]); if (!room) fail(404, 'Game not found. Check your PIN.');
        const action = parts[3];
        if (req.method === 'POST' && action === 'join') {
          if (room.status !== 'lobby') fail(409, 'This game has already started.');
          if (room.players.size >= 100) fail(409, 'This game is full.');
          const { nickname } = await body(req);
          if (room.status !== 'lobby') fail(409, 'This game has already started.');
          if (room.players.size >= 100) fail(409, 'This game is full.');
          if (typeof nickname !== 'string' || !nickname.trim() || nickname.trim().length > 24 || /[\u0000-\u001f\u007f]/.test(nickname)) fail(400, 'Choose a nickname of 1–24 characters.');
          if ([...room.players.values()].some(p => p.nickname.toLowerCase() === nickname.trim().toLowerCase())) fail(409, 'That nickname is already taken.');
          const playerToken = secret(); room.players.set(playerToken, { id: randomUUID(), nickname: nickname.trim(), score: 0 }); room.touchedAt = Date.now(); broadcast(room); return send(res, 201, { playerToken });
        }
        const who = identity(room, bearer(req) || req.headers['x-quiz-host-token'] || url.searchParams.get('token')); if (!who) fail(401, 'A valid game token is required.');
        room.touchedAt = Date.now();
        if (room.status === 'question' && Date.now() >= room.deadline) reveal(room);
        if (req.method === 'GET' && action === 'state') return send(res, 200, state(room, who));
        if (req.method === 'GET' && action === 'events') {
          if ([...room.clients].filter(c => c.who === who || (c.who.host && who.host)).length >= 5) fail(429, 'Too many live connections.');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          const client = { res, who }; room.clients.add(client); res.write(`event: state\ndata: ${JSON.stringify(state(room, who))}\n\n`);
          const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000); heartbeat.unref();
          res.on('close', () => { clearInterval(heartbeat); room.clients.delete(client); }); return;
        }
        if (req.method === 'POST' && action === 'answer') {
          if (who.host) fail(403, 'Only players can answer.');
          const { answerIndex, answerText, questionIndex } = await body(req);
          if (room.status !== 'question' || Date.now() >= room.deadline) { reveal(room); fail(409, 'Answers are closed.'); }
          if (questionIndex !== room.index) fail(409, 'This question is no longer active.');
          if (who.answer !== undefined) fail(409, 'Your answer has already been submitted.');
          const q = room.quiz.questions[room.index];
          if (q.type === 'type-answer') {
            if (typeof answerText !== 'string' || !answerText.trim() || answerText.length > 200) fail(400, 'Type an answer of 1–200 characters.');
            who.answer = answerText.trim(); who.correct = q.acceptedAnswers.some(a => normalizeAnswer(a) === normalizeAnswer(answerText));
          } else {
            if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= q.answers.length) fail(400, 'Choose a valid answer.');
            who.answer = answerIndex; who.correct = q.type !== 'poll' && answerIndex === q.correctIndex;
          }
          who.points = who.correct ? Math.round(500 + 500 * Math.max(0, 1 - (Date.now() - room.startedAt) / (q.timeLimit * 1000))) : 0;
          if ([...room.players.values()].every(p => p.answer !== undefined)) reveal(room); else broadcast(room);
          return send(res, 200, { ok: true });
        }
        if (req.method === 'POST' && ['start', 'open', 'next', 'end'].includes(action)) {
          authorizeHost(req);
          if (!who.host) fail(403, 'Only the host can control the game.');
          if (action === 'start') { if (room.status !== 'lobby') fail(409, 'Game already started.'); if (!room.players.size) fail(409, 'Wait for at least one player.'); advance(room); }
          if (action === 'open') { if (room.status !== 'preview') fail(409, 'The question is not in preview.'); openAnswers(room); }
          if (action === 'next') { if (room.status === 'question') reveal(room); else if (room.status === 'reveal') advance(room); else fail(409, 'No next question available.'); }
          if (action === 'end') { if (room.status === 'question') reveal(room); clearTimeout(room.timer); room.status = 'finished'; broadcast(room); }
          return send(res, 200, state(room, who));
        }
        fail(404, 'Endpoint not found.');
      }
      if (url.pathname.startsWith('/api/')) fail(404, 'Endpoint not found.');
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed.');
      if (url.pathname === '/host') { authorizeHost(req); res.setHeader('X-Robots-Tag', 'noindex'); }
      const relative = url.pathname === '/host' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const target = path.resolve(publicDir, relative);
      if (!target.startsWith(path.resolve(publicDir) + path.sep)) fail(403, 'Forbidden.');
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp' };
      let content; try { content = await readFile(target); } catch { fail(404, 'File not found.'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { if (!res.headersSent && error.basicAuth) res.setHeader('WWW-Authenticate', 'Basic realm="Fredagsquizet host", charset="UTF-8"'); if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Internal server error.' }); else res.end(); if (!error.status) console.error(error); }
  });
  const sweep = setInterval(() => { for (const [pin, room] of rooms) if (Date.now() - room.touchedAt > roomTtlMs) { clearTimeout(room.timer); for (const c of room.clients) c.res.end(); rooms.delete(pin); } }, Math.min(roomTtlMs, 60000)); sweep.unref();
  const close = async () => { clearInterval(sweep); for (const room of rooms.values()) { clearTimeout(room.timer); for (const c of room.clients) c.res.end(); } server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  return { server, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp(); const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '0.0.0.0', () => console.log(`Fredagsquizet live at http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
}
