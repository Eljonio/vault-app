// redact — вычистка учётных данных из текста, который уходит наружу (vault-recall → хук → контекст каждой сессии,
// MEMORY.next.md). Сами заметки не трогаем: секреты в заметках правит только их владелец.
'use strict';

const HIDE = '[скрыто]';
// готовые форматы ключей и токенов (то же, что отвергает `vault fact set`)
const TOKEN_RES = [
  /EAA[A-Za-z0-9]{24,}/g,
  /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
// «каша» ≥ 32 символов: верхний + нижний регистр + цифры (git-хэши — только hex в нижнем, не ловятся)
const MUSH_RE = /[A-Za-z0-9_+/=.-]{32,}/g;
const isMush = w => /[A-Z]/.test(w) && /[a-z]/.test(w) && /\d/.test(w) && !w.includes('://');

// сильные слова: после них значение скрываем всегда (кроме обычного русского слова: «пароль от кабинета», «логин и …»)
const STRONG = 'пароль|пароля|паролем|пароли|password|passwd|pass|pwd|логин|логина|логином|login|username|pin-код|пин-код|pin|пин';
// слабые: «код», «ключ», «токен» — скрываем, только если значение похоже на секрет (есть цифры/латиница) или стоит «:»/«=»
const WEAK = 'код|кода|code|ключ|key|токен|token|secret|секрет';
// значение: телефон целиком («+1 555 010 00 00») или одно «слово» до пробела/запятой
const VAL = String.raw`(\+?\d[\d\s()-]{5,}\d|[^\s,;()«»"'<>\]\[]+)`;
const SEP = String.raw`(\s*(?:[:=]|—|–|-)?\s*[«"'\x60]?)`;
const END = String.raw`(?![\p{L}\d_])`; // слово целиком: user_alice, passport, ключевой — не наши
const STRONG_RE = new RegExp(String.raw`(^|[^\p{L}\d_])(${STRONG})${END}${SEP}${VAL}`, 'giu');
const WEAK_RE = new RegExp(String.raw`(^|[^\p{L}\d_])(${WEAK})${END}${SEP}${VAL}`, 'giu');
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PASSWORD_WORD = /пароль|пароля|паролем|password|passwd|\bpwd\b/i;

const plainWord = v => /^[а-яё]+$/u.test(v) && v.length <= 14;   // обычное слово текста, не значение
const envName = v => /^[A-Z][A-Z0-9_]{2,}[`'"]?$/.test(v);              // имя переменной (META_WA_TOKEN) — не секрет
const looksValue = v => /\d/.test(v) || /[A-Za-z]/.test(v) && /[^A-Za-z]/.test(v) || /[!@#$%^&*?]/.test(v);

function redact(text) {
  let s = String(text ?? '');
  if (!s) return s;
  for (const re of TOKEN_RES) s = s.replace(re, HIDE);
  s = s.replace(MUSH_RE, w => (isMush(w) ? HIDE : w));
  s = s.replace(STRONG_RE, (m, pre, kw, sep, val) => {
    if (val === HIDE || val.startsWith('[скрыто')) return m;
    const hasColon = /[:=]/.test(sep);
    if (!hasColon && plainWord(val)) return m;
    return `${pre}${kw}${sep}${HIDE}`;
  });
  s = s.replace(WEAK_RE, (m, pre, kw, sep, val) => {
    if (val.startsWith('[скрыто')) return m;
    const hasColon = /[:=]/.test(sep);
    if (envName(val)) return m;
    if ((hasColon && !plainWord(val)) || (looksValue(val) && val.length >= 4)) return `${pre}${kw}${sep}${HIDE}`;
    return m;
  });
  // почты рядом со словом «пароль» (в том же тексте) — скрыть все
  if (PASSWORD_WORD.test(s)) s = s.replace(EMAIL_RE, HIDE);
  return s;
}
// есть ли в тексте слово «пароль/password» — тогда описание заметки не показываем вовсе
function mentionsPassword(text) { return PASSWORD_WORD.test(String(text ?? '')); }
// для `fact set`: явные учётные данные (сильное слово + значение) в факт не кладём
function hasCredential(text) {
  const s = String(text ?? '');
  STRONG_RE.lastIndex = 0;
  let m;
  while ((m = STRONG_RE.exec(s))) { if (/[:=]/.test(m[3]) || !plainWord(m[4])) return true; }
  return false;
}

module.exports = { redact, mentionsPassword, hasCredential, HIDE, TOKEN_RES, isMush };
