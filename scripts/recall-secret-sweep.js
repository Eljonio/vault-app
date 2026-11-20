#!/usr/bin/env node
// Прогон по всем описаниям заметок и всем фактам: в выводе vault-recall не должно остаться учётных данных.
//   node scripts/recall-secret-sweep.js [--verbose]
// Значения секретов НЕ печатает — только имена заметок и счётчики.
'use strict';
const fs = require('fs');
const path = require('path');
const facts = require('../lib/facts');
const R = require('../lib/recall');
const { TOKEN_RES, isMush } = require('../lib/redact');

const dir = facts.vaultDir();
const verbose = process.argv.includes('--verbose');
const ix = R.buildIndex(dir);
const notes = ix.docs.filter(d => d.kind === 'note');

// кандидаты в секреты берём из СЫРЫХ описаний (кэш recall хранит уже вычищенные)
function rawDesc(id, folder) {
  const t = fs.readFileSync(path.join(dir, folder, id + '.md'), 'utf8').slice(0, 12000);
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return ((m && (m[1].match(/^description:\s*(.*)$/m) || [])[1]) || '').replace(/^["']|["']$/g, '');
}
const KW = /(?:пароль|пароля|паролем|password|passwd|pwd|pass|логин|логина|login|username|pin|пин)(?![\p{L}\d_])\s*(?:[:=]|—|–|-)?\s*[«"'`]?(\+?\d[\d\s()-]{5,}\d|[^\s,;()«»"'<>\]\[]+)/giu;
function candidates(text) {
  const out = new Set();
  let m;
  KW.lastIndex = 0;
  while ((m = KW.exec(text))) if (m[1].length >= 3) out.add(m[1].replace(/[`'".]+$/, ''));
  if (/пароль|password/i.test(text)) for (const e of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []) out.add(e);
  for (const re of TOKEN_RES) for (const t of text.match(new RegExp(re.source, 'g')) || []) out.add(t);
  for (const w of text.match(/[A-Za-z0-9_+/=.-]{32,}/g) || []) if (isMush(w)) out.add(w);
  return [...out].filter(c => c.length >= 3);
}

let withCands = 0, totalCands = 0, leaks = 0, lines = 0, outputs = 0;
const leakNotes = new Set();
const allCands = [];
for (const d of notes) {
  const raw = rawDesc(d.id, d.folder);
  const c = candidates(raw);
  if (c.length) { withCands++; totalCands += c.length; allCands.push(...c.map(v => [d.id, v])); }
}
for (const f of facts.all()) {
  const c = [f.title, f.status, f.value, f.src].flatMap(x => candidates(String(x || '')));
  if (c.length) { withCands++; totalCands += c.length; allCands.push(...c.map(v => [f.id, v])); }
}
const check = (out, label) => {
  outputs++;
  lines += out ? out.split('\n').length : 0;
  for (const [owner, v] of allCands) {
    // «обычные» слова-кандидаты вроде «и», «от» не считаем утечкой: проверяем только похожее на значение
    if (/^[а-яё]+$/u.test(v)) continue;
    if (out.includes(v)) { leaks++; leakNotes.add(owner + ' (запрос: ' + label + ')'); }
  }
};
// 1) каждая заметка напрямую через format (как её покажет recall), 2) живой recall по имени и началу описания
for (const d of notes) {
  check(R.format({ items: [{ doc: d, score: 9, why: [] }] }), d.id);
  const q = d.id.replace(/_/g, ' ') + ' ' + d.desc.split(/\s+/).slice(0, 4).join(' ');
  check(R.format(R.recall(q, { dir, index: ix })), d.id);
}
for (const f of facts.all()) check(R.format(R.recall(f.id.replace(/_/g, ' ') + ' ' + f.title, { dir, index: ix })), f.id);
for (const q of ['пароль', 'логин пароль', 'прокси парсера', 'че по прокси парсера', 'доступы к кабинету', 'вход crm pin', 'ключ токен']) check(R.format(R.recall(q, { dir, index: ix })), q);

// контроль, что проверка не пустая: если бы recall печатал СЫРЫЕ описания, сколько значений утекло бы
let control = 0;
const owners = new Set();
for (const d of notes) {
  const raw = '📄 ' + d.id + ' — ' + rawDesc(d.id, d.folder);
  for (const [owner, v] of allCands) if (!/^[а-яё]+$/u.test(v) && raw.includes(v)) { control++; owners.add(owner); }
}
console.log(`заметок с описанием: ${notes.length}, фактов: ${facts.all().length}`);
console.log(`описаний/фактов с похожим на учётные данные: ${withCands} (значений-кандидатов: ${totalCands})`);
console.log(`прогонов recall: ${outputs}, строк вывода: ${lines}`);
console.log(`контроль без вычистки: утекло бы значений ${control} (заметки: ${[...owners].join(', ') || '—'})`);
console.log(`утечек в выводе: ${leaks}`);
if (leaks && verbose) for (const n of leakNotes) console.log('  ✗ ' + n);
process.exit(leaks ? 1 : 0);
