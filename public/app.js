'use strict';
const app = document.querySelector('#app');
const symbols = ['▲', '◆', '●', '■'];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// getRandomValues works on LAN HTTP as well as HTTPS; randomUUID requires a secure context.
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
let ownerToken = localStorage.getItem('quizpop-owner');
if (!ownerToken) { ownerToken = randomToken(); localStorage.setItem('quizpop-owner', ownerToken); }
let stream, roomState, session, timer, quizzes = [], draft, routeVersion = 0;
const questionTypes = {'quiz':'Multiple choice', 'true-false':'True or false', 'type-answer':'Type an answer', 'poll':'Poll'};
const newQuestion = () => ({type:'quiz', question:'', image:'', imageAlt:'', answers:['','','',''], correctIndex:0, timeLimit:20});
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.hidden = false; clearTimeout(toast.timeout); toast.timeout = setTimeout(() => el.hidden = true, 6000); }
async function api(path, {method='GET', body, token=ownerToken} = {}) {
  const response = await fetch(`/api${path}`, {method, headers:{'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})}, ...(body ? {body:JSON.stringify(body)} : {})});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}
async function run(button, action) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { await action(); } catch (error) { toast(error.message); }
  finally { if (button?.isConnected) button.disabled = false; }
}
function joinPage(pin='') {
  app.innerHTML = `<section class="join"><p class="eyebrow">Big questions. Good company.</p><h1 class="hero-logo">QuizPop<span>!</span></h1><p class="subtitle">Gather your people.<br>Let the game begin.</p><form class="card" id="join-form"><label class="field" for="pin">Got a game PIN?</label><input class="input pin-input" id="pin" name="pin" inputmode="numeric" autocomplete="off" pattern="[0-9]{6}" maxlength="6" placeholder="Game PIN" value="${escapeHTML(pin)}" required aria-label="Six-digit game PIN"><button class="btn wide" type="submit">Enter <span aria-hidden="true">→</span></button></form><p class="join-note">Bringing everyone together? <a href="#host">Host a quiz</a></p><div class="shape-row" aria-hidden="true"><span>▲</span><span>◆</span><span>●</span><span>■</span></div><p class="small muted-white">One screen to host. Any device to play.</p></section>`;
  document.querySelector('#join-form').onsubmit = event => {
    event.preventDefault(); const pin = document.querySelector('#pin').value.trim();
    nicknamePage(pin);
  };
}
function nicknamePage(pin) {
  app.innerHTML = `<section class="join"><p class="eyebrow">Game PIN ${escapeHTML(pin)}</p><h1 class="hero-logo">You're in<span>?</span></h1><p class="subtitle">Every legend needs a name.</p><form class="card" id="nickname-form"><label class="field" for="nickname">Your nickname</label><input class="input" id="nickname" name="nickname" maxlength="24" autocomplete="nickname" placeholder="Quiz wizard" required><button class="btn wide" type="submit">Let's go! <span aria-hidden="true">→</span></button></form><p class="join-note"><a href="#" id="back-pin">Use a different PIN</a></p></section>`;
  document.querySelector('#nickname').focus();
  document.querySelector('#back-pin').onclick = event => { event.preventDefault(); joinPage(pin); };
  document.querySelector('#nickname-form').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
    const result = await api(`/rooms/${pin}/join`, {method:'POST', token:null, body:{nickname:document.querySelector('#nickname').value.trim()}});
    saveSession({pin, token:result.playerToken, role:'player'});
  }); };
}
async function library(version) {
  app.innerHTML = '<section class="shell"><span class="spinner"></span><p style="text-align:center">Opening your quiz library…</p></section>';
  quizzes = await api('/quizzes'); if (version !== routeVersion) return;
  app.innerHTML = `<section class="shell"><div class="topline"><div><p class="eyebrow">The host's corner</p><h1>Your next great game.</h1><p>Pick a quiz, share the PIN, and bring the room to life.</p></div><a class="btn light" href="#create">＋ Create quiz</a></div><div class="quiz-grid">${quizzes.map((q,i) => `<article class="card quiz-card"><div class="quiz-art" aria-hidden="true">${['✦','◎','✷'][i%3]}</div><div class="quiz-body"><div><span class="badge">${q.id==='sample'?'READY TO PLAY':'YOUR CREATION'}</span></div><h2 style="margin-top:14px">${escapeHTML(q.title)}</h2><span class="small">${q.questions.length} questions · ${Math.ceil(q.questions.reduce((n,q)=>n+q.timeLimit,0)/60)} min of play</span><div class="actions"><button class="btn primary" data-host="${escapeHTML(q.id)}">Host live →</button><button class="btn subtle" data-edit="${escapeHTML(q.id)}">${q.id==='sample'?'Copy':'Edit'}</button>${q.id==='sample'?'':`<button class="btn subtle" data-delete="${escapeHTML(q.id)}" aria-label="Delete ${escapeHTML(q.title)}">×</button>`}</div></div></article>`).join('')}</div><p class="small muted-white" style="margin-top:28px">Your quizzes are saved on this server. Use this browser to manage them.</p></section>`;
  app.querySelectorAll('[data-host]').forEach(button => button.onclick = () => run(button, async () => {
    const result = await api('/rooms', {method:'POST', body:{quizId:button.dataset.host}});
    saveSession({pin:result.pin, token:result.hostToken, role:'host'});
  }));
  app.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => { location.hash = `edit/${button.dataset.edit}`; });
  app.querySelectorAll('[data-delete]').forEach(button => button.onclick = () => run(button, async () => {
    if (!confirm('Delete this quiz from your library?')) return;
    await api(`/quizzes/${button.dataset.delete}`, {method:'DELETE'}); await library(routeVersion);
  }));
}
function readDraft() {
  draft.title = document.querySelector('#quiz-title').value;
  draft.questions = [...app.querySelectorAll('.question-editor')].map((el, i) => ({
    ...draft.questions[i],
    type: el.querySelector('[data-type]').value,
    question: el.querySelector('[data-question]').value,
    imageAlt: el.querySelector('[data-image-alt]')?.value || '',
    answers: [...el.querySelectorAll('[data-answer]')].map(input => input.value),
    acceptedAnswers: (el.querySelector('[data-accepted]')?.value || '').split('\n').map(answer => answer.trim()).filter(Boolean),
    correctIndex: Number(el.querySelector('input[type=radio]:checked')?.value || 0),
    timeLimit: Number(el.querySelector('[data-time]').value)
  }));
}
function editorQuestion(q, i) {
  const type = q.type || 'quiz';
  let answers;
  if (type === 'type-answer') {
    answers = `<label class="field" for="accepted-${i}">Accepted answers (one per line)</label><textarea class="input" id="accepted-${i}" data-accepted rows="3" required placeholder="Stockholm\nStockholm city">${escapeHTML((q.acceptedAnswers || ['']).join('\n'))}</textarea><p class="small">Up to 10 accepted spellings. Capitalization and extra spaces are ignored.</p>`;
  } else {
    answers = `<div class="answer-inputs">${q.answers.map((answer, j) => `<div class="answer-edit">${type !== 'poll' ? `<input type="radio" name="correct-${i}" value="${j}" ${q.correctIndex === j ? 'checked' : ''} aria-label="Mark answer ${j + 1} correct">` : ''}<span aria-hidden="true">${type === 'true-false' ? ['✓','✕'][j] : symbols[j]}</span><input class="input" data-answer required maxlength="200" placeholder="Answer ${j + 1}" aria-label="Question ${i + 1}, answer ${j + 1}" value="${escapeHTML(answer)}" ${type === 'true-false' ? 'readonly' : ''}></div>`).join('')}</div><p class="small">${type === 'poll' ? 'Everyone gets a vote. No correct answer and no points.' : 'Select the circle beside the correct answer.'}</p>`;
  }
  return `<article class="card question-editor">
    <div class="question-heading"><h2>Question ${i + 1}</h2><button class="btn subtle" type="button" data-remove="${i}" ${draft.questions.length === 1 ? 'disabled' : ''} aria-label="Remove question ${i + 1}">Remove</button></div>
    <label class="field" for="type-${i}">Question type</label><select class="input type-select" id="type-${i}" data-type="${i}">${Object.entries(questionTypes).map(([value, label]) => `<option value="${value}" ${value === type ? 'selected' : ''}>${label}</option>`).join('')}</select>
    <label class="field" for="question-${i}">Question heading</label><textarea class="input" id="question-${i}" data-question maxlength="500" required rows="2" placeholder="Type your question…">${escapeHTML(q.question)}</textarea>
    <div class="image-editor">${q.image ? `<img class="editor-image" src="${escapeHTML(q.image)}" alt="${escapeHTML(q.imageAlt || 'Question image')}"><button class="btn subtle" type="button" data-remove-image="${i}">Remove picture</button>` : '<p class="small">Add a picture to bring your question to life.</p>'}<label class="field" for="image-${i}">${q.image ? 'Replace picture' : 'Upload picture'}</label><input class="input" id="image-${i}" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-image="${i}"><p class="small">PNG, JPEG, WebP or GIF · up to 5 MB. Shown before answers open.</p>${q.image ? `<label class="field" for="alt-${i}">Picture description</label><input class="input" id="alt-${i}" data-image-alt maxlength="200" placeholder="Describe the picture for players using a screen reader" value="${escapeHTML(q.imageAlt)}">` : ''}</div>
    ${answers}<div class="form-row"><label class="field" for="time-${i}" style="margin:0">Answer time</label><select class="input" id="time-${i}" data-time>${[...new Set([5,10,20,30,60,90,120,q.timeLimit])].sort((a,b) => a-b).map(t => `<option value="${t}" ${q.timeLimit === t ? 'selected' : ''}>${t} sec</option>`).join('')}</select><span class="small">Starts when the host opens answers.</span></div>
  </article>`;
}
function editor() {
  app.innerHTML = `<section class="shell editor"><div class="topline"><div><p class="eyebrow">Make it your own</p><h1>${draft.id ? 'Edit your quiz' : 'A great game starts here.'}</h1><p>Mix question types, add pictures, and set the pace.</p></div><a class="btn ghost" href="#host">Back to library</a></div><form id="editor-form"><label class="field" for="quiz-title">Quiz title</label><input class="input editor-title" id="quiz-title" placeholder="Give your quiz a name" maxlength="120" required value="${escapeHTML(draft.title)}">${draft.questions.map(editorQuestion).join('')}<div class="savebar"><button class="btn ghost" id="add-question" type="button" ${draft.questions.length >= 50 ? 'disabled' : ''}>＋ Add question</button><button class="btn light" type="submit">Save quiz ✓</button></div></form></section>`;
  document.querySelector('#add-question').onclick = () => { readDraft(); draft.questions.push(newQuestion()); editor(); app.querySelectorAll('.question-editor')[draft.questions.length - 1].scrollIntoView({block:'center',behavior:'smooth'}); };
  app.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => { readDraft(); draft.questions.splice(Number(button.dataset.remove), 1); editor(); });
  app.querySelectorAll('[data-type]').forEach(select => select.onchange = () => {
    readDraft(); const q = draft.questions[Number(select.dataset.type)];
    if (q.type === 'true-false') { q.answers = ['True','False']; q.correctIndex = Math.min(q.correctIndex, 1); }
    else if (q.type !== 'type-answer' && q.answers.length < 2) q.answers = ['','','',''];
    if (q.type === 'type-answer' && !q.acceptedAnswers?.length) q.acceptedAnswers = [''];
    editor();
  });
  app.querySelectorAll('[data-remove-image]').forEach(button => button.onclick = () => { readDraft(); draft.questions[Number(button.dataset.removeImage)].image = ''; editor(); });
  app.querySelectorAll('[data-image]').forEach(input => input.onchange = async () => {
    const file = input.files[0]; if (!file) return;
    const version = routeVersion; readDraft(); const q = draft.questions[Number(input.dataset.image)];
    app.querySelectorAll('#editor-form input, #editor-form textarea, #editor-form select, #editor-form button').forEach(el => el.disabled = true);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Choose an image no larger than 5 MB.');
      const bitmap = await createImageBitmap(file); const pixels = bitmap.width * bitmap.height; bitmap.close();
      if (pixels > 30000000) throw new Error('Choose an image smaller than 30 megapixels.');
      const response = await fetch('/api/images', {method:'POST', headers:{Authorization:`Bearer ${ownerToken}`, 'Content-Type':file.type || 'application/octet-stream'}, body:file});
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      if (version === routeVersion) q.image = result.image;
    } catch (error) { toast(error.message || 'This picture could not be read. Try a PNG or JPEG.'); }
    finally { if (version === routeVersion) editor(); }
  });
  document.querySelector('#editor-form').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
    readDraft(); const version = routeVersion;
    await api(draft.id ? `/quizzes/${draft.id}` : '/quizzes', {method:draft.id ? 'PUT' : 'POST', body:draft});
    if (version !== routeVersion) return; draft = null; location.hash = 'host';
  }); };
}
function saveSession(value) { session = value; sessionStorage.setItem(`quizpop-${value.role}-${value.pin}`,JSON.stringify(value)); location.hash=`room/${value.role}/${value.pin}`; }
async function connectRoom(role, pin, version) {
  const stored = sessionStorage.getItem(`quizpop-${role}-${pin}`);
  if (!stored) { location.hash = role==='host'?'host':`join/${pin}`; return; }
  session = JSON.parse(stored);
  roomState = await api(`/rooms/${pin}/state`,{token:session.token});
  if (version !== routeVersion) return;
  renderRoom();
  stream = new EventSource(`/api/rooms/${pin}/events?token=${encodeURIComponent(session.token)}`);
  stream.addEventListener('state',event => { if(version !== routeVersion) return; roomState = JSON.parse(event.data); renderRoom(); });
  stream.onopen = () => { const el=document.querySelector('.connection'); if(el) el.textContent='● Connected'; };
  stream.onerror = () => { const el=document.querySelector('.connection'); if(el) el.textContent='Reconnecting…'; };
  timer = setInterval(updateTimer,250);
}
function leaderboard(players) {
  return `<div class="ranking">${players.slice(0,10).map((p,i)=>`<div class="rank-row"><span class="position">${i+1}</span><strong>${escapeHTML(p.nickname)}${p.id===roomState.self?.id?' (you)':''}</strong><span class="score">${p.score.toLocaleString()} <small>pts</small></span></div>`).join('')}</div>`;
}
function questionContent(s) {
  const q = s.question, host = s.host, preview = s.status === 'preview', reveal = s.status === 'reveal';
  const typed = q.type === 'type-answer', poll = q.type === 'poll';
  const image = q.image ? `<figure class="question-picture"><img src="${escapeHTML(q.image)}" alt="${escapeHTML(q.imageAlt || 'Question picture')}"></figure>` : '';
  const heading = `<p class="eyebrow">${escapeHTML(questionTypes[q.type] || questionTypes.quiz)} · Question ${s.questionIndex + 1} of ${s.questionCount}</p><h1>${escapeHTML(q.question)}</h1>${image}`;
  if (preview) return `${heading}<div class="preview-note"><span class="badge">TAKE A LOOK</span><p>Read the question${q.image ? ' and study the picture' : ''}. Answers will open next.</p></div>${host ? '<button class="btn light" data-action="open">Open answers →</button>' : '<p class="muted-white">Waiting for the host to open answers…</p>'}`;
  let controls;
  if (typed) {
    controls = reveal ? `<div class="feedback">Accepted answers: ${q.acceptedAnswers.map(escapeHTML).join(' · ')}</div>` : host ? '<p class="waiting-answer">Players are typing their answers…</p>' : s.self.answered ? '<p class="waiting-answer">Answer locked in. Fingers crossed!</p>' : `<form id="typed-answer-form" class="card typed-answer"><label class="field" for="typed-answer">Your answer</label><input class="input" id="typed-answer" data-question-index="${s.questionIndex}" maxlength="200" required autocomplete="off" placeholder="Type your answer…"><button class="btn primary wide" type="submit">Lock in answer →</button></form>`;
  } else {
    controls = `<div class="answers ${q.type === 'true-false' ? 'true-false' : ''}">${q.answers.map((answer, i) => `<button class="answer ${reveal && !poll ? (i === q.correctIndex ? 'correct' : 'dim') : ''} ${s.self?.answerIndex === i ? 'selected' : ''}" data-answer-index="${i}" ${host || reveal || s.self?.answered ? 'disabled' : ''}><span class="symbol" aria-hidden="true">${q.type === 'true-false' ? ['✓','✕'][i] : symbols[i]}</span><span>${escapeHTML(answer)}${reveal && !poll && i === q.correctIndex ? ' ✓' : ''}${reveal ? ` <small>(${s.answerCounts?.[i] ?? 0}${poll ? ' votes' : ''})</small>` : ''}</span></button>`).join('')}</div>${!host && !reveal && s.self.answered ? `<p class="waiting-answer">${poll ? 'Vote recorded. Waiting for everyone…' : 'Answer locked in. Fingers crossed!'}</p>` : ''}`;
  }
  const feedback = !host && reveal ? `<div class="feedback">${poll ? (s.self.answered ? 'Thanks for voting! No points in this round.' : 'Voting closed. No points in this round.') : s.self.correct ? `Correct! +${s.self.points} points` : s.self.answered ? 'Not this time. You’ve got the next one!' : 'Time’s up!'}</div>` : '';
  return `${heading}<div class="question-meta"><div class="timer" aria-label="Seconds remaining" id="timer">${reveal ? '✓' : q.timeLimit}</div><div class="progress" aria-hidden="true"><div id="time-progress" style="width:${reveal ? 0 : 100}%"></div></div><span class="answer-count">${s.answeredCount} / ${s.players.length} ${poll ? 'voted' : 'answered'}</span></div>${controls}${feedback}${reveal && !poll ? leaderboard(s.leaderboard) : ''}${host ? `<div class="lobby-actions"><button class="btn light" data-action="next">${!reveal ? (poll ? 'Show votes' : 'Reveal answers') : s.questionIndex + 1 === s.questionCount ? 'Show podium 🏆' : 'Next question →'}</button><button class="btn ghost" data-action="end">End game</button></div>` : reveal ? '<p class="muted-white">Waiting for the host…</p>' : ''}`;
}
function renderRoom() {
  const oldInput = document.querySelector('#typed-answer');
  const inputDraft = oldInput ? {value:oldInput.value, index:Number(oldInput.dataset.questionIndex), focused:document.activeElement === oldInput, start:oldInput.selectionStart, end:oldInput.selectionEnd} : null;
  const version = routeVersion, token = session.token;
  const s = roomState, host = s.host, q = s.question, isQuestion = s.status==='question', isReveal=s.status==='reveal';
  const url = `${location.origin}/#join/${s.pin}`;
  const bar = `<div class="room-bar"><span><b>PIN ${escapeHTML(s.pin)}</b> · ${escapeHTML(s.quizTitle)}</span><span class="connection">● Connected</span><button class="danger-link" id="leave-room">${host?'Leave host screen':'Leave game'}</button></div>`;
  let content;
  if (s.status==='lobby') {
    content = host ? `<p class="eyebrow">Ready, set, quiz.</p><h1>Everyone in?</h1><p class="join-url">Join at <b>${escapeHTML(location.host)}</b> with game PIN</p><div class="pin-display"><small>GAME PIN</small><strong>${s.pin}</strong></div><div><button class="btn ghost" id="copy-link">Copy invite link ↗</button></div><p class="room-title">${s.players.length} ${s.players.length===1?'player':'players'} in the lobby</p><div class="player-list">${s.players.length?s.players.map(p=>`<span class="player-chip">${escapeHTML(p.nickname)}</span>`).join(''):'<p class="empty">The stage is set. Just waiting for your people…</p>'}</div><div class="lobby-actions"><button class="btn light" data-action="start" ${s.players.length?'':'disabled'}>Start game →</button></div>` : `<div class="podium-icon" aria-hidden="true">✦</div><p class="eyebrow">You're on the list</p><h1>You're in, ${escapeHTML(s.self.nickname)}!</h1><p class="subtitle">Get ready. Your host will start the game soon.</p><span class="spinner"></span><p class="muted-white">${s.players.length} ${s.players.length===1?'player':'players'} ready to play</p>`;
  } else if (isQuestion || isReveal || s.status === 'preview') {
    content = questionContent(s);
  } else {
    content = `<div class="podium-icon" aria-hidden="true">🏆</div><p class="eyebrow">That's a wrap</p><h1>${s.hasScoredQuestions && s.leaderboard.length?`${escapeHTML(s.leaderboard[0].nickname)} takes the crown!`:'Thanks for playing!'}</h1><p class="subtitle">${escapeHTML(s.quizTitle)}${s.self?` · Your score: ${s.self.score.toLocaleString()} points`:''}</p>${s.hasScoredQuestions ? leaderboard(s.leaderboard) : '<p class="muted-white">All votes are in. Thanks for sharing your thoughts.</p>'}<a class="btn light" href="${host?'#host':'#'}">${host?'Host another quiz':'Play again'} →</a>`;
  }
  app.innerHTML = `<section class="room">${bar}${content}</section>`;
  const typedInput = document.querySelector('#typed-answer');
  if (typedInput && inputDraft?.index === s.questionIndex) {
    typedInput.value = inputDraft.value;
    if (inputDraft.focused) { typedInput.focus(); typedInput.setSelectionRange(inputDraft.start, inputDraft.end); }
  }
  const submitAnswer = async answer => {
    try { await api(`/rooms/${s.pin}/answer`, {method:'POST', token, body:{...answer, questionIndex:s.questionIndex}}); }
    finally { const result = await api(`/rooms/${s.pin}/state`, {token}); if (version === routeVersion) { roomState = result; renderRoom(); } }
  };
  document.querySelector('#typed-answer-form')?.addEventListener('submit', event => {
    event.preventDefault(); const answerText = typedInput.value;
    run(event.submitter, () => submitAnswer({answerText}));
  });
  document.querySelector('#leave-room').onclick=()=>{ if(confirm(host?'Leave this screen? The game stays available; return with your browser Back button.':'Leave this game? You can return with your browser Back button.')) location.hash=host?'host':''; };
  document.querySelector('#copy-link')?.addEventListener('click', () => run(document.querySelector('#copy-link'),async()=>{
    if(navigator.clipboard?.writeText){ await navigator.clipboard.writeText(url); document.querySelector('#copy-link').textContent='Link copied ✓'; }
    else prompt('Copy this invite link:',url);
  }));
  app.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>run(button,async()=>{
    if(button.dataset.action==='end'&&!confirm('End the game now and show final scores?'))return;
    const result=await api(`/rooms/${s.pin}/${button.dataset.action}`,{method:'POST',token}); if(version !== routeVersion) return; roomState=result;renderRoom();
  }));
  app.querySelectorAll('[data-answer-index]').forEach(button=>button.onclick=()=>run(button,async()=>{
    app.querySelectorAll('[data-answer-index]').forEach(b=>b.disabled=true);
    await submitAnswer({answerIndex:Number(button.dataset.answerIndex)});
  }));
  updateTimer();
}
function updateTimer() {
  if(roomState?.status!=='question')return;
  const remaining=Math.max(0,roomState.question.deadline-Date.now());
  const el=document.querySelector('#timer');if(el)el.textContent=Math.ceil(remaining/1000);
  const progress=document.querySelector('#time-progress');if(progress)progress.style.width=`${remaining/(roomState.question.timeLimit*1000)*100}%`;
}
async function route() {
  const version=++routeVersion;stream?.close();stream=null;clearInterval(timer);roomState=null;
  const [page,arg,pin]=location.hash.slice(1).split('/');
  try {
    if(page==='host')await library(version);
    else if(page==='create'){draft={title:'',questions:[newQuestion()]};editor();}
    else if(page==='edit'){
      draft=await api(`/quizzes/${encodeURIComponent(arg)}`);if(version!==routeVersion)return;
      if(draft.id==='sample'){delete draft.id;draft.title+=' (copy)';}editor();
    }else if(page==='room')await connectRoom(arg,pin,version);
    else joinPage(page==='join'&&/^\d{6}$/.test(arg)?arg:'');
  } catch(error){if(version!==routeVersion)return;app.innerHTML=`<section class="join"><div class="card"><h1>Couldn't open that.</h1><p>${escapeHTML(error.message)}</p><a class="btn wide" href="#">Back to join</a><a class="btn subtle wide" href="#host">Quiz library</a></div></section>`;}
}
window.addEventListener('hashchange',route);
route();
