'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { redact, mentionsPassword, hasCredential } = require('../lib/redact');
const facts = require('../lib/facts');
const R = require('../lib/recall');
const memindex = require('../lib/memindex');
const { tmpVault, seed, FAKE } = require('./helpers');

test('redact: учётные данные → [скрыто], обычный текст цел', () => {
  const cases = [
    ['логин foo@example.com, пароль Abc123!x; что брать', 'логин [скрыто], пароль [скрыто]; что брать'],
    ['пароль: qwerty', 'пароль: [скрыто]'],
    ['password=hunter2', 'password=[скрыто]'],
    ['PIN 4821', 'PIN [скрыто]'],
    ['вход: логин +1 555 010 00 00, пароль x', 'вход: логин [скрыто], пароль [скрыто]'],
    ['key=abcd1234', 'key=[скрыто]'],
    ['токен ' + FAKE.meta + ' в .env', 'токен [скрыто] в .env'],
    ['ключ ' + FAKE.anthropic, 'ключ [скрыто]'],
    ['почта me@example.com, пароль у Алисы', 'почта [скрыто], пароль у Алисы'],
  ];
  for (const [a, b] of cases) assert.equal(redact(a), b, a);
  for (const t of ['пароль от кабинета', 'логин и пароль у Алисы', 'PIN придумать', 'токен META_WA_TOKEN засвечен', 'ключ в ~/.ssh/demo-key',
    'ссылка+код живут 72 ч', 'user_alice', 'Claude Code CLI', 'git 815b30f9c3d2e1a0b9c8d7e6f5a4b3c2d1e0f9a8', 'почта hello@example.com'])
    assert.equal(redact(t), t, t);
  assert.equal(mentionsPassword('логин и Пароль'), true);
  assert.equal(mentionsPassword('логин'), false);
  assert.equal(hasCredential('пароль Abc123'), true);
  assert.equal(hasCredential('пароль от кабинета'), false);
});

test('recall: описание с паролем не показывается, факты чистятся, кэш без секретов', () => {
  const dir = tmpVault();
  seed(facts, dir);
  fs.writeFileSync(path.join(dir, 'reference', 'reference_proxy_vendor.md'),
    '---\nname: reference_proxy_vendor\ndescription: "Аккаунт прокси-сервиса для парсера demo: логин spy@example.com, пароль Sup3rS3cret!; что брать"\n---\n# x\n');
  fs.writeFileSync(path.join(dir, 'reference', 'reference_box.md'),
    '---\nname: reference_box\ndescription: "Сервер box прокси: PIN 4821, token=Zx9Kq2Lm8Np4Rt6Vw1Yb3Cd5Ef7Gh0Ij2"\n---\n# x\n');
  const out = R.format(R.recall('proxy vendor прокси box', { dir }));
  assert.match(out, /reference_proxy_vendor \(описание скрыто/);
  for (const s of ['spy@example.com', 'Sup3rS3cret', '4821', 'Zx9Kq2Lm8Np4Rt6Vw1Yb3Cd5Ef7Gh0Ij2']) assert.ok(!out.includes(s), s);
  const cache = fs.readdirSync(process.env.XDG_RUNTIME_DIR).filter(f => f.startsWith('vault-recall-')).map(f => fs.readFileSync(path.join(process.env.XDG_RUNTIME_DIR, f), 'utf8')).join('');
  for (const s of ['Sup3rS3cret', 'Zx9Kq2Lm8Np4Rt6Vw1Yb3Cd5Ef7Gh0Ij2', '4821']) assert.ok(!cache.includes(s), 'кэш: ' + s);
  // fact set не принимает «пароль <значение>»
  assert.throws(() => facts.set('creds', { value: 'вход: логин admin, пароль Qwerty12' }, { dir }), /секрет/);
  // индекс: описание с паролем не попадает
  fs.writeFileSync(path.join(dir, 'facts', 'memory-pins.md'), '- [[reference_proxy_vendor]]\n');
  const idx = memindex.build({ dir });
  assert.ok(!idx.includes('Sup3rS3cret') && !idx.includes('spy@example.com'));
  // прогон по всем описаниям (скрипт) — утечек 0
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'recall-secret-sweep.js')], { env: { ...process.env, VAULT_DIR: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /утечек в выводе: 0/);
  assert.match(r.stdout, /утекло бы значений [1-9]/, 'контроль: проверка не пустая');
});
