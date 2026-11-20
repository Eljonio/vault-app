// facts — хранилище фактов памяти: одна сущность — одна запись, со статусом, источником и историей.
// Файл ~/claude-vault/facts/facts.json (git-снимки vault-commit подхватывают его сами).
// Рядом генерируется FACTS.md — вид для Obsidian и `vault find`; правда — только в JSON.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATES = {
  risk:    { icon: '🔴', label: 'риск / срочно', ttl: 2,  order: 0 },
  blocked: { icon: '⛔', label: 'стоит',          ttl: 7,  order: 1 },
  wait:    { icon: '⏳', label: 'ждём',           ttl: 14, order: 2 },
  todo:    { icon: '📌', label: 'сделать',        ttl: 14, order: 3 },
  later:   { icon: '💤', label: 'потом',          ttl: 30, order: 4 },
  done:    { icon: '✅', label: 'готово',         ttl: 30, order: 5 },
  info:    { icon: 'ℹ️', label: 'справка',        ttl: 30, order: 6 },
};
// поля, изменение которых — событие в истории
const TRACKED = ['state', 'status', 'value', 'since', 'src', 'by'];
const FIELD_ORDER = ['id', 'title', 'state', 'status', 'value', 'since', 'src', 'by', 'notes', 'tags', 'check', 'ttl',
  'created', 'updated', 'checked', 'verify', 'archived'];
const KEY_ALIAS = { date: 'since', note: 'notes', ref: 'notes', refs: 'notes', tag: 'tags', source: 'src', who: 'by', comment: 'why', msg: 'why' };
// checked= — когда утверждение последний раз сверяли с источником (по умолчанию — сейчас)
const ALLOWED = new Set(['title', 'state', 'status', 'value', 'since', 'src', 'by', 'notes', 'tags', 'ttl', 'check', 'why', 'checked']);
const ID_RE = /^[a-z0-9][a-z0-9_]{1,63}$/;

function vaultDir() { return process.env.VAULT_DIR || path.join(os.homedir(), 'claude-vault'); }
function paths(dir = vaultDir()) {
  const f = path.join(dir, 'facts');
  return { vault: dir, dir: f, json: path.join(f, 'facts.json'), md: path.join(f, 'FACTS.md'), lock: path.join(f, '.facts.lock'),
    synonyms: path.join(f, 'synonyms.md'), pins: path.join(f, 'memory-pins.md') };
}

// ---------- секреты в факты не кладём ----------
const SECRET_RES = [
  /EAA[A-Za-z0-9]{24,}/,                 // токены Meta
  /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/,       // Anthropic / OpenAI
  /gh[pousr]_[A-Za-z0-9]{20,}/,           // GitHub
  /xox[abpr]-[A-Za-z0-9-]{10,}/,          // Slack
  /AKIA[0-9A-Z]{16}/,                     // AWS
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/,      // Telegram bot token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
function looksSecret(s) {
  s = String(s ?? '');
  if (SECRET_RES.some(r => r.test(s))) return true;
  // длинная «каша» из верхнего+нижнего регистра и цифр — похоже на ключ (git-хэши — только hex в нижнем, не ловятся)
  for (const w of s.split(/[\s"'`,;()<>]+/)) {
    if (w.length >= 32 && /[A-Z]/.test(w) && /[a-z]/.test(w) && /\d/.test(w) && !/^https?:/.test(w) && !w.includes('/')) return true;
  }
  return false;
}

// ---------- статус → состояние ----------
function guessState(status) {
  const s = String(status || '').toLowerCase();
  if (!s) return null;
  if (/засвеч|утек|утёк|срочн|горит|🔴|\b(leak|leaked|urgent|risk)\b/.test(s)) return 'risk';
  if (/потом|отлож|не спеш|позже|💤|\b(later|someday)\b/.test(s)) return 'later';
  if (/стоит|заблок|не оплач|отклон|слома|упал|не работает|отказ|⛔|\b(blocked|stuck|broken|failed)\b/.test(s)) return 'blocked';
  if (/не выкач|на проверке|на одобрении|жд[её]|ожида|ид[её]т|в работе|⏳|\b(wait|waiting|pending|in progress)\b/.test(s)) return 'wait';
  if (/не подан|не сделан|надо |нужно|сделать|📌|\b(todo|to do)\b/.test(s)) return 'todo';
  if (/готов|сделан|выкачен|на проде|оплачен|подключ|работает|принят|одобрен|подан|✅|\b(done|ready|deployed|live|paid|fixed|ok|works|working)\b/.test(s)) return 'done';
  return null;
}

// ---------- даты ----------
const pad2 = n => String(n).padStart(2, '0');
function normDate(v, now = new Date()) {
  if (v == null) return v;
  const s = String(v).trim();
  if (!s) return '';
  if (/^(сегодня|today|now)$/i.test(s)) return isoLocal(now).slice(0, 10);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (m) return m[4] ? `${m[1]}-${m[2]}-${m[3]} ${pad2(m[4])}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (m) {
    let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : now.getFullYear();
    const d = `${y}-${pad2(m[2])}-${pad2(m[1])}`;
    return m[4] ? `${d} ${pad2(m[4])}:${m[5]}` : d;
  }
  return s; // «после 16.10», «неизвестно» — оставляем текстом
}
function isoLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function parseTs(s) {
  if (!s) return NaN;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
}
// «с 20.10» для даты, иначе текст как есть («после 16.10»)
function sinceText(s) { return /^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? 'с ' + shortDate(s) : String(s || ''); }
// «20.10» / «20.10 00:32» для показа
function shortDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}:\d{2}))?$/);
  if (!m) return String(s || '');
  return `${m[3]}.${m[2]}${m[4] ? ' ' + m[4] : ''}`;
}

// ---------- чтение / запись ----------
let CACHE = { file: null, mtimeMs: -1, db: null };
function emptyDb() { return { version: 1, updated: null, facts: {} }; }
function load(dir = vaultDir()) {
  const p = paths(dir).json;
  let st;
  try { st = fs.statSync(p); } catch { return emptyDb(); }
  if (CACHE.file === p && CACHE.mtimeMs === st.mtimeMs && CACHE.size === st.size) return CACHE.db;
  const db = JSON.parse(fs.readFileSync(p, 'utf8'));
  db.facts = db.facts || {};
  CACHE = { file: p, mtimeMs: st.mtimeMs, size: st.size, db };
  return db;
}
function mtime(dir = vaultDir()) { try { return fs.statSync(paths(dir).json).mtimeMs; } catch { return 0; } }

function serialize(db) {
  const out = ['{', `  "version": ${db.version || 1},`, `  "updated": ${JSON.stringify(db.updated || null)},`, '  "facts": {'];
  const ids = Object.keys(db.facts).sort();
  ids.forEach((id, i) => {
    const f = db.facts[id];
    const keys = FIELD_ORDER.filter(k => f[k] !== undefined && f[k] !== null && f[k] !== '')
      .concat(Object.keys(f).filter(k => !FIELD_ORDER.includes(k) && k !== 'history'));
    const lines = keys.map(k => `      ${JSON.stringify(k)}: ${JSON.stringify(f[k])}`);
    const hist = (f.history || []).map(h => `        ${JSON.stringify(h)}`);
    lines.push(`      "history": [${hist.length ? '\n' + hist.join(',\n') + '\n      ' : ''}]`);
    out.push(`    ${JSON.stringify(id)}: {\n${lines.join(',\n')}\n    }${i < ids.length - 1 ? ',' : ''}`);
  });
  out.push('  }', '}', '');
  return out.join('\n');
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function withLock(dir, fn) {
  const P = paths(dir);
  fs.mkdirSync(P.dir, { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try { const fd = fs.openSync(P.lock, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(P.lock).mtimeMs > 10000) { fs.unlinkSync(P.lock); continue; } } catch {}
      if (Date.now() - t0 > 5000) throw new Error('факты заняты другим процессом (lock ' + P.lock + ')');
      sleepMs(40);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(P.lock); } catch {} }
}
function writeDb(dir, db) {
  const P = paths(dir);
  db.updated = isoLocal();
  const tmp = P.json + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, serialize(db), 'utf8');
  fs.renameSync(tmp, P.json);
  CACHE = { file: null, mtimeMs: -1, db: null };
  try { fs.writeFileSync(P.md, renderFactsMd(db), 'utf8'); } catch (e) { console.error('FACTS.md:', e.message); }
}

// ---------- нормализация входа ----------
function toList(v) {
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v ?? '').split(/[,;]\s*|\s+(?=\[\[)/).map(s => s.trim().replace(/^\[\[|\]\]$/g, '')).filter(Boolean);
}
const CHECK_PRESETS = {
  // версия приложения на проде: только чтение package.json по ssh (хост и файл — VAULT_PROD_HOST / VAULT_PROD_FILE)
  prod_version: expect => ({ kind: 'ssh_grep', host: process.env.VAULT_PROD_HOST || 'prod', file: process.env.VAULT_PROD_FILE || '~/app/package.json', pattern: '"version"', expect }),
};
function parseCheck(v) {
  if (v == null || v === '' || v === 'none') return undefined;
  if (typeof v === 'object') return v;
  const s = String(v).trim();
  if (s.startsWith('{')) return JSON.parse(s);
  const m = s.match(/^(\w+):(.*)$/);
  if (m && CHECK_PRESETS[m[1]]) return CHECK_PRESETS[m[1]](m[2]);
  throw new Error(`check: JSON {"kind":…} или пресет ${Object.keys(CHECK_PRESETS).map(k => k + ':<ожидаемое>').join(', ')}`);
}
function normFields(input) {
  const out = {};
  for (let [k, v] of Object.entries(input)) {
    k = KEY_ALIAS[k] || k;
    if (!ALLOWED.has(k)) throw new Error(`неизвестное поле «${k}». Можно: ${[...ALLOWED].join(', ')} (+ date, note)`);
    if (k === 'notes' || k === 'tags') v = toList(v);
    else if (k === 'ttl') { v = v === '' ? undefined : Number(v); if (v !== undefined && !(v > 0)) throw new Error('ttl — число дней > 0'); }
    else if (k === 'check') v = parseCheck(v);
    else if (k === 'since' || k === 'checked') v = normDate(v);
    else if (k === 'state') {
      v = String(v).trim();
      const byIcon = Object.entries(STATES).find(([, s]) => s.icon === v);
      if (byIcon) v = byIcon[0];
      if (!STATES[v]) throw new Error(`state: одно из ${Object.keys(STATES).join(' ')}`);
    } else v = String(v ?? '').trim();
    out[k] = v;
  }
  for (const [k, v] of Object.entries(out)) {
    const flat = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    if (looksSecret(flat) || require('./redact').hasCredential(flat)) throw new Error(`поле «${k}» похоже на секрет — в факты не кладём (пиши «токен засвечен», значение — в менеджер секретов)`);
  }
  return out;
}

// ---------- операции ----------
// заметка есть? — файл в любой папке vault, навык ~/.claude/skills/<имя>/SKILL.md или «FACTS»
function noteExists(dir, name) {
  if (!/^[\w.-]+$/u.test(name)) return false;
  if (name === 'FACTS') return true;
  try { if (fs.existsSync(path.join(dir, name + '.md'))) return true; } catch {}
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
  for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(path.join(dir, e.name, name + '.md'))) return true;
  return fs.existsSync(path.join(os.homedir(), '.claude', 'skills', name, 'SKILL.md'));
}
function checkId(id) {
  if (!ID_RE.test(String(id || ''))) throw new Error(`id «${id}»: латиница в нижнем регистре, цифры и _ (пример: app_review)`);
}
/**
 * set — создать или изменить факт. Любой set с полями состояния = подтверждение (checked = сейчас).
 * opts.ok — подтверждение без изменений (vault fact ok).
 */
function set(id, input = {}, opts = {}) {
  checkId(id);
  const dir = opts.dir || vaultDir();
  const fields = normFields(input);
  const why = fields.why; delete fields.why;
  return withLock(dir, () => {
    const db = clone(load(dir));
    const now = isoLocal(opts.now);
    const prev = db.facts[id];
    for (const n of fields.notes || []) {
      const base = String(n).split('#')[0];
      if (!noteExists(dir, base) && !db.facts[base]) throw new Error(`note «${n}» — нет такой заметки/навыка/факта. notes = имена заметок (desk_…, project_…); текст — в value= или why=`);
    }
    if (!prev && opts.ok) throw new Error(`факта «${id}» нет — сначала vault fact set`);
    const f = prev ? { ...prev } : { id, title: id, created: now, history: [] };
    if (prev && prev.archived && !opts.ok) delete f.archived;
    if (fields.status !== undefined && fields.state === undefined) {
      const g = guessState(fields.status);
      if (g) fields.state = g; else if (!f.state) fields.state = 'info';
    }
    if (!f.state && fields.state === undefined) fields.state = 'info';
    const changed = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || (Array.isArray(v) && !v.length && !(prev && prev[k]))) { if (v === undefined) delete f[k]; continue; }
      if (JSON.stringify(f[k]) !== JSON.stringify(v)) { if (TRACKED.includes(k)) changed[k] = v; f[k] = v; }
    }
    const touchedTracked = Object.keys(fields).some(k => TRACKED.includes(k));
    const isNew = !prev;
    if (isNew || Object.keys(changed).length) f.updated = now;
    if (isNew || touchedTracked || opts.ok) f.checked = fields.checked || now;
    else if (fields.checked) f.checked = fields.checked;
    if (isNew || Object.keys(changed).length || opts.ok || why) {
      const h = { at: now };
      for (const k of TRACKED) if (isNew ? f[k] !== undefined : changed[k] !== undefined) h[k] = f[k];
      if (opts.ok) h.ok = true;
      if (why) h.why = why;
      // «подтвердил» — только тот, кого назвали в этом вызове; прежний подтверждавший за новое состояние не отвечает
      if (fields.by) h.by = fields.by;
      else if (opts.ok || Object.keys(changed).length) delete f.by;
      f.history = [...(f.history || []), h];
    }
    db.facts[id] = f;
    writeDb(dir, db);
    return decorate(f, opts.now);
  });
}
function archive(id, why, opts = {}) {
  const dir = opts.dir || vaultDir();
  return withLock(dir, () => {
    const db = clone(load(dir));
    const f = db.facts[id];
    if (!f) throw new Error(`факта «${id}» нет`);
    const now = isoLocal(opts.now);
    f.archived = now;
    f.history = [...(f.history || []), { at: now, archived: true, ...(why ? { why } : {}) }];
    writeDb(dir, db);
    return decorate(f, opts.now);
  });
}
function recordVerify(id, result, opts = {}) {
  const dir = opts.dir || vaultDir();
  return withLock(dir, () => {
    const db = clone(load(dir));
    const f = db.facts[id];
    if (!f) return null;
    const now = isoLocal(opts.now);
    f.verify = { at: now, ok: result.ok, observed: String(result.observed ?? result.error ?? '').slice(0, 200) };
    if (result.ok === true) f.checked = now;
    writeDb(dir, db);
    return decorate(f, opts.now);
  });
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }

function ageDays(f, now = Date.now()) {
  const t = parseTs(f.checked || f.updated || f.created);
  return isNaN(t) ? Infinity : Math.floor((now - t) / 86400000);
}
function ttlOf(f) { return f.ttl || (STATES[f.state] || STATES.info).ttl; }
function decorate(f, now) {
  const n = now ? new Date(now).getTime() : Date.now();
  const age = ageDays(f, n);
  return { ...f, icon: (STATES[f.state] || STATES.info).icon, age, ttlDays: ttlOf(f), stale: age > ttlOf(f) };
}
function get(id, opts = {}) {
  const db = load(opts.dir);
  const f = db.facts[id];
  return f ? decorate(f, opts.now) : null;
}
function all(opts = {}) {
  const db = load(opts.dir);
  return Object.values(db.facts).filter(f => opts.archived || !f.archived).map(f => decorate(f, opts.now)).sort(byStateThenFresh);
}
function byStateThenFresh(a, b) {
  return (STATES[a.state] || STATES.info).order - (STATES[b.state] || STATES.info).order
    || (parseTs(b.updated) || 0) - (parseTs(a.updated) || 0) || a.id.localeCompare(b.id);
}
function list(filter = '', opts = {}) {
  const q = String(filter || '').toLowerCase().replace(/ё/g, 'е').trim();
  return all(opts).filter(f => {
    if (opts.stale && !f.stale) return false;
    if (opts.state && f.state !== opts.state) return false;
    if (!q) return true;
    const hay = [f.id, f.title, f.status, f.value, f.src, ...(f.notes || []), ...(f.tags || [])].join(' ').toLowerCase().replace(/ё/g, 'е');
    return q.split(/\s+/).every(t => hay.includes(t));
  });
}
// нечёткий поиск id: точное → начало → подстрока в id/названии
function resolve(q, opts = {}) {
  const db = load(opts.dir);
  if (db.facts[q]) return q;
  const low = String(q).toLowerCase();
  const ids = Object.keys(db.facts);
  const pre = ids.filter(i => i.startsWith(low));
  if (pre.length === 1) return pre[0];
  const sub = ids.filter(i => i.includes(low) || String(db.facts[i].title || '').toLowerCase().includes(low));
  if (sub.length === 1) return sub[0];
  return { ambiguous: [...new Set([...pre, ...sub])] };
}

// ---------- представление ----------
function oneLine(f, opts = {}) {
  const max = opts.max || 220;
  const meta = [sinceText(f.since), f.src ? 'src ' + f.src : '', f.stale ? `не сверялось ${f.age} дн` : ''].filter(Boolean).join('; ');
  let s = `${f.icon} ${f.title} — ${f.status || STATES[f.state]?.label || ''}`;
  if (f.value && opts.value !== false) s += ': ' + f.value;
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s + (meta ? ` (${meta})` : '') + (f.notes && f.notes.length ? ' → ' + f.notes.join(', ') : '');
}
// {{fact:id}} в тексте заметки → дописать текущее значение (для vault show и для Claude, читающего сырой md)
const REF_RE = /\{\{fact:([a-z0-9_]+)\}\}/g;
function expandRefs(text, opts = {}) {
  let db;
  try { db = load(opts.dir); } catch { return text; }
  return String(text).replace(REF_RE, (m, id) => {
    const f = db.facts[id];
    if (!f) return `${m} ⟨нет такого факта⟩`;
    const d = decorate(f);
    return `${m} ⟨${d.icon} ${d.status || ''}${d.since ? ' · ' + sinceText(d.since) : ''}${d.src ? ' · src ' + d.src : ''}${d.stale ? ` · не сверялось ${d.age} дн` : ''}⟩`;
  });
}
function refIds(text) { const out = new Set(); let m; REF_RE.lastIndex = 0; while ((m = REF_RE.exec(text))) out.add(m[1]); return [...out]; }

function renderFactsMd(db) {
  const facts = Object.values(db.facts).filter(f => !f.archived).map(f => decorate(f)).sort(byStateThenFresh);
  const out = ['---', 'name: FACTS',
    'description: "Факты памяти — что сейчас правда (статусы, версии, долги, решения) с источником и датой. Сгенерировано из facts/facts.json, руками не править: vault fact set / вкладка «Факты» на :4040"',
    'metadata:', '  type: facts', '---', '', '# Факты — что сейчас правда', '',
    `Последнее обновление: **${db.updated || isoLocal()}** (сгенерировано, ${facts.length} фактов)`, '',
    'Источник правды — `facts/facts.json`. Правка: `vault fact set <id> status=… src=…`, подтвердить без изменений — `vault fact ok <id>`.',
    'В заметках статус текстом не копировать — ставить ссылку `{{fact:<id>}} [[FACTS#<id>]]` (`vault fact ref <id>`).', ''];
  let cur = null;
  for (const f of facts) {
    if (f.state !== cur) { cur = f.state; out.push(`## ${STATES[cur]?.icon || ''} ${STATES[cur]?.label || cur}`, ''); }
    out.push(`### ${f.id}`);
    out.push(`**${f.title}** — ${f.status || ''}${f.value ? ': ' + f.value : ''}`);
    const meta = [sinceText(f.since), f.src ? 'источник: ' + f.src : '', f.by ? 'подтвердил: ' + f.by : '',
      `сверено ${f.age === Infinity ? '—' : f.age + ' дн назад'}${f.stale ? ' ⚠' : ''}`, f.verify ? `verify ${f.verify.ok === true ? 'ок' : f.verify.ok === false ? 'РАСХОЖДЕНИЕ' : 'не смог'} ${shortDate(f.verify.at)}` : ''].filter(Boolean);
    out.push(meta.join(' · ') + (f.notes && f.notes.length ? ' → ' + f.notes.map(n => `[[${n}]]`).join(', ') : ''), '');
  }
  return out.join('\n');
}

module.exports = {
  STATES, TRACKED, ID_RE, paths, vaultDir, load, mtime, set, archive, recordVerify, get, all, list, resolve,
  decorate, oneLine, expandRefs, refIds, renderFactsMd, serialize, looksSecret, guessState, normDate, normFields,
  isoLocal, parseTs, shortDate, sinceText, ageDays, parseCheck, CHECK_PRESETS, writeDb, withLock,
};
