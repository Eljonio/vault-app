'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const CREATED = [];
process.on('exit', () => { for (const d of CREATED) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
function tmpDir(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); CREATED.push(d); return d; }
// кэш vault-recall тестов — во временную папку, а не в настоящий $XDG_RUNTIME_DIR
process.env.XDG_RUNTIME_DIR = tmpDir('vault-rt-');

// Синтетические «секреты» для тестов детектора собираются из частей, чтобы сканеры секретов
// не принимали тестовые строки за настоящие ключи.
const FAKE = {
  meta: 'EAA' + 'TESTtest0123456789FAKEfake',
  anthropic: 'sk-' + 'ant-' + 'test'.repeat(6),
  github: 'ghp' + '_' + 'FAKE0'.repeat(5),
  telegram: '123456789' + ':' + 'AAtestFAKEtoken0123456789abcdefXYZ',
};

// временный vault: заметки-столы + словарь синонимов; факты заводят сами тесты.
// Все имена, клиенты и события — выдуманные.
function tmpVault() {
  const dir = tmpDir('vault-test-');
  for (const d of ['project', 'feedback', 'reference', 'user', 'facts']) fs.mkdirSync(path.join(dir, d));
  const note = (folder, name, desc, body = '') =>
    fs.writeFileSync(path.join(dir, folder, name + '.md'), `---\nname: ${name}\ndescription: "${desc}"\nmetadata:\n  type: ${folder}\n---\n\n# ${name}\n\nПоследнее обновление: **2026-10-20**\n\n${body}\n`);
  note('project', 'desk_mobile', 'Стол агента mobile: мобильное приложение, сборки, App Review, реклама');
  note('project', 'desk_acme', 'Стол агента acme: клиент Acme Corp (магазин Алисы в demo-city)');
  note('project', 'desk_tracker', 'Стол агента tracker: задачи в Jira, спринты');
  note('project', 'desk_crm', 'Стол агента crm: CRM для клиентов demo-app');
  note('project', 'desk_workshop', 'Стол «мастерская»: детали, раскрой, DXF');
  note('project', 'project_news_channels', 'Новостные каналы — план контента');
  note('project', 'project_claude_panel', 'Пульт сессий Claude и аудитор');
  note('feedback', 'feedback_agent_team', '⚡ Команда агентов и столы');
  note('feedback', 'feedback_memory_without_asking', '⚡ Факты в память сразу, без «запомни»');
  note('project', 'project_vault_app', 'Vault — навигатор по памяти', 'Статус: {{fact:app_review}} [[FACTS#app_review]]');
  fs.writeFileSync(path.join(dir, 'facts', 'synonyms.md'), [
    '# синонимы', '',
    '- mobile, мобилка, мобилке, мобилку, приложение → desk_mobile',
    '- app review, апп ревью, ревью → app_review, desk_mobile',
    '- jira, джира, джиры, джиру',
    '- acme, acme corp, акме, тётя алиса, алиса, алисе → desk_acme',
    '- crm, црм, срм → desk_crm, crm_prod_version',
    '- агенты, агент, агентам, столы → feedback_agent_team, agents_reports',
    '- аудитор, пульт → project_claude_panel',
    '- мастерская, мастерской, мастерскую → desk_workshop',
    '- станок, станка, чпу, cnc → desk_workshop, workshop_machine',
    '- новостные, новостной, новости, новостные каналы → project_news_channels',
    '- 50, $50, предоплата, реклама → ad_prepay',
    '- ключ, ключи, key, api key',
    '- выкат, выкатили, загрузил, загрузили, на проде',
    '- подали, подавали, подано',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'facts', 'memory-pins.md'), '- [[project_vault_app]]\n- [[feedback_memory_without_asking]]\n');
  return dir;
}
function seed(facts, dir) {
  const s = (id, f) => facts.set(id, f, { dir });
  s('app_review', { title: 'App Review мобильного приложения', state: 'wait', status: 'подано, на проверке', value: 'подано после 16.10', since: 'после 16.10', src: 'скрин 20.10', notes: 'desk_mobile', tags: 'app review,mobile' });
  s('hosting_debt', { title: 'Долг хостинга', state: 'blocked', status: 'не оплачен', value: '$12, бэкенд стоит', src: 'billing', notes: 'desk_mobile', tags: 'mobile,долг' });
  s('ad_prepay', { title: '$50 — предоплата рекламного кабинета', state: 'wait', status: 'на рекламном кабинете', src: 'Alice', notes: 'desk_mobile', tags: '50,реклама,mobile' });
  s('jira_key', { title: 'Ключ API Jira', state: 'later', status: 'потом', src: 'Alice 20.10', notes: 'desk_tracker', tags: 'jira,ключ,api' });
  s('acme_bot_rollout', { title: 'Acme: бот для магазина', state: 'later', status: 'готово, не выкачено — «не спешим»', notes: 'desk_acme', tags: 'acme,бот' });
  s('crm_prod_version', { title: 'Версия demo-app на проде (CRM)', state: 'done', status: '0.1.62-crm на проде', value: 'заявки загружены 104', notes: 'desk_crm', tags: 'crm,прод,выкат' });
  s('agents_reports', { title: 'Разбор итогов агентов', state: 'todo', status: 'разобрать', notes: 'feedback_agent_team', tags: 'агенты' });
  s('panel_auditor_memory', { title: 'Аудитор пульта сверяет память', state: 'wait', status: 'в работе', notes: 'project_claude_panel', tags: 'аудитор,пульт' });
  s('workshop_machine', { title: 'Мастерская: какой станок ЧПУ', state: 'wait', status: 'неизвестен', notes: 'desk_workshop', tags: 'мастерская,станок' });
  s('news_channels', { title: 'Новостные каналы', state: 'wait', status: 'план готов', notes: 'project_news_channels', tags: 'новостные,каналы' });
  s('staging_key_leak', { title: 'Ключ тестового стенда', state: 'risk', status: 'утёк, не отозван', tags: 'стенд,ключ' });
}
module.exports = { tmpVault, tmpDir, seed, FAKE };
