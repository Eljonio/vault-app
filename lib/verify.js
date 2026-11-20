// verify — дешёвая сверка факта с источником. Только чтение: grep по ssh, git log, GET по http, grep локального файла.
// Произвольных команд нет и не будет: вид проверки — из белого списка ниже, аргументы экранируются.
'use strict';
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const remotePath = p => (String(p).startsWith('~/') ? '~/' + q(String(p).slice(2)) : q(p));
const expandHome = p => String(p).replace(/^~(?=\/|$)/, os.homedir());
const bad = s => !s || /^-/.test(String(s)) || /[\n\r\0]/.test(String(s));

function matches(observed, expect) {
  if (expect == null || expect === '') return null;
  const e = String(expect);
  const m = e.match(/^\/(.*)\/([a-z]*)$/);
  return m ? new RegExp(m[1], m[2]).test(observed) : String(observed).includes(e);
}

const KINDS = {
  // ssh <host> grep -m1 -e <pattern> -- <file>   (BatchMode: без паролей и вопросов)
  ssh_grep(c) {
    if (bad(c.host) || !/^[\w.@-]+$/.test(c.host)) throw new Error('host');
    if (bad(c.file) || bad(c.pattern)) throw new Error('file/pattern');
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', c.host, `grep -m1 -e ${q(c.pattern)} -- ${remotePath(c.file)}`],
      { encoding: 'utf8', timeout: 15000 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error((r.stderr || `код ${r.status}`).trim().split('\n').pop());
    return r.stdout.trim();
  },
  // git -C <repo> log -1 --format='%h %s' <ref>
  git_head(c) {
    if (bad(c.repo)) throw new Error('repo');
    const ref = c.ref || 'HEAD';
    if (bad(ref)) throw new Error('ref');
    const r = spawnSync('git', ['-C', expandHome(c.repo), 'log', '-1', '--format=%h %s', ref, '--'], { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) throw new Error((r.stderr || 'git').trim().split('\n').pop());
    return r.stdout.trim();
  },
  // первая строка локального файла, где есть pattern
  file_grep(c) {
    const text = fs.readFileSync(expandHome(c.path || c.file), 'utf8');
    const line = text.split('\n').find(l => matches(l, c.pattern));
    if (line === undefined) throw new Error('нет строки с ' + c.pattern);
    return line.trim();
  },
  // GET url → «<код> <первое совпадение pattern в теле>»
  async http(c) {
    if (!/^https?:\/\//.test(String(c.url || ''))) throw new Error('url');
    const r = await fetch(c.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    let tail = '';
    if (c.pattern) {
      const body = await r.text();
      const m = body.match(new RegExp(c.pattern));
      tail = m ? ' ' + m[0].slice(0, 120) : ' (нет ' + c.pattern + ')';
    }
    return `${r.status}${tail}`;
  },
};

async function runCheck(check) {
  if (!check || !KINDS[check.kind]) return { ok: null, error: `неизвестный вид проверки ${check && check.kind}` };
  try {
    const observed = await KINDS[check.kind](check);
    const ok = matches(observed, check.expect);
    return { ok, observed };
  } catch (e) {
    return { ok: null, error: String(e.message || e).slice(0, 200) };
  }
}

module.exports = { KINDS, runCheck, matches };
