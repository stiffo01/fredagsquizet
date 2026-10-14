'use strict';
const app = document.querySelector('#app');
const symbols = ['▲', '◆', '●', '■'];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// getRandomValues works on LAN HTTP as well as HTTPS; randomUUID requires a secure context.
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), b => b.toString(16).padStart(2, '0')).join('');
let ownerToken = localStorage.getItem('quizpop-owner');
if (!ownerToken) { ownerToken = randomToken(); localStorage.setItem('quizpop-owner', ownerToken); }
let stream, roomState, session, timer, autosaveTimer, autosaveTask, autosavePending = false, quizzes = [], draft, routeVersion = 0;
const questionTypes = {'quiz':'Multiple choice', 'true-false':'True or false', 'type-answer':'Type an answer', 'poll':'Poll'};
const playerEmojis = ['😀', '😎', '🤓', '🥳', '🐸', '🦊', '🐼', '🐙', '🦄', '🐧', '🐢', '🦖', '🍕', '🚀', '⭐', '👾'];
const newQuestion = () => ({type:'quiz', question:'', image:'', imageAlt:'', answers:['','','',''], correctIndex:0, timeLimit:20});
function toast(message) { const el = document.querySelector('#toast'); el.textContent = message; el.hidden = false; clearTimeout(toast.timeout); toast.timeout = setTimeout(() => el.hidden = true, 6000); }
async function api(path, {method='GET', body, token=ownerToken} = {}) {
  const authHeaders = token === ownerToken ? {'X-Quiz-Owner':token}
    : session?.role === 'host' && token === session.token ? {'X-Quiz-Host-Token':token}
    : token ? {Authorization:`Bearer ${token}`} : {};
  const response = await fetch(`/api${path}`, {method, headers:{'Content-Type':'application/json', ...authHeaders}, ...(body ? {body:JSON.stringify(body)} : {})});
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
  quizzes = await api('/quizzes'); if (version !== routeVersion) return;
  app.innerHTML = `<section class="shell"><div class="topline"><div><p class="eyebrow">The host's corner</p><h1>Your next great game.</h1><p>Pick a quiz, share the PIN, and bring the room to life.</p></div><a class="btn light" href="#create">＋ Create quiz</a></div><div class="quiz-grid">${quizzes.map((q,i) => `<article class="card quiz-card"><div class="quiz-art">${q.coverImage ? `<img class="quiz-cover-thumb" src="${escapeHTML(q.coverImage)}" alt="${escapeHTML(q.coverImageAlt || `${q.title} cover`)}">` : `<span aria-hidden="true">${['✦','◎','✷'][i%3]}</span>`}</div><div class="quiz-body"><div><span class="badge">${q.id==='feature-test'?'FEATURE TEST':q.id==='sample'?'READY TO PLAY':'YOUR CREATION'}</span></div><h2 style="margin-top:14px">${escapeHTML(q.title)}</h2>${q.id==='feature-test'?'<p class="small">Try previews, pictures, question types, polls, and scoring with your group.</p>':''}<span class="small">${q.questions.length} questions · ${Math.ceil(q.questions.reduce((n,q)=>n+q.timeLimit,0)/60)} min of play</span><div class="actions"><button class="btn primary" data-host="${escapeHTML(q.id)}">${q.id==='feature-test'?'Host test →':'Host live →'}</button><button class="btn subtle" data-edit="${escapeHTML(q.id)}">${q.id==='sample'||q.id==='feature-test'?'Copy':'Edit'}</button>${q.id==='feature-test'?'':`<button class="btn subtle" data-delete="${escapeHTML(q.id)}" aria-label="Remove ${escapeHTML(q.title)}">×</button>`}</div></div></article>`).join('')}</div><p class="small muted-white" style="margin-top:28px">Your quizzes are saved on this server. Use this browser to manage them.</p></section>`;
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
  draft.coverImageAlt = document.querySelector('[data-cover-alt]')?.value || '';
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
const draftKey = value => `quizpop-draft-${value.id || 'new'}`;
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
          try { localStorage.removeItem('quizpop-draft-new'); } catch {}
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
  modal.innerHTML = `<div class="crop-card"><h2>Crop your picture</h2><p class="small">Drag the sliders to frame the part you want to keep.</p><div class="crop-stage"><img class="crop-image" alt="Picture crop preview"></div><label class="field" for="crop-ratio">Shape</label><select class="input" id="crop-ratio"><option value="4/3">Landscape 4:3</option><option value="1/1">Square</option><option value="16/9">Wide 16:9</option></select><label class="field" for="crop-zoom">Zoom</label><input class="input crop-range" id="crop-zoom" type="range" min="1" max="3" step="0.01" value="1"><div class="crop-range-row"><label class="field" for="crop-x">Left / right</label><input class="input crop-range" id="crop-x" type="range" min="-1" max="1" step="0.01" value="0"></div><div class="crop-range-row"><label class="field" for="crop-y">Up / down</label><input class="input crop-range" id="crop-y" type="range" min="-1" max="1" step="0.01" value="0"></div><div class="actions crop-actions"><button type="button" class="btn subtle" data-crop-cancel>Cancel</button><button type="button" class="btn primary" data-crop-save>Use this crop</button></div></div>`;
  app.append(modal);
  const stage = modal.querySelector('.crop-stage'), image = modal.querySelector('.crop-image');
  const zoom = modal.querySelector('#crop-zoom'), horizontal = modal.querySelector('#crop-x'), vertical = modal.querySelector('#crop-y');
  const updatePreview = () => {
    if (!image.naturalWidth || !stage.clientWidth) return;
    const width = stage.clientWidth, height = stage.clientHeight;
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * Number(zoom.value);
    const imageWidth = image.naturalWidth * scale, imageHeight = image.naturalHeight * scale;
    image.style.width = `${imageWidth}px`; image.style.height = `${imageHeight}px`;
    image.style.left = `${(width - imageWidth) * (Number(horizontal.value) + 1) / 2}px`;
    image.style.top = `${(height - imageHeight) * (Number(vertical.value) + 1) / 2}px`;
  };
  const cropButton = modal.querySelector('[data-crop-save]'); cropButton.disabled = true;
  image.onload = () => { cropButton.disabled = false; updatePreview(); }; image.src = source;
  for (const input of [zoom, horizontal, vertical]) input.addEventListener('input', updatePreview);
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
  if (type === 'type-answer') {
    answers = `<label class="field" for="accepted-${i}">Accepted answers (one per line)</label><textarea class="input" id="accepted-${i}" data-accepted rows="3" required placeholder="Stockholm\nStockholm city">${escapeHTML((q.acceptedAnswers || ['']).join('\n'))}</textarea><p class="small">Up to 10 accepted spellings. Capitalization and extra spaces are ignored.</p>`;
  } else {
    answers = `<div class="answer-inputs">${q.answers.map((answer, j) => `<div class="answer-edit">${type !== 'poll' ? `<input type="radio" name="correct-${i}" value="${j}" ${q.correctIndex === j ? 'checked' : ''} aria-label="Mark answer ${j + 1} correct">` : ''}<span aria-hidden="true">${type === 'true-false' ? ['✓','✕'][j] : symbols[j]}</span><input class="input" data-answer required maxlength="200" placeholder="Answer ${j + 1}" aria-label="Question ${i + 1}, answer ${j + 1}" value="${escapeHTML(answer)}" ${type === 'true-false' ? 'readonly' : ''}></div>`).join('')}</div><p class="small">${type === 'poll' ? 'Everyone gets a vote. No correct answer and no points.' : 'Select the circle beside the correct answer.'}</p>`;
  }
  return `<article class="card question-editor">
    <div class="question-heading"><h2>Question ${i + 1}</h2><button class="btn subtle" type="button" data-remove="${i}" ${draft.questions.length === 1 ? 'disabled' : ''} aria-label="Remove question ${i + 1}">Remove</button></div>
    <label class="field" for="type-${i}">Question type</label><select class="input type-select" id="type-${i}" data-type="${i}">${Object.entries(questionTypes).map(([value, label]) => `<option value="${value}" ${value === type ? 'selected' : ''}>${label}</option>`).join('')}</select>
    <label class="field" for="question-${i}">Question heading</label><textarea class="input" id="question-${i}" data-question maxlength="500" required rows="2" placeholder="Type your question…">${escapeHTML(q.question)}</textarea>
    <div class="image-editor">${q.image ? `<img class="editor-image" src="${escapeHTML(q.image)}" alt="${escapeHTML(q.imageAlt || 'Question image')}"><button class="btn subtle" type="button" data-remove-image="${i}">Remove picture</button>` : `<img class="default-image" src="${defaultPicture(q)}" alt="Colourful quiz illustration"><p class="small">Standard quiz picture · add your own to replace it.</p>`}<label class="field" for="image-${i}">${q.image ? 'Replace picture' : 'Upload picture'}</label><input class="input" id="image-${i}" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-image="${i}"><p class="small">PNG, JPEG, WebP or GIF · up to 50 MB.</p>${pictureUrlControls(`question-${i}`)}${q.image ? `<label class="field" for="alt-${i}">Picture description</label><input class="input" id="alt-${i}" data-image-alt maxlength="200" placeholder="Describe the picture for players using a screen reader" value="${escapeHTML(q.imageAlt)}">` : ''}</div>
    ${answers}<div class="form-row"><label class="field" for="time-${i}" style="margin:0">Answer time</label><select class="input" id="time-${i}" data-time>${[...new Set([5,10,20,30,60,90,120,q.timeLimit])].sort((a,b) => a-b).map(t => `<option value="${t}" ${q.timeLimit === t ? 'selected' : ''}>${t} sec</option>`).join('')}</select><span class="small">Starts when the host opens answers.</span></div>
  </article>`;
}
function editor() {
  app.innerHTML = `<section class="shell editor"><div class="topline"><div><p class="eyebrow">Make it your own</p><h1>${draft.id ? 'Edit your quiz' : 'A great game starts here.'}</h1><p>Mix question types, add pictures, and set the pace.</p></div><a class="btn ghost" href="/host#host">Back to library</a></div><form id="editor-form"><label class="field" for="quiz-title">Quiz title</label><input class="input editor-title" id="quiz-title" placeholder="Give your quiz a name" maxlength="120" required value="${escapeHTML(draft.title)}"><section class="card image-editor quiz-cover-editor"><h2 class="question-heading">Quiz cover picture</h2>${draft.coverImage ? `<img class="editor-cover" src="${escapeHTML(draft.coverImage)}" alt="${escapeHTML(draft.coverImageAlt || 'Quiz cover picture')}"><button class="btn subtle" type="button" data-remove-cover>Remove cover picture</button>` : `<img class="default-image" src="/images/quiz.svg" alt="Colourful quiz-themed cover"><p class="small">Standard quiz artwork is used on the library card until you add a cover.</p>`}<label class="field" for="cover-image">${draft.coverImage ? 'Replace cover picture' : 'Upload cover picture'}</label><input class="input" id="cover-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-cover-image><p class="small">PNG, JPEG, WebP or GIF · up to 50 MB.</p>${pictureUrlControls('cover')}${draft.coverImage ? `<label class="field" for="cover-alt">Picture description</label><input class="input" id="cover-alt" data-cover-alt maxlength="200" placeholder="Describe the cover picture" value="${escapeHTML(draft.coverImageAlt || '')}">` : ''}</section>${draft.questions.map(editorQuestion).join('')}<div class="savebar"><button class="btn ghost" id="add-question" type="button" ${draft.questions.length >= 50 ? 'disabled' : ''}>＋ Add question</button><span class="small" id="save-status" role="status" aria-live="polite">${draftIsComplete(draft) ? 'Changes will save automatically' : 'Your work is saved on this device as you type'}</span><button class="btn light" type="submit">Save quiz ✓</button></div></form></section>`;
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
        else draft.questions[target].image = result.image;
      }
    } catch (error) { toast(error.message || 'This picture could not be read. Try a PNG or JPEG.'); }
    finally { uploading = false; if (version === routeVersion) { editor(); scheduleDraftSave(); } }
  };
  app.querySelectorAll('[data-image]').forEach(input => input.onchange = () => uploadPicture(input.files[0], Number(input.dataset.image)));
  app.querySelector('[data-cover-image]').onchange = event => uploadPicture(event.target.files[0], 'cover');
  app.querySelectorAll('[data-load-picture]').forEach(button => button.onclick = () => run(button, async () => {
    const version = routeVersion, target = button.dataset.loadPicture;
    readDraft(); cacheDraft();
    const url = app.querySelector(`[data-picture-url="${target}"]`).value.trim();
    if (!url) throw new Error('Paste an image URL first.');
    const result = await api('/images/from-url', {method:'POST', body:{url}});
    if (version === routeVersion) openCropper(result.image, target === 'cover' ? 'cover' : Number(target.slice('question-'.length)), uploadPicture);
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
function saveSession(value) { session = value; sessionStorage.setItem(`quizpop-${value.role}-${value.pin}`,JSON.stringify(value)); location.hash=`room/${value.role}/${value.pin}`; }
async function connectRoom(role, pin, version) {
  const stored = sessionStorage.getItem(`quizpop-${role}-${pin}`);
  if (!stored) { location.href = role==='host'?'/host#host':`/#join/${pin}`; return; }
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
  return `<div class="ranking">${players.slice(0,10).map((p,i)=>`<div class="rank-row"><span class="position">${i+1}</span><span class="player-emoji" aria-hidden="true">${escapeHTML(p.emoji || '😀')}</span><strong>${escapeHTML(p.nickname)}${p.id===roomState.self?.id?' (you)':''}</strong><span class="score">${p.score.toLocaleString()} <small>pts</small></span></div>`).join('')}</div>`;
}
function questionContent(s) {
  const q = s.question, host = s.host, preview = s.status === 'preview', reveal = s.status === 'reveal';
  const typed = q.type === 'type-answer', poll = q.type === 'poll';
  const image = `<figure class="question-picture"><img src="${escapeHTML(q.image || defaultPicture(q))}" alt="${escapeHTML(q.image ? q.imageAlt || 'Question picture' : 'Colourful quiz illustration')}"></figure>`;
  const heading = `<p class="eyebrow">${escapeHTML(questionTypes[q.type] || questionTypes.quiz)} · Question ${s.questionIndex + 1} of ${s.questionCount}</p><h1>${escapeHTML(q.question)}</h1>${image}`;
  if (preview) return `${heading}<div class="preview-note"><span class="badge">TAKE A LOOK</span><p>Read the question and study the picture. Answers will open next.</p></div>${host ? '<button class="btn light" data-action="open">Open answers →</button>' : '<p class="muted-white">Waiting for the host to open answers…</p>'}`;
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
    content = host ? `<p class="eyebrow">Ready, set, quiz.</p><h1>Everyone in?</h1><p class="join-url">Join at <b>${escapeHTML(location.host)}</b> with game PIN</p><div class="pin-display"><small>GAME PIN</small><strong>${s.pin}</strong></div><div><button class="btn ghost" id="copy-link">Copy invite link ↗</button></div><p class="room-title">${s.players.length} ${s.players.length===1?'player':'players'} in the lobby</p><div class="player-list">${s.players.length?s.players.map(p=>`<span class="player-chip"><span aria-hidden="true">${escapeHTML(p.emoji || '😀')}</span> ${escapeHTML(p.nickname)}</span>`).join(''):'<p class="empty">The stage is set. Just waiting for your people…</p>'}</div><div class="lobby-actions"><button class="btn light" data-action="start" ${s.players.length?'':'disabled'}>Start game →</button></div>` : `<div class="podium-icon" aria-hidden="true">✦</div><p class="eyebrow">You're on the list</p><h1>You're in, ${escapeHTML(s.self.emoji || '😀')} ${escapeHTML(s.self.nickname)}!</h1><p class="subtitle">Get ready. Your host will start the game soon.</p><span class="spinner"></span><p class="muted-white">${s.players.length} ${s.players.length===1?'player':'players'} ready to play</p>`;
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
  document.querySelector('#leave-room').onclick=()=>{ if(confirm(host?'Leave this screen? The game stays available; return with your browser Back button.':'Leave this game? You can return with your browser Back button.')) location.href=host?'/host#host':'/'; };
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
  if ((['host','create','edit'].includes(page) || (page === 'room' && arg === 'host')) && location.pathname !== '/host') { location.replace(`/host${location.hash}`); return; }
  try {
    if(page==='host')await library(version);
    else if(page==='create'){draft=restoreDraft({title:'',questions:[newQuestion()]});editor();}
    else if(page==='edit'){
      draft=await api(`/quizzes/${encodeURIComponent(arg)}`);if(version!==routeVersion)return;
      if(draft.id==='sample'||draft.id==='feature-test'){delete draft.id;draft.title+=' (copy)';}else draft=restoreDraft(draft);editor();
    }else if(page==='room')await connectRoom(arg,pin,version);
    else joinPage(page==='join'&&/^\d{6}$/.test(arg)?arg:'');
  } catch(error){if(version!==routeVersion)return;app.innerHTML=`<section class="join"><div class="card"><h1>Couldn't open that.</h1><p>${escapeHTML(error.message)}</p><a class="btn wide" href="#">Back to join</a><a class="btn subtle wide" href="/host#host">Quiz library</a></div></section>`;}
}
window.addEventListener('hashchange',route);
route();
