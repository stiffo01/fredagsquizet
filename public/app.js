'use strict';
const app = document.querySelector('#app');
const githubLink = document.querySelector('.github-corner');
const setGithubActive = active => {
  githubLink.classList.toggle('inactive', !active);
  githubLink.setAttribute('aria-disabled', String(!active));
  githubLink.tabIndex = active ? 0 : -1;
  if (active && githubLink.dataset.originalHref) githubLink.href = githubLink.dataset.originalHref;
  else if (!active && githubLink.hasAttribute('href')) { githubLink.dataset.originalHref = githubLink.href; githubLink.removeAttribute('href'); }
};
const symbols = ['▲', '◆', '●', '■'];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// getRandomValues works on LAN HTTP as well as HTTPS; randomUUID requires a secure context.
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
// Preserve ownership, drafts, and sessions saved before the application rename.
for (const storage of [localStorage, sessionStorage]) {
  for (const oldKey of Object.keys(storage).filter(key => key.startsWith('quizpop-'))) {
    const newKey = `fredagsquizet-${oldKey.slice('quizpop-'.length)}`;
    if (storage.getItem(newKey) === null) storage.setItem(newKey, storage.getItem(oldKey));
    storage.removeItem(oldKey);
  }
}
let ownerToken = localStorage.getItem('fredagsquizet-owner');
if (!ownerToken) { ownerToken = randomToken(); localStorage.setItem('fredagsquizet-owner', ownerToken); }
let stream, roomState, session, timer, roomSyncCleanup, statePoll, autosaveTimer, autosaveTask, autosavePending = false, quizzes = [], draft, routeVersion = 0, playerAnswerOnly = false;
const questionTypes = {'quiz':'Multiple choice', 'true-false':'True or false', 'type-answer':'Type an answer', 'poll':'Poll', 'map-pin':'Pin on a map'};
const playerEmojis = ['😀', '😎', '🤓', '🥳', '🐸', '🦊', '🐼', '🐙', '🦄', '🐧', '🐢', '🦖', '🍕', '🚀', '⭐', '👾'];
const newQuestion = () => ({type:'quiz', question:'', image:'', imageAlt:'', revealImage:'', revealImageAlt:'', showRevealImage:false, answers:['','','',''], correctIndex:0, timeLimit:20});
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.hidden = false; clearTimeout(toast.timeout); toast.timeout = setTimeout(() => el.hidden = true, 6000); }
async function api(path, {method='GET', body, token=ownerToken, signal} = {}) {
  const authHeaders = token === ownerToken ? {'X-Quiz-Owner':token}
    : session?.role === 'host' && token === session.token ? {'X-Quiz-Host-Token':token}
    : token ? {Authorization:`Bearer ${token}`} : {};
  const response = await fetch(`/api${path}`, {method, cache:'no-store', signal, headers:{'Content-Type':'application/json', ...authHeaders}, ...(body ? {body:JSON.stringify(body)} : {})});
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
  app.innerHTML = `<section class="join"><p class="eyebrow">Big questions. Good company.</p><h1 class="hero-logo">Fredags<span>quizet</span></h1><p class="subtitle">Gather your people.<br>Let the game begin.</p><form class="card" id="join-form"><label class="field" for="pin">Got a game PIN?</label><input class="input pin-input" id="pin" name="pin" inputmode="numeric" autocomplete="off" pattern="[0-9]{6}" maxlength="6" placeholder="Game PIN" value="${escapeHTML(pin)}" required aria-label="Six-digit game PIN"><button class="btn wide" type="submit">Enter <span aria-hidden="true">→</span></button></form><p class="join-note">Bringing everyone together? <a href="/host#host">Host a quiz</a></p><div class="shape-row" aria-hidden="true"><span>▲</span><span>◆</span><span>●</span><span>■</span></div><p class="small muted-white">One screen to host. Any device to play.</p></section>`;
  document.querySelector('#join-form').onsubmit = event => {
    event.preventDefault(); const pin = document.querySelector('#pin').value.trim();
    nicknamePage(pin);
  };
}
function nicknamePage(pin) {
  let selectedEmoji = playerEmojis[0];
  app.innerHTML = `<section class="join"><p class="eyebrow">Game PIN ${escapeHTML(pin)}</p><h1 class="hero-logo">You're in<span>?</span></h1><p class="subtitle">Pick your name and game emoji.</p><form class="card" id="nickname-form"><label class="field" for="nickname">Your nickname</label><input class="input" id="nickname" name="nickname" maxlength="24" autocomplete="nickname" placeholder="Quiz wizard" required><span class="field" style="margin-top:18px">Choose your emoji</span><div class="emoji-picker" role="group" aria-label="Choose a player emoji">${playerEmojis.map((emoji,i) => `<button type="button" class="emoji-choice${i===0?' selected':''}" data-emoji="${emoji}" aria-label="Play as ${emoji}" aria-pressed="${i===0}">${emoji}</button>`).join('')}</div><button class="btn wide" type="submit">Let's go! <span aria-hidden="true">→</span></button></form><p class="join-note"><a href="#" id="back-pin">Use a different PIN</a></p></section>`;
  document.querySelector('#nickname').focus();
  app.querySelectorAll('[data-emoji]').forEach(button => button.onclick = () => {
    selectedEmoji = button.dataset.emoji;
    app.querySelectorAll('[data-emoji]').forEach(choice => { const selected = choice === button; choice.classList.toggle('selected', selected); choice.setAttribute('aria-pressed', String(selected)); });
  });
  document.querySelector('#back-pin').onclick = event => { event.preventDefault(); joinPage(pin); };
  document.querySelector('#nickname-form').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
    const result = await api(`/rooms/${pin}/join`, {method:'POST', token:null, body:{nickname:document.querySelector('#nickname').value.trim(), emoji:selectedEmoji}});
    saveSession({pin, token:result.playerToken, role:'player'});
  }); };
}
async function library(version) {
  app.innerHTML = '<section class="shell"><span class="spinner"></span><p style="text-align:center">Opening your quiz library…</p></section>';
  const [quizList, activeGames] = await Promise.all([api('/quizzes'), api('/rooms')]); quizzes = quizList; if (version !== routeVersion) return;
  const gameCards = activeGames.length ? activeGames.map(game => `<article class="card game-admin-card"><div class="game-admin-heading"><div><span class="badge">${game.status==='finished'?(game.scoreboardDeleted?'SCOREBOARD REMOVED':'FINISHED'):game.status==='lobby'?'WAITING FOR PLAYERS':'LIVE GAME'}</span><h3>${escapeHTML(game.quizTitle)}</h3><p class="small">PIN ${escapeHTML(game.pin)} · ${game.playerCount} ${game.playerCount===1?'player':'players'} · ${escapeHTML(game.status)}</p></div><button class="btn subtle" data-open-game="${escapeHTML(game.pin)}">Open game</button></div>${game.scoreboardAvailable?`<div class="admin-scoreboard"><h4>Final scoreboard</h4>${game.leaderboard.map(player=>`<div class="admin-score-row"><span>${player.rank}.</span><span>${escapeHTML(player.emoji||'😀')} ${escapeHTML(player.nickname)}</span><span>${player.correctAnswers} correct</span><b>${player.score.toLocaleString()} pts</b></div>`).join('')}</div>`:''}<div class="actions admin-game-actions">${game.status!=='finished'?`<button class="btn danger" data-stop-game="${escapeHTML(game.pin)}">Stop quiz</button>`:''}${game.scoreboardAvailable?`<button class="btn subtle" data-remove-scoreboard="${escapeHTML(game.pin)}">Remove scoreboard</button>`:''}</div></article>`).join('') : '<p class="small muted-white">No active quizzes or saved scoreboards.</p>';
  app.innerHTML = `<section class="shell"><div class="topline"><div><p class="eyebrow">The host's corner</p><h1>Your next great game.</h1><p>Pick a quiz, share the PIN, and bring the room to life.</p></div><a class="btn light" href="#create">＋ Create quiz</a></div><section class="games-admin"><div class="games-admin-title"><h2>Active quizzes and scoreboards</h2><button class="btn ghost" id="refresh-games">Refresh</button></div><div class="game-admin-grid">${gameCards}</div></section><div class="quiz-grid">${quizzes.map((q,i) => `<article class="card quiz-card"><div class="quiz-art">${q.coverImage ? `<img class="quiz-cover-thumb" src="${escapeHTML(q.coverImage)}" alt="${escapeHTML(q.coverImageAlt || `${q.title} cover`)}">` : `<span aria-hidden="true">${['✦','◎','✷'][i%3]}</span>`}</div><div class="quiz-body"><div><span class="badge">${q.id==='feature-test'?'FEATURE TEST':q.id==='sample'?'READY TO PLAY':'YOUR CREATION'}</span></div><h2 style="margin-top:14px">${escapeHTML(q.title)}</h2>${q.id==='feature-test'?'<p class="small">Try previews, pictures, question types, polls, and scoring with your group.</p>':''}${q.creator?`<p class="small quiz-creator">Created by ${escapeHTML(q.creator)}</p>`:''}<span class="small">${q.questions.length} questions · ${Math.ceil(q.questions.reduce((n,q)=>n+q.timeLimit,0)/60)} min of play</span><div class="actions"><button class="btn primary" data-host="${escapeHTML(q.id)}">${q.id==='feature-test'?'Host test →':'Host live →'}</button><button class="btn subtle" data-edit="${escapeHTML(q.id)}">${q.id==='sample'||q.id==='feature-test'?'Copy':'Edit'}</button>${q.id==='feature-test'?'':`<button class="btn subtle" data-delete="${escapeHTML(q.id)}" aria-label="Remove ${escapeHTML(q.title)}">×</button>`}</div></div></article>`).join('')}</div><p class="small muted-white" style="margin-top:28px">Your quizzes are saved on this server. Use this browser to manage them.</p></section>`;
  document.querySelector('#refresh-games').onclick = () => library(routeVersion);
  app.querySelectorAll('[data-open-game]').forEach(button => button.onclick = () => { const game=activeGames.find(item=>item.pin===button.dataset.openGame); saveSession({pin:game.pin,token:game.hostToken,role:'host'}); });
  app.querySelectorAll('[data-stop-game]').forEach(button => button.onclick = () => run(button,async()=>{ if(!confirm('Stop this quiz now? Players will see the finished game.'))return; await api(`/rooms/${button.dataset.stopGame}/end`,{method:'POST',token:activeGames.find(item=>item.pin===button.dataset.stopGame).hostToken}); await library(routeVersion); }));
  app.querySelectorAll('[data-remove-scoreboard]').forEach(button => button.onclick = () => run(button,async()=>{ if(!confirm('Remove this scoreboard and clear the players’ points? This cannot be undone.'))return; await api(`/rooms/${button.dataset.removeScoreboard}/clear-scoreboard`,{method:'POST',token:activeGames.find(item=>item.pin===button.dataset.removeScoreboard).hostToken}); await library(routeVersion); }));
  app.querySelectorAll('[data-host]').forEach(button => button.onclick = () => run(button, async () => {
    const result = await api('/rooms', {method:'POST', body:{quizId:button.dataset.host}});
    saveSession({pin:result.pin, token:result.hostToken, role:'host'});
  }));
  app.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => { location.href = `/host#edit/${button.dataset.edit}`; });
  app.querySelectorAll('[data-delete]').forEach(button => button.onclick = () => run(button, async () => {
    if (!confirm('Delete this quiz from your library?')) return;
    await api(`/quizzes/${button.dataset.delete}`, {method:'DELETE'}); await library(routeVersion);
  }));
}
function readDraft() {
  draft.title = document.querySelector('#quiz-title').value;
  draft.creator = document.querySelector('#quiz-creator').value;
  draft.coverImageAlt = document.querySelector('[data-cover-alt]')?.value || '';
  draft.questions = [...app.querySelectorAll('.question-editor')].map((el, i) => ({
    ...draft.questions[i],
    type: el.querySelector('[data-type]').value,
    question: el.querySelector('[data-question]').value,
    imageAlt: el.querySelector('[data-image-alt]')?.value || '',
    revealImage: draft.questions[i].revealImage || '',
    revealImageAlt: el.querySelector('[data-reveal-image-alt]')?.value || '',
    showRevealImage: el.querySelector('[data-reveal-image]')?.checked || false,
    answers: [...el.querySelectorAll('[data-answer]')].map(input => input.value),
    acceptedAnswers: (el.querySelector('[data-accepted]')?.value || '').split('\n').map(answer => answer.trim()).filter(Boolean),
    target: readLocation(el),
    maxDistanceKm: Number(el.querySelector('[data-map-distance]')?.value || 2000),
    correctIndex: Number(el.querySelector('input[type=radio]:checked')?.value || 0),
    timeLimit: Number(el.querySelector('[data-time]').value)
  }));
}
const draftKey = value => `fredagsquizet-draft-${value.id || 'new'}`;
function cacheDraft(value = draft) {
  try { localStorage.setItem(draftKey(value), JSON.stringify(value)); } catch { /* Server autosave remains available. */ }
}
function restoreDraft(value) {
  try {
    const cached = JSON.parse(localStorage.getItem(draftKey(value)) || 'null');
    return cached && cached.id === value.id ? cached : value;
  } catch { return value; }
}
function draftIsComplete(value) {
  return !!value.title?.trim() && value.title.length <= 120 && value.questions.length > 0 && value.questions.length <= 50 && value.questions.every(q => {
    if (!q.question?.trim() || q.question.length > 500 || q.timeLimit < 1 || q.timeLimit > 120) return false;
    if (q.type === 'map-pin') return !!q.target && Number.isFinite(q.maxDistanceKm) && q.maxDistanceKm >= 1 && q.maxDistanceKm <= 20000;
    if (q.type === 'type-answer') return q.acceptedAnswers?.length > 0 && q.acceptedAnswers.length <= 10 && q.acceptedAnswers.every(answer => answer.length <= 200);
    return q.answers?.length >= 2 && q.answers.length <= 4 && q.answers.every(answer => answer.trim() && answer.length <= 200) && (q.type === 'poll' || q.correctIndex < q.answers.length);
  });
}
function scheduleDraftSave() {
  if (!draft || !document.querySelector('#editor-form')) return;
  try { readDraft(); cacheDraft(); } catch { /* Keep the latest previously captured draft. */ }
  const status = document.querySelector('#save-status');
  if (status) status.textContent = 'Saving changes…';
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { void persistDraft(); }, 700);
}
async function persistDraft() {
  if (autosaveTask) { autosavePending = true; return autosaveTask; }
  autosaveTask = (async () => {
    do {
      autosavePending = false;
      const version = routeVersion, target = draft;
      try { readDraft(); cacheDraft(); } catch { continue; }
      if (version !== routeVersion || !draftIsComplete(target)) {
        const status = document.querySelector('#save-status');
        if (status && version === routeVersion) status.textContent = 'Saved on this device · finish required fields to sync';
        continue;
      }
      const wasNew = !target.id;
      try {
        const saved = await api(target.id ? `/quizzes/${target.id}` : '/quizzes', {method:target.id ? 'PUT' : 'POST', body:target});
        if (version !== routeVersion || target !== draft) continue;
        if (wasNew) {
          target.id = saved.id;
          history.replaceState(null, '', `/host#edit/${encodeURIComponent(saved.id)}`);
          try { localStorage.removeItem('fredagsquizet-draft-new'); } catch {}
        }
        cacheDraft(target);
        const status = document.querySelector('#save-status');
        if (status) status.textContent = 'All changes saved';
      } catch {
        const status = document.querySelector('#save-status');
        if (status && version === routeVersion) status.textContent = 'Saved on this device · server sync will retry';
      }
    } while (autosavePending);
  })();
  try { await autosaveTask; } finally { autosaveTask = null; }
}
const defaultPicture = q => `/images/${Object.hasOwn(questionTypes, q.type) ? q.type : 'quiz'}.svg`;
function pictureUrlControls(target) {
  return `<div class="url-import"><label class="field" for="picture-url-${target}">Paste picture URL</label><div class="form-row"><input class="input" id="picture-url-${target}" type="url" data-picture-url="${target}" placeholder="https://example.com/picture.jpg" maxlength="2048"><button class="btn subtle" type="button" data-load-picture="${target}">Load and crop</button></div><p class="small">Use a publicly accessible image URL. Supported: PNG, JPEG, WebP or GIF · up to 50 MB.</p></div>`;
}
function openCropper(source, target, uploadPicture) {
  const modal = document.createElement('section');
  modal.className = 'crop-modal';
  modal.innerHTML = `<div class="crop-card"><h2>Crop your picture</h2><p class="small">Drag the picture to reposition it. Use the zoom control to frame it.</p><div class="crop-stage" aria-label="Drag to reposition the picture"><img class="crop-image" alt="Picture crop preview"></div><label class="field" for="crop-ratio">Shape</label><select class="input" id="crop-ratio"><option value="4/3">Landscape 4:3</option><option value="1/1">Square</option><option value="16/9">Wide 16:9</option></select><label class="field" for="crop-zoom">Zoom</label><input class="input crop-range" id="crop-zoom" type="range" min="1" max="3" step="0.01" value="1"><div class="actions crop-actions"><button type="button" class="btn subtle" data-crop-cancel>Cancel</button><button type="button" class="btn primary" data-crop-save>Use this crop</button></div></div>`;
  app.append(modal);
  const stage = modal.querySelector('.crop-stage'), image = modal.querySelector('.crop-image');
  const zoom = modal.querySelector('#crop-zoom');
  let positionX = 0, positionY = 0, pointerX = 0, pointerY = 0, dragging = false;
  const updatePreview = () => {
    if (!image.naturalWidth || !stage.clientWidth) return;
    const width = stage.clientWidth, height = stage.clientHeight;
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * Number(zoom.value);
    const imageWidth = image.naturalWidth * scale, imageHeight = image.naturalHeight * scale;
    image.style.width = `${imageWidth}px`; image.style.height = `${imageHeight}px`;
    image.style.left = `${(width - imageWidth) * (positionX + 1) / 2}px`;
    image.style.top = `${(height - imageHeight) * (positionY + 1) / 2}px`;
  };
  const cropButton = modal.querySelector('[data-crop-save]'); cropButton.disabled = true;
  image.onload = () => { cropButton.disabled = false; updatePreview(); }; image.src = source;
  zoom.addEventListener('input', updatePreview);
  stage.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragging = true; pointerX = event.clientX; pointerY = event.clientY;
    stage.classList.add('dragging'); stage.setPointerCapture(event.pointerId); event.preventDefault();
  });
  stage.addEventListener('pointermove', event => {
    if (!dragging) return;
    const bounds = stage.getBoundingClientRect(), picture = image.getBoundingClientRect();
    if (picture.width > bounds.width) positionX = Math.max(-1, Math.min(1, positionX + (event.clientX - pointerX) * 2 / (bounds.width - picture.width)));
    if (picture.height > bounds.height) positionY = Math.max(-1, Math.min(1, positionY + (event.clientY - pointerY) * 2 / (bounds.height - picture.height)));
    pointerX = event.clientX; pointerY = event.clientY; updatePreview();
  });
  const stopDragging = () => { dragging = false; stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', stopDragging); stage.addEventListener('pointercancel', stopDragging); stage.addEventListener('lostpointercapture', stopDragging);
  modal.querySelector('#crop-ratio').onchange = event => { stage.style.aspectRatio = event.target.value; requestAnimationFrame(updatePreview); };
  window.addEventListener('resize', updatePreview);
  const close = () => { window.removeEventListener('resize', updatePreview); modal.remove(); };
  modal.querySelector('[data-crop-cancel]').onclick = close;
  modal.querySelector('[data-crop-save]').onclick = async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      const bounds = stage.getBoundingClientRect(), scale = image.getBoundingClientRect().width / image.naturalWidth;
      const imageBounds = image.getBoundingClientRect();
      const sx = Math.max(0, (bounds.left - imageBounds.left) / scale), sy = Math.max(0, (bounds.top - imageBounds.top) / scale);
      const sw = Math.min(image.naturalWidth - sx, bounds.width / scale), sh = Math.min(image.naturalHeight - sy, bounds.height / scale);
      const factor = Math.min(1, Math.sqrt(30000000 / (sw * sh)));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(sw * factor)); canvas.height = Math.max(1, Math.round(sh * factor));
      canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (!blob) throw new Error('Could not create the cropped picture.');
      close(); await uploadPicture(new File([blob], 'cropped-picture.jpg', {type:'image/jpeg'}), target);
    } catch (error) { button.disabled = false; toast(error.message); }
  };
}
function editorQuestion(q, i) {
  const type = q.type || 'quiz';
  let answers;
  if (type === 'map-pin') {
    answers = `<p>Choose the correct location. Click or tap to place the pin, or use arrow keys to pan and Enter to pin the map centre.</p><div class="quiz-map" data-editor-map="${i}" aria-label="Correct location map"></div><p class="small" data-map-status role="status"></p>${locationFields(q.target)}<label class="field">Distance for zero points (km)<input class="input" data-map-distance type="number" min="1" max="20000" step="any" required value="${escapeHTML(q.maxDistanceKm || 2000)}"></label><p class="small">Up to 1,000 points for accuracy. Points decrease evenly to zero at this distance. No speed bonus.</p>`;
  } else if (type === 'type-answer') {
    answers = `<label class="field" for="accepted-${i}">Accepted answers (one per line)</label><textarea class="input" id="accepted-${i}" data-accepted rows="3" required placeholder="Stockholm\nStockholm city">${escapeHTML((q.acceptedAnswers || ['']).join('\n'))}</textarea><p class="small">Up to 10 accepted spellings. Capitalization and extra spaces are ignored.</p>`;
  } else {
    answers = `<div class="answer-inputs">${q.answers.map((answer, j) => `<div class="answer-edit">${type !== 'poll' ? `<input type="radio" name="correct-${i}" value="${j}" ${q.correctIndex === j ? 'checked' : ''} aria-label="Mark answer ${j + 1} correct">` : ''}<span aria-hidden="true">${type === 'true-false' ? ['✓','✕'][j] : symbols[j]}</span><input class="input" data-answer required maxlength="200" placeholder="Answer ${j + 1}" aria-label="Question ${i + 1}, answer ${j + 1}" value="${escapeHTML(answer)}" ${type === 'true-false' ? 'readonly' : ''}></div>`).join('')}</div><p class="small">${type === 'poll' ? 'Everyone gets a vote. No correct answer and no points.' : 'Select the circle beside the correct answer.'}</p>`;
  }
  return `<article class="card question-editor">
    <div class="question-heading"><h2>Question ${i + 1}</h2><button class="btn subtle" type="button" data-remove="${i}" ${draft.questions.length === 1 ? 'disabled' : ''} aria-label="Remove question ${i + 1}">Remove</button></div>
    <label class="field" for="type-${i}">Question type</label><select class="input type-select" id="type-${i}" data-type="${i}">${Object.entries(questionTypes).map(([value, label]) => `<option value="${value}" ${value === type ? 'selected' : ''}>${label}</option>`).join('')}</select>
    <label class="field" for="question-${i}">Question heading</label><textarea class="input" id="question-${i}" data-question maxlength="500" required rows="2" placeholder="Type your question…">${escapeHTML(q.question)}</textarea>
    <div class="image-editor">${q.image ? `<img class="editor-image" src="${escapeHTML(q.image)}" alt="${escapeHTML(q.imageAlt || 'Question image')}"><button class="btn subtle" type="button" data-remove-image="${i}">Remove picture</button>` : `<img class="default-image" src="${defaultPicture(q)}" alt="Colourful quiz illustration"><p class="small">Standard quiz picture · add your own to replace it.</p>`}<label class="field" for="image-${i}">${q.image ? 'Replace picture' : 'Upload picture'}</label><input class="input" id="image-${i}" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-image="${i}"><p class="small">PNG, JPEG, WebP or GIF · up to 50 MB.</p>${pictureUrlControls(`question-${i}`)}${q.image ? `<label class="field" for="alt-${i}">Picture description</label><input class="input" id="alt-${i}" data-image-alt maxlength="200" placeholder="Describe the picture for players using a screen reader" value="${escapeHTML(q.imageAlt)}">` : ''}<label class="reveal-picture-toggle"><input type="checkbox" data-reveal-image ${q.showRevealImage ? 'checked' : ''}> Show an extra picture after answers are revealed</label>${q.showRevealImage ? `<div class="reveal-picture-settings">${q.revealImage ? `<img class="editor-image" src="${escapeHTML(q.revealImage)}" alt="${escapeHTML(q.revealImageAlt || 'Answer explanation picture')}"><button class="btn subtle" type="button" data-remove-reveal-image="${i}">Remove extra picture</button>` : '<p class="small">Add an explanation picture below.</p>'}<label class="field" for="reveal-image-${i}">${q.revealImage ? 'Replace picture' : 'Upload picture'}</label><input class="input" id="reveal-image-${i}" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-image="reveal-${i}"><p class="small">PNG, JPEG, WebP or GIF · up to 50 MB.</p>${pictureUrlControls(`reveal-${i}`)}${q.revealImage ? `<label class="field" for="reveal-alt-${i}">Picture description</label><input class="input" id="reveal-alt-${i}" data-reveal-image-alt maxlength="200" placeholder="Describe how this picture explains the answer" value="${escapeHTML(q.revealImageAlt || '')}">` : ''}</div>` : ''}</div>
    ${answers}<div class="form-row"><label class="field" for="time-${i}" style="margin:0">Answer time</label><select class="input" id="time-${i}" data-time>${[...new Set([5,10,20,30,60,90,120,q.timeLimit])].sort((a,b) => a-b).map(t => `<option value="${t}" ${q.timeLimit === t ? 'selected' : ''}>${t} sec</option>`).join('')}</select><span class="small">Starts when the host opens answers.</span></div>
  </article>`;
}
async function refreshQuizGames(quizId, version) {
  const section = document.querySelector('#quiz-games');
  if (!section) return;
  try {
    const games = (await api('/rooms')).filter(game => game.quizId === quizId);
    if (version !== routeVersion || !section.isConnected) return;
    const cards = games.length ? games.map(game => `<article class="card game-admin-card"><div class="game-admin-heading"><div><span class="badge">${game.status==='finished'?(game.scoreboardDeleted?'SCOREBOARD REMOVED':'FINISHED'):game.status==='lobby'?'WAITING FOR PLAYERS':'LIVE GAME'}</span><h3>${escapeHTML(game.quizTitle)}</h3><p class="small">PIN ${escapeHTML(game.pin)} · ${game.playerCount} ${game.playerCount===1?'player':'players'} · ${escapeHTML(game.status)}</p></div><button class="btn subtle" data-open-quiz-game="${escapeHTML(game.pin)}">Open game</button></div>${game.scoreboardAvailable?`<div class="admin-scoreboard"><h4>Final scoreboard</h4>${game.leaderboard.map(player=>`<div class="admin-score-row"><span>${player.rank}.</span><span>${escapeHTML(player.emoji||'😀')} ${escapeHTML(player.nickname)}</span><span>${player.correctAnswers} correct</span><b>${player.score.toLocaleString()} pts</b></div>`).join('')}</div>`:''}<div class="actions admin-game-actions">${game.status!=='finished'?`<button class="btn danger" data-stop-quiz-game="${escapeHTML(game.pin)}">Stop quiz</button>`:''}${game.scoreboardAvailable?`<button class="btn subtle" data-remove-quiz-scoreboard="${escapeHTML(game.pin)}">Remove scoreboard</button>`:''}</div></article>`).join('') : '<p class="small">There are no active games or scoreboards for this quiz.</p>';
    section.querySelector('.game-admin-grid')?.remove();
    section.querySelector('.games-empty')?.remove();
    section.insertAdjacentHTML('beforeend', `<div class="game-admin-grid">${cards}</div>`);
    section.querySelector('#refresh-quiz-games').onclick = () => refreshQuizGames(quizId, version);
    section.querySelectorAll('[data-open-quiz-game]').forEach(button => button.onclick = () => { const game=games.find(item=>item.pin===button.dataset.openQuizGame); saveSession({pin:game.pin,token:game.hostToken,role:'host'}); });
    section.querySelectorAll('[data-stop-quiz-game]').forEach(button => button.onclick = () => run(button,async()=>{ if(!confirm('Stop this quiz now? Players will see the finished game.'))return; await api(`/rooms/${button.dataset.stopQuizGame}/end`,{method:'POST',token:games.find(item=>item.pin===button.dataset.stopQuizGame).hostToken}); await refreshQuizGames(quizId,version); }));
    section.querySelectorAll('[data-remove-quiz-scoreboard]').forEach(button => button.onclick = () => run(button,async()=>{ if(!confirm('Remove this scoreboard and clear the players’ points? This cannot be undone.'))return; await api(`/rooms/${button.dataset.removeQuizScoreboard}/clear-scoreboard`,{method:'POST',token:games.find(item=>item.pin===button.dataset.removeQuizScoreboard).hostToken}); await refreshQuizGames(quizId,version); }));
  } catch (error) { if (version === routeVersion && section.isConnected) { const message=section.querySelector('.games-empty') || document.createElement('p'); message.className='small games-empty'; message.textContent=error.message; if(!message.isConnected)section.append(message); } }
}
function editor() {
  clearQuizMaps();
  app.innerHTML = `<section class="shell editor"><div class="topline"><div><p class="eyebrow">Make it your own</p><h1>${draft.id ? 'Edit your quiz' : 'A great game starts here.'}</h1><p>Mix question types, add pictures, and set the pace.</p></div><a class="btn ghost" href="/host#host">Back to library</a></div>${draft.id ? '<section class="games-admin editor-games" id="quiz-games"><div class="games-admin-title"><h2>Games and scoreboards for this quiz</h2><button class="btn ghost" id="refresh-quiz-games">Refresh</button></div><p class="small games-empty">Loading games…</p></section>' : ''}<form id="editor-form"><label class="field" for="quiz-title">Quiz title</label><input class="input editor-title" id="quiz-title" placeholder="Give your quiz a name" maxlength="120" required value="${escapeHTML(draft.title)}"><label class="field" for="quiz-creator">Creator name <span class="small">(optional)</span></label><input class="input" id="quiz-creator" placeholder="Who created this quiz?" maxlength="80" value="${escapeHTML(draft.creator || '')}"><section class="card image-editor quiz-cover-editor"><h2 class="question-heading">Quiz cover picture</h2>${draft.coverImage ? `<img class="editor-cover" src="${escapeHTML(draft.coverImage)}" alt="${escapeHTML(draft.coverImageAlt || 'Quiz cover picture')}"><button class="btn subtle" type="button" data-remove-cover>Remove cover picture</button>` : `<img class="default-image" src="/images/quiz.svg" alt="Colourful quiz-themed cover"><p class="small">Standard quiz artwork is used on the library card until you add a cover.</p>`}<label class="field" for="cover-image">${draft.coverImage ? 'Replace cover picture' : 'Upload cover picture'}</label><input class="input" id="cover-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-cover-image><p class="small">PNG, JPEG, WebP or GIF · up to 50 MB.</p>${pictureUrlControls('cover')}${draft.coverImage ? `<label class="field" for="cover-alt">Picture description</label><input class="input" id="cover-alt" data-cover-alt maxlength="200" placeholder="Describe the cover picture" value="${escapeHTML(draft.coverImageAlt || '')}">` : ''}</section>${draft.questions.map(editorQuestion).join('')}<div class="savebar"><button class="btn ghost" id="add-question" type="button" ${draft.questions.length >= 50 ? 'disabled' : ''}>＋ Add question</button><span class="small" id="save-status" role="status" aria-live="polite">${draftIsComplete(draft) ? 'Changes will save automatically' : 'Your work is saved on this device as you type'}</span><button class="btn light" type="submit">Save quiz ✓</button></div></form></section>`;
  app.querySelectorAll('[data-editor-map]').forEach(element => {
    const i = Number(element.dataset.editorMap), container = element.closest('.question-editor');
    const widget = mountQuizMap(element, {key:`editor:${draft.id || 'new'}:${i}`, point:draft.questions[i].target, onSelect:point => { setLocationFields(container, point); scheduleDraftSave(); }});
    wireLocationFields(container, widget);
  });
  if (draft.id) refreshQuizGames(draft.id, routeVersion);
  const form = document.querySelector('#editor-form');
  form.addEventListener('input', scheduleDraftSave);
  form.addEventListener('change', scheduleDraftSave);
  document.querySelector('#add-question').onclick = () => { readDraft(); draft.questions.push(newQuestion()); editor(); scheduleDraftSave(); app.querySelectorAll('.question-editor')[draft.questions.length - 1].scrollIntoView({block:'center',behavior:'smooth'}); };
  app.querySelectorAll('[data-remove]').forEach(button => button.onclick = () => { readDraft(); draft.questions.splice(Number(button.dataset.remove), 1); editor(); scheduleDraftSave(); });
  app.querySelectorAll('[data-type]').forEach(select => select.onchange = () => {
    readDraft(); const q = draft.questions[Number(select.dataset.type)];
    if (q.type === 'true-false') { q.answers = ['True','False']; q.correctIndex = Math.min(q.correctIndex, 1); }
    else if (q.type !== 'type-answer' && q.answers.length < 2) q.answers = ['','','',''];
    if (q.type === 'type-answer' && !q.acceptedAnswers?.length) q.acceptedAnswers = [''];
    editor(); scheduleDraftSave();
  });
  app.querySelectorAll('[data-remove-image]').forEach(button => button.onclick = () => { readDraft(); draft.questions[Number(button.dataset.removeImage)].image = ''; editor(); scheduleDraftSave(); });
  app.querySelectorAll('[data-reveal-image]').forEach(input => input.onchange = () => { readDraft(); editor(); scheduleDraftSave(); });
  app.querySelectorAll('[data-remove-reveal-image]').forEach(button => button.onclick = () => { readDraft(); draft.questions[Number(button.dataset.removeRevealImage)].revealImage = ''; editor(); scheduleDraftSave(); });
  app.querySelector('[data-remove-cover]')?.addEventListener('click', () => { readDraft(); draft.coverImage = ''; draft.coverImageAlt = ''; editor(); scheduleDraftSave(); });
  let uploading = false;
  const uploadPicture = async (file, target) => {
    if (!file) return;
    if (uploading) return; uploading = true;
    const version = routeVersion; readDraft();
    app.querySelectorAll('#editor-form input, #editor-form textarea, #editor-form select, #editor-form button').forEach(el => el.disabled = true);
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('Choose an image no larger than 50 MB.');
      const bitmap = await createImageBitmap(file); const pixels = bitmap.width * bitmap.height; bitmap.close();
      if (pixels > 30000000) throw new Error('Choose an image smaller than 30 megapixels.');
      const response = await fetch('/api/images', {method:'POST', headers:{'X-Quiz-Owner':ownerToken, 'Content-Type':file.type || 'application/octet-stream'}, body:file});
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      if (version === routeVersion) {
        if (target === 'cover') draft.coverImage = result.image;
        else if (typeof target === 'string' && target.startsWith('reveal-')) draft.questions[Number(target.slice('reveal-'.length))].revealImage = result.image;
        else draft.questions[target].image = result.image;
      }
    } catch (error) { toast(error.message || 'This picture could not be read. Try a PNG or JPEG.'); }
    finally { uploading = false; if (version === routeVersion) { editor(); scheduleDraftSave(); } }
  };
  app.querySelectorAll('[data-image]').forEach(input => input.onchange = () => uploadPicture(input.files[0], input.dataset.image.startsWith('reveal-') ? input.dataset.image : Number(input.dataset.image)));
  app.querySelector('[data-cover-image]').onchange = event => uploadPicture(event.target.files[0], 'cover');
  app.querySelectorAll('[data-load-picture]').forEach(button => button.onclick = () => run(button, async () => {
    const version = routeVersion, target = button.dataset.loadPicture;
    readDraft(); cacheDraft();
    const url = app.querySelector(`[data-picture-url="${target}"]`).value.trim();
    if (!url) throw new Error('Paste an image URL first.');
    const result = await api('/images/from-url', {method:'POST', body:{url}});
    if (version === routeVersion) openCropper(result.image, target === 'cover' ? 'cover' : target.startsWith('reveal-') ? target : Number(target.slice('question-'.length)), uploadPicture);
  }));
  document.querySelector('#editor-form').onsubmit = event => { event.preventDefault(); run(event.submitter, async () => {
    clearTimeout(autosaveTimer);
    if (autosaveTask) await autosaveTask;
    readDraft(); const version = routeVersion;
    await api(draft.id ? `/quizzes/${draft.id}` : '/quizzes', {method:draft.id ? 'PUT' : 'POST', body:draft});
    if (version !== routeVersion) return;
    try { localStorage.removeItem(draftKey(draft)); } catch {}
    draft = null; location.href = '/host#host';
  }); };
}
function saveSession(value) { session = value; sessionStorage.setItem(`fredagsquizet-${value.role}-${value.pin}`,JSON.stringify(value)); location.hash=`room/${value.role}/${value.pin}`; }
function applyRoomState(latest, version) {
  if (version !== routeVersion) return false;
  if (roomState && latest.pin === roomState.pin && latest.revision <= roomState.revision) return false;
  roomState = latest;
  renderRoom();
  return true;
}
async function connectRoom(role, pin, version) {
  const stored = sessionStorage.getItem(`fredagsquizet-${role}-${pin}`);
  if (!stored) { location.href = role==='host'?'/host#host':`/#join/${pin}`; return; }
  session = JSON.parse(stored);
  const token = session.token;
  playerAnswerOnly = role === 'player' && sessionStorage.getItem(`fredagsquizet-answer-view-${pin}`) === 'answers-only';
  const initial = await api(`/rooms/${pin}/state`,{token});
  if (!applyRoomState(initial, version)) return;
  let fetching = false, refreshPending = false, controller;
  const pollState = async () => {
    if (version !== routeVersion) return;
    if (fetching) { refreshPending = true; return; }
    fetching = true;
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const latest = await api(`/rooms/${pin}/state`,{token, signal:controller.signal});
      if (version !== routeVersion) return;
      applyRoomState(latest, version);
      const el = document.querySelector('.connection'); if (el) el.textContent = '● Connected';
    } catch {
      if (version === routeVersion) { const el = document.querySelector('.connection'); if (el) el.textContent = 'Reconnecting…'; }
    } finally {
      clearTimeout(timeout);
      fetching = false;
      if (refreshPending && version === routeVersion) { refreshPending = false; void pollState(); }
    }
  };
  // Corporate proxies may buffer SSE and replay old questions and heartbeats.
  // Treat events only as refresh hints; always read the current server snapshot.
  stream = new EventSource(`/api/rooms/${pin}/events?token=${encodeURIComponent(token)}`);
  stream.addEventListener('state',pollState);
  stream.onopen = pollState;
  stream.onerror = pollState;
  // Keep polling even when a buffered stream appears healthy.
  statePoll = setInterval(pollState,1500);
  const resume = () => { if (!document.hidden) void pollState(); };
  window.addEventListener('focus',resume);
  window.addEventListener('online',resume);
  document.addEventListener('visibilitychange',resume);
  roomSyncCleanup = () => {
    controller?.abort();
    window.removeEventListener('focus',resume);
    window.removeEventListener('online',resume);
    document.removeEventListener('visibilitychange',resume);
  };
  timer = setInterval(updateTimer,250);
}

function leaderboard(players, {full=false, showCorrect=false}={}) {
  const rows = full ? players : players.slice(0,10);
  return `<div class="ranking${showCorrect?' final-ranking':''}">${rows.map((p,i)=>`<div class="rank-row"><span class="position">${p.rank || i+1}</span><span class="player-emoji" aria-hidden="true">${escapeHTML(p.emoji || '😀')}</span><strong>${escapeHTML(p.nickname)}${p.id===roomState.self?.id?' (you)':''}</strong>${showCorrect?`<span class="correct-count">${p.correctAnswers} correct</span>`:''}<span class="score">${p.score.toLocaleString()} <small>pts</small></span></div>`).join('')}</div>`;
}
function updateScoreboardReveal() {
  const target = document.querySelector('#scoreboard-reveal');
  if(!target || !roomState?.scoreboardVisible || !Number.isFinite(roomState.scoreboardShownAt))return;
  const elapsed = Math.max(0,Date.now()-roomState.scoreboardShownAt), step = 2200;
  const stage = elapsed < step*3 ? Math.floor(elapsed/step) : 3;
  const key = `${roomState.scoreboardShownAt}:${stage}`;
  if(target.dataset.stageKey===key)return;
  target.dataset.stageKey=key;
  if(stage===3) {
    target.innerHTML=leaderboard(roomState.leaderboard,{full:true,showCorrect:true});
    return;
  }
  const place = 3-stage, player = roomState.leaderboard[place-1];
  target.innerHTML=`<div class="podium-reveal place-${place}">${place===1?'<div class="fireworks" aria-hidden="true"><i></i><i></i><i></i></div>':''}<p class="place-label">${place}${place===1?'st':place===2?'nd':'rd'} place</p>${player?`<div class="podium-player"><span aria-hidden="true">${escapeHTML(player.emoji||'😀')}</span><h2>${escapeHTML(player.nickname)}</h2><p>${player.correctAnswers} correct answers · ${player.score.toLocaleString()} points</p></div>`:'<h2>No player in this place</h2>'}</div>`;
}
function questionContent(s) {
  const q = s.question, host = s.host, preview = s.status === 'preview', reveal = s.status === 'reveal';
  const answerOnly = !host && playerAnswerOnly && s.status === 'question';
  const mapPin = q.type === 'map-pin';
  const typed = q.type === 'type-answer', poll = q.type === 'poll';
  const image = `<figure class="question-picture"><img src="${escapeHTML(q.image || defaultPicture(q))}" alt="${escapeHTML(q.image ? q.imageAlt || 'Question picture' : 'Colourful quiz illustration')}"></figure>`;
  const revealImage = reveal && q.revealImage ? `<figure class="question-picture explanation-picture"><figcaption>More context</figcaption><img src="${escapeHTML(q.revealImage)}" alt="${escapeHTML(q.revealImageAlt || 'Answer explanation picture')}"></figure>` : '';
  const heading = `<p class="eyebrow">${escapeHTML(questionTypes[q.type] || questionTypes.quiz)} · Question ${s.questionIndex + 1} of ${s.questionCount}</p><h1>${escapeHTML(q.question)}</h1>${image}`;
  if (preview) return `${heading}<div class="preview-note"><span class="badge">TAKE A LOOK</span>${s.previewEndsAt ? '<div class="preview-countdown"><span>Answers in</span><strong id="preview-countdown">5</strong></div>' : '<p>Read the question and study the picture. Answers will open when the host is ready.</p>'}</div>${host && !s.previewEndsAt ? '<button class="btn light" data-action="open">Open answers →</button>' : ''}`;
  let controls;
  if (mapPin) {
    const editable = !host && !reveal && !s.self.answered;
    const pendingKey = `${s.pin}:${s.questionIndex}`;
    const hasPin = !!s.self.answerLocation || pendingPins.has(pendingKey);
    controls = `<div class="map-answer"><p class="visually-hidden">${reveal ? 'Correct location and your pin.' : editable ? 'Tap the map to place your pin. Pan and zoom to refine it, then lock it in.' : host ? 'Players are placing their pins.' : 'Pin locked in. Waiting for the reveal.'}</p><div id="answer-map" class="quiz-map" aria-label="Answer map"></div><p class="map-status" data-map-status role="status"></p>${editable ? `<form id="map-answer-form" class="map-answer-controls">${locationFields(s.self.answerLocation)}<button class="btn primary map-coordinate-toggle" type="button" aria-expanded="false">Enter coordinates</button><button class="btn primary map-lock-button" type="submit" ${hasPin ? '' : 'disabled'}>Lock in pin →</button></form>` : ''}</div>`;
  } else if (typed) {
    controls = reveal ? `<div class="feedback">Accepted answers: ${q.acceptedAnswers.map(escapeHTML).join(' · ')}</div>` : host ? '<p class="waiting-answer">Players are typing their answers…</p>' : s.self.answered ? '<p class="waiting-answer">Answer locked in. Fingers crossed!</p>' : `<form id="typed-answer-form" class="card typed-answer"><label class="field" for="typed-answer">Your answer</label><input class="input" id="typed-answer" data-question-index="${s.questionIndex}" maxlength="200" required autocomplete="off" placeholder="Type your answer…"><button class="btn primary wide" type="submit">Lock in answer →</button></form>`;
  } else {
    controls = `<div class="answers ${q.type === 'true-false' ? 'true-false' : ''}">${q.answers.map((answer, i) => `<button class="answer ${reveal && !poll ? (i === q.correctIndex ? 'correct' : 'dim') : ''} ${s.self?.answerIndex === i ? 'selected' : ''}" data-answer-index="${i}" ${host || reveal || s.self?.answered ? 'disabled' : ''}><span class="symbol" aria-hidden="true">${q.type === 'true-false' ? ['✓','✕'][i] : symbols[i]}</span><span>${escapeHTML(answer)}${reveal && !poll && i === q.correctIndex ? ' ✓' : ''}${reveal ? ` <small>(${s.answerCounts?.[i] ?? 0}${poll ? ' votes' : ''})</small>` : ''}</span></button>`).join('')}</div>${!host && !reveal && s.self.answered ? `<p class="waiting-answer">${poll ? 'Vote recorded. Waiting for everyone…' : 'Answer locked in. Fingers crossed!'}</p>` : ''}`;
  }
  const feedback = !host && reveal ? `<div class="feedback">${mapPin ? (s.self.answered ? `${s.self.distanceKm.toLocaleString(undefined,{maximumFractionDigits:2})} km away · +${s.self.points} points` : 'No pin submitted. 0 points.') : poll ? (s.self.answered ? 'Thanks for voting! No points in this round.' : 'Voting closed. No points in this round.') : s.self.correct ? `Correct! +${s.self.points} points` : s.self.answered ? 'Not this time. You’ve got the next one!' : 'Time’s up!'}</div>` : '';
  const showHeading = !answerOnly;
  const meta = answerOnly ? '' : `<div class="question-meta"><div class="timer" aria-label="Seconds remaining" id="timer">${reveal ? '✓' : q.timeLimit}</div><div class="progress" aria-hidden="true"><div id="time-progress" style="width:${reveal ? 0 : 100}%"></div></div><span class="answer-count">${s.answeredCount} / ${s.players.length} ${poll ? 'voted' : 'answered'}</span></div>`;
  const answerView = !host && s.status === 'question' && q.answers?.length >= 2 ? `<div class="answer-view-control"><button class="btn ghost" data-toggle-answer-view aria-pressed="${answerOnly}">${answerOnly ? 'Show question + answers' : 'Show answers only'}</button></div>` : '';
  return `${showHeading ? heading : ''}${meta}${answerView}${controls}${feedback}${revealImage}${reveal && !poll ? leaderboard(s.leaderboard) : ''}${host ? `<div class="lobby-actions"><button class="btn light" data-action="next">${!reveal ? (poll ? 'Show votes' : 'Reveal answers') : s.questionIndex + 1 === s.questionCount ? 'Show podium 🏆' : 'Next question →'}</button><button class="btn ghost" data-action="end">End game</button></div>` : reveal ? '<p class="muted-white">Waiting for the host…</p>' : ''}`;
}
const pendingPins = new Map();
function renderRoom() {
  clearQuizMaps();
  const oldInput = document.querySelector('#typed-answer');
  const inputDraft = oldInput ? {value:oldInput.value, index:Number(oldInput.dataset.questionIndex), focused:document.activeElement === oldInput, start:oldInput.selectionStart, end:oldInput.selectionEnd} : null;
  const version = routeVersion, token = session.token;
  const s = roomState, host = s.host, q = s.question, isQuestion = s.status==='question', isReveal=s.status==='reveal';
  const url = `${location.origin}/#join/${s.pin}`;
  const bar = `<div class="room-bar"><span><b>PIN ${escapeHTML(s.pin)}</b> · ${escapeHTML(s.quizTitle)}</span><span class="connection">● Connected</span><button class="danger-link" id="leave-room">${host?'Leave host screen':'Leave game'}</button></div>`;
  let content;
  if (s.status==='countdown') {
    content = `<div class="start-countdown"><p class="eyebrow">Get ready to play</p><strong id="start-countdown">10</strong><p>The quiz is about to begin!</p></div>`;
  } else if (s.status==='lobby') {
    content = host ? `<p class="eyebrow">Ready, set, quiz.</p><h1>Everyone in?</h1><p class="join-url">Join at <b>${escapeHTML(location.host)}</b> with game PIN</p><div class="lobby-invite"><div class="pin-display"><small>GAME PIN</small><strong>${s.pin}</strong></div><div class="qr-invite"><img src="/api/rooms/${s.pin}/qr" alt="QR code to join game PIN ${s.pin}" width="240" height="240"><p>Scan to join</p></div></div><div><button class="btn ghost" id="copy-link">Copy invite link ↗</button></div><p class="scoring-note"><b>How points work:</b> A correct answer earns 500 base points plus up to 500 speed points. The speed bonus decreases steadily as time runs out, so an instant answer earns 1,000 and a correct answer at the deadline earns 500. Wrong or missed answers earn 0; polls are unscored. Map pins earn up to 1,000 points for distance alone; closer is better.</p><p class="room-title">${s.players.length} ${s.players.length===1?'player':'players'} in the lobby</p><div class="player-list">${s.players.length?s.players.map(p=>`<span class="player-chip"><span aria-hidden="true">${escapeHTML(p.emoji || '😀')}</span> ${escapeHTML(p.nickname)}</span>`).join(''):'<p class="empty">The stage is set. Just waiting for your people…</p>'}</div><div class="lobby-actions"><button class="btn light" data-action="start" ${s.players.length?'':'disabled'}>Start game →</button></div>` : `<div class="podium-icon" aria-hidden="true">✦</div><p class="eyebrow">You're on the list</p><h1>You're in, ${escapeHTML(s.self.emoji || '😀')} ${escapeHTML(s.self.nickname)}!</h1><p class="subtitle">Get ready. Your host will start the game soon.</p><p class="scoring-note"><b>How points work:</b> A correct answer earns 500 base points plus up to 500 speed points. The speed bonus decreases steadily as time runs out, so an instant answer earns 1,000 and a correct answer at the deadline earns 500. Wrong or missed answers earn 0; polls are unscored. Map pins earn up to 1,000 points for distance alone; closer is better.</p><span class="spinner"></span><p class="muted-white">${s.players.length} ${s.players.length===1?'player':'players'} ready to play</p>`;
  } else if (isQuestion || isReveal || s.status === 'preview') {
    content = questionContent(s);
  } else {
    const board = s.scoreboardDeleted ? '<p class="muted-white">The scoreboard has been cleared.</p>' : s.scoreboardVisible ? '<div id="scoreboard-reveal"></div>' : '<p class="muted-white">The final scoreboard is ready when you are.</p>';
    const scoreboardControls = host && s.hasScoredQuestions && !s.scoreboardDeleted ? `<div class="lobby-actions"><button class="btn light" data-action="show-scoreboard">${s.scoreboardVisible ? 'Hide scoreboard' : 'Show scoreboard'}</button><button class="btn ghost" data-action="clear-scoreboard">Delete scoreboard</button></div>` : '';
    content = `<div class="podium-icon" aria-hidden="true">🏆</div><p class="eyebrow">That's a wrap</p><h1>Thanks for playing!</h1><p class="subtitle">${escapeHTML(s.quizTitle)}${s.self?` · Your score: ${s.self.score.toLocaleString()} points`:''}</p>${s.hasScoredQuestions ? `${board}${scoreboardControls}` : '<p class="muted-white">All votes are in. Thanks for sharing your thoughts.</p>'}<a class="btn light" href="${host?'#host':'#'}">${host?'Host another quiz':'Play again'} →</a>`;
  }
  app.innerHTML = `<section class="room">${bar}${content}</section>`;
  updateScoreboardReveal();
  const typedInput = document.querySelector('#typed-answer');
  if (typedInput && inputDraft?.index === s.questionIndex) {
    typedInput.value = inputDraft.value;
    if (inputDraft.focused) { typedInput.focus(); typedInput.setSelectionRange(inputDraft.start, inputDraft.end); }
  }
  const submitAnswer = async answer => {
    try { await api(`/rooms/${s.pin}/answer`, {method:'POST', token, body:{...answer, questionIndex:s.questionIndex}}); }
    finally { const result = await api(`/rooms/${s.pin}/state`, {token}); if (version === routeVersion) { if (!applyRoomState(result, version)) renderRoom(); } }
  };
  const mapElement = document.querySelector('#answer-map');
  if (mapElement) {
    const key = `${s.pin}:${s.questionIndex}`, form = document.querySelector('#map-answer-form');
    const point = s.self?.answerLocation || (form ? pendingPins.get(key) : undefined);
    if (form && point) setLocationFields(form, point);
    const widget = mountQuizMap(mapElement, {key:`room:${key}:${s.status}`, point, target:isReveal ? q.target : undefined, onSelect:form ? point => { pendingPins.set(key,point); setLocationFields(form,point); form.querySelector('.map-lock-button').disabled=false; } : undefined});
    if (form) {
      const coordinateToggle = form.querySelector('.map-coordinate-toggle');
      const coordinates = form.querySelector('.map-coordinates');
      coordinateToggle.onclick = () => {
        const open = coordinates.classList.toggle('coordinates-open');
        coordinateToggle.setAttribute('aria-expanded',String(open));
      };
      wireLocationFields(form, widget);
      form.addEventListener('submit', event => { event.preventDefault(); const answerLocation = readLocation(form); if (answerLocation) run(event.submitter, () => submitAnswer({answerLocation})); });
    }
  }
  document.querySelector('#typed-answer-form')?.addEventListener('submit', event => {
    event.preventDefault(); const answerText = typedInput.value;
    run(event.submitter, () => submitAnswer({answerText}));
  });
  document.querySelector('#leave-room').onclick=()=>{ if(confirm(host?'Leave this screen? The game stays available; return with your browser Back button.':'Leave this game? You can return with your browser Back button.')) location.href=host?'/host#host':'/'; };
  document.querySelector('#copy-link')?.addEventListener('click', () => run(document.querySelector('#copy-link'),async()=>{
    if(navigator.clipboard?.writeText){ await navigator.clipboard.writeText(url); document.querySelector('#copy-link').textContent='Link copied ✓'; }
    else prompt('Copy this invite link:',url);
  }));
  app.querySelectorAll('[data-action]').forEach(button=>button.onclick=()=>run(button,async()=>{
    if(button.dataset.action==='end'&&!confirm('End the game now and show final scores?'))return;
    if(button.dataset.action==='clear-scoreboard'&&!confirm('Delete the final scoreboard and clear all player scores for this game? This cannot be undone.'))return;
    const result=await api(`/rooms/${s.pin}/${button.dataset.action}`,{method:'POST',token}); applyRoomState(result, version);
  }));
  app.querySelectorAll('[data-toggle-answer-view]').forEach(button=>button.onclick=()=>{
    playerAnswerOnly = !playerAnswerOnly;
    sessionStorage.setItem(`fredagsquizet-answer-view-${s.pin}`, playerAnswerOnly ? 'answers-only' : 'question-and-answers');
    renderRoom();
  });
  app.querySelectorAll('[data-answer-index]').forEach(button=>button.onclick=()=>run(button,async()=>{
    app.querySelectorAll('[data-answer-index]').forEach(b=>b.disabled=true);
    await submitAnswer({answerIndex:Number(button.dataset.answerIndex)});
  }));
  updateTimer();
}
function updateTimer() {
  if(!roomState)return;
  if(roomState.status==='finished') { updateScoreboardReveal(); return; }
  const updateCountdown = (element, deadline) => {
    if(!element)return;
    const next = String(Math.max(1, Math.ceil((deadline-Date.now())/1000)));
    if(element.textContent===next)return;
    element.textContent=next;
    element.classList.remove('countdown-tick');
    void element.offsetWidth;
    element.classList.add('countdown-tick');
  };
  if(roomState.status==='countdown') { updateCountdown(document.querySelector('#start-countdown'),roomState.countdownEndsAt); return; }
  if(roomState.status==='preview'&&roomState.previewEndsAt) updateCountdown(document.querySelector('#preview-countdown'),roomState.previewEndsAt);
  if(roomState.status!=='question')return;
  const remaining=Math.max(0,roomState.question.deadline-Date.now());
  const el=document.querySelector('#timer');if(el)el.textContent=Math.ceil(remaining/1000);
  const progress=document.querySelector('#time-progress');if(progress)progress.style.width=`${remaining/(roomState.question.timeLimit*1000)*100}%`;
}
async function route() {
  clearQuizMaps();
  const version=++routeVersion;stream?.close();stream=null;clearInterval(timer);roomSyncCleanup?.();roomSyncCleanup=null;clearInterval(statePoll);statePoll=null;roomState=null;
  const [page,arg,pin]=location.hash.slice(1).split('/');
  document.body.classList.toggle('playing-game', page === 'room');
  setGithubActive(page !== 'room');
  if ((['host','create','edit'].includes(page) || (page === 'room' && arg === 'host')) && location.pathname !== '/host') { location.replace(`/host${location.hash}`); return; }
  try {
    if(page==='host')await library(version);
    else if(page==='create'){draft=restoreDraft({title:'',creator:'',questions:[newQuestion()]});editor();}
    else if(page==='edit'){
      draft=await api(`/quizzes/${encodeURIComponent(arg)}`);if(version!==routeVersion)return;
      if(draft.id==='sample'||draft.id==='feature-test'){delete draft.id;draft.title+=' (copy)';draft.creator='';}else draft=restoreDraft(draft);editor();
    }else if(page==='room')await connectRoom(arg,pin,version);
    else joinPage(page==='join'&&/^\d{6}$/.test(arg)?arg:'');
  } catch(error){if(version!==routeVersion)return;app.innerHTML=`<section class="join"><div class="card"><h1>Couldn't open that.</h1><p>${escapeHTML(error.message)}</p><a class="btn wide" href="#">Back to join</a><a class="btn subtle wide" href="/host#host">Quiz library</a></div></section>`;}
}
window.addEventListener('hashchange',route);
route();
