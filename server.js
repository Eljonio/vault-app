#!/usr/bin/env node
// Vault — личный Obsidian под себя. Читает/пишет markdown прямо на диске.
// Без внешних зависимостей: чистый node http + fs.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.VAULT_PORT || 4040);
const HOME = os.homedir();
// кто правит факты из веба (поле by в истории): VAULT_USER или имя пользователя ОС
const WEB_USER = process.env.VAULT_USER || (() => { try { return os.userInfo().username; } catch { return 'web'; } })();
// Корни: id → абсолютный путь. Всё, что показываем, лежит внутри них.
const ROOTS = {
  vault: process.env.VAULT_DIR || path.join(HOME, 'claude-vault'),
  skills: process.env.SKILLS_DIR || path.join(HOME, '.claude', 'skills'),
};
const PUBLIC = path.join(__dirname, 'public');
process.env.VAULT_DIR = ROOTS.vault; // lib/facts читает отсюда
const facts = require('./lib/facts');
const IGNORE_DIRS = new Set(['.obsidian', 'node_modules', '.git', 'synced']);

// ---------- утилиты ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

// id вида "vault/project/project_acme.md" → абсолютный путь (с защитой от выхода за корень)
function resolveId(id) {
  if (!id) return null;
  const [rootKey, ...rest] = id.split('/');
  const root = ROOTS[rootKey];
  if (!root) return null;
  const abs = path.resolve(root, ...rest);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: text, fmRaw: '' };
  const fm = {};
  let lastKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    const nested = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (top) {
      lastKey = top[1];
      fm[lastKey] = top[2].replace(/^["']|["']$/g, '').trim();
    } else if (nested && lastKey) {
      // metadata.type → пробрасываем наверх, если верхнего нет
      const k = nested[1], v = nested[2].replace(/^["']|["']$/g, '').trim();
      fm[`${lastKey}.${k}`] = v;
      if (fm[k] === undefined || fm[k] === '') fm[k] = v;
    }
  }
  return { fm, body: text.slice(m[0].length), fmRaw: m[0] };
}

const WIKI_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MDLINK_RE = /\[[^\]]*\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g;
// ключ для резолва ссылок: регистр и дефис/подчёркивание не важны ([[feedback-modal-pattern]] == feedback_modal_pattern.md)
const normKey = s => String(s).toLowerCase().replace(/-/g, '_');
// Связи заметки: [[wiki]] и [текст](path.md); внутри ``` ``` и `code` — это текст, а не ссылка
function extractLinks(body) {
  const clean = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const out = [];
  let m;
  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(clean))) out.push(m[1].trim());
  MDLINK_RE.lastIndex = 0;
  while ((m = MDLINK_RE.exec(clean))) { try { out.push(decodeURIComponent(m[1])); } catch { out.push(m[1]); } }
  return out;
}
const HEAD_RE = /^(#{1,6})\s+(.*)$/gm;
const DATE_RE = /(\d{1,2})(?:[–-]\d{1,2})?\.(\d{1,2})\.(\d{4})/;
const ISO_RE = /(\d{4})-(\d{2})-(\d{2})/;
const STATUS_RE = /^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}][\u{FE0F}]?)/u;

function extractHeadings(body) {
  const out = [];
  let m;
  HEAD_RE.lastIndex = 0;
  // пропускаем заголовки внутри fenced code
  const lines = body.split('\n');
  let inCode = false, lineNo = 0;
  for (const raw of lines) {
    lineNo++;
    if (/^```/.test(raw)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (!h) continue;
    const text = h[2].trim();
    const st = text.match(STATUS_RE);
    const d = text.match(DATE_RE);
    const iso = !d && text.match(ISO_RE);
    out.push({
      level: h[1].length, text, line: lineNo,
      status: st ? st[1] : null,
      date: d ? `${d[3]}-${d[2].padStart(2, '0')}-${d[1].padStart(2, '0')}` : iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null,
    });
  }
  return out;
}

// ---------- индекс ----------
let INDEX = { notes: [], byId: new Map(), byKey: new Map(), builtAt: 0 };

function walk(rootKey, dir, rel, acc) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    if (IGNORE_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(rootKey, abs, r, acc);
    else if (e.isFile() && /\.md$/i.test(e.name)) {
      // для skills берём только SKILL.md (references/ внутри навыков — шум)
      if (rootKey === 'skills' && e.name !== 'SKILL.md') continue;
      acc.push({ rootKey, abs, rel: r });
    }
  }
}

function buildIndex() {
  const files = [];
  for (const k of Object.keys(ROOTS)) walk(k, ROOTS[k], '', files);
  const notes = [];
  const byId = new Map(), byKey = new Map();
  for (const f of files) {
    let text, st;
    try { text = fs.readFileSync(f.abs, 'utf8'); st = fs.statSync(f.abs); } catch { continue; }
    const { fm, body } = parseFrontmatter(text);
    const id = `${f.rootKey}/${f.rel}`;
    const base = path.basename(f.rel, '.md');
    const folder = f.rel.includes('/') ? f.rel.split('/')[0] : '';
    const links = extractLinks(body);
    const headings = extractHeadings(body);
    const dates = headings.map(h => h.date).filter(Boolean).sort();
    const title = f.rootKey === 'skills' && base === 'SKILL' ? (fm.name || f.rel.split('/')[0]) : (fm.name || base);
    const note = {
      id, abs: f.abs, root: f.rootKey, rel: f.rel, base, folder, title,
      name: fm.name || base,
      description: fm.description || '',
      type: fm.type || (f.rootKey === 'skills' ? 'skill' : folder || 'note'),
      modified: fm.modified || st.mtime.toISOString(),
      mtime: st.mtime.toISOString(),
      size: st.size,
      lines: text.split('\n').length,
      links, headings: headings.length,
      lastDate: dates.length ? dates[dates.length - 1] : null,
      firstDate: dates.length ? dates[0] : null,
      statuses: countStatuses(headings),
      hasFm: Object.keys(fm).length > 0 || /^MEMORY/.test(base),
      factRefs: facts.refIds(body),
      hasDate: /Последнее обновление/i.test(body),
    };
    notes.push(note);
    byId.set(id, note);
    // ключи для резолва wikilink: basename, name, для skill — имя папки
    for (const key of new Set([base, fm.name, f.rootKey === 'skills' ? f.rel.split('/')[0] : null, f.rel.replace(/\.md$/, '')].filter(Boolean))) {
      const lk = normKey(key);
      if (!byKey.has(lk)) byKey.set(lk, note.id);
    }
  }
  // backlinks
  const inbound = new Map();
  for (const n of notes) {
    n.outIds = [];
    n.broken = [];
    for (const l of new Set(n.links)) {
      const target = resolveLink(l, byKey);
      if (target && target !== n.id) {
        n.outIds.push(target);
        if (!inbound.has(target)) inbound.set(target, new Set());
        inbound.get(target).add(n.id);
      } else if (!target) n.broken.push(l);
    }
  }
  for (const n of notes) n.inIds = [...(inbound.get(n.id) || [])];
  INDEX = { notes, byId, byKey, builtAt: Date.now() };
  return INDEX;
}

function countStatuses(headings) {
  const c = {};
  for (const h of headings) if (h.status) c[h.status] = (c[h.status] || 0) + 1;
  return c;
}

function resolveLink(raw, byKey = INDEX.byKey) {
  let k = normKey(raw.trim().replace(/\.md$/i, ''));
  if (byKey.has(k)) return byKey.get(k);
  const base = k.split('/').pop();
  if (byKey.has(base)) return byKey.get(base);
  return null;
}

function publicNote(n) {
  const { outIds, inIds, abs, ...rest } = n;
  return { ...rest, out: outIds.length, in: inIds.length, brokenCount: n.broken.length };
}

// Пересборка индекса по изменению файлов (debounce)
let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { try { buildIndex(); } catch (e) { console.error('rebuild', e); } }, 400);
}
for (const k of Object.keys(ROOTS)) {
  try { fs.watch(ROOTS[k], { recursive: true }, scheduleRebuild); } catch (e) { console.warn('watch failed', ROOTS[k], e.message); }
}

// ---------- API ----------
function apiTree() {
  return {
    roots: Object.keys(ROOTS).map(k => ({ key: k, path: ROOTS[k] })),
    notes: INDEX.notes.map(publicNote),
    builtAt: INDEX.builtAt,
    facts: factsSummary(),
  };
}

// ---------- факты ----------
function factsSummary() {
  try { const a = facts.all(); return { mtime: facts.mtime(), count: a.length, stale: a.filter(f => f.stale).length }; }
  catch (e) { return { mtime: 0, count: 0, stale: 0, error: e.message }; }
}
function apiFacts(all) {
  return facts.all({ archived: !!all }).map(({ history, ...f }) => ({ ...f, events: (history || []).length, refs: refsOf(f.id).length }));
}
function refsOf(id) { return INDEX.notes.filter(n => (n.factRefs || []).includes(id)).map(publicNote); }
function apiFact(id) {
  const f = facts.get(id);
  return f ? { ...f, refs: refsOf(id) } : null;
}
function apiFactSet(b) {
  const { id, ok, archive, ...fields } = b || {};
  if (archive) return facts.archive(id, fields.why);
  const clean = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) clean[k] = v;
  if (!clean.by && (ok || ['status', 'value', 'state', 'since', 'src'].some(k => k in clean))) clean.by = `${WEB_USER} (веб :${PORT})`;
  return facts.set(id, clean, { ok: !!ok });
}

function apiNote(id) {
  const abs = resolveId(id);
  const n = INDEX.byId.get(id);
  if (!abs || !n) return null;
  const text = fs.readFileSync(abs, 'utf8');
  const { fm, body, fmRaw } = parseFrontmatter(text);
  const headings = extractHeadings(body);
  return {
    ...publicNote(n), fm, fmRaw, body, raw: text, headings,
    outlinks: n.outIds.map(i => INDEX.byId.get(i)).filter(Boolean).map(publicNote),
    backlinks: n.inIds.map(i => INDEX.byId.get(i)).filter(Boolean).map(publicNote),
    broken: n.broken,
  };
}

function apiSearch(q, limit = 60) {
  q = (q || '').trim();
  if (!q) return [];
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  for (const n of INDEX.notes) {
    let text;
    try { text = fs.readFileSync(n.abs, 'utf8'); } catch { continue; }
    const low = text.toLowerCase();
    const titleLow = (n.title + ' ' + n.description).toLowerCase();
    // AND: каждое слово должно быть в файле (или в заголовке/описании)
    if (!terms.every(t => low.includes(t) || titleLow.includes(t))) continue;

    // Ранг считаем по СТРОКАМ, а не по числу вхождений в файле: иначе побеждает
    // самый большой файл просто потому, что он большой.
    const lines = text.split('\n');
    const hits = [];            // строки с несколькими словами запроса
    let bestOnLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const ll = lines[i].toLowerCase();
      let k = 0;
      for (const t of terms) if (ll.includes(t)) k++;
      if (k >= 2 || (terms.length === 1 && k === 1)) {
        hits.push({ line: i + 1, text: lines[i].trim().slice(0, 220), k });
        if (k > bestOnLine) bestOnLine = k;
      }
    }
    hits.sort((a, b) => b.k - a.k || a.line - b.line);

    // Близость: где слова запроса стоят кучнее, там и смысл. Ищем самое узкое окно строк,
    // внутри которого встретились ВСЕ слова. Без этого «слова есть где-то в файле» побеждает
    // размером файла, а не смыслом.
    const pos = terms.map(t => {
      const ls = [];
      for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(t)) ls.push(i);
      return ls;
    });
    let window = Infinity;
    if (pos.every(ls => ls.length)) {
      const flat = [];
      pos.forEach((ls, ti) => ls.forEach(l => flat.push([l, ti])));
      flat.sort((a, b) => a[0] - b[0]);
      const need = terms.length, seen = new Array(need).fill(0);
      let have = 0, lo = 0;
      for (let hi = 0; hi < flat.length; hi++) {
        if (seen[flat[hi][1]]++ === 0) have++;
        while (have === need) {
          window = Math.min(window, flat[hi][0] - flat[lo][0]);
          if (--seen[flat[lo][1]] === 0) have--;
          lo++;
        }
      }
    }

    let score = 0;
    if (bestOnLine === terms.length) score += 1000;   // все слова в одной строке — прямое попадание
    score += bestOnLine * 100;
    score += Math.min(hits.length, 10) * 5;
    for (const t of terms) if (titleLow.includes(t)) score += 60;   // имя и описание весят много
    if (window < Infinity) score += Math.round(300 / (1 + window));  // чем кучнее, тем выше

    // сниппеты: сначала строки с бОльшим числом совпавших слов
    let snippets = hits.slice(0, 3);
    if (!snippets.length) {
      // показываем окрестность самого кучного места: по одной строке на слово, рядом
      const anchors = pos.map(ls => ls.length ? ls[0] : -1).filter(i => i >= 0).sort((a, b) => a - b);
      for (const i of anchors.slice(0, 3)) snippets.push({ line: i + 1, text: lines[i].trim().slice(0, 220), k: 1 });
    }
    results.push({ ...publicNote(n), score, window: window === Infinity ? null : window, snippets });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function apiGraph() {
  const nodes = INDEX.notes.map(n => ({ id: n.id, title: n.title, type: n.type, root: n.root, size: n.size, in: n.inIds.length, out: n.outIds.length }));
  const edges = [];
  for (const n of INDEX.notes) for (const t of n.outIds) edges.push({ s: n.id, t });
  return { nodes, edges };
}

function apiSave(id, content) {
  const abs = resolveId(id);
  if (!abs) throw new Error('bad id');
  fs.writeFileSync(abs, content, 'utf8');
  buildIndex();
  return { ok: true, id };
}

function apiCreate(root, folder, name, type) {
  if (!ROOTS[root]) throw new Error('bad root');
  const safe = String(name || '').trim().replace(/[^\w\-а-яА-ЯёЁ ]/g, '').replace(/\s+/g, '_');
  if (!safe) throw new Error('empty name');
  const rel = root === 'skills' ? `${safe}/SKILL.md` : (folder ? `${folder}/${safe}.md` : `${safe}.md`);
  const abs = resolveId(`${root}/${rel}`);
  if (!abs) throw new Error('bad path');
  if (fs.existsSync(abs)) throw new Error('exists');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const fm = root === 'skills'
    ? `---\nname: ${safe}\ndescription: \n---\n\n# ${safe}\n\nПоследнее обновление: **${today}**\n\n`
    : `---\nname: ${safe}\ndescription: \nmetadata:\n  type: ${type || folder || 'project'}\n  modified: ${new Date().toISOString()}\n---\n\n# ${safe}\n\nПоследнее обновление: **${today}**\n\n`;
  fs.writeFileSync(abs, fm, 'utf8');
  buildIndex();
  return { ok: true, id: `${root}/${rel}` };
}

function apiDelete(id) {
  const abs = resolveId(id);
  if (!abs || !fs.existsSync(abs)) throw new Error('not found');
  // не удаляем, а переносим в корзину внутри vault
  const trash = path.join(ROOTS.vault, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  const dest = path.join(trash, `${Date.now()}_${path.basename(abs)}`);
  fs.renameSync(abs, dest);
  buildIndex();
  return { ok: true, trash: dest };
}

function apiRename(id, newName) {
  const abs = resolveId(id);
  if (!abs || !fs.existsSync(abs)) throw new Error('not found');
  const safe = String(newName || '').trim().replace(/[^\w\-а-яА-ЯёЁ ]/g, '').replace(/\s+/g, '_');
  if (!safe) throw new Error('empty name');
  const dest = path.join(path.dirname(abs), safe + '.md');
  if (fs.existsSync(dest)) throw new Error('exists');
  fs.renameSync(abs, dest);
  buildIndex();
  const [root] = id.split('/');
  const rel = path.relative(ROOTS[root], dest).split(path.sep).join('/');
  return { ok: true, id: `${root}/${rel}` };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ---------- защита локального сервера ----------
// Сервер слушает только 127.0.0.1, но браузер пользователя — тоже локальный клиент: страница чужого
// сайта может отправить сюда запрос. Поэтому:
//  1) Host — только наш адрес (иначе через DNS rebinding чужой сайт читает заметки как «свой»);
//  2) для /api/ заголовки Origin и Sec-Fetch-Site, если пришли, должны быть нашими;
//  3) тело POST — только application/json: с чужой страницы такой запрос без разрешения CORS не уйдёт.
// CLI, curl и тесты этих заголовков не шлют и работают как раньше.
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const LOCAL_ORIGINS = new Set([...LOCAL_HOSTS].map(h => `http://${h}`));
function guard(req, isApi) {
  if (!LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase())) return [403, 'bad host'];
  if (!isApi) return null;
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGINS.has(origin)) return [403, 'cross-origin request'];
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return [403, 'cross-site request'];
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    return [415, 'content-type must be application/json'];
  }
  return null;
}

// ---------- сервер ----------
const server = http.createServer(async (req, res) => {
  let p = '';
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    p = url.pathname;
    const denied = guard(req, p.startsWith('/api/'));
    if (denied) return send(res, denied[0], { error: denied[1] });
    if (p.startsWith('/api/')) {
      if (p === '/api/tree') return send(res, 200, apiTree());
      if (p === '/api/note') {
        const n = apiNote(url.searchParams.get('id'));
        return n ? send(res, 200, n) : send(res, 404, { error: 'not found' });
      }
      if (p === '/api/search') return send(res, 200, apiSearch(url.searchParams.get('q')));
      if (p === '/api/graph') return send(res, 200, apiGraph());
      if (p === '/api/resolve') {
        const t = resolveLink(url.searchParams.get('link') || '');
        return send(res, 200, { id: t });
      }
      if (p === '/api/facts') return send(res, 200, { facts: apiFacts(url.searchParams.get('all')), states: facts.STATES, ...factsSummary() });
      if (p === '/api/fact' && req.method === 'GET') {
        const f = apiFact(url.searchParams.get('id'));
        return f ? send(res, 200, f) : send(res, 404, { error: 'нет такого факта' });
      }
      if (p === '/api/fact' && req.method === 'POST') {
        const b = await readBody(req);
        try { return send(res, 200, apiFactSet(b)); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === '/api/rebuild') { buildIndex(); return send(res, 200, { ok: true, count: INDEX.notes.length }); }
      if (req.method === 'POST' && p === '/api/save') { const b = await readBody(req); return send(res, 200, apiSave(b.id, b.content)); }
      if (req.method === 'POST' && p === '/api/create') { const b = await readBody(req); return send(res, 200, apiCreate(b.root, b.folder, b.name, b.type)); }
      if (req.method === 'POST' && p === '/api/delete') { const b = await readBody(req); return send(res, 200, apiDelete(b.id)); }
      if (req.method === 'POST' && p === '/api/rename') { const b = await readBody(req); return send(res, 200, apiRename(b.id, b.name)); }
      if (p === '/api/open-external') {
        // открыть файл в системном редакторе / папку — по желанию
        const abs = resolveId(url.searchParams.get('id'));
        if (!abs) return send(res, 400, { error: 'bad id' });
        require('child_process').spawn('xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'no such api' });
    }
    // вложения из vault (картинки в design-docs и т.п.): /file/<id>
    if (p.startsWith('/file/')) {
      const abs = resolveId(decodeURIComponent(p.slice(6)));
      if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, fs.readFileSync(abs), MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    }
    // статика
    let file = p === '/' ? '/index.html' : p;
    const abs = path.join(PUBLIC, path.normalize(file));
    if (!abs.startsWith(PUBLIC) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), MIME['.html']);
    }
    return send(res, 200, fs.readFileSync(abs), MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
  } catch (e) {
    console.error(req.method, p, e.message);
    return send(res, 500, { error: e.message });
  }
});

// ---------- авто-выход: если не осталось живых сессий Claude (маркеры пишет bin/vaultctl) ----------
const RUN_DIR = process.env.VAULT_RUN_DIR || path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'vault-app');
const SESS_DIR = path.join(RUN_DIR, 'sessions');
if (process.env.VAULT_AUTOEXIT === '1') {
  const GRACE = Number(process.env.VAULT_AUTOEXIT_GRACE_MS || 60000); // не гаснуть первую минуту после старта
  const POLL = Number(process.env.VAULT_AUTOEXIT_POLL_MS || 20000);
  const startedAt = Date.now();
  setInterval(() => {
    let files;
    try { files = fs.readdirSync(SESS_DIR); } catch { return; }
    let alive = 0;
    for (const f of files) {
      const p = path.join(SESS_DIR, f);
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(p, 'utf8').trim(), 10) || 0; } catch { continue; }
      if (pid > 0) {
        try { process.kill(pid, 0); alive++; } catch { try { fs.unlinkSync(p); } catch {} }
      } else alive++; // маркер без pid (ручной запуск) — живёт до явного stop/kill
    }
    if (alive === 0 && Date.now() - startedAt > GRACE) {
      console.log('Vault: живых сессий не осталось — выхожу');
      process.exit(0);
    }
  }, POLL);
}

buildIndex();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Vault: http://127.0.0.1:${PORT}  (${INDEX.notes.length} заметок; vault=${ROOTS.vault}, skills=${ROOTS.skills})`);
});
