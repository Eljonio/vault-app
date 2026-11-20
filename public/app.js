/* Vault — фронт. Ванильный JS, без сборки. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const api = async (p, opts) => {
  const r = await fetch(p, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const fmtDate = iso => { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return iso; return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }); };
const ago = iso => {
  const t = new Date(iso).getTime(); if (isNaN(t)) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' мин';
  if (s < 86400) return Math.round(s / 3600) + ' ч';
  if (s < 86400 * 30) return Math.round(s / 86400) + ' д';
  if (s < 86400 * 365) return Math.round(s / 86400 / 30) + ' мес';
  return Math.round(s / 86400 / 365) + ' г';
};
const TYPE_COLOR = { project: '#5ec8ff', feedback: '#fbbf24', reference: '#4ade80', user: '#f472b6', skill: '#8b74ff', 'manual-testing': '#fb923c', 'design-docs': '#a3a5b0', note: '#a3a5b0' };
const FOLDER_ORDER = ['project', 'reference', 'feedback', 'user', 'manual-testing', 'design-docs'];

const S = {
  notes: [], byId: new Map(), byKey: new Map(),
  current: null, // полный объект заметки
  mode: 'read', dirty: false,
  leftView: 'tree', rightView: 'outline',
  olFilter: null,
  pins: JSON.parse(localStorage.getItem('pins') || '[]'),
  closed: new Set(JSON.parse(localStorage.getItem('closed') || '[]')),
  filter: '',
  palIdx: 0, palItems: [],
};

// ---------------- marked: wikilinks, картинки, id заголовков ----------------
const wikiExt = {
  name: 'wiki', level: 'inline',
  start(src) { return src.indexOf('[['); },
  tokenizer(src) {
    const m = /^\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/.exec(src);
    if (!m) return;
    return { type: 'wiki', raw: m[0], link: m[1].trim(), anchor: m[2] || '', alias: m[3] || '' };
  },
  renderer(tok) {
    const id = resolveLink(tok.link);
    const label = tok.alias || (id ? S.byId.get(id).title : tok.link);
    return `<a class="wiki${id ? '' : ' broken'}" data-id="${esc(id || '')}" data-link="${esc(tok.link)}" data-anchor="${esc(tok.anchor)}" title="${esc(tok.link)}">${esc(label)}</a>`;
  },
};
let headingCounter = 0;
marked.use({
  gfm: true, breaks: false,
  extensions: [wikiExt],
  renderer: {
    heading({ tokens, depth }) {
      const i = headingCounter++;
      return `<h${depth} id="h${i}" data-hi="${i}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
    image({ href, title, text }) {
      return `<img src="${esc(fileUrl(href))}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''}>`;
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      if (/^https?:|^mailto:/.test(href)) return `<a href="${esc(href)}" target="_blank" rel="noopener"${title ? ` title="${esc(title)}"` : ''}>${inner}</a>`;
      // относительная ссылка на .md → внутренняя
      if (/\.md(#.*)?$/.test(href)) {
        const id = resolveLink(href.replace(/#.*$/, ''));
        return `<a class="wiki${id ? '' : ' broken'}" data-id="${esc(id || '')}" data-link="${esc(href)}">${inner}</a>`;
      }
      return `<a href="${esc(fileUrl(href))}" target="_blank">${inner}</a>`;
    },
  },
});
function fileUrl(href) {
  if (/^(https?:|data:|\/)/.test(href)) return href;
  const n = S.current; if (!n) return href;
  const dir = n.rel.includes('/') ? n.rel.slice(0, n.rel.lastIndexOf('/')) : '';
  const parts = (dir ? dir + '/' : '') + href;
  const norm = [];
  for (const p of parts.split('/')) { if (p === '..') norm.pop(); else if (p && p !== '.') norm.push(p); }
  return '/file/' + n.root + '/' + norm.map(encodeURIComponent).join('/');
}
const normKey = s => String(s).toLowerCase().replace(/-/g, '_');
function resolveLink(raw) {
  let k = normKey(raw.trim().replace(/\.md$/i, ''));
  if (S.byKey.has(k)) return S.byKey.get(k);
  const b = k.split('/').pop();
  return S.byKey.get(b) || null;
}

// ---------------- загрузка индекса ----------------
async function loadTree() {
  const t = await api('/api/tree');
  S.notes = t.notes;
  S.byId = new Map(t.notes.map(n => [n.id, n]));
  S.byKey = new Map();
  for (const n of t.notes) {
    const keys = [n.base, n.name, n.rel.replace(/\.md$/, ''), n.root === 'skills' ? n.rel.split('/')[0] : null].filter(Boolean);
    for (const k of keys) { const lk = normKey(k); if (!S.byKey.has(lk)) S.byKey.set(lk, n.id); }
  }
  $('#stat').textContent = `${t.notes.length} заметок · ${fmtSize(t.notes.reduce((a, n) => a + n.size, 0))}`;
  renderLeft();
}

// ---------------- левая панель ----------------
function renderLeft() {
  const body = $('#left-body');
  const f = S.filter.trim().toLowerCase();
  const match = n => !f || (n.title + ' ' + n.description + ' ' + n.rel).toLowerCase().includes(f);
  let html = '';
  if (S.leftView === 'tree') html = renderTree(match);
  else if (S.leftView === 'recent') html = renderList(S.notes.filter(match).sort((a, b) => new Date(b.mtime) - new Date(a.mtime)).slice(0, 80), 'по времени изменения файла');
  else if (S.leftView === 'pins') html = renderList(S.pins.map(id => S.byId.get(id)).filter(Boolean).filter(match), 'закладки') || '<div class="empty">Закладок нет. Жми ☆ на заметке.</div>';
  else if (S.leftView === 'issues') html = renderIssues(match);
  else if (S.leftView === 'facts') html = renderFactsList(match);
  body.innerHTML = html;
  markActive();
}
function itemHtml(n, extra = '') {
  const st = Object.entries(n.statuses || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s).join('');
  const cls = n.size > 60000 ? 'huge' : n.size > 20000 ? 'big' : '';
  return `<div class="item" data-id="${esc(n.id)}" title="${esc(n.description || n.rel)}">
    ${S.pins.includes(n.id) ? '<span class="pin">★</span>' : ''}
    <span class="t">${esc(n.title)}</span>
    ${st ? `<span class="st">${st}</span>` : ''}
    ${extra}
    <span class="badge ${cls}">${fmtSize(n.size)}</span>
  </div>`;
}
function renderList(list, label) {
  if (!list.length) return '';
  return `<div class="list-h">${esc(label)}</div>` + list.map(n => itemHtml(n, `<span class="d">${ago(n.mtime)}</span>`)).join('');
}
function renderTree(match) {
  // группировка: root → folder → (subfolder) → items
  const groups = {};
  for (const n of S.notes) {
    if (!match(n)) continue;
    const g = n.root === 'skills' ? 'skills' : 'vault';
    const folder = n.root === 'skills' ? '' : (n.folder || '');
    const sub = n.root === 'skills' ? '' : n.rel.split('/').slice(1, -1).join('/');
    ((groups[g] ??= {})[folder] ??= {})[sub] ??= [];
    groups[g][folder][sub].push(n);
  }
  const sortNotes = arr => arr.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  let html = '';
  const folderBlock = (key, label, content, count) => {
    const closed = S.closed.has(key) && !S.filter;
    return `<div class="folder${closed ? ' closed' : ''}" data-key="${esc(key)}"><div class="fh"><span class="tw">▼</span>${esc(label)}<span class="n">${count}</span></div><div class="fl">${content}</div></div>`;
  };
  if (groups.vault) {
    const folders = Object.keys(groups.vault).sort((a, b) => (FOLDER_ORDER.indexOf(a) + 1 || 99) - (FOLDER_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
    for (const fo of folders) {
      const subs = groups.vault[fo];
      let inner = '';
      let count = 0;
      for (const sub of Object.keys(subs).sort()) {
        const items = sortNotes(subs[sub]); count += items.length;
        const list = items.map(n => itemHtml(n)).join('');
        inner += sub ? folderBlock(`vault/${fo}/${sub}`, sub, list, items.length) : list;
      }
      html += folderBlock(`vault/${fo}`, fo || 'корень', inner, count);
    }
  }
  if (groups.skills) {
    const items = sortNotes(Object.values(groups.skills['']).flat());
    html += folderBlock('skills', 'skills (~/.claude/skills)', items.map(n => itemHtml(n)).join(''), items.length);
  }
  return html || '<div class="empty">Ничего не найдено</div>';
}
function renderIssues(match) {
  const orphans = S.notes.filter(n => match(n) && n.in === 0 && n.root === 'vault' && !n.base.startsWith('MEMORY'));
  const broken = S.notes.filter(n => match(n) && n.brokenCount > 0 && n.root === 'vault');
  const nofm = S.notes.filter(n => match(n) && !n.hasFm);
  const huge = S.notes.filter(n => match(n) && n.size > 40000).sort((a, b) => b.size - a.size);
  const stale = S.notes.filter(n => match(n) && n.root === 'vault' && (Date.now() - new Date(n.mtime)) > 120 * 86400e3).sort((a, b) => new Date(a.mtime) - new Date(b.mtime));
  let h = '';
  if (huge.length) h += `<div class="list-h">Слишком большие (>40 KB) — резать</div>` + huge.map(n => itemHtml(n, `<span class="d">${n.headings} загол.</span>`)).join('');
  if (broken.length) h += `<div class="list-h">Битые [[ссылки]]</div>` + broken.map(n => itemHtml(n, `<span class="d">${n.brokenCount} бит.</span>`)).join('');
  if (orphans.length) h += `<div class="list-h">Одиночки (никто не ссылается)</div>` + orphans.map(n => itemHtml(n)).join('');
  if (stale.length) h += `<div class="list-h">Не трогались >4 мес</div>` + stale.map(n => itemHtml(n, `<span class="d">${ago(n.mtime)}</span>`)).join('');
  if (nofm.length) h += `<div class="list-h">Без frontmatter</div>` + nofm.map(n => itemHtml(n)).join('');
  return h || '<div class="empty">Проблем нет 🎉</div>';
}
function markActive() {
  $$('#left-body .item').forEach(el => el.classList.toggle('active', !!S.current && el.dataset.id === S.current.id));
  const a = $('#left-body .item.active'); if (a) a.scrollIntoView({ block: 'nearest' });
}

// ---------------- открытие заметки ----------------
async function openNote(id, opts = {}) {
  if (S.dirty && !confirm('Есть несохранённые правки. Выйти без сохранения?')) return;
  let n;
  try { n = await api('/api/note?id=' + encodeURIComponent(id)); } catch (e) { toast('Не открылось: ' + e.message, true); return; }
  S.current = n; S.dirty = false; S.mode = 'read'; S.olFilter = null; S.fact = null;
  document.body.classList.remove('fact-mode');
  location.hash = '#/' + id + (opts.line ? ':' + opts.line : '');
  renderCenter();
  renderRight();
  markActive();
  document.title = n.title + ' — Vault';
  if (opts.line) scrollToLine(opts.line);
  else if (opts.anchor) scrollToHeadingText(opts.anchor);
  else $('#content').scrollTop = 0;
}
function renderCenter() {
  const n = S.current;
  $('#crumbs').innerHTML = n ? `${esc(n.root)} / ${n.rel.split('/').map((p, i, a) => i === a.length - 1 ? `<b>${esc(p)}</b>` : esc(p)).join(' / ')}` : '';
  $('#btn-mode-read').classList.toggle('active', S.mode === 'read');
  $('#btn-mode-edit').classList.toggle('active', S.mode !== 'read');
  $('#btn-save').hidden = S.mode === 'read';
  $('#btn-save').classList.toggle('dirty', S.dirty);
  $('#btn-pin').textContent = n && S.pins.includes(n.id) ? '★' : '☆';
  $('#btn-pin').classList.toggle('on', !!n && S.pins.includes(n.id));
  const c = $('#content');
  if (!n && S.fact) return; // открыта карточка факта — её рисует facts.js
  c.classList.toggle('editing', S.mode !== 'read');
  if (!n) { c.innerHTML = ''; return; }
  if (S.mode === 'read') {
    c.innerHTML = `<div class="doc">${docMetaHtml(n)}${n.description ? `<div class="doc-desc">${esc(n.description)}</div>` : ''}<div class="md">${renderMd(n.body)}</div></div>`;
    setupScrollSpy();
  } else {
    c.innerHTML = `<textarea id="editor" spellcheck="false"></textarea>`;
    const ed = $('#editor'); ed.value = n.raw;
    ed.addEventListener('input', () => { if (!S.dirty) { S.dirty = true; $('#btn-save').classList.add('dirty'); } });
    ed.addEventListener('keydown', e => {
      if (e.key === 'Tab') { e.preventDefault(); const s = ed.selectionStart; ed.setRangeText('  ', s, ed.selectionEnd, 'end'); }
    });
    ed.focus();
  }
}
function docMetaHtml(n) {
  const st = Object.entries(n.statuses || {}).sort((a, b) => b[1] - a[1]).map(([s, c]) => `<span class="chip">${s} ${c}</span>`).join('');
  return `<div class="doc-meta">
    <span class="chip t-${esc(n.type)}">${esc(n.type)}</span>
    <span>${fmtSize(n.size)} · ${n.lines} строк · ${n.headings.length} загол.</span>
    <span>изменён ${fmtDate(n.mtime)} (${ago(n.mtime)} назад)</span>
    ${n.lastDate ? `<span>последняя дата в тексте <b>${n.lastDate}</b></span>` : ''}
    <span>← ${n.in} · → ${n.out}${n.brokenCount ? ` · <span style="color:var(--err)">✗ ${n.brokenCount}</span>` : ''}</span>
    ${st}
  </div>`;
}
function renderMd(md) { headingCounter = 0; try { return marked.parse(md); } catch (e) { return `<pre>${esc(md)}</pre>`; } }

function scrollToLine(line) {
  // ищем ближайший заголовок с line <= нужной
  const hs = S.current.headings; let best = -1;
  for (let i = 0; i < hs.length; i++) if (hs[i].line <= line) best = i;
  if (best >= 0) scrollToHeading(best); else $('#content').scrollTop = 0;
}
function scrollToHeadingText(text) {
  const i = S.current.headings.findIndex(h => h.text.toLowerCase().includes(text.toLowerCase()));
  if (i >= 0) scrollToHeading(i);
}
function scrollToHeading(i) {
  if (S.mode !== 'read') { // в редакторе — переносим курсор на строку
    const ed = $('#editor'); const line = S.current.headings[i].line + (S.current.fmRaw ? S.current.fmRaw.split('\n').length - 1 : 0);
    const pos = ed.value.split('\n').slice(0, line - 1).join('\n').length + 1;
    ed.focus(); ed.setSelectionRange(pos, pos);
    const lh = parseFloat(getComputedStyle(ed).lineHeight) || 21; ed.scrollTop = Math.max(0, (line - 4) * lh);
    return;
  }
  const el = $('#h' + i); if (!el) return;
  el.scrollIntoView({ block: 'start' });
  el.classList.remove('hl'); void el.offsetWidth; el.classList.add('hl');
}
let spyTimer = null;
function setupScrollSpy() {
  const c = $('#content');
  c.onscroll = () => { clearTimeout(spyTimer); spyTimer = setTimeout(spy, 80); };
}
function spy() {
  if (S.mode !== 'read' || S.rightView !== 'outline') return;
  const c = $('#content'); const top = c.scrollTop + 60;
  let act = -1;
  $$('#content [data-hi]').forEach(h => { if (h.offsetTop <= top) act = +h.dataset.hi; });
  $$('#right-body .ol .h').forEach(el => el.classList.toggle('active', +el.dataset.i === act));
}

// ---------------- правая панель ----------------
function renderRight() {
  const b = $('#right-body'); const n = S.current;
  $$('.right-tabs button').forEach(x => x.classList.toggle('active', x.dataset.rv === S.rightView));
  if (!n && S.fact) return renderFactRight(b);
  if (!n) { b.innerHTML = '<div class="empty">Открой заметку</div>'; return; }
  if (S.rightView === 'outline') {
    const counts = {};
    for (const h of n.headings) if (h.status) counts[h.status] = (counts[h.status] || 0) + 1;
    const chips = Object.entries(counts).sort((a, c) => c[1] - a[1]);
    const dateCount = n.headings.filter(h => h.date).length;
    let html = '';
    if (chips.length || dateCount) {
      html += `<div class="ol-filter"><button data-f="" class="${S.olFilter ? '' : 'active'}">все<span class="c">${n.headings.length}</span></button>`;
      html += chips.map(([s, c]) => `<button data-f="${esc(s)}" class="${S.olFilter === s ? 'active' : ''}">${s}<span class="c">${c}</span></button>`).join('');
      if (dateCount) html += `<button data-f="@date" class="${S.olFilter === '@date' ? 'active' : ''}">по дате<span class="c">${dateCount}</span></button>`;
      html += '</div>';
    }
    let list = n.headings.map((h, i) => ({ ...h, i }));
    if (S.olFilter === '@date') list = list.filter(h => h.date).sort((a, c) => c.date.localeCompare(a.date));
    html += '<div class="ol">' + (list.length ? list.map(h => {
      const dim = S.olFilter && S.olFilter !== '@date' && h.status !== S.olFilter && h.level > 1;
      const text = h.text.replace(/^\S+\s+/, m => h.status ? '' : m); // убираем статус-эмодзи из текста
      return `<div class="h l${h.level}${dim ? ' dim' : ''}" data-i="${h.i}" title="${esc(h.text)}"><span class="s">${h.status || ''}</span>${h.date ? `<span class="dt">${h.date.slice(5).split('-').reverse().join('.')}</span>` : ''}<span class="tx">${esc(text)}</span></div>`;
    }).join('') : '<div class="empty">Заголовков нет</div>') + '</div>';
    b.innerHTML = html;
    spy();
  } else if (S.rightView === 'links') {
    const grp = (label, arr, extra) => `<div class="list-h">${label} (${arr.length})</div><div class="linkgroup">${arr.length ? arr.map(x => itemHtml(x)).join('') : '<div class="empty">—</div>'}</div>`;
    b.innerHTML = grp('← Ссылаются на эту', n.backlinks) + grp('→ Эта ссылается на', n.outlinks) +
      (n.broken.length ? `<div class="list-h" style="color:var(--err)">✗ Битые ссылки (${n.broken.length})</div><div class="linkgroup">${n.broken.map(l => `<div class="item" title="нет такой заметки"><span class="t" style="color:var(--err)">[[${esc(l)}]]</span></div>`).join('')}</div>` : '') +
      `<div class="rmeta">${Object.entries(n.fm).filter(([k]) => !k.includes('.') && k !== 'metadata').map(([k, v]) => `<b>${esc(k)}</b>: ${esc(v).slice(0, 120)}<br>`).join('')}<b>файл</b>: ${esc(n.rel)}<br><b>mtime</b>: ${esc(new Date(n.mtime).toLocaleString('ru-RU'))}</div>`;
  } else if (S.rightView === 'local') {
    b.innerHTML = '<div class="right-canvas-wrap"><canvas id="local-canvas"></canvas></div>';
    const ids = new Set([n.id, ...n.backlinks.map(x => x.id), ...n.outlinks.map(x => x.id)]);
    // соседи соседей — одним уровнем глубже, но только связи между уже выбранными
    const nodes = [...ids].map(id => S.byId.get(id)).filter(Boolean);
    const edges = [];
    for (const x of nodes) {
      if (x.id === n.id) { for (const o of n.outlinks) edges.push({ s: n.id, t: o.id }); for (const o of n.backlinks) edges.push({ s: o.id, t: n.id }); }
    }
    startGraph($('#local-canvas'), nodes, edges, { center: n.id, small: true });
  }
}

// ---------------- сохранение / создание / прочее ----------------
async function save() {
  if (!S.current || S.mode === 'read') return;
  const content = $('#editor').value;
  try {
    await post('/api/save', { id: S.current.id, content });
    S.dirty = false; $('#btn-save').classList.remove('dirty');
    toast('Сохранено');
    const id = S.current.id; const ed = $('#editor'); const st = ed.scrollTop, ss = ed.selectionStart;
    await loadTree();
    const n = await api('/api/note?id=' + encodeURIComponent(id)); S.current = n;
    renderRight();
    // остаёмся в редакторе
    if ($('#editor')) { $('#editor').scrollTop = st; $('#editor').setSelectionRange(ss, ss); }
  } catch (e) { toast('Ошибка сохранения: ' + e.message, true); }
}
function setMode(m) {
  if (m === S.mode) return;
  if (S.mode !== 'read' && S.dirty && !confirm('Есть несохранённые правки. Отбросить?')) return;
  S.dirty = false; S.mode = m; renderCenter(); renderRight();
}
async function createNote() {
  const cur = S.current;
  const defFolder = cur && cur.root === 'vault' ? cur.folder : 'project';
  const name = prompt(`Имя новой заметки (папка vault/${defFolder}; чтобы в другую — "reference/имя"; для скилла — "skills/имя"):`);
  if (!name) return;
  let root = 'vault', folder = defFolder, base = name.trim();
  if (base.includes('/')) { const [a, ...r] = base.split('/'); if (a === 'skills') { root = 'skills'; folder = ''; } else folder = a; base = r.join('/'); }
  try {
    const r = await post('/api/create', { root, folder, name: base, type: folder });
    await loadTree(); await openNote(r.id); setMode('edit');
    toast('Создано. Не забудь строку в MEMORY.md');
  } catch (e) { toast('Не создалось: ' + e.message, true); }
}
async function renameNote() {
  if (!S.current) return;
  const name = prompt('Новое имя файла (без .md):', S.current.base);
  if (!name || name === S.current.base) return;
  try { const r = await post('/api/rename', { id: S.current.id, name }); await loadTree(); await openNote(r.id); toast('Переименовано. [[ссылки]] на старое имя — проверь во вкладке Проблемы'); }
  catch (e) { toast('Не вышло: ' + e.message, true); }
}
async function deleteNote() {
  if (!S.current) return;
  if (!confirm(`Убрать «${S.current.title}» в корзину (claude-vault/.trash)?`)) return;
  try { await post('/api/delete', { id: S.current.id }); S.current = null; S.dirty = false; await loadTree(); goHome(); toast('Перенесено в .trash'); }
  catch (e) { toast('Не вышло: ' + e.message, true); }
}
function togglePin() {
  if (!S.current) return;
  const i = S.pins.indexOf(S.current.id);
  if (i >= 0) S.pins.splice(i, 1); else S.pins.unshift(S.current.id);
  localStorage.setItem('pins', JSON.stringify(S.pins));
  renderCenter(); renderLeft();
}
function goHome() {
  const home = S.byKey.get('memory');
  if (home) openNote(home); else { S.current = null; renderCenter(); renderRight(); }
}
let toastT = null;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, err ? 5000 : 2200);
}

// ---------------- палитра / поиск ----------------
let palTimer = null;
function openPalette(prefill = '') {
  $('#palette').hidden = false;
  const i = $('#palette-input'); i.value = prefill; i.focus(); i.select();
  palSearch();
}
function closePalette() { $('#palette').hidden = true; }
async function palSearch() {
  const q = $('#palette-input').value.trim();
  const box = $('#palette-results');
  S.palIdx = 0;
  if (!q) {
    S.palItems = S.notes.slice().sort((a, b) => new Date(b.mtime) - new Date(a.mtime)).slice(0, 15).map(n => ({ kind: 'note', n }));
    box.innerHTML = '<div class="list-h">Недавние</div>' + S.palItems.map((it, i) => palRow(it, i)).join('');
    return;
  }
  if (q.startsWith('>')) {
    const cmds = [
      { t: 'Новая заметка', f: createNote }, { t: 'Граф связей', f: openGraph }, { t: 'Переименовать текущую', f: renameNote },
      { t: 'В корзину текущую', f: deleteNote }, { t: 'Пересобрать индекс', f: async () => { await api('/api/rebuild'); await loadTree(); toast('Индекс пересобран'); } },
      { t: 'Переключить тему', f: toggleTheme }, { t: 'Скрыть/показать правую панель', f: () => document.body.classList.toggle('hide-right') },
      { t: 'Открыть файл во внешнем редакторе', f: () => S.current && api('/api/open-external?id=' + encodeURIComponent(S.current.id)) },
    ].filter(c => c.t.toLowerCase().includes(q.slice(1).trim().toLowerCase()));
    S.palItems = cmds.map(c => ({ kind: 'cmd', c }));
    box.innerHTML = S.palItems.map((it, i) => palRow(it, i)).join('') || '<div class="empty">Нет команды</div>';
    return;
  }
  // быстрый локальный матч по имени + серверный полнотекст
  const ql = q.toLowerCase();
  const local = S.notes.filter(n => (n.title + ' ' + n.description).toLowerCase().includes(ql)).slice(0, 8).map(n => ({ kind: 'note', n }));
  S.palItems = local;
  box.innerHTML = local.map((it, i) => palRow(it, i)).join('') + '<div class="empty">ищу в тексте…</div>';
  const res = await api('/api/search?q=' + encodeURIComponent(q));
  if ($('#palette-input').value.trim() !== q) return;
  const seen = new Set(local.map(x => x.n.id));
  const rest = res.filter(r => !seen.has(r.id)).map(r => ({ kind: 'hit', n: r }));
  S.palItems = [...local, ...rest];
  box.innerHTML = S.palItems.map((it, i) => palRow(it, i, q)).join('') || '<div class="empty">Ничего</div>';
}
function palRow(it, i, q = '') {
  const act = i === S.palIdx ? ' active' : '';
  if (it.kind === 'cmd') return `<div class="pr cmd${act}" data-i="${i}">› ${esc(it.c.t)}</div>`;
  const n = it.n;
  const hl = s => q ? esc(s).replace(new RegExp(q.split(/\s+/).filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi'), m => `<mark>${m}</mark>`) : esc(s);
  const sn = it.kind === 'hit' && n.snippets ? n.snippets.map(s => `<div class="sn"><span class="ln">:${s.line}</span>${hl(s.text)}</div>`).join('') : (n.description ? `<div class="sn">${hl(n.description)}</div>` : '');
  return `<div class="pr${act}" data-i="${i}"><div class="t"><span class="n">${hl(n.title)}</span><span class="p">${esc(n.rel)}</span><span class="p">${fmtSize(n.size)}</span></div>${sn}</div>`;
}
function palGo(i) {
  const it = S.palItems[i]; if (!it) return;
  closePalette();
  if (it.kind === 'cmd') return it.c.f();
  const line = it.kind === 'hit' && it.n.snippets && it.n.snippets[0] ? it.n.snippets[0].line : 0;
  openNote(it.n.id, { line });
}

// ---------------- граф ----------------
let G = null; // текущая симуляция
function startGraph(canvas, nodes, edges, opts = {}) {
  if (G) { G.stop(); G = null; }
  const ctx = canvas.getContext('2d');
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const fit = () => { const r = wrap.getBoundingClientRect(); canvas.width = r.width * dpr; canvas.height = r.height * dpr; canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px'; };
  fit();
  const W = () => canvas.width / dpr, H = () => canvas.height / dpr;
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const deg = new Map(); for (const e of edges) { deg.set(e.s, (deg.get(e.s) || 0) + 1); deg.set(e.t, (deg.get(e.t) || 0) + 1); }
  const P = nodes.map((n, i) => ({ id: n.id, title: n.title, type: n.type, r: 3 + Math.min(10, Math.sqrt((deg.get(n.id) || 0) * 2)),
    x: W() / 2 + (Math.random() - .5) * W() * .6, y: H() / 2 + (Math.random() - .5) * H() * .6, vx: 0, vy: 0, fixed: false }));
  const E = edges.map(e => [idx.get(e.s), idx.get(e.t)]).filter(([a, b]) => a !== undefined && b !== undefined);
  if (opts.center !== undefined) { const c = P[idx.get(opts.center)]; if (c) { c.x = W() / 2; c.y = H() / 2; c.fixed = true; } }
  let alpha = 1, tx = 0, ty = 0, zoom = opts.small ? 1 : 0.9, hover = -1, drag = -1, panning = null, hlSet = null, showOrphans = true;
  const orphan = i => !E.some(([a, b]) => a === i || b === i);
  const K = opts.small ? 90 : 60; // желаемая длина ребра
  function step() {
    // отталкивание (O(n²), n≈150 — ок)
    for (let i = 0; i < P.length; i++) { const a = P[i]; if (!showOrphans && orphan(i)) continue; for (let j = i + 1; j < P.length; j++) { const b = P[j]; if (!showOrphans && orphan(j)) continue;
      let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy + 0.01; if (d2 > 250000) continue; const f = (K * K * 0.35) / d2; const d = Math.sqrt(d2); dx /= d; dy /= d;
      a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f; } }
    // притяжение по рёбрам
    for (const [i, j] of E) { const a = P[i], b = P[j]; const dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) + .01; const f = (d - K) * 0.02; a.vx += dx / d * f; a.vy += dy / d * f; b.vx -= dx / d * f; b.vy -= dy / d * f; }
    // к центру
    for (const p of P) { p.vx += (W() / 2 - p.x) * 0.002; p.vy += (H() / 2 - p.y) * 0.002; }
    for (const p of P) { if (p.fixed) { p.vx = p.vy = 0; continue; } p.vx *= 0.75; p.vy *= 0.75; p.x += p.vx * alpha; p.y += p.vy * alpha; }
    alpha = Math.max(0.05, alpha * 0.995);
  }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W(), H());
    ctx.save(); ctx.translate(tx, ty); ctx.scale(zoom, zoom);
    const css = getComputedStyle(document.documentElement);
    const lineC = css.getPropertyValue('--line').trim(), fgC = css.getPropertyValue('--fg').trim(), fg3 = css.getPropertyValue('--fg3').trim();
    const neighbors = new Set(); if (hover >= 0) { neighbors.add(hover); for (const [a, b] of E) { if (a === hover) neighbors.add(b); if (b === hover) neighbors.add(a); } }
    ctx.lineWidth = 1 / zoom;
    for (const [i, j] of E) { const a = P[i], b = P[j]; const on = hover < 0 || (neighbors.has(i) && neighbors.has(j) && (i === hover || j === hover)); ctx.strokeStyle = on ? (hover >= 0 ? fg3 : lineC) : lineC; ctx.globalAlpha = hover >= 0 && !on ? .15 : 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    ctx.globalAlpha = 1;
    for (let i = 0; i < P.length; i++) { const p = P[i]; if (!showOrphans && orphan(i)) continue;
      const dimmed = (hover >= 0 && !neighbors.has(i)) || (hlSet && !hlSet.has(i));
      ctx.globalAlpha = dimmed ? .18 : 1; ctx.fillStyle = TYPE_COLOR[p.type] || '#a3a5b0';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r + (i === hover ? 2 : 0), 0, Math.PI * 2); ctx.fill();
      if (opts.center === p.id) { ctx.strokeStyle = fgC; ctx.lineWidth = 2 / zoom; ctx.stroke(); }
      const showLabel = opts.small || zoom > 1.1 || p.r > 6 || i === hover || (hlSet && hlSet.has(i)) || neighbors.has(i);
      if (showLabel) { ctx.fillStyle = fgC; ctx.font = `${(opts.small ? 11 : 11) / zoom}px ${css.getPropertyValue('--sans')}`; ctx.fillText(p.title.length > 34 ? p.title.slice(0, 32) + '…' : p.title, p.x + p.r + 3, p.y + 4 / zoom); }
    }
    ctx.globalAlpha = 1; ctx.restore();
  }
  let raf;
  function loop() { step(); draw(); raf = requestAnimationFrame(loop); }
  loop();
  const toWorld = (mx, my) => [(mx - tx) / zoom, (my - ty) / zoom];
  const hit = (mx, my) => { const [x, y] = toWorld(mx, my); let best = -1, bd = 1e9; for (let i = 0; i < P.length; i++) { if (!showOrphans && orphan(i)) continue; const p = P[i]; const d = Math.hypot(p.x - x, p.y - y); if (d < p.r + 6 / zoom && d < bd) { bd = d; best = i; } } return best; };
  const pos = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.onmousemove = e => { const [mx, my] = pos(e);
    if (drag >= 0) { const [x, y] = toWorld(mx, my); P[drag].x = x; P[drag].y = y; alpha = Math.max(alpha, .3); return; }
    if (panning) { tx = panning.tx + (mx - panning.mx); ty = panning.ty + (my - panning.my); return; }
    hover = hit(mx, my); canvas.style.cursor = hover >= 0 ? 'pointer' : 'grab'; canvas.title = hover >= 0 ? P[hover].title : ''; };
  canvas.onmousedown = e => { const [mx, my] = pos(e); const h = hit(mx, my); if (h >= 0) { drag = h; P[h].fixed = true; } else panning = { mx, my, tx, ty }; };
  window.addEventListener('mouseup', e => { if (drag >= 0) { const p = P[drag]; if (p.id !== opts.center) p.fixed = false; drag = -1; } panning = null; });
  canvas.onclick = e => { const [mx, my] = pos(e); const h = hit(mx, my); if (h >= 0 && (!G || !G.moved)) { if (!opts.small) closeGraph(); openNote(P[h].id); } };
  canvas.onwheel = e => { e.preventDefault(); const [mx, my] = pos(e); const z = Math.min(4, Math.max(.2, zoom * (e.deltaY < 0 ? 1.12 : .89))); tx = mx - (mx - tx) * z / zoom; ty = my - (my - ty) * z / zoom; zoom = z; };
  const ro = new ResizeObserver(fit); ro.observe(wrap);
  G = { stop() { cancelAnimationFrame(raf); ro.disconnect(); }, highlight(q) { q = q.trim().toLowerCase(); hlSet = q ? new Set(P.map((p, i) => p.title.toLowerCase().includes(q) ? i : -1).filter(i => i >= 0)) : null; }, orphans(v) { showOrphans = v; alpha = 1; } };
  return G;
}
async function openGraph() {
  $('#graph').hidden = false;
  const g = await api('/api/graph');
  startGraph($('#graph-canvas'), g.nodes, g.edges);
  $('#graph-legend').innerHTML = Object.entries(TYPE_COLOR).filter(([t]) => g.nodes.some(n => n.type === t)).map(([t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join('') + `<span style="margin-left:auto">${g.nodes.length} узлов · ${g.edges.length} связей · колесо — зум, тянуть — двигать</span>`;
  $('#graph-filter').value = ''; $('#graph-filter').focus();
}
function closeGraph() { $('#graph').hidden = true; if (G) { G.stop(); G = null; } if (S.rightView === 'local') renderRight(); }
function toggleTheme() {
  const cur = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = cur; localStorage.setItem('theme', cur);
}

// ---------------- события ----------------
function bind() {
  document.documentElement.dataset.theme = localStorage.getItem('theme') || 'dark';
  $('#filter').addEventListener('input', e => { S.filter = e.target.value; renderLeft(); });
  $('#filter').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; S.filter = ''; renderLeft(); } if (e.key === 'Enter') { const f = $('#left-body .item'); if (f) openNote(f.dataset.id); } });
  $$('.left-tabs button').forEach(b => b.addEventListener('click', () => { S.leftView = b.dataset.view; $$('.left-tabs button').forEach(x => x.classList.toggle('active', x === b)); renderLeft(); }));
  $$('.right-tabs button').forEach(b => b.addEventListener('click', () => { S.rightView = b.dataset.rv; renderRight(); }));
  $('#left-body').addEventListener('click', e => {
    const fh = e.target.closest('.fh');
    if (fh) { const f = fh.parentElement; f.classList.toggle('closed'); const k = f.dataset.key; if (f.classList.contains('closed')) S.closed.add(k); else S.closed.delete(k); localStorage.setItem('closed', JSON.stringify([...S.closed])); return; }
    const it = e.target.closest('.item'); if (it && it.dataset.id) openNote(it.dataset.id);
  });
  $('#right-body').addEventListener('click', e => {
    const f = e.target.closest('.ol-filter button'); if (f) { S.olFilter = f.dataset.f || null; renderRight(); return; }
    const h = e.target.closest('.ol .h'); if (h) { scrollToHeading(+h.dataset.i); return; }
    const it = e.target.closest('.item'); if (it && it.dataset.id) openNote(it.dataset.id);
  });
  $('#content').addEventListener('click', e => {
    const a = e.target.closest('a.wiki'); if (!a) return;
    e.preventDefault();
    if (a.dataset.id) openNote(a.dataset.id, { anchor: a.dataset.anchor || '' });
    else if (confirm(`Заметки «${a.dataset.link}» нет. Создать в vault/project?`)) post('/api/create', { root: 'vault', folder: 'project', name: a.dataset.link, type: 'project' }).then(r => loadTree().then(() => openNote(r.id))).catch(err => toast(err.message, true));
  });
  $('#btn-home').onclick = goHome;
  $('#btn-new').onclick = createNote;
  $('#btn-graph').onclick = openGraph;
  $('#btn-theme').onclick = toggleTheme;
  $('#btn-mode-read').onclick = () => setMode('read');
  $('#btn-mode-edit').onclick = () => setMode('edit');
  $('#btn-save').onclick = save;
  $('#btn-pin').onclick = togglePin;
  $('#btn-more').onclick = e => showMenu(e.currentTarget);
  $('#graph-close').onclick = closeGraph;
  $('#graph-filter').addEventListener('input', e => G && G.highlight(e.target.value));
  $('#graph-orphans').addEventListener('change', e => G && G.orphans(e.target.checked));
  $('#graph').addEventListener('click', e => { if (e.target.id === 'graph') closeGraph(); });
  $('#palette').addEventListener('click', e => { if (e.target.id === 'palette') closePalette(); });
  $('#palette-input').addEventListener('input', () => { clearTimeout(palTimer); palTimer = setTimeout(palSearch, 120); });
  $('#palette-input').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); S.palIdx = Math.min(S.palItems.length - 1, S.palIdx + 1); palPaint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); S.palIdx = Math.max(0, S.palIdx - 1); palPaint(); }
    else if (e.key === 'Enter') { e.preventDefault(); palGo(S.palIdx); }
    else if (e.key === 'Escape') closePalette();
  });
  $('#palette-results').addEventListener('click', e => { const r = e.target.closest('.pr'); if (r) palGo(+r.dataset.i); });
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); setMode(S.mode === 'read' ? 'edit' : 'read'); }
    else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); createNote(); }
    else if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); $('#graph').hidden ? openGraph() : closeGraph(); }
    else if (mod && e.key === '\\') { e.preventDefault(); document.body.classList.toggle('hide-right'); }
    else if (e.key === 'Escape') { if (!$('#graph').hidden) closeGraph(); else if (!$('#palette').hidden) closePalette(); else $$('.menu').forEach(m => m.remove()); }
  });
  window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('hashchange', routeFromHash);
  // авто-обновление индекса, если файлы поменяли извне (Claude пишет в память)
  setInterval(async () => {
    try { const t = await api('/api/tree'); const cur = S.current;
      if (window.onTreeFacts) window.onTreeFacts(t.facts);
      if (document.body.classList.contains('offline')) { document.body.classList.remove('offline'); toast('Сервер Vault снова на связи'); }
      if (t.notes.length !== S.notes.length || t.notes.some(n => { const o = S.byId.get(n.id); return !o || o.mtime !== n.mtime; })) {
        await loadTree();
        if (cur && S.mode === 'read') { const fresh = S.byId.get(cur.id); if (fresh && fresh.mtime !== cur.mtime) { const n = await api('/api/note?id=' + encodeURIComponent(cur.id)); const st = $('#content').scrollTop; S.current = n; renderCenter(); renderRight(); $('#content').scrollTop = st; toast('Заметка обновилась на диске'); } }
      } } catch { document.body.classList.add('offline'); }
  }, 4000);
}
function palPaint() { $$('#palette-results .pr').forEach(el => el.classList.toggle('active', +el.dataset.i === S.palIdx)); const a = $('#palette-results .pr.active'); if (a) a.scrollIntoView({ block: 'nearest' }); }
function showMenu(btn) {
  $$('.menu').forEach(m => m.remove());
  const m = document.createElement('div'); m.className = 'menu';
  const r = btn.getBoundingClientRect(); m.style.top = r.bottom + 4 + 'px'; m.style.right = (window.innerWidth - r.right) + 'px';
  const items = [
    ['Скопировать [[wikilink]]', () => { navigator.clipboard.writeText(`[[${S.current.base}]]`); toast('Скопировано'); }],
    ['Скопировать путь', () => { navigator.clipboard.writeText(`~/${S.current.root === 'vault' ? 'claude-vault' : '.claude/skills'}/${S.current.rel}`); toast('Скопировано'); }],
    ['Открыть во внешнем редакторе', () => api('/api/open-external?id=' + encodeURIComponent(S.current.id))],
    null,
    ['Переименовать', renameNote],
    ['Показать/скрыть правую панель (Ctrl+\\)', () => document.body.classList.toggle('hide-right')],
    null,
    ['В корзину', deleteNote, 'danger'],
  ];
  for (const it of items) { if (!it) { m.appendChild(document.createElement('hr')); continue; } const b = document.createElement('button'); b.textContent = it[0]; if (it[2]) b.className = it[2]; b.onclick = () => { m.remove(); if (S.current) it[1](); }; m.appendChild(b); }
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('click', function h(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', h); } }), 0);
}
function routeFromHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (!h) return goHome();
  if (h.startsWith('fact/')) { const fid = h.slice(5); if (!S.fact || S.fact.id !== fid) openFact(fid); return; }
  const [id, line] = h.split(':');
  if (S.current && S.current.id === id) return;
  if (S.byId.has(id)) openNote(id, { line: line ? +line : 0 }); else goHome();
}

(async function main() {
  bind();
  await loadTree();
  routeFromHash();
})();
