'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const facts = require('../lib/facts');
const R = require('../lib/recall');
const { tmpVault, seed } = require('./helpers');

const dir = tmpVault();
seed(facts, dir);
const ix = R.buildIndex(dir);
const top = (q, n = 3) => R.recall(q, { dir, index: ix }).items.slice(0, n).map(r => r.doc.id);

test('стемминг и похожесть', () => {
  assert.equal(R.stem('мобилке'), R.stem('мобилка'));
  assert.equal(R.stem('агентам'), 'агент');
  assert.ok(R.sim(R.stem('агентам'), R.stem('агентами')) >= 0.6);
  assert.equal(R.sim(R.stem('раскрой'), R.stem('раскладка')), 0, 'общие 4 буквы — ещё не родство');
  assert.equal(R.sim('мет', 'метр'), 0, 'короткие — только целиком');
  assert.equal(R.norm('Ёлка, $50!'), 'елка 50');
});

test('словарь: варианты, многословные, цели', () => {
  const g = R.parseSynonyms('# x\n- acme, acme corp, тётя алиса → desk_acme\nне список\n- jira, джира');
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].targets, ['desk_acme']);
  assert.ok(g[0].seqs.some(s => s.length === 2 && s[0] === 'acme'));
});

// разговорные фразы (синтетические примеры) → что должно оказаться наверху
const CASES = [
  ['ну шо по агентам', 'agents_reports'],
  ['джира ключ', 'jira_key'],
  ['app review мы же подавали', 'app_review'],
  ['че по мобилке', 'desk_mobile'],
  ['acme corp', 'desk_acme'],
  ['тётя Алиса что там', 'desk_acme'],
  ['црм загрузил?', 'crm_prod_version'],
  ['$50', 'ad_prepay'],
  ['аудитор', 'project_claude_panel'],
  ['мастерская станок', 'workshop_machine'],
  ['новостные каналы', 'news_channels'],
];
for (const [q, want] of CASES) {
  test(`recall «${q}» → ${want}`, () => {
    const got = top(q);
    assert.ok(got.includes(want), `${q}: ${got.join(', ')}`);
  });
}

test('стол, на который ссылается найденный факт, подтягивается', () => {
  assert.ok(top('джира ключ', 5).includes('desk_tracker'));
});

test('мусор и стоп-слова → пусто; вывод ≤ 1 КБ', () => {
  assert.equal(R.recall('ну шо там как', { dir, index: ix }).items.length, 0);
  assert.equal(R.format(R.recall('ну шо там', { dir, index: ix })), '');
  for (const [q] of CASES) {
    const out = R.format(R.recall(q, { dir, index: ix }));
    assert.ok(Buffer.byteLength(out) <= 1000, `${q}: ${Buffer.byteLength(out)} байт`);
  }
  const out = R.format(R.recall('че по мобилке', { dir, index: ix }));
  assert.match(out, /^память \(vault-recall\)/);
  assert.match(out, /⛔ hosting_debt «Долг хостинга» — не оплачен/);
});

test('bin/vault-recall --hook: JSON на stdin, слэш-команды и ошибки молча', () => {
  const bin = path.join(__dirname, '..', 'bin', 'vault-recall');
  const env = { ...process.env, VAULT_DIR: dir };
  let r = spawnSync(bin, ['--hook'], { input: JSON.stringify({ prompt: 'acme corp', session_id: 'x' }), env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /desk_acme/);
  r = spawnSync(bin, ['--hook'], { input: JSON.stringify({ prompt: '/clear' }), env, encoding: 'utf8' });
  assert.equal(r.stdout, '');
  r = spawnSync(bin, ['--hook'], { input: 'не json, но про мобилку', env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  r = spawnSync(bin, ['--hook'], { input: '{"prompt":"мобилка"}', env: { ...process.env, VAULT_DIR: '/nonexistent/x' }, encoding: 'utf8' });
  assert.equal(r.status, 0, 'нет vault — молчим, не роняем хук');
});

test('стоп-слова: местоимения и глаголы-команды не дают очков', () => {
  for (const w of ['этого', 'моего', 'удали', 'посмотри', 'сделай']) assert.ok(R.STOP.has(w), w);
  const r = R.recall('удали этого с моего терминала', { dir, index: ix });
  assert.deepEqual(r.units, ['терминала']);
});

test('хаб: заметка-стол получает 0.3 от лучшего факта, а не сумму всех', () => {
  const r = R.recall('че по мобилке', { dir, index: ix });
  const desk = r.items.find(x => x.doc.id === 'desk_mobile');
  assert.ok(desk, 'desk_mobile найден');
  // тот же vault без фактов → очки стола за свои слова и словарь
  const bare = tmpVault();
  const own = R.recall('че по мобилке', { dir: bare, index: R.buildIndex(bare) }).items.find(x => x.doc.id === 'desk_mobile').score;
  const linked = R.recall('че по мобилке', { dir, index: ix, max: 50 }).items.filter(x => x.doc.kind === 'fact' && (x.doc.fact.notes || []).includes('desk_mobile')).map(x => x.score).sort((a, b) => b - a);
  assert.ok(linked.length >= 2, 'к desk_mobile привязано ≥2 найденных факта');
  const bonus = desk.score - own;
  const sum = linked.reduce((a, x) => a + x, 0);
  assert.ok(bonus <= 0.3 * linked[0] + 0.05 * (sum - linked[0]) + 1e-6, `бонус ${bonus} по формуле`);
  assert.ok(bonus < 0.3 * sum, `бонус ${bonus} меньше старой суммы ${0.3 * sum}`);
});
