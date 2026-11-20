'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const facts = require('../lib/facts');
const { tmpVault, FAKE } = require('./helpers');

test('set: заводит факт, история, состояние угадывается по статусу', () => {
  const dir = tmpVault();
  const f = facts.set('app_review', { title: 'App Review', status: 'подано, на проверке', src: 'скрин', note: 'desk_mobile' }, { dir });
  assert.equal(f.state, 'wait');
  assert.deepEqual(f.notes, ['desk_mobile']);
  assert.equal(f.history.length, 1);
  const g = facts.set('app_review', { status: 'одобрено', src: 'кабинет', why: 'письмо' }, { dir });
  assert.equal(g.state, 'done');
  assert.equal(g.history.length, 2);
  assert.equal(g.history[1].why, 'письмо');
  assert.equal(g.history[1].status, 'одобрено');
  assert.equal(g.history[1].value, undefined, 'в событие попадает только изменённое');
});

test('set без изменений не плодит историю; ok — подтверждение с отметкой', () => {
  const dir = tmpVault();
  facts.set('x_fact', { status: 'ждём', src: 'a' }, { dir });
  const a = facts.set('x_fact', { tags: 'один,два' }, { dir });
  assert.equal(a.history.length, 1);
  assert.deepEqual(a.tags, ['один', 'два']);
  const b = facts.set('x_fact', {}, { dir, ok: true });
  assert.equal(b.history.length, 2);
  assert.equal(b.history[1].ok, true);
  assert.throws(() => facts.set('nope_fact', {}, { dir, ok: true }), /нет/);
});

test('секреты не кладутся', () => {
  const dir = tmpVault();
  for (const v of [FAKE.meta, FAKE.anthropic, FAKE.github, FAKE.telegram])
    assert.throws(() => facts.set('tok', { value: v }, { dir }), /секрет/, v);
  // git-хэш и обычный текст — можно
  facts.set('tok', { value: 'коммит 815b30f9c3d2e1a0b9c8d7e6f5a4b3c2d1e0f9a8, токен засвечен' }, { dir });
  assert.ok(facts.get('tok', { dir }));
});

test('id и поля валидируются', () => {
  const dir = tmpVault();
  assert.throws(() => facts.set('Bad-Id', {}, { dir }), /id/);
  assert.throws(() => facts.set('ok_id', { colour: 'red' }, { dir }), /неизвестное поле/);
  assert.throws(() => facts.set('ok_id', { state: 'maybe' }, { dir }), /state/);
  assert.throws(() => facts.set('ok_id', { ttl: '-1' }, { dir }), /ttl/);
  const f = facts.set('ok_id', { state: '⛔', since: '20.10.2026 00:32', check: 'prod_version:0.1.62-crm' }, { dir });
  assert.equal(f.state, 'blocked');
  assert.equal(f.since, '2026-10-20 00:32');
  assert.equal(f.check.kind, 'ssh_grep');
  assert.equal(f.check.expect, '0.1.62-crm');
});

test('normDate и guessState', () => {
  const now = new Date(2026, 9, 20, 1, 0);
  assert.equal(facts.normDate('16.10', now), '2026-10-16');
  assert.equal(facts.normDate('2026-10-20 0:32', now), '2026-10-20 00:32');
  assert.equal(facts.normDate('после 16.10', now), 'после 16.10');
  assert.equal(facts.guessState('не выкачено'), 'wait');
  assert.equal(facts.guessState('не подано'), 'todo');
  assert.equal(facts.guessState('засвечен'), 'risk');
  assert.equal(facts.guessState('потом'), 'later');
  assert.equal(facts.guessState('не оплачен — стоит'), 'blocked');
  assert.equal(facts.guessState('на проде'), 'done');
  assert.equal(facts.guessState('что-то'), null);
});

test('stale: по сроку состояния, checked= задаёт дату сверки', () => {
  const dir = tmpVault();
  facts.set('old_one', { state: 'wait', status: 'ждём', checked: '2026-10-10' }, { dir });
  facts.set('fresh_one', { state: 'wait', status: 'ждём' }, { dir });
  const now = new Date();
  const stale = facts.list('', { dir, stale: true, now }).map(f => f.id);
  assert.ok(stale.includes('old_one'));
  assert.ok(!stale.includes('fresh_one'));
  const f = facts.get('old_one', { dir });
  assert.ok(f.age >= 14 && f.ttlDays === 14, `wait — срок 14 дн (с 10.11), age ${f.age}`);
});

test('archive прячет из списка, история остаётся; resolve нечёткий', () => {
  const dir = tmpVault();
  facts.set('acme_bot', { status: 'готово' }, { dir });
  facts.set('acme_qr', { status: 'ждём' }, { dir });
  assert.deepEqual(facts.resolve('acme_q', { dir }), 'acme_qr');
  assert.deepEqual(facts.resolve('acme', { dir }).ambiguous.sort(), ['acme_bot', 'acme_qr']);
  facts.archive('acme_bot', 'устарело', { dir });
  assert.deepEqual(facts.list('', { dir }).map(f => f.id), ['acme_qr']);
  assert.equal(facts.list('', { dir, archived: true }).length, 2);
  assert.equal(facts.get('acme_bot', { dir }).history.at(-1).archived, true);
});

test('файл: JSON читается обратно, FACTS.md с якорями, {{fact:id}} раскрывается', () => {
  const dir = tmpVault();
  facts.set('app_review', { title: 'App Review', status: 'на проверке', src: 'скрин', since: '2026-10-20', notes: 'desk_mobile' }, { dir });
  const raw = fs.readFileSync(path.join(dir, 'facts', 'facts.json'), 'utf8');
  const db = JSON.parse(raw);
  assert.equal(db.facts.app_review.status, 'на проверке');
  assert.match(raw, /\n        \{"at":/, 'события истории — по одному на строку (диффы в git читаемые)');
  const md = fs.readFileSync(path.join(dir, 'facts', 'FACTS.md'), 'utf8');
  assert.match(md, /^### app_review$/m);
  assert.match(md, /\[\[desk_mobile\]\]/);
  const t = facts.expandRefs('см. {{fact:app_review}} и {{fact:nope}}', { dir });
  assert.match(t, /\{\{fact:app_review\}\} ⟨⏳ на проверке · с 20\.10 · src скрин⟩/);
  assert.match(t, /\{\{fact:nope\}\} ⟨нет такого факта⟩/);
  assert.deepEqual(facts.refIds('a {{fact:x_y}} b {{fact:x_y}} {{fact:z1}}'), ['x_y', 'z1']);
});

test('lock: параллельные процессы не теряют записи', async () => {
  const dir = tmpVault();
  const { spawn } = require('child_process');
  const lib = path.join(__dirname, '..', 'lib', 'facts.js');
  const run = i => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['-e', `const f=require(${JSON.stringify(lib)});for(let k=0;k<5;k++)f.set('p${i}_'+k,{status:'ждём'},{dir:${JSON.stringify(dir)}})`]);
    p.on('exit', c => (c === 0 ? res() : rej(new Error('exit ' + c))));
  });
  await Promise.all([0, 1, 2, 3].map(run));
  assert.equal(facts.list('', { dir }).length, 20);
});

test('notes — только существующие заметки', () => {
  const { tmpVault } = require('./helpers');
  const d = tmpVault();
  assert.throws(() => facts.set('x_note', { title: 'x', status: 'wait', notes: 'оркестратор' }, { dir: d }), /нет такой заметки/);
  assert.doesNotThrow(() => facts.set('x_note', { title: 'x', status: 'wait', notes: 'desk_mobile' }, { dir: d }));
  assert.doesNotThrow(() => facts.set('x_note', { notes: 'FACTS#x_note' }, { dir: d }));
});

test('guessState: английские статусы агентов (done/wait/blocked), «live» внутри слова не считается', () => {
  assert.equal(facts.guessState('done'), 'done');
  assert.equal(facts.guessState('wait'), 'wait');
  assert.equal(facts.guessState('blocked'), 'blocked');
  assert.equal(facts.guessState('todo'), 'todo');
  assert.equal(facts.guessState('delivered 10'), null);
});

test('by: прежний подтверждавший за новое состояние не отвечает', () => {
  const { tmpVault } = require('./helpers');
  const d = tmpVault();
  facts.set('b1', { status: 'готово', by: 'Alice' }, { dir: d });
  let f = facts.set('b1', { status: 'сломалось' }, { dir: d });
  assert.equal(f.by, undefined);
  assert.equal(f.history.at(-1).by, undefined);
  f = facts.set('b1', { status: 'снова готово', by: 'Claude' }, { dir: d });
  assert.equal(f.by, 'Claude');
  assert.equal(f.history.at(-1).by, 'Claude');
});
