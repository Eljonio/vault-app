'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const facts = require('../lib/facts');
const { runCheck, matches, KINDS } = require('../lib/verify');
const memindex = require('../lib/memindex');
const { tmpVault, tmpDir, seed, FAKE } = require('./helpers');

test('verify: file_grep совпадение и расхождение, regex', async () => {
  const f = path.join(tmpDir('vf-'), 'package.json');
  fs.writeFileSync(f, '{\n  "name": "demo-app",\n  "version": "0.1.62-crm",\n}\n');
  assert.deepEqual(await runCheck({ kind: 'file_grep', path: f, pattern: '"version"', expect: '0.1.62-crm' }), { ok: true, observed: '"version": "0.1.62-crm",' });
  assert.equal((await runCheck({ kind: 'file_grep', path: f, pattern: '"version"', expect: '0.1.63' })).ok, false);
  assert.equal(matches('0.1.62-crm', '/0\\.1\\.6\\d/'), true);
  assert.equal(matches('x', ''), null);
});

test('verify: git_head на временном репо', async () => {
  const repo = tmpDir('vg-');
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('init', '-q'); fs.writeFileSync(path.join(repo, 'a'), '1'); g('add', 'a');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', '0.1.62-crm: релиз');
  const r = await runCheck({ kind: 'git_head', repo, ref: 'HEAD', expect: '0.1.62-crm' });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('verify: опасное и неизвестное отклоняется без запуска', async () => {
  assert.equal((await runCheck({ kind: 'rm_rf' })).ok, null);
  assert.match((await runCheck({ kind: 'ssh_grep', host: '-oProxyCommand=touch /tmp/x', file: 'a', pattern: 'b' })).error, /host/);
  assert.match((await runCheck({ kind: 'git_head', repo: '/tmp', ref: '--output=/tmp/x' })).error, /ref/);
  assert.match((await runCheck({ kind: 'http', url: 'file:///etc/passwd' })).error, /url/);
  assert.deepEqual(Object.keys(KINDS).sort(), ['file_grep', 'git_head', 'http', 'ssh_grep']);
});

test('index --build: ≤ 10 КБ, блоки «Сейчас», столы, главные, правила', () => {
  const dir = tmpVault();
  seed(facts, dir);
  const text = memindex.build({ dir });
  assert.ok(Buffer.byteLength(text) <= memindex.LIMIT);
  for (const h of ['## Как работать с памятью', '## Сейчас — факты', '## Столы агентов', '## Главные заметки', '## Правила ⚡'])
    assert.ok(text.includes(h), h);
  assert.match(text, /⛔ `hosting_debt` Долг хостинга/);
  assert.match(text, /\[\[desk_mobile\]\]/);
  // разбухание: 300 фактов всё равно ≤ 10 КБ
  for (let i = 0; i < 300; i++) facts.set('bulk_' + i, { state: 'todo', status: 'дело номер ' + i, value: 'x'.repeat(80) }, { dir });
  const big = memindex.build({ dir });
  assert.ok(Buffer.byteLength(big) <= memindex.LIMIT, Buffer.byteLength(big) + ' байт');
  assert.match(big, /… ещё \d+: `vault fact ls`/);
  const r = memindex.write({ dir });
  assert.equal(r.out, path.join(dir, 'MEMORY.next.md'));
  assert.ok(!fs.existsSync(path.join(dir, 'MEMORY.md')), 'MEMORY.md не создаётся и не трогается');
});

test('CLI: vault fact set/get/ls/log/ref/ok, секрет → код 1, без сервера', () => {
  const dir = tmpVault();
  const bin = path.join(__dirname, '..', 'bin', 'vault');
  const env = { ...process.env, VAULT_DIR: dir, VAULT_PORT: '1' }; // порт 1 — сервера нет, факты должны работать без него
  const v = (...a) => spawnSync(bin, a, { env, encoding: 'utf8' });
  let r = v('fact', 'set', 'app_review', 'title=App Review', 'status=подано, на проверке', 'src=скрин 20.10', 'note=desk_mobile', 'since=после 16.10');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /заведён: ⏳ App Review/);
  r = v('fact', 'set', 'app_review', 'status=одобрено', 'src=кабинет', 'why=письмо');
  assert.match(r.stdout, /обновлён: ✅/);
  r = v('fact', 'get', 'app_rev');
  assert.match(r.stdout, /история \(2\)/);
  r = v('fact', 'log', 'app_review');
  assert.match(r.stdout, /одобрено src: кабинет \(письмо\)/);
  r = v('fact', 'ls', '--state=done');
  assert.match(r.stdout, /app_review/);
  r = v('fact', 'ref', 'app_review');
  assert.equal(r.stdout.trim(), '{{fact:app_review}} [[FACTS#app_review]]');
  r = v('fact', 'ok', 'app_review');
  assert.match(r.stdout, /подтверждено/);
  r = v('fact', 'set', 'tok', 'value=' + FAKE.anthropic);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /секрет/);
  r = v('fact', 'set', 'x1', 'oops');
  assert.equal(r.status, 1);
  r = v('index', '--build');
  assert.match(r.stdout, /MEMORY\.next\.md/);
  r = v('verify', '--dry');
  assert.equal(r.status, 0);
});
