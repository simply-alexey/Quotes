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

async function listPieces(authorId) {
  await openDBIfNeeded();
  return new Promise((resolve) => {
    const idx = tx('pieces').index('byAuthor');
    const range = IDBKeyRange.only(Number(authorId));
    const out = [];
    idx.openCursor(range).onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return resolve(out.sort((a,b)=>b.createdAt - a.createdAt));
      out.push(cur.value);
      cur.continue();
    };
  });
}

async function addPiece(authorId, title, text, favorite=false) {
  await openDBIfNeeded();
  return new Promise((resolve, reject) => {
    const req = tx('pieces','readwrite').add({
      authorId: Number(authorId),
      title: title || '',
      text: text || '',
      favorite: !!favorite,
      createdAt: Date.now()
    });
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
  await new Promise((res,rej)=>{ const t = db.transaction(['authors','pieces'],'readwrite'); t.objectStore('authors').clear(); t.objectStore('pieces').clear(); t.oncomplete=res; t.onerror=rej; });
  await Promise.all((data.authors||[]).map(a=>new Promise((res)=>{ tx('authors','readwrite').add(a).onsuccess=()=>res(); })));
  await Promise.all((data.pieces||[]).map(p=>new Promise((res)=>{ tx('pieces','readwrite').add(p).onsuccess=()=>res(); })));
}

// ---------- UI ----------
const Categories = ['Poems','Quotes'];

function route() {
  const hash = location.hash || '#/home';
  const [ , first, second ] = hash.split('/');

  document.body.classList.toggle('home', first === 'home');

  if (first === 'home') renderHome();
  else if (first === 'authors') renderAuthors(decodeURIComponent(second||'Poems'));
  else if (first === 'pieces') renderPieces(Number(second));
  else if (first === 'piece') renderReadPiece(Number(second));
  else if (first === 'memorise') renderMemorisePiece(Number(second));
  else renderHome();
}

function renderHome() {
  app.innerHTML = `
    <div class="home-categories">
      ${Categories.map(c=>`<button class="btn" onclick="goto('#/authors/${encodeURIComponent(c)}')">${c}</button>`).join('')}
    </div>
  `;
}

/* ===== Authors list for category ===== */
async function renderAuthors(category) {
  app.innerHTML = `
    <div class="authors-page">
      <div class="pieces-header">
        <h2>${category}</h2>
        <button class="btn back" id="backBtn">Back</button>
      </div>
      <div id="authors" class="authors-grid"></div>
      <button id="fabAddAuthor" class="fab" aria-label="Add author">+</button>
    </div>
  `;

  // Back from category to Home
  $('#backBtn').addEventListener('click', () => goto('#/home'));

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

    cont.querySelectorAll('.author-item').forEach(item => {
      const id = Number(item.dataset.id);
      const openBtn = item.querySelector('[data-role="open"]');
      addLongPress(openBtn, () => enterEditAuthor(item, id, item.dataset.name), () => goto(`#/pieces/${id}`));
    });
  }

  function solidTapTarget(btn, input) {
    ['pointerdown','touchstart','mousedown'].forEach(ev => {
      btn.addEventListener(ev, () => { if (input) input.blur(); }, { passive: true });
    });
  }

  function enterEditAuthor(itemEl, id, currentName) {
    itemEl.innerHTML = `
      <div class="author-edit">
        <input class="input light" value="${escapeAttr(currentName)}" aria-label="Author name">
        <div class="row space edit-actions">
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

    input.focus(); input.setSelectionRange(0, input.value.length);
    [saveBtn, cancelBtn, delBtn].forEach(b => solidTapTarget(b, input));

    saveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newName = input.value.trim();
      if (!newName) return;
      await updateAuthor(id, { name: newName });
      await refresh();
    });

    cancelBtn.addEventListener('click', async (e) => { e.stopPropagation(); await refresh(); });

    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
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

  $('#fabAddAuthor').addEventListener('click', async () => {
    const name = (prompt('Author name') || '').trim();
    if (!name) return;
    await addAuthor(name, category);
    await refresh();
  });
}

/* ===== Pieces screen (Poems/Quotes) ===== */
async function renderPieces(authorId) {
  const author = await getAuthor(authorId);
  if (!author) return renderHome();

  const isQuoteMode = (author.category === 'Quotes');

  app.innerHTML = `
    <div class="pieces-page">
      <div class="pieces-header">
        <h2>${escapeHtml(author.name)}</h2>
        <button class="btn back" id="backBtn">Back</button>
      </div>
      <div id="pieces" class="pieces-grid"></div>
      <button id="fabAddPiece" class="fab" aria-label="Add ${isQuoteMode ? 'quote' : 'poem'}">+</button>

      <!-- Dialog -->
      <div id="pieceModal" class="modal-backdrop hidden" role="dialog" aria-modal="true">
        <div class="modal">
          <h3 class="modal-title">Add ${isQuoteMode ? 'quote' : 'poem'}</h3>
          ${isQuoteMode ? '' : '<input id="pmTitle" class="input light" placeholder="Title">'}
          <textarea id="pmText" class="input light ta" placeholder="${isQuoteMode ? 'Quote text…' : 'Write text here…'}"></textarea>
          <label class="fav-row"><input type="checkbox" id="pmFav"> <span>Add to favourites</span></label>
          <div class="row space" style="margin-top:12px">
            <button class="btn" id="pmCancel" type="button">Cancel</button>
            <button class="btn acc" id="pmAdd" type="button">Add</button>
          </div>
        </div>
      </div>
    </div>
  `;

  $('#backBtn').addEventListener('click', () => goto(`#/authors/${encodeURIComponent(author.category)}`));

  const cont = $('#pieces');
  const pieceModal = $('#pieceModal');

  async function refresh() {
    const items = await listPieces(authorId);
    if (!items.length) {
      cont.innerHTML = `<div class="muted">No ${isQuoteMode ? 'quotes' : 'poems'} yet.</div>`;
      return;
    }

    cont.innerHTML = items.map(p => `
      <div class="piece-item" data-id="${p.id}">
        <button class="btn piece-btn" data-role="open">
          ${p.favorite ? '★ ' : ''}
          ${escapeHtml(renderPieceLabel(p, isQuoteMode))}
        </button>
      </div>
    `).join('');

    cont.querySelectorAll('.piece-item').forEach(item => {
      const id = Number(item.dataset.id);
      const openBtn = item.querySelector('[data-role="open"]');
      addLongPress(openBtn, () => enterEditPiece(item, id, isQuoteMode), () => goto(`#/piece/${id}`));
    });
  }

  function renderPieceLabel(p, isQuote) {
    if (!isQuote) return p.title?.trim() ? p.title : 'Untitled';
    return snippet(p.text || '', 8);
  }

  function snippet(txt, words=8) {
    const parts = (txt || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length <= words) return parts.join(' ');
    return parts.slice(0, words).join(' ') + '…';
  }

  function openModal() {
    pieceModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(()=>{ ($('#pmTitle')||$('#pmText'))?.focus(); },0);
  }
  function closeModal() {
    pieceModal.classList.add('hidden');
    document.activeElement?.blur?.();
    const t = $('#pmTitle'); const x = $('#pmText'); const f = $('#pmFav');
    if (t) t.value = '';
    if (x) x.value = '';
    if (f) f.checked = false;
    document.body.style.overflow = '';
  }

  $('#fabAddPiece').addEventListener('click', openModal);
  pieceModal.addEventListener('click', (e)=>{ if (e.target.id === 'pieceModal') closeModal(); });
  $('#pmCancel').addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); closeModal(); });
  $('#pmAdd').addEventListener('click', async (e)=>{
    e.preventDefault(); e.stopPropagation();
    const isQuoteModeLocal = (author.category === 'Quotes');
    const title = isQuoteModeLocal ? '' : ($('#pmTitle')?.value || '').trim();
    const text  = ($('#pmText')?.value || '').trim();
    const fav   = $('#pmFav')?.checked || false;
    if (!text) return;
    await addPiece(authorId, title, text, fav);
    closeModal();
    await refresh();
  });

  function solidTapTarget(btn, inputs) {
    ['pointerdown','touchstart','mousedown'].forEach(ev => {
      btn.addEventListener(ev, () => { inputs.forEach(i=>i.blur()); }, { passive: true });
    });
  }

  async function enterEditPiece(itemEl, id, isQuote) {
    const p = await getPiece(id);
    itemEl.innerHTML = `
      <div class="piece-edit">
        ${isQuote ? '' : `<input class="input light" value="${escapeAttr(p.title||'')}" placeholder="Title">`}
        <textarea class="input light ta" placeholder="${isQuote ? 'Quote text…' : 'Text…'}">${escapeHtml(p.text||'')}</textarea>
        <label class="fav-row"><input type="checkbox" ${p.favorite?'checked':''}> <span>Favourite</span></label>
        <div class="row space">
          <button class="btn" data-cancel>Cancel</button>
          <div class="row" style="gap:.5rem">
            <button class="btn danger" data-delete>Delete</button>
            <button class="btn acc" data-save>Save</button>
          </div>
        </div>
      </div>
    `;
    const titleEl = itemEl.querySelector('input');
    const textEl  = itemEl.querySelector('textarea');
    const favEl   = itemEl.querySelector('input[type="checkbox"]');
    const saveBtn = itemEl.querySelector('[data-save]');
    const cancelBtn = itemEl.querySelector('[data-cancel]');
    const delBtn = itemEl.querySelector('[data-delete]');

    solidTapTarget(saveBtn, [titleEl, textEl]);
    solidTapTarget(cancelBtn, [titleEl, textEl]);
    solidTapTarget(delBtn, [titleEl, textEl]);

    saveBtn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      await savePiece(id, {
        title: titleEl ? titleEl.value.trim() : p.title,
        text: (textEl?.value||'').trim(),
        favorite: !!favEl?.checked
      });
      await refresh();
    });
    cancelBtn.addEventListener('click', async (e)=>{ e.stopPropagation(); await refresh(); });
    delBtn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      if(!confirm('Delete this item?')) return;
      await delPiece(id); await refresh();
    });

    textEl?.addEventListener('keydown', async (e)=>{
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBtn.click(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
    });
    titleEl?.addEventListener('keydown', async (e)=>{
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveBtn.click(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
    });
  }

  await refresh();
}

/** Long-press with short-tap fallback. */
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
    if (timer) {
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

/* ===== Read view (viewer) ===== */
async function renderReadPiece(id) {
  const p = await getPiece(id);
  if (!p) return renderHome();
  const a = await getAuthor(p.authorId);
  const isQuote = a?.category === 'Quotes';

  app.innerHTML = `
    <div class="read-page">
      <div class="read-header">
        <div class="read-meta">
          ${isQuote ? '' : `
            <div class="read-author">${escapeHtml(a?.name || '')}</div>
            <div class="read-title">${escapeHtml(p.title || 'Untitled')}</div>
          `}
        </div>
        <button class="btn back" id="backBtn">Back</button>
      </div>
      <div id="readText" class="read-text"></div>
      ${isQuote ? '' : `
        <div class="mem-cta">
          <button class="btn mem-open" id="memOpenBtn" type="button">Memorise</button>
        </div>
      `}
    </div>
  `;

  $('#backBtn').addEventListener('click', () => goto(`#/pieces/${p.authorId}`));

  const readEl = $('#readText');
  readEl.textContent = p.text || '';

  if (!isQuote) {
    $('#memOpenBtn')?.addEventListener('click', () => goto(`#/memorise/${p.id}`));
  }

  function autoScale() {
    const containerWidth = readEl.getBoundingClientRect().width;
    if (!containerWidth) return;

    let lo = 10;
    let hi = 200;
    let best = lo;

    const fits = () => {
      readEl.offsetHeight;
      return readEl.scrollWidth <= containerWidth;
    };

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      readEl.style.fontSize = `${mid}px`;
      if (fits()) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    readEl.style.fontSize = `${best}px`;
  }

  autoScale();
  window.addEventListener('resize', autoScale, { passive: true });
  setTimeout(autoScale, 50);
  setTimeout(autoScale, 300);
}

/* ===== Memorise screen ===== */
async function renderMemorisePiece(id) {
  const p = await getPiece(id);
  if (!p) return renderHome();
  const a = await getAuthor(p.authorId);
  const isQuote = a?.category === 'Quotes';

  if (isQuote) {
    goto(`#/piece/${id}`);
    return;
  }

  app.innerHTML = `
    <div class="mem-page">
      <div class="mem-header">
        <div class="mem-meta">
          <div class="mem-author">${escapeHtml(a?.name || '')}</div>
          <div class="mem-title">${escapeHtml(p.title || 'Untitled')}</div>
        </div>
        <button class="btn back" id="backBtn">Back</button>
      </div>

      <p class="mem-help">
        Choose a mode, try to recall the next line or word, then tap "Next" to reveal it.
      </p>

      <div class="mem-panel">
        <div class="mem-controls">
          <button class="btn mem-btn" id="memLinesBtn" type="button">By lines</button>
          <button class="btn mem-btn" id="memWordsBtn" type="button">By words</button>
        </div>
        <div id="memDisplay" class="mem-display">
          Choose a mode to begin.
        </div>
        <div class="mem-buttons">
          <button class="btn mem-nav" id="memBackBtn" type="button" disabled>Back</button>
          <button class="btn mem-nav" id="memNextBtn" type="button" disabled>Next</button>
        </div>
      </div>
    </div>
  `;

  $('#backBtn').addEventListener('click', () => goto(`#/piece/${id}`));

  const fullText = p.text || '';
  const lines = fullText
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length);
  const words = fullText
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length);

  const display = $('#memDisplay');
  const nextBtn = $('#memNextBtn');
  const backBtn = $('#memBackBtn');
  const linesBtn = $('#memLinesBtn');
  const wordsBtn = $('#memWordsBtn');

  let mode = null;
  let seq = [];
  let idx = 0;

  function updateDisplay() {
    if (!seq.length || !mode) {
      display.textContent = 'Choose a mode to begin.';
      return;
    }

    if (idx === 0) {
      display.textContent = 'Tap "Next" to reveal the first ' + (mode === 'lines' ? 'line.' : 'word.');
      return;
    }

    const revealed = seq.slice(0, idx);
    if (mode === 'lines') {
      display.textContent = revealed.join('\n');
    } else {
      display.textContent = revealed.join(' ');
    }
  }

  function updateButtons() {
    nextBtn.disabled = !seq.length || idx >= seq.length;
    backBtn.disabled = idx === 0;
  }

  function start(newMode) {
    mode = newMode;
    seq = mode === 'lines' ? lines : words;
    idx = 0;
    updateDisplay();
    updateButtons();
  }

  function showNext() {
    if (!seq.length || !mode) return;
    if (idx >= seq.length) return;
    idx++;
    updateDisplay();
    updateButtons();
  }

  function hideBack() {
    if (idx === 0) return;
    idx--;
    updateDisplay();
    updateButtons();
  }

  linesBtn.addEventListener('click', () => start('lines'));
  wordsBtn.addEventListener('click', () => start('words'));
  nextBtn.addEventListener('click', showNext);
  backBtn.addEventListener('click', hideBack);
}

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
  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault(); deferredPrompt = e;
    $('#installBtn')?.classList.remove('hidden');
  });
  $('#installBtn')?.addEventListener('click', async ()=>{
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#installBtn')?.classList.add('hidden');
  });
}

// Footer actions
document.addEventListener('click', (e)=>{
  if (e.target.id === 'homeBtn') goto('#/home');
  if (e.target.id === 'exportBtn') exportJSON();
});
document.getElementById('importInput')?.addEventListener('change', (e)=> {
  const file = e.target.files?.[0]; if (file) importJSON(file);
});
