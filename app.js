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
  else if (first === 'piece') renderReadPiece(Number(second)); // read view
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
  app.innerHTML = `
    <div class="authors-page">
      <h2>${category}</h2>
      <div id="authors" class="authors-grid"></div>
      <button id="fabAddAuthor" class="fab" aria-label="Add author">+</button>
    </div>
  `;

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
      const name = item.dataset.name;
      const openBtn = item.querySelector('[data-role="open"]');
      addLongPress(openBtn, () => enterEditAuthor(item, id, name), () => goto(`#/pieces/${id}`));
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
      <div class="row space pieces-header">
        <h2>${escapeHtml(author.name)}</h2>
        <button class="btn" id="backBtn">Back</button>
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
        <label class="fav-row"><input type="checkbox" class="favChk" ${p.favorite ? 'checked' : ''}> <span>Favourite</span></label>
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
    const favChk  = itemEl.querySelector('.favChk');
    const saveBtn = itemEl.querySelector('[data-save]');
    const cancelBtn = itemEl.querySelector('[data-cancel]');
    const delBtn = itemEl.querySelector('[data-delete]');

    (titleEl || textEl).focus();

    [saveBtn, cancelBtn, delBtn].forEach(b => solidTapTarget(b, [elFilter(titleEl), elFilter(textEl)]));

    saveBtn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const newTitle = isQuote ? (p.title||'') : (titleEl?.value || '').trim();
      const newText  = (textEl?.value || '').trim();
      const fav      = !!favChk?.checked;
      if (!newText) return;
      await savePiece(id, { title:newTitle, text:newText, favorite:fav });
      await refresh();
    });

    cancelBtn.addEventListener('click', async (e)=>{ e.stopPropagation(); await refresh(); });

    delBtn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      if (!confirm('Delete this entry?')) return;
      await delPiece(id);
      await refresh();
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
  function elFilter(x){ return x || { blur(){} }; }

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

/* ===== Read view (new) ===== */
async function renderReadPiece(id) {
  const p = await getPiece(id);
  if (!p) return renderHome();
  const a = await getAuthor(p.authorId);
  const isQuote = a?.category === 'Quotes';

  app.innerHTML = `
    <div class="read-page">
      <div class="row space read-header">
        <div class="read-meta">
          ${isQuote ? '' : `<div class="read-author">${escapeHtml(a?.name || '')}</div>
                            <div class="read-title">${escapeHtml(p.title || 'Untitled')}</div>`}
        </div>
        <button class="btn" id="backBtn">Back</button>
      </div>
      <div id="readText" class="read-text"></div>
    </div>
  `;

  $('#backBtn').addEventListener('click', () => goto(`#/pieces/${p.authorId}`));

  const readEl = $('#readText');
  readEl.textContent = p.text || '';

  // --- Accurate auto-scale so each line fits without horizontal overflow
  function autoScale() {
    const cs = getComputedStyle(readEl);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const target = Math.max(10, readEl.clientWidth - padLeft - padRight);

    // Create a hidden measuring element with identical typography
    const meas = document.createElement('div');
    meas.style.position = 'absolute';
    meas.style.visibility = 'hidden';
    meas.style.whiteSpace = 'pre';
    meas.style.fontFamily = cs.fontFamily;
    meas.style.fontWeight = cs.fontWeight;
    meas.style.letterSpacing = cs.letterSpacing;
    meas.style.padding = '0';
    meas.style.margin = '0';
    meas.style.lineHeight = cs.lineHeight;
    meas.style.fontSize = '16px'; // base for proportional scaling
    document.body.appendChild(meas);

    const lines = (p.text || '').split('\n');
    let longestWidth = 1;
    for (const line of lines.length ? lines : [' ']) {
      meas.textContent = line || ' ';
      const w = meas.scrollWidth;
      if (w > longestWidth) longestWidth = w;
    }
    document.body.removeChild(meas);

    // scale from base 16px
    let proposed = Math.floor((target / longestWidth) * 16);
    proposed = Math.max(14, Math.min(40, proposed)); // clamp
    readEl.style.fontSize = `${proposed}px`;
  }

  autoScale();
  window.addEventListener('resize', autoScale, { passive: true });
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
  const homeBtn = document.getElementById('homeBtn');
  const exportBtn = document.getElementById('exportBtn');
  const importInput = document.getElementById('importInput');
  if (homeBtn) homeBtn.onclick = () => goto('#/home');
  if (exportBtn) exportBtn.onclick = () => exportJSON();
  if (importInput) importInput.addEventListener('change', (e)=>{
    const f = e.target.files[0]; if (f) importJSON(f).then(()=>route());
  });
}