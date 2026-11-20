// Команды CLI `vault fact …`, `vault verify`, `vault index --build`. Работают с файлами напрямую, без сервера.
'use strict';
const facts = require('./facts');
const { runCheck } = require('./verify');
const memindex = require('./memindex');

const tty = process.stdout.isTTY;
const bold = s => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = s => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const die = (msg, code = 1) => { console.error('vault fact: ' + msg); process.exit(code); };

function parseKv(args) {
  const out = {};
  for (const a of args) {
    const i = a.indexOf('=');
    if (i <= 0) die(`ожидаю ключ=значение, а не «${a}»`);
    out[a.slice(0, i).trim()] = a.slice(i + 1);
  }
  return out;
}
function needId(q) {
  if (!q) die('нужен id факта (vault fact ls — список)');
  const r = facts.resolve(q);
  if (typeof r === 'string') return r;
  if (r.ambiguous.length) die(`«${q}» — несколько: ${r.ambiguous.join(', ')}`, 2);
  die(`факта «${q}» нет (vault fact ls ${q})`);
}
function printFact(f, histN = 5) {
  const S = facts.STATES[f.state] || facts.STATES.info;
  console.log(`${f.icon} ${bold(f.title)}  ${dim('[' + f.id + ']')}${f.archived ? '  (в архиве с ' + f.archived + ')' : ''}`);
  console.log(`   статус:   ${f.status || S.label}  (${f.state})`);
  if (f.value) console.log(`   значение: ${f.value}`);
  if (f.since) console.log(`   с:        ${f.since}`);
  if (f.src) console.log(`   источник: ${f.src}`);
  if (f.by) console.log(`   подтвердил: ${f.by}`);
  if (f.notes && f.notes.length) console.log(`   заметки:  ${f.notes.join(', ')}`);
  if (f.tags && f.tags.length) console.log(`   теги:     ${f.tags.join(', ')}`);
  console.log(`   сверено:  ${f.checked || '—'} (${f.age === Infinity ? '?' : f.age + ' дн назад'}, срок ${f.ttlDays} дн)${f.stale ? '  ⚠ пора сверить' : ''}`);
  if (f.check) console.log(`   проверка: ${JSON.stringify(f.check)}${f.verify ? `  → последняя ${f.verify.at}: ${f.verify.ok === true ? 'ок' : f.verify.ok === false ? 'РАСХОЖДЕНИЕ' : 'не смог'} «${f.verify.observed}»` : ''}`);
  const h = f.history || [];
  if (histN && h.length) {
    console.log(`   история (${h.length}):`);
    for (const e of h.slice(-histN)) console.log('     ' + histLine(e));
  }
}
function histLine(e) {
  const parts = [];
  if (e.archived) parts.push('в архив');
  if (e.ok) parts.push('подтверждено');
  if (e.state) parts.push((facts.STATES[e.state] || {}).icon || e.state);
  if (e.status !== undefined) parts.push(e.status);
  if (e.value !== undefined) parts.push('«' + e.value + '»');
  if (e.since !== undefined) parts.push('с ' + e.since);
  if (e.src !== undefined) parts.push('src: ' + e.src);
  if (e.by) parts.push('— ' + e.by);
  if (e.why) parts.push('(' + e.why + ')');
  return `${e.at}  ${parts.join(' ')}`;
}

const sub = {
  set(args) {
    const id = args[0];
    if (!id) die('vault fact set <id> status=… value=… src=… note=…');
    const kv = parseKv(args.slice(1));
    try {
      const existed = !!facts.get(id);
      const f = facts.set(id, kv);
      console.log(`${existed ? 'обновлён' : 'заведён'}: ${facts.oneLine(f)}`);
    } catch (e) { die(e.message); }
  },
  ok(args) {
    const id = needId(args[0]);
    try { const f = facts.set(id, parseKv(args.slice(1)), { ok: true }); console.log('подтверждено: ' + facts.oneLine(f)); } catch (e) { die(e.message); }
  },
  get(args) { printFact(facts.get(needId(args[0])), 5); },
  show(args) { sub.get(args); },
  log(args) {
    const f = facts.get(needId(args[0]));
    console.log(`${f.icon} ${bold(f.title)} ${dim('[' + f.id + ']')}`);
    for (const e of f.history || []) console.log('  ' + histLine(e));
  },
  ls(args) {
    const opts = { stale: args.includes('--stale'), archived: args.includes('--all') };
    const st = args.find(a => a.startsWith('--state='));
    if (st) opts.state = st.split('=')[1];
    const q = args.filter(a => !a.startsWith('--')).join(' ');
    const list = facts.list(q, opts);
    for (const f of list) {
      const age = f.age === Infinity ? '?' : f.age + 'д';
      console.log(`${f.icon} ${f.id.padEnd(24)} ${(f.status || '').slice(0, 34).padEnd(34)} ${dim(age.padStart(4))}${f.stale ? ' ⚠' : '  '} ${(f.title || '').slice(0, 60)}`);
    }
    const stale = list.filter(f => f.stale).length;
    console.log(dim(`\n${list.length} фактов${stale ? `, ⚠ не сверялись дольше срока: ${stale} (vault verify / vault fact ok <id>)` : ''}`));
  },
  ref(args) { const id = needId(args[0]); console.log(`{{fact:${id}}} [[FACTS#${id}]]`); },
  rm(args) {
    const id = needId(args[0]);
    const kv = parseKv(args.slice(1));
    const f = facts.archive(id, kv.why);
    console.log('в архиве: ' + f.id);
  },
  md() { const db = facts.load(); facts.withLock(facts.vaultDir(), () => facts.writeDb(facts.vaultDir(), JSON.parse(JSON.stringify(db)))); console.log(facts.paths().md); },
};

module.exports = {
  async fact(args) {
    const [c, ...rest] = args;
    if (!c || !sub[c]) {
      console.log('vault fact set|ok|get|ls|log|ref|rm|md …  (vault без аргументов — справка)');
      return;
    }
    return sub[c](rest);
  },
  async facts(args) { return sub.ls(args); },
  async verify(args) {
    const dry = args.includes('--dry');
    const ids = args.filter(a => !a.startsWith('--'));
    const list = ids.length ? ids.map(i => facts.get(needId(i))) : facts.all();
    let bad = 0, ok = 0, fail = 0;
    for (const f of list.filter(x => x.check)) {
      const r = await runCheck(f.check);
      if (!dry) facts.recordVerify(f.id, r);
      if (r.ok === true) { ok++; console.log(`✅ ${f.id}: совпадает — «${r.observed}»`); }
      else if (r.ok === false) { bad++; console.log(`⚠ ${f.id}: РАСХОЖДЕНИЕ — в памяти «${f.check.expect}», источник говорит «${r.observed}»\n   → поправь: vault fact set ${f.id} status=… src="${f.check.kind} ${facts.isoLocal().slice(0, 10)}"`); }
      else { fail++; console.log(`? ${f.id}: не смог сверить — ${r.error || 'нет ожидаемого значения (check.expect)'}`); }
    }
    const fresh = facts.all().filter(f => !f.check && f.stale && (!ids.length || ids.includes(f.id)));
    if (fresh.length) {
      console.log(`\nБез автопроверки и давно не сверялись (${fresh.length}) — сверить руками и \`vault fact ok <id> src=…\`:`);
      for (const f of fresh) console.log(`  ${f.icon} ${f.id.padEnd(24)} ${f.age === Infinity ? '?' : f.age} дн (срок ${f.ttlDays})  ${(f.status || '').slice(0, 50)}`);
    }
    console.log(dim(`\nавтопроверка: ок ${ok}, расхождений ${bad}, не смог ${fail}${dry ? ' (--dry: ничего не записано)' : ''}`));
    if (bad) process.exitCode = 3;
  },
  async index(args) {
    if (!args.includes('--build')) { console.log('vault index --build  — собрать черновик MEMORY.next.md (MEMORY.md не трогает)'); return; }
    const r = memindex.write();
    console.log(`собрано: ${r.out} (${(r.bytes / 1024).toFixed(1)} КБ из ${memindex.LIMIT / 1024})`);
  },
};
