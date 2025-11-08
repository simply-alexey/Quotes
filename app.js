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

async function openDBIfNeeded() { if (!db) await openDB(); }

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
  const [ , first, second, third ] = hash.split('/'); // e.g. #/author/Poems or #/pieces/authorId
  if (first === 'home') renderHome();
  else if (first === 'authors') renderAuthors(decodeURIComponent(second||'Poems'));
  else if (first === 'pieces') renderPieces(Number(second));
  else if (first === 'piece') renderPieceDetail(Number(second));
  else renderHome();
}

function renderHome() {
  app.innerHTML = `
    <div class="card group">
      <h2>Categories</h2>
      <div class="list">
        ${Categories.map(c=>`<button class="btn" onclick="goto('#/authors/${encodeURIComponent(c)}')">${c}</button>`).join('')}
      </div>
    </div>
    <div class="card small muted">Tip: Add authors inside a category, then add texts for each author. Everything is saved offline on your device.</div>
  `;
}

async function renderAuthors(category) {
  const searchId = 'search-auth';
  app.innerHTML = `
    <div class="card">
      <h2>${category}</h2>
      <input id="${searchId}" class="input search" placeholder="Search authors…" />
      <div id="authors" class="list"></div>
      <div class="row space" style="margin-top:10px">
        <input id="newAuthor" class="input" placeholder="New author name" />
        <button class="btn acc" id="addAuthorBtn">Add</button>
      </div>
    </div>
  `;
  const cont = $('#authors');
  async function refresh() {
    const items = await listAuthors(category, $(`#${searchId}`).value.trim());
    cont.innerHTML = items.length ? items.map(a => (
      `<div class="item">
         <div>
           <div class="title">${escapeHtml(a.name)}</div>
           <div class="small muted">${category}</div>
         </div>
         <div class="row">
           <button class="btn" onclick="goto('#/pieces/${a.id}')">Open</button>
           <button class="btn" onclick="confirmDeleteAuthor(${a.id})">Delete</button>
         </div>
       </div>`)).join('')
       : `<div class="muted">No authors yet.</div>`;
  }
  await refresh();
  $(`#${searchId}`).addEventListener('input', refresh);
  $('#addAuthorBtn').addEventListener('click', async ()=>{
    const name = $('#newAuthor').value.trim();
    if (!name) return;
    await addAuthor(name, category);
    $('#newAuthor').value='';
    await refresh();
  });
}

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
function confirmDeleteAuthor(id) {
  if (confirm('Delete author and all texts?')) deleteAuthor(id).then(route);
}

// ---------- Helpers ----------
function escapeHtml(s=''){ return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function escapeAttr(s=''){ return s.replace(/"/g,'&quot;'); }

// ---------- Install prompt ----------
let deferredPrompt;
function setupInstallPrompt(){
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('installBtn');
    btn.classList.remove('hidden');
    btn.onclick = async () => {
      btn.classList.add('hidden');
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    };
  });
  // footer controls
  document.getElementById('homeBtn').onclick = () => goto('#/home');
  document.getElementById('exportBtn').onclick = () => exportJSON();
  document.getElementById('importInput').addEventListener('change', (e)=>{
    const f = e.target.files[0]; if (f) importJSON(f).then(()=>route());
  });
}
