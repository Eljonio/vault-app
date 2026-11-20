// recall — по фразе пользователя находит 3–5 самых нужных фактов и заметок. Без сети и без LLM, < 150 мс.
// Слова → стеммы (грубо, по окончаниям) → понятия из словаря синонимов (facts/synonyms.md) → очки по полям.
'use strict';
const fs = require('fs');
const path = require('path');
const facts = require('./facts');
const { redact, mentionsPassword } = require('./redact');

// ---------- текст ----------
const STOP = new Set(`ну шо што что че чё чо по мы же а и в во на с со к ко у о об обо за из от до как там тут это этот эта эти вот да нет не ни ли бы
ты я он она оно они вы мне меня мной тебе тебя нам нас вам вас его ее её их им так уже еще ещё все всё всех всем давай го есть был была было были
можно надо нужно какой какая какие каким где когда кто чем зачем почему или то тоже только просто щас сейчас ок окей плиз пж ага угу слушай
смотри короче типа вообще значит ж ведь вроде сам сама сами там че-как чего чему ему ей кстати ваще блин хоть пусть ну-ка мол
the a an is are of to for and or we did do does what how about with on in it this that be pls
этого этом этой этому эту этих этими моего моей моем моём моему мою моих мой моя мое моё мои твой твоего твоей твою твои свой своего своей свою свои
наш нашего нашей нашу наши нашим такой такого такая такую такие который которые которая которую которых потом сразу снова опять
удали удалить убери убрать сделай сделать делай посмотри посмотреть глянь глянуть проверь проверить покажи показать скажи сказать расскажи
напиши написать запусти запустить открой открыть добавь добавить поправь поправить исправь исправить почини починить найди найти
пожалуйста спасибо привет дарова дароу здравствуй здарова норм нормально хорошо ладно понял поняла`.split(/\s+/));
function norm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-z0-9а-яәғқңөұүһі]+/g, ' ').trim();
}
const RU_END = ['ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'иях', 'ией', 'ах', 'ях', 'ия', 'ие', 'ий', 'ый', 'ой', 'ей', 'ая', 'яя',
  'ое', 'ее', 'ые', 'ом', 'ем', 'ам', 'ям', 'ов', 'ев', 'ую', 'юю', 'ью', 'ья', 'ье', 'ьи', 'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й'];
function stem(t) {
  if (/^[a-z]+$/.test(t)) return t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;
  if (/^[а-яәғқңөұүһі]+$/.test(t)) for (const e of RU_END) if (t.length - e.length >= 3 && t.endsWith(e)) return t.slice(0, -e.length);
  return t;
}
const tokens = s => norm(s).split(' ').filter(Boolean);
const stems = s => tokens(s).map(stem);
// похожесть двух стеммов: 1 — то же, 0.8 — один начало другого, 0.6 — общий корень (≥4 букв), 0 — нет
function sim(a, b) {
  if (a === b) return 1;
  const m = Math.min(a.length, b.length);
  if (m < 4) return 0;
  if (a.startsWith(b) || b.startsWith(a)) return 0.8;
  let c = 0; while (c < m && a[c] === b[c]) c++;
  return c >= 5 && c >= m - 1 ? 0.6 : 0; // беглые гласные («станок/станка») — через словарь, не через похожесть
}

// ---------- словарь синонимов ----------
// строка: «- канон, вариант, вариант → цель, цель»  (цели — id фактов или имена заметок, необязательно)
function parseSynonyms(text) {
  const groups = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^\s*[-*]\s+/, '').trim();
    if (!line || raw.trim().startsWith('#') || !/^\s*[-*]\s+/.test(raw)) continue;
    const [left, right = ''] = line.split(/\s*(?:→|=>|->)\s*/);
    const variants = left.split(/\s*,\s*/).map(v => v.replace(/`/g, '').trim()).filter(Boolean);
    if (!variants.length) continue;
    const seqs = [...new Set(variants.map(v => stems(v).join(' ')))].filter(Boolean).map(s => s.split(' '));
    const targets = right.split(/\s*,\s*/).map(t => t.replace(/[`\[\]]/g, '').trim()).filter(Boolean);
    groups.push({ canon: variants[0], seqs, targets });
  }
  return groups;
}

// ---------- документы: факты + заметки ----------
const NOTE_DIRS = ['project', 'reference', 'feedback', 'user'];
const SKIP_NOTE = /^(MEMORY|FACTS|journal_|synonyms|memory-pins)/;
function readHead(file, n = 3072) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(n); const k = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, k).toString('utf8'); } finally { fs.closeSync(fd); }
}
function noteMeta(file) {
  let head = readHead(file);
  if (head.startsWith('---') && !/\n---\s*\n/.test(head.slice(3))) head = readHead(file, 12288);
  const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = m ? m[1] : '';
  const desc = (fm.match(/^description:\s*(.*)$/m) || [])[1] || '';
  return desc.replace(/^["']|["']$/g, '');
}
// заметки: описания из frontmatter + готовые стеммы полей. Кэш в $XDG_RUNTIME_DIR, ключ — имена и mtime файлов,
// так что правка любой заметки сама сбрасывает кэш. Без кэша — ~30 мс на стемминг, с кэшем — ~5.
const CACHE_V = 3; // v3: описания хранятся уже вычищенными (redact), с флагом hide
function loadNotes(vaultDir) {
  const files = [];
  for (const d of NOTE_DIRS) {
    let ents; try { ents = fs.readdirSync(path.join(vaultDir, d)); } catch { continue; }
    for (const e of ents) {
      if (!e.endsWith('.md') || SKIP_NOTE.test(e)) continue;
      const p = path.join(vaultDir, d, e);
      let st; try { st = fs.statSync(p); } catch { continue; }
      files.push({ d, e, p, m: st.mtimeMs });
    }
  }
  const sig = require('crypto').createHash('md5').update(CACHE_V + '|' + files.map(f => f.d + '/' + f.e + ':' + f.m).join('|')).digest('hex');
  const cacheFile = path.join(process.env.XDG_RUNTIME_DIR || require('os').tmpdir(),
    'vault-recall-' + require('crypto').createHash('md5').update(path.resolve(vaultDir)).digest('hex').slice(0, 10) + '.json');
  try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (c.sig === sig) return c.notes; } catch {}
  const out = [];
  for (const f of files) {
    let raw = '';
    try { raw = noteMeta(f.p); } catch { continue; }
    // учётные данные из описаний не попадают ни в вывод, ни в кэш; с «паролем» описание не показываем вовсе
    const doc = { kind: 'note', id: f.e.slice(0, -3), folder: f.d, desc: redact(raw), hide: mentionsPassword(raw) };
    doc.fstems = docFields(doc).map(([t, w]) => [stems(t), w]);
    out.push(doc);
  }
  try { const tmp = cacheFile + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify({ sig, notes: out }), { mode: 0o600 }); fs.renameSync(tmp, cacheFile); } catch {}
  return out;
}
// поля с весами: имя/название/теги весят больше текста
function docFields(doc) {
  if (doc.kind === 'fact') {
    const f = doc.fact;
    return [[f.id.replace(/_/g, ' '), 3], [f.title, 3], [(f.tags || []).join(' , '), 3], [f.status, 1], [f.value, 1],
      [(f.notes || []).join(' ').replace(/_/g, ' '), 1], [f.src, 0.5]];
  }
  return [[doc.id.replace(/_/g, ' '), 3], [doc.desc, 1]];
}

function buildIndex(vaultDir) {
  const P = facts.paths(vaultDir);
  let groups = [];
  try { groups = parseSynonyms(fs.readFileSync(P.synonyms, 'utf8')); } catch {}
  const docs = [];
  for (const f of facts.all({ dir: vaultDir })) docs.push({ kind: 'fact', id: f.id, fact: f });
  for (const n of loadNotes(vaultDir)) docs.push(n);
  // обратный индекс: стемм → [docIdx, вес]; и по первым 4 буквам — для нечёткого
  const inv = new Map(), pre = new Map();
  docs.forEach((d, di) => {
    for (const [st, w] of d.fstems || docFields(d).map(([t, w2]) => [stems(t), w2])) {
      for (const s of st) {
        let row = inv.get(s);
        if (!row) { row = new Map(); inv.set(s, row); if (s.length >= 4) { const k = s.slice(0, 4); (pre.get(k) || pre.set(k, new Set()).get(k)).add(s); } }
        if ((row.get(di) || 0) < w) row.set(di, w);
      }
    }
  });
  const byId = new Map(docs.map((d, i) => [d.id, i]));
  return { docs, inv, pre, groups, byId };
}

// стемм запроса → Map(docIdx → лучший вес·похожесть)
function termHits(ix, s, minSim = 0.6) {
  const hits = new Map();
  const add = (row, k) => { for (const [di, w] of row) { const v = w * k; if ((hits.get(di) || 0) < v) hits.set(di, v); } };
  const exact = ix.inv.get(s); if (exact) add(exact, 1);
  if (s.length >= 4) for (const cand of ix.pre.get(s.slice(0, 4)) || []) {
    if (cand === s) continue;
    const k = sim(s, cand); if (k >= minSim) add(ix.inv.get(cand), k);
  }
  return hits;
}
// последовательность стеммов (вариант синонима) в документах: все слова должны найтись → min по словам
function seqHits(ix, seq) {
  let acc = null;
  for (const s of seq) {
    const h = termHits(ix, s, seq.length > 1 ? 0.8 : 0.6);
    if (!acc) { acc = h; continue; }
    const next = new Map();
    for (const [di, v] of acc) if (h.has(di)) next.set(di, Math.min(v, h.get(di)));
    acc = next;
    if (!acc.size) break;
  }
  return acc || new Map();
}
// есть ли вариант (последовательность) в запросе подряд; возвращает позиции
function findSeq(qs, seq) {
  for (let i = 0; i + seq.length <= qs.length; i++) {
    let ok = true;
    for (let j = 0; j < seq.length; j++) {
      const a = qs[i + j], b = seq[j];
      if (!(a === b || (Math.min(a.length, b.length) >= 4 && sim(a, b) >= 0.8))) { ok = false; break; }
    }
    if (ok) return [i, i + seq.length];
  }
  return null;
}

function recall(query, opts = {}) {
  const vaultDir = opts.dir || facts.vaultDir();
  const ix = opts.index || buildIndex(vaultDir);
  const qs = stems(query);
  const used = new Array(qs.length).fill(false);
  const units = []; // {label, seqs, targets}
  for (const g of ix.groups) {
    let hit = null;
    for (const seq of g.seqs) { const r = findSeq(qs, seq); if (r) { hit = r; break; } }
    if (!hit) continue;
    for (let i = hit[0]; i < hit[1]; i++) used[i] = true;
    units.push({ label: g.canon, seqs: g.seqs, targets: g.targets, concept: true });
  }
  qs.forEach((s, i) => {
    if (used[i]) return;
    const raw = tokens(query)[i];
    if (STOP.has(raw) || STOP.has(s) || (s.length < 2 && !/\d/.test(s))) return;
    units.push({ label: raw, seqs: [[s]], targets: [] });
  });
  if (!units.length) return { units: [], items: [] };
  const N = ix.docs.length;
  const score = new Map();
  const why = new Map();
  const bump = (di, v, u) => { score.set(di, (score.get(di) || 0) + v); if (!why.has(di)) why.set(di, new Set()); why.get(di).add(u.label); };
  for (const u of units) {
    const best = new Map();
    for (const seq of u.seqs) for (const [di, v] of seqHits(ix, seq)) if ((best.get(di) || 0) < v) best.set(di, v);
    const idf = Math.log(1 + N / (1 + best.size));
    for (const [di, v] of best) bump(di, v * idf, u);
    for (const t of u.targets) {
      const di = ix.byId.get(t);
      if (di !== undefined) bump(di, 6, u);
    }
  }
  // стол/заметка, на которую ссылается найденный факт, поднимается: «джира ключ» → jira_key → desk_tracker
  // Раньше очки всех фактов складывались — стол с 14 фактами перевешивал всё по любому слову.
  // Теперь: 0.3 от лучшего факта + 0.05 от остальных, и только от фактов, которые сами прошли порог.
  const min = opts.min ?? 2.5;
  const hub = new Map(); // noteIdx → [{sc, id}]
  for (const [di, sc] of [...score.entries()]) {
    const d = ix.docs[di];
    if (d.kind !== 'fact' || sc < min) continue;
    for (const n of d.fact.notes || []) {
      const ni = ix.byId.get(n);
      if (ni !== undefined && ix.docs[ni].kind === 'note') (hub.get(ni) || hub.set(ni, []).get(ni)).push({ sc, id: d.id });
    }
  }
  for (const [ni, arr] of hub) {
    arr.sort((a, b) => b.sc - a.sc);
    const bonus = 0.3 * arr[0].sc + 0.05 * arr.slice(1).reduce((a, x) => a + x.sc, 0);
    score.set(ni, (score.get(ni) || 0) + bonus);
    if (!why.has(ni)) why.set(ni, new Set());
    for (const x of arr) why.get(ni).add('← ' + x.id);
  }
  const ranked = [...score.entries()].filter(([, s]) => s >= min).map(([di, s]) => ({ doc: ix.docs[di], score: s, why: [...why.get(di)] }))
    .sort((a, b) => b.score - a.score
      || (a.doc.kind === 'fact' ? 0 : 1) - (b.doc.kind === 'fact' ? 0 : 1)
      || (a.doc.kind === 'fact' ? (facts.STATES[a.doc.fact.state]?.order ?? 9) - (facts.STATES[b.doc.fact.state]?.order ?? 9) : 0));
  // не больше 4 фактов и 2 заметок, всего ≤ 5; заметка-стол, на которую ссылается выбранный факт, — в приоритете
  const maxItems = opts.max || 5;
  const items = [];
  let nf = 0, nn = 0;
  for (const r of ranked) {
    if (items.length >= maxItems) break;
    if (r.doc.kind === 'fact' ? nf >= 4 : nn >= 2) continue;
    items.push(r); r.doc.kind === 'fact' ? nf++ : nn++;
  }
  return { units: units.map(u => u.label), items };
}

// ---------- вывод ≤ 1 КБ ----------
const B = s => Buffer.byteLength(s, 'utf8');
const cutc = (t, n) => (t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t);
// строка факта под бюджет байт: сначала выкидываем подробности, потом укорачиваем название и источник
function factLine(f, budget) {
  const mk = (title, src, value) => {
    const meta = [facts.sinceText(f.since), f.src ? 'src ' + cutc(f.src, src) : '', f.stale ? `не сверялось ${f.age} дн` : ''].filter(Boolean).join('; ');
    return `${f.icon} ${f.id}${title ? ' «' + cutc(f.title || '', title) + '»' : ''} — ${f.status || ''}${value ? ': ' + value : ''}${meta ? ` (${meta})` : ''}${(f.notes || []).length ? ' → ' + f.notes[0] : ''}`;
  };
  for (const [t, sr] of [[60, 40], [40, 30], [28, 24], [0, 24], [0, 14]]) {
    const base = mk(t, sr, '');
    if (B(base) > budget) continue;
    const room = budget - B(base) - 3;
    return f.value && room > 30 ? mk(t, sr, cutBytes(f.value, room)) : base;
  }
  return cutBytes(mk(0, 14, ''), budget);
}
function format(res, opts = {}) {
  const limit = opts.bytes || 1000;
  if (!res.items.length) return '';
  const head = 'память (vault-recall), сверь перед ответом:';
  const tail = 'подробно: vault fact get <id> · vault show <заметка>';
  const budgetEach = Math.floor((limit - B(head) - B(tail) - 2) / res.items.length) - 1;
  const lines = [head];
  for (const r of res.items) {
    if (r.doc.kind === 'fact') {
      const f = r.doc.fact;
      lines.push(factLine({ ...f, title: redact(f.title), status: redact(f.status), value: redact(f.value), src: redact(f.src) }, budgetEach));
    } else if (r.doc.hide || mentionsPassword(r.doc.desc)) {
      lines.push(`📄 ${r.doc.id} (описание скрыто: там учётные данные)`);
    } else {
      lines.push(cutBytes(`📄 ${r.doc.id} — ${redact(r.doc.desc).replace(/\s+/g, ' ')}`, Math.min(budgetEach, 230)));
    }
  }
  lines.push(tail);
  return lines.join('\n');
}
function cutBytes(s, n) {
  if (Buffer.byteLength(s, 'utf8') <= n) return s;
  let out = '';
  for (const ch of s) { if (Buffer.byteLength(out + ch + '…', 'utf8') > n) break; out += ch; }
  return out + '…';
}

module.exports = { recall, format, buildIndex, parseSynonyms, stems, stem, norm, sim, tokens, STOP };
