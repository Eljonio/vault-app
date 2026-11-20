// memindex — короткий индекс памяти (MEMORY.next.md, ≤ 10 КБ): «Сейчас» из фактов + столы + главные заметки + правила.
// Сам MEMORY.md не трогаем — черновик кладётся рядом, заменять решает человек.
'use strict';
const fs = require('fs');
const path = require('path');
const facts = require('./facts');
const { redact, mentionsPassword } = require('./redact');

const LIMIT = 10 * 1024;
const B = s => Buffer.byteLength(s, 'utf8');

function fmDesc(file) {
  try {
    const t = fs.readFileSync(file, 'utf8').slice(0, 12000);
    const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const d = ((m && (m[1].match(/^description:\s*(.*)$/m) || [])[1]) || '').replace(/^["']|["']$/g, '').trim();
    return mentionsPassword(d) ? '' : redact(d); // учётные данные в индекс не тащим
  } catch { return ''; }
}
// первая фраза описания, не длиннее n символов
function brief(desc, n) {
  let s = String(desc || '').replace(/\s+/g, ' ').trim();
  const cut = s.search(/[.;:](\s|$)| — /);
  if (cut > 20 && cut < n) s = s.slice(0, cut);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function listNotes(dir, folder) {
  try { return fs.readdirSync(path.join(dir, folder)).filter(f => f.endsWith('.md')).sort().map(f => ({ base: f.slice(0, -3), file: path.join(dir, folder, f) })); }
  catch { return []; }
}
function readPins(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map(l => l.match(/^\s*[-*]\s+\[\[([^\]|#]+)/)).filter(Boolean).map(m => m[1].trim());
  } catch { return []; }
}
function findNote(dir, base) {
  for (const f of ['project', 'reference', 'feedback', 'user', '']) {
    const p = path.join(dir, f, base + '.md');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// строка факта для индекса: только состояние и статус, подробности — vault fact get
function factLine(f) {
  const cut = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const note = (f.notes || [])[0];
  return `- ${f.icon} \`${f.id}\` ${cut(f.title || '', 60)} — ${cut(f.status || '', 60)}${f.stale ? ' ⚠ не сверялось ' + f.age + ' дн' : ''}${note ? ` → [[${note}]]` : ''}`;
}

function build(opts = {}) {
  const dir = opts.dir || facts.vaultDir();
  const P = facts.paths(dir);
  const now = facts.isoLocal(opts.now);
  const all = facts.all({ dir, now: opts.now });
  // done — только свежие (7 дней), остальное — всё живое
  const live = all.filter(f => f.state !== 'done' || facts.parseTs(f.updated) > Date.now() - 7 * 864e5);
  const staleN = all.filter(f => f.stale).length;

  const head = [
    `# Memory Index — черновик v2 (собран \`vault index --build\` ${now}, руками не править)`, '',
    '## Как работать с памятью',
    '- **Статусы — только из фактов.** Перед «сделано / не сделано / подано / на проде» — `vault fact get <id>` или `vault-recall "<фраза>"`; заметки могут отставать. Дёшево сверить с источником — сверь (`vault verify`).',
    '- **Изменилось состояние** (подано / выкачено / оплачено / решено / агент закончил) — сразу `vault fact set <id> status=… src=… note=desk_…`, без просьбы пользователя ([[feedback_memory_without_asking]]). В заметке — `{{fact:<id>}}`, не копия статуса.',
    '- Поиск по тексту: `vault find` → `vault toc` → `vault show <заметка> \'#секция\'`; журналы >40 КБ целиком не читать. Все факты с источниками: [[FACTS]], `vault fact ls [--stale]`.',
    '',
  ].join('\n');

  const desks = listNotes(dir, 'project').filter(n => n.base.startsWith('desk_')).map(n => ({ ...n, desc: fmDesc(n.file).replace(/^Стол( агента)? \S+:\s*/, '').replace(/^«[^»]+»\s*/, '') }));
  const pins = readPins(P.pins).map(b => ({ base: b, file: findNote(dir, b) })).filter(x => x.file).map(x => ({ ...x, desc: fmDesc(x.file) }));
  const fb = listNotes(dir, 'feedback').map(n => ({ ...n, desc: fmDesc(n.file) }));
  const rules = fb.filter(n => n.desc.includes('⚡'));

  const render = (v) => {
    const lines = live.slice(0, v.nFacts).map(factLine);
    if (v.nFacts < live.length) lines.push(`- … ещё ${live.length - v.nFacts}: \`vault fact ls\``);
    const parts = [head,
      `## Сейчас — факты (${live.length} живых из ${all.length}; не сверялись дольше срока: ${staleN})`, ...lines, '',
      '## Столы агентов ([[feedback_agent_team]])', ...desks.map(n => `- [[${n.base}]]${v.desk ? ' — ' + brief(n.desc, v.desk) : ''}`), '',
      '## Главные заметки', ...pins.map(n => `- [[${n.base}]]${v.pin ? ' — ' + brief(n.desc.replace(/^[⭐⚡⚠️✅⏳🔴\s]+/u, ''), v.pin) : ''}`), '',
      '## Правила ⚡ (feedback)', v.ruleDesc ? rules.map(n => `- [[${n.base}]] — ${brief(n.desc.replace(/⚡\s*/g, ''), v.ruleDesc)}`).join('\n') : rules.map(n => `[[${n.base}]]`).join(' · '),
      v.otherFb ? `Остальные: ${fb.filter(n => !rules.includes(n)).map(n => `[[${n.base}]]`).join(' · ')}` : `Остальные правила (${fb.length - rules.length}): \`vault ls feedback\``, '',
      '## Остальное', '- `vault ls <тема>` / `vault find <слова>` — проекты, справка, хобби, поле. Полный старый индекс — MEMORY.md.', ''];
    return parts.join('\n');
  };
  // от подробного к сжатому; факты режем в последнюю очередь (снизу — done/info)
  const variants = [
    { desk: 80, pin: 70, ruleDesc: 60, otherFb: true },
    { desk: 60, pin: 60, ruleDesc: 45, otherFb: false },
    { desk: 45, pin: 45, ruleDesc: 0, otherFb: false },
    { desk: 35, pin: 35, ruleDesc: 0, otherFb: false },
    { desk: 28, pin: 28, ruleDesc: 0, otherFb: false },
    { desk: 0, pin: 30, ruleDesc: 0, otherFb: false },
    { desk: 0, pin: 0, ruleDesc: 0, otherFb: false },
  ];
  for (const v of variants) { const t = render({ ...v, nFacts: live.length }); if (B(t) <= LIMIT) return t; }
  const v = { ...variants[variants.length - 1] };
  for (let n = live.length - 1; n >= 0; n--) { const t = render({ ...v, nFacts: n }); if (B(t) <= LIMIT) return t; }
  return render({ ...v, nFacts: 0 });
}

function write(opts = {}) {
  const dir = opts.dir || facts.vaultDir();
  const text = build(opts);
  const out = opts.out || path.join(dir, 'MEMORY.next.md');
  fs.writeFileSync(out, text, 'utf8');
  return { out, bytes: B(text) };
}

module.exports = { build, write, LIMIT };
