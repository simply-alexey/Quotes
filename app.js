// Pocket Verse PWA — vanilla JS + IndexedDB
const $ = sel => document.querySelector(sel);
const app = $('#app');

// simple router
window.addEventListener('hashchange', route);
window.addEventListener('load', () => { route(); setupInstallPrompt(); });

function goto(hash) { location.hash = hash; }

// ---------- DB (IndexedDB) ----------
const DB_NAME = 'pocket-verse-db';
const DB_VER = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      const authors = _db.createObjectStore('authors', { keyPath: 'id', autoIncrement: true });
      authors.createIndex('byCategory', 'category');
      authors.createIndex('byName', 'name');
      const pieces = _db.createObjectStore('pieces', { keyPath: 'id', autoIncrement: true });
      pieces.createIndex('byAuthor', 'authorId');
      pieces.createIndex('byCreatedAt', 'createdAt');
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode='readonly') {
  return db.transaction(store, mode).objectStore(store);
}

async function openDBIfNeeded() { if (!db) await openDB(); }

async function listAuthors(category, search = '') {
  await openDBIfNeeded();
  return new Promise((resolve) => {
    const idx = tx('authors').index('byCategory');
    const range = IDBKeyRange.only(category);
    const out = [];
    idx.openCursor(range).onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return resolve(out.sort((a,b)=>a.name.localeCompare(b.name)));
      const a = cur.value;
      if (!search || a.name.toLowerCase().includes(search.toLowerCase())) out.push(a);
      cur.continue();
    };
  });
}

async function addAuthor(name, category) {
  await openDBIfNeeded();
  return new Promise((resolve, reject) => {
    const req = tx('authors','readwrite').add({ name, category, createdAt: Date.now() });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function updateAuthor(id, updates) {
  await openDBIfNeeded();
  const existing = await new Promise(res => tx('authors').get(Number(id)).onsuccess = e => res(e.target.result));
  if (!existing) return;
  Object.assign(existing, updates);
  return new Promise((resolve, reject) => {
    const req = tx('authors','readwrite').put(existing);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function deleteAuthor(id) {
  await openDBIfNeeded();
  // delete pieces of this author too
  const pieces = await listPieces(id);
  await Promise.all(pieces.map(p => delPiece(p.id)));
  return new Promise((resolve, reject) => {
    const req = tx('authors','readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getAuthor(id) {
  await openDBIfNeeded();
  return new Promise((resolve) => {
    tx('authors').get(Number(id)).onsuccess = e => resolve(e.target.result);
  });
}

async function listPieces(authorId, search = '') {
  await openDBIfNeeded();
  return new Promise((resolve) => {
    const idx = tx('pieces').index('byAuthor');
    const range = IDBKeyRange.only(Number(authorId));
    const out = [];
    idx.openCursor(range).onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return resolve(out.sort((a,b)=>b.createdAt - a.createdAt));
      const p = cur.value;
      if (!search || (p.title?.toLowerCase().includes(search.toLowerCase()) || p.text.toLowerCase().includes(search.toLowerCase()))) out.push(p);
      cur.continue();
    };
  });
}

async function addPiece(authorId, title, text) {
  await openDBIfNeeded();
  return new Promise((resolve, reject) => {
    const req = tx('pieces','readwrite').add({ authorId: Number(authorId), title, text, createdAt: Date.now() });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getPiece(id) {
  await openDBIfNeeded();
  return new Promise((resolve) => tx('pieces').get(Number(id)).onsuccess = e => resolve(e.target.result));
}

async function savePiece(id, updates) {
  await openDBIfNeeded();
  const p = await getPiece(id);
  Object.assign(p, updates);
  return new Promise((resolve, reject) => {
    const req = tx('pieces','readwrite').put(p);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function delPiece(id) {
  await openDBIfNeeded();
  return new Promise((resolve, reject) => {
    const req = tx('pieces','readwrite').delete(Number(id));
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------- Export / Import ----------
async function exportJSON() {
  await openDBIfNeeded();
  const authors = await new Promise((resolve)=>{
    const out=[]; tx('authors').openCursor().onsuccess=e=>{const c=e.target.result; if(!c) return resolve(out); out.push(c.value); c.continue();};
  });
  const pieces = await new Promise((resolve)=>{
    const out=[]; tx('pieces').openCursor().onsuccess=e=>{const c=e.target.result; if(!c) return resolve(out); out.push(c.value); c.continue();};
  });
  const blob = new Blob([JSON.stringify({version:1, exportedAt:new Date().toISOString(), authors, pieces}, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'pocket-verse-backup.json'; a.click();
  URL.revokeObjectURL(url);
}

async function importJSON(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  await openDBIfNeeded();
  // wipe then import (simple strategy)
  await new Promise((res,rej)=>{ const t = db.transaction(['authors','pieces'],'readwrite'); t.objectStore('authors').clear(); t.objectStore('pieces').clear(); t.oncomplete=res; t.onerror=rej; });
  await Promise.all((data.authors||[]).map(a=>new Promise((res,rej)=>{ tx('authors','readwrite').add(a).onsuccess=()=>res(); })));
  await Promise.all((data.pieces||[]).map(p=>new Promise((res,rej)=>{ tx('pieces','readwrite').add(p).onsuccess=()=>res(); })));
}

// ---------- UI ----------
const Categories = ['Poems','Quotes'];

function route() {
  const hash = location.hash || '#/home';
  const [ , first, second ] = hash.split('/');

  // toggle body class for home-only styling
  document.body.classList.toggle('home', first === 'home');

  if (first === 'home') renderHome();
  else if (first === 'authors') renderAuthors(decodeURIComponent(second||'Poems'));
  else if (first === 'pieces') renderPieces(Number(second));
  else if (first === 'piece') renderPieceDetail(Number(second));
  else renderHome();
}

function renderHome() {
  app.innerHTML = `
    <div class="home-categories">
      ${Categories.map(c=>`<button class="btn" onclick="goto('#/authors/${encodeURIComponent(c)}')">${c}</button>`).join('')}
    </div>
  `;
}

async function renderAuthors(category) {
  // Light page: title + grid of author buttons + FAB add
  app.innerHTML = `
    <div class="authors-page">
      <h2>${category}</h2>
      <div id="authors" class="authors-grid"></div>
      <button id="fabAddAuthor" class="fab" aria-label="Add author">+</button>
    </div>
  `;

  // one-time hint toast
  if (!localStorage.getItem('pv_hint_author_edit_shown')) {
    showToast('Tip: hold an author to rename or delete', 2800);
    localStorage.setItem('pv_hint_author_edit_shown', '1');
  }

  const cont = $('#authors');

  async function refresh() {
    const items = await listAuthors(category);
    if (!items.length) {
      cont.innerHTML = `<div class="muted">No authors yet.</div>`;
      return;
    }
    cont.innerHTML = items.map(a => `
      <div class="author-item" data-id="${a.id}" data-name="${escapeAttr(a.name)}">
        <button class="btn author-btn" data-role="open">${escapeHtml(a.name)}</button>
      </div>
    `).join('');

    // attach long-press + click handlers
    cont.querySelectorAll('.author-item').forEach(item => {
      const id = Number(item.dataset.id);
      const name = item.dataset.name;

      const openBtn = item.querySelector('[data-role="open"]');
      addLongPress(openBtn, () => enterEdit(item, id, name), () => goto(`#/pieces/${id}`));
    });
  }

  function enterEdit(itemEl, id, currentName) {
    // replace content with inline editor
    itemEl.innerHTML = `
      <div class="author-edit">
        <input class="input light" value="${escapeAttr(currentName)}" aria-label="Author name">
        <div class="row space" style="margin-top:10px">
          <button class="btn" data-cancel>Cancel</button>
          <div class="row" style="gap:.5rem">
            <button class="btn danger" data-delete>Delete</button>
            <button class="btn acc" data-save>Save</button>
          </div>
        </div>
      </div>
    `;
    const input = itemEl.querySelector('input');
    const saveBtn = itemEl.querySelector('[data-save]');
    const cancelBtn = itemEl.querySelector('[data-cancel]');
    const delBtn = itemEl.querySelector('[data-delete]');

    input.focus();
    input.setSelectionRange(0, input.value.length);

    saveBtn.addEventListener('click', async () => {
      const newName = input.value.trim();
      if (!newName) return;
      await updateAuthor(id, { name: newName });
      await refresh();
    });

    cancelBtn.addEventListener('click', refresh);

    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete author and all texts?')) return;
      await deleteAuthor(id);
      await refresh();
    });

    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
    });
  }

  await refresh();

  // FAB directly adds (no modal)
  $('#fabAddAuthor').addEventListener('click', async () => {
    const name = (prompt('Author name') || '').trim();
    if (!name) return;
    await addAuthor(name, category);
    await refresh();
  });
}

/** Add a long-press handler that falls back to click if press is short. */
function addLongPress(el, onLongPress, onShortTap) {
  let timer = null, longFired = false;
  const threshold = 500; // ms
  let startX = 0, startY = 0;

  const start = (e) => {
    longFired = false;
    const p = getPoint(e);
    startX = p.x; startY = p.y;
    timer = setTimeout(() => { longFired = true; onLongPress(e); }, threshold);
  };
  const move = (e) => {
    if (!timer) return;
    const p = getPoint(e);
    if (Math.hypot(p.x - startX, p.y - startY) > 10) { clear(); }
  };
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const end = (e) => {
    if (timer) { // short tap
      clear();
      if (!longFired && onShortTap) onShortTap(e);
    }
  };

  el.addEventListener('pointerdown', start, { passive: true });
  el.addEventListener('pointermove', move, { passive: true });
  el.addEventListener('pointerup', end, { passive: true });
  el.addEventListener('pointercancel', clear, { passive: true });
  el.addEventListener('pointerleave', clear, { passive: true });
}
function getPoint(e){ return { x: e.clientX ?? (e.touches?.[0]?.clientX||0), y: e.clientY ?? (e.touches?.[0]?.clientY||0) }; }

async function renderPieces(authorId) {
  const author = await getAuthor(authorId);
  if (!author) return renderHome();
  const searchId = 'search-piece';
  app.innerHTML = `
    <div class="card">
      <div class="row space">
        <h2>${escapeHtml(author.name)}</h2>
        <button class="btn" onclick="goto('#/authors/${encodeURIComponent(author.category)}')">Back</button>
      </div>
      <input id="${searchId}" class="input search" placeholder="Search texts…" />
      <div id="pieces" class="list"></div>
      <div class="group" style="margin-top:10px">
        <input id="newTitle" class="input" placeholder="Title (optional)" />
        <textarea id="newText" placeholder="Write text here…"></textarea>
        <button class="btn acc" id="addPieceBtn">Add text</button>
      </div>
    </div>
  `;
  const cont = $('#pieces');
  async function refresh() {
    const items = await listPieces(authorId, $(`#${searchId}`).value.trim());
    cont.innerHTML = items.length ? items.map(p => (
      `<div class="item">
        <div>
          <div class="title">${escapeHtml(p.title || 'Untitled')}</div>
          <div class="small muted">${new Date(p.createdAt).toLocaleDateString()}</div>
        </div>
        <div class="row">
          <button class="btn" onclick="goto('#/piece/${p.id}')">Open</button>
          <button class="btn" onclick="delPieceAndRefresh(${p.id})">Delete</button>
        </div>
      </div>`)).join('')
      : `<div class="muted">No texts yet.</div>`;
  }
  await refresh();
  $(`#${searchId}`).addEventListener('input', refresh);
  $('#addPieceBtn').addEventListener('click', async ()=>{
    const title = $('#newTitle').value.trim();
    const text = $('#newText').value.trim();
    if (!text) return;
    await addPiece(authorId, title, text);
    $('#newTitle').value=''; $('#newText').value='';
    await refresh();
  });
}

async function renderPieceDetail(id) {
  const p = await getPiece(id);
  if (!p) return renderHome();
  const a = await getAuthor(p.authorId);
  app.innerHTML = `
    <div class="card">
      <div class="row space">
        <h2>${escapeHtml(a?.name || 'Text')}</h2>
        <button class="btn" onclick="goto('#/pieces/${p.authorId}')">Back</button>
      </div>
      <input id="title" class="input" value="${escapeAttr(p.title||'')}" placeholder="Title (optional)">
      <textarea id="text">${escapeHtml(p.text)}</textarea>
      <div class="row space">
        <div class="muted small">Saved: <span id="savedAt">${new Date(p.createdAt).toLocaleString()}</span></div>
        <div class="row" style="gap:.5rem">
          <button class="btn" id="shareBtn">Share</button>
          <button class="btn acc" id="saveBtn">Save</button>
        </div>
      </div>
    </div>
  `;
  $('#saveBtn').addEventListener('click', async ()=>{
    await savePiece(id, { title: $('#title').value, text: $('#text').value });
    $('#savedAt').textContent = new Date().toLocaleString();
  });
  $('#shareBtn').addEventListener('click', async ()=>{
    const data = { title: p.title || 'Text', text: $('#text').value };
    if (navigator.share) { try { await navigator.share(data); } catch(e){} }
    else { alert('Sharing not supported in this browser.'); }
  });
}

async function delPieceAndRefresh(id) { await delPiece(id); route(); }

// ---------- Helpers ----------
function escapeHtml(s=''){ return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function escapeAttr(s=''){ return s.replace(/"/g,'&quot;'); }

function showToast(text, ms=2000){
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(()=> el.classList.add('show'));
  setTimeout(()=>{ el.classList.remove('show'); setTimeout(()=>el.remove(), 250); }, ms);
}

// ---------- Install prompt ----------
let deferredPrompt;
function setupInstallPrompt(){
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('installBtn');
    if (btn) {
      btn.classList.remove('hidden');
      btn.onclick = async () => {
        btn.classList.add('hidden');
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
      };
    }
  });
  // footer controls
  const homeBtn = document.getElementById('homeBtn');
  const exportBtn = document.getElementById('exportBtn');
  const importInput = document.getElementById('importInput');
  if (homeBtn) homeBtn.onclick = () => goto('#/home');
  if (exportBtn) exportBtn.onclick = () => exportJSON();
  if (importInput) importInput.addEventListener('change', (e)=>{
    const f = e.target.files[0]; if (f) importJSON(f).then(()=>route());
  });
}