'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const facts = require('../lib/facts');
const { tmpVault, tmpDir, seed, FAKE } = require('./helpers');

const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
let srv, dir;

test.before(async () => {
  dir = tmpVault();
  seed(facts, dir);
  const skills = tmpDir('vs-');
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, VAULT_DIR: dir, SKILLS_DIR: skills, VAULT_PORT: String(PORT), VAULT_AUTOEXIT: '' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/tree'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
  throw new Error('server did not start');
});
test.after(() => srv && srv.kill());

const j = async (p, o) => { const r = await fetch(BASE + p, o); return { status: r.status, body: await r.json() }; };
const post = (p, b) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

// запрос с произвольными заголовками (fetch не даёт подменить Host и Origin)
const raw = (method, p, headers = {}, body = '') => new Promise((resolve, reject) => {
  const req = require('http').request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, res => {
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: data }));
  });
  req.on('error', reject);
  req.end(body);
});

test('защита: чужая страница не пишет и не читает через браузер пользователя', async () => {
  const note = 'vault/project/project_vault_app.md';
  const before = (await j('/api/note?id=' + encodeURIComponent(note))).body.raw;
  const payload = JSON.stringify({ id: note, content: 'затёрто чужой страницей' });
  const json = { 'Content-Type': 'application/json' };

  // форма с чужого сайта: «простой» запрос без preflight — text/plain
  assert.equal((await raw('POST', '/api/save', { 'Content-Type': 'text/plain' }, payload)).status, 415);
  // чужой Origin, даже с правильным типом тела
  assert.equal((await raw('POST', '/api/save', { ...json, Origin: 'https://evil.example' }, payload)).status, 403);
  // соседнее локальное приложение на другом порту
  assert.equal((await raw('POST', '/api/save', { ...json, Origin: 'http://127.0.0.1:1' }, payload)).status, 403);
  // <img src> с чужого сайта на GET с побочным действием
  assert.equal((await raw('GET', '/api/open-external?id=' + encodeURIComponent(note), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  // DNS rebinding: чужое имя указывает на 127.0.0.1
  assert.equal((await raw('GET', '/api/tree', { Host: 'evil.example:' + PORT })).status, 403);
  assert.equal((await raw('GET', '/', { Host: 'evil.example' })).status, 403);

  assert.equal((await j('/api/note?id=' + encodeURIComponent(note))).body.raw, before, 'заметка не изменилась');

  // своя страница и CLI работают
  const own = { ...json, Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await raw('POST', '/api/save', own, JSON.stringify({ id: note, content: before }))).status, 200);
  assert.equal((await raw('GET', '/api/tree', { Host: 'localhost:' + PORT })).status, 200);
});

test('GET /api/tree: сводка фактов и ссылки {{fact:}} в заметках', async () => {
  const { body } = await j('/api/tree');
  assert.equal(body.facts.count, 11);
  const n = body.notes.find(x => x.base === 'project_vault_app');
  assert.deepEqual(n.factRefs, ['app_review']);
});

test('GET /api/facts и /api/fact: список без истории, карточка с историей и где упоминается', async () => {
  const { body } = await j('/api/facts');
  assert.equal(body.facts.length, 11);
  assert.equal(body.facts[0].state, 'risk', 'сортировка по состоянию');
  assert.ok(!('history' in body.facts[0]));
  const one = await j('/api/fact?id=app_review');
  assert.equal(one.body.history.length, 1);
  assert.deepEqual(one.body.refs.map(r => r.base), ['project_vault_app']);
  assert.equal((await j('/api/fact?id=nope')).status, 404);
});

test('POST /api/fact: правка из веба пишет историю с «by», секрет → 400, ok и архив', async () => {
  let r = await post('/api/fact', { id: 'app_review', status: 'одобрено', state: 'done', src: 'кабинет' });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'done');
  assert.match(r.body.history.at(-1).by, /\(веб :\d+\)$/);
  r = await post('/api/fact', { id: 'app_review', value: FAKE.meta });
  assert.equal(r.status, 400);
  r = await post('/api/fact', { id: 'app_review', ok: true });
  assert.equal(r.body.history.at(-1).ok, true);
  r = await post('/api/fact', { id: 'ad_prepay', archive: true, why: 'потрачено' });
  assert.ok(r.body.archived);
  assert.equal((await j('/api/facts')).body.facts.length, 10);
});
