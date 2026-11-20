/* Vault — вкладка «Факты»: список, карточка с историей, правка; {{fact:id}} в заметках → живой чип. */
'use strict';

S.facts = []; S.factsById = new Map(); S.factsMtime = -1; S.fact = null; S.states = {};

async function loadFacts() {
  try {
    const r = await api('/api/facts');
    S.facts = r.facts; S.states = r.states || {}; S.factsMtime = r.mtime;
    S.factsById = new Map(r.facts.map(f => [f.id, f]));
    const tab = $('.left-tabs button[data-view="facts"]');
    if (tab) tab.innerHTML = `Факты${r.stale ? `<span class="tab-warn" title="не сверялись дольше срока">${r.stale}</span>` : ''}`;
  } catch (e) { /* сервер без фактов — вкладка просто пустая */ }
}
// app.js зовёт при каждом опросе /api/tree
window.onTreeFacts = async info => {
  if (!info || info.mtime === S.factsMtime) return;
  await loadFacts();
  if (S.leftView === 'facts') renderLeft();
  if (S.fact && !S.current) { const id = S.fact.id; if (!$('#fact-form') || !$('#fact-form').dataset.dirty) openFact(id, { keepScroll: true }); }
  else if (S.current && S.mode === 'read' && (S.current.factRefs || []).length) { const st = $('#content').scrollTop; renderCenter(); $('#content').scrollTop = st; }
};

const stateIcon = st => (S.states[st] || {}).icon || '';
const factAge = f => f.age == null || f.age === null ? '' : (f.age > 9999 ? '?' : f.age + ' д');
const sinceTxt = s => /^\d{4}-\d{2}-\d{2}/.test(s || '') ? 'с ' + s.slice(8, 10) + '.' + s.slice(5, 7) + (s.length > 10 ? ' ' + s.slice(11) : '') : (s || '');

// ---------- левая панель ----------
function renderFactsList(match) {
  const f = S.filter.trim().toLowerCase();
  const list = S.facts.filter(x => !f || [x.id, x.title, x.status, x.value, ...(x.tags || []), ...(x.notes || [])].join(' ').toLowerCase().includes(f));
  const stale = list.filter(x => x.stale).length;
  let h = `<div class="facts-head"><span>${list.length} фактов${stale ? ` · <b class="warn">⚠ ${stale}</b> пора сверить` : ''}</span><button class="seg" id="btn-new-fact" title="Новый факт">＋ факт</button></div>`;
  let cur = null;
  for (const x of list) {
    if (x.state !== cur) { cur = x.state; h += `<div class="list-h">${stateIcon(cur)} ${esc((S.states[cur] || {}).label || cur)}</div>`; }
    h += `<div class="item fact-item${x.stale ? ' stale' : ''}" data-fact="${esc(x.id)}" title="${esc(x.status + (x.value ? ': ' + x.value : ''))}">
      <span class="st">${stateIcon(x.state)}</span><span class="t">${esc(x.title)}</span>
      <span class="d">${x.stale ? '⚠ ' : ''}${factAge(x)}</span></div>`;
  }
  return h + (list.length ? '' : '<div class="empty">Фактов нет. CLI: vault fact set &lt;id&gt; status=… src=…</div>');
}

// ---------- карточка факта ----------
async function openFact(id, opts = {}) {
  if (S.dirty && !confirm('Есть несохранённые правки. Выйти без сохранения?')) return;
  let f = null;
  if (!opts.isNew) { try { f = await api('/api/fact?id=' + encodeURIComponent(id)); } catch (e) { toast('Нет факта: ' + e.message, true); return; } }
  else f = { id, title: id, state: 'info', status: '', history: [], refs: [], isNew: true };
  const st = $('#content').scrollTop;
  S.current = null; S.dirty = false; S.fact = f;
  if (S.leftView !== 'facts') { S.leftView = 'facts'; $$('.left-tabs button').forEach(x => x.classList.toggle('active', x.dataset.view === 'facts')); renderLeft(); }
  if (location.hash !== '#/fact/' + id) history.replaceState(null, '', '#/fact/' + id);
  document.body.classList.add('fact-mode');
  document.title = f.title + ' — факт — Vault';
  $('#crumbs').innerHTML = `факты / <b>${esc(f.id)}</b>`;
  $('#content').classList.remove('editing');
  $('#content').innerHTML = factHtml(f);
  $('#content').scrollTop = opts.keepScroll ? st : 0;
  $$('#left-body .item').forEach(el => el.classList.toggle('active', el.dataset.fact === id));
  renderRight();
}
function factHtml(f) {
  const states = Object.entries(S.states);
  const notes = (f.notes || []).map(n => { const nid = resolveLink(n); return `<a class="wiki${nid ? '' : ' broken'}" data-id="${esc(nid || '')}" data-link="${esc(n)}">${esc(n)}</a>`; }).join(', ');
  const v = f.verify ? `${f.verify.ok === true ? '✅ совпало' : f.verify.ok === false ? '⚠ РАСХОЖДЕНИЕ' : '? не смог'} ${esc(f.verify.at)} — «${esc(f.verify.observed)}»` : '';
  const hist = (f.history || []).slice().reverse().map(e => {
    const parts = [];
    if (e.archived) parts.push('<b>в архив</b>');
    if (e.ok) parts.push('<b>подтверждено</b>');
    if (e.state) parts.push(stateIcon(e.state));
    if (e.status !== undefined) parts.push(`<b>${esc(e.status)}</b>`);
    if (e.value !== undefined) parts.push(esc(e.value));
    if (e.since !== undefined) parts.push(`<span class="m">${esc(sinceTxt(e.since))}</span>`);
    if (e.src !== undefined) parts.push(`<span class="m">src: ${esc(e.src)}</span>`);
    if (e.by) parts.push(`<span class="m">— ${esc(e.by)}</span>`);
    if (e.why) parts.push(`<span class="m">(${esc(e.why)})</span>`);
    return `<li><span class="at">${esc(e.at)}</span> ${parts.join(' ')}</li>`;
  }).join('');
  const ref = `{{fact:${f.id}}} [[FACTS#${f.id}]]`;
  return `<div class="doc fact-doc">
    ${f.isNew ? '<div class="doc-meta"><span class="chip">новый факт</span></div>' : `<div class="doc-meta">
      <span class="chip t-facts">факт</span><span>${esc(f.id)}</span>
      <span>сверено ${esc(f.checked || '—')} (${factAge(f)} назад, срок ${f.ttlDays} д)${f.stale ? ' <b class="warn">⚠ пора сверить</b>' : ''}</span>
      ${f.archived ? `<span class="warn">в архиве с ${esc(f.archived)}</span>` : ''}</div>`}
    <h1 class="fact-title">${stateIcon(f.state)} ${esc(f.title)}</h1>
    ${f.isNew ? '' : `<div class="fact-status st-${esc(f.state)}">${esc(f.status || (S.states[f.state] || {}).label || '')}</div>
    ${f.value ? `<p class="fact-value">${esc(f.value)}</p>` : ''}
    <table class="fact-props">
      ${f.since ? `<tr><th>когда</th><td>${esc(sinceTxt(f.since))}</td></tr>` : ''}
      ${f.src ? `<tr><th>источник</th><td>${esc(f.src)}</td></tr>` : ''}
      ${f.by ? `<tr><th>подтвердил</th><td>${esc(f.by)}</td></tr>` : ''}
      ${notes ? `<tr><th>стол / заметки</th><td>${notes}</td></tr>` : ''}
      ${(f.tags || []).length ? `<tr><th>теги</th><td>${f.tags.map(t => `<span class="tag">${esc(t)}</span>`).join(' ')}</td></tr>` : ''}
      ${f.check ? `<tr><th>автопроверка</th><td><code>${esc(JSON.stringify(f.check))}</code>${v ? '<br>' + v : ''}</td></tr>` : ''}
      <tr><th>в заметку</th><td><code class="fact-ref">${esc(ref)}</code> <button class="seg" data-copy="${esc(ref)}">копировать</button></td></tr>
    </table>
    <h2>История (${(f.history || []).length})</h2><ul class="fact-hist">${hist || '<li>—</li>'}</ul>`}
    <h2>${f.isNew ? 'Заполнить' : 'Изменить'}</h2>
    <form id="fact-form" class="fact-form" data-id="${esc(f.id)}" autocomplete="off">
      ${f.isNew ? `<label>Название<input name="title" value="${esc(f.title)}"></label>` : ''}
      <div class="row">
        <label>Состояние<select name="state">${states.map(([k, s]) => `<option value="${k}"${k === f.state ? ' selected' : ''}>${s.icon} ${esc(s.label)}</option>`).join('')}</select></label>
        <label class="grow">Статус (коротко)<input name="status" value="${esc(f.status || '')}"></label>
      </div>
      <label>Значение / подробности<textarea name="value" rows="3">${esc(f.value || '')}</textarea></label>
      <div class="row">
        <label>Когда (дата или текст)<input name="since" value="${esc(f.since || '')}" placeholder="2026-10-20 или «после 16.10»"></label>
        <label class="grow">Источник<input name="src" value="" placeholder="${esc(f.src || 'скрин / git / кабинет / со слов пользователя')}"></label>
      </div>
      <div class="row">
        <label class="grow">Стол / заметки<input name="notes" value="${esc((f.notes || []).join(', '))}"></label>
        <label class="grow">Теги<input name="tags" value="${esc((f.tags || []).join(', '))}"></label>
      </div>
      <label>Почему меняем (в историю)<input name="why" value=""></label>
      <div class="row buttons">
        <button type="submit" class="primary">Сохранить</button>
        ${f.isNew ? '' : '<button type="button" class="seg" data-act="ok" title="Ничего не поменялось — обновить «сверено»">Всё так, подтвердить</button><button type="button" class="seg danger" data-act="archive">В архив</button>'}
      </div>
      <div class="hint">Секреты сюда не писать — только «токен засвечен». Источник обязателен при смене статуса.</div>
    </form>
  </div>`;
}
function renderFactRight(b) {
  const f = S.fact;
  const refs = f.refs || [];
  b.innerHTML = `<div class="list-h">Где стоит {{fact:${esc(f.id)}}} (${refs.length})</div><div class="linkgroup">${refs.length ? refs.map(x => itemHtml(x)).join('') : '<div class="empty">Нигде. Вставь в заметку строку из «в заметку».</div>'}</div>`
    + `<div class="list-h">Стол / заметки</div><div class="linkgroup">${(f.notes || []).map(n => S.byId.get(resolveLink(n) || '')).filter(Boolean).map(x => itemHtml(x)).join('') || '<div class="empty">—</div>'}</div>`;
}
async function submitFact(form, act) {
  const id = form.dataset.id;
  const fd = new FormData(form);
  const body = { id };
  const cur = S.fact && !S.fact.isNew ? S.fact : {};
  for (const [k, v] of fd.entries()) {
    const val = String(v).trim();
    if (k === 'src' || k === 'why') { if (val) body[k] = val; continue; }
    const was = k === 'notes' || k === 'tags' ? (cur[k] || []).join(', ') : (cur[k] ?? '');
    if (S.fact.isNew || val !== String(was)) body[k] = val;
  }
  if ('status' in body && !('state' in body) && fd.get('state')) body.state = fd.get('state'); // выбранное состояние не угадывать заново
  if (act === 'ok') body.ok = true;
  if (act === 'archive') { if (!confirm('Убрать факт в архив? История останется.')) return; body.archive = true; }
  const statusChanged = ['status', 'state', 'value'].some(k => k in body);
  if (statusChanged && !body.src && !S.fact.isNew) { if (!confirm('Статус меняется без источника. Сохранить всё равно?')) return; }
  try {
    await post('/api/fact', body);
    toast(act === 'ok' ? 'Подтверждено' : act === 'archive' ? 'В архиве' : 'Сохранено');
    await loadFacts(); if (S.leftView === 'facts') renderLeft();
    openFact(id);
  } catch (e) { toast(e.message, true); }
}

// ---------- {{fact:id}} в тексте заметок ----------
marked.use({ extensions: [{
  name: 'factref', level: 'inline',
  start(src) { const i = src.indexOf('{{fact:'); return i < 0 ? undefined : i; },
  tokenizer(src) { const m = /^\{\{fact:([a-z0-9_]+)\}\}/.exec(src); if (m) return { type: 'factref', raw: m[0], id: m[1] }; },
  renderer(tok) {
    const f = S.factsById.get(tok.id);
    if (!f) return `<a class="fact-chip broken" data-fact="${esc(tok.id)}" title="нет такого факта">${esc(tok.id)} ?</a>`;
    return `<a class="fact-chip st-${esc(f.state)}${f.stale ? ' stale' : ''}" data-fact="${esc(f.id)}" title="${esc(f.title + ' — ' + (f.value || '') + (f.src ? ' · src ' + f.src : '') + ' · сверено ' + factAge(f) + ' назад')}">${stateIcon(f.state)} ${esc(f.status || f.title)}${f.since ? ` <span class="m">${esc(sinceTxt(f.since))}</span>` : ''}${f.stale ? ' ⚠' : ''}</a>`;
  },
}] });

// ---------- события ----------
(function bindFacts() {
  $('#left-body').addEventListener('click', e => {
    if (e.target.closest('#btn-new-fact')) {
      const id = (prompt('id нового факта (латиница, цифры, _), например app_review') || '').trim();
      if (!id) return;
      if (!/^[a-z0-9][a-z0-9_]{1,63}$/.test(id)) return toast('id: латиница в нижнем регистре, цифры, _', true);
      if (S.factsById.has(id)) return openFact(id);
      return openFact(id, { isNew: true });
    }
    const it = e.target.closest('.item[data-fact]'); if (it) openFact(it.dataset.fact);
  });
  $('#content').addEventListener('click', e => {
    const chip = e.target.closest('[data-fact]'); if (chip) { e.preventDefault(); openFact(chip.dataset.fact); return; }
    const cp = e.target.closest('[data-copy]'); if (cp) { e.preventDefault(); navigator.clipboard.writeText(cp.dataset.copy); toast('Скопировано'); return; }
    const act = e.target.closest('#fact-form [data-act]'); if (act) { e.preventDefault(); submitFact($('#fact-form'), act.dataset.act); }
  });
  $('#content').addEventListener('submit', e => { if (e.target.id === 'fact-form') { e.preventDefault(); submitFact(e.target); } });
  $('#content').addEventListener('input', e => { const f = e.target.closest('#fact-form'); if (f) f.dataset.dirty = '1'; });
  loadFacts().then(() => { if (S.leftView === 'facts') renderLeft(); if (S.current) renderCenter(); });
})();
