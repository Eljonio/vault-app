# vault-app

[![tests](https://github.com/Eljonio/vault-app/actions/workflows/test.yml/badge.svg)](https://github.com/Eljonio/vault-app/actions/workflows/test.yml)

Long-term memory for AI coding agents (built for Claude Code): a local web UI and a CLI on top of a plain folder of
Markdown notes, plus a small "facts" store and a prompt-time recall hook.

## Where to look first

| to check | open |
|---|---|
| retrieval at prompt time: stemming, synonyms, IDF scoring, boost for notes that several facts point to | [`lib/recall.js`](lib/recall.js) |
| the facts store: lock file, atomic write, history, TTL, state guessed from the status text | [`lib/facts.js`](lib/facts.js) |
| credential redaction on write and on recall | [`lib/redact.js`](lib/redact.js), [`scripts/recall-secret-sweep.js`](scripts/recall-secret-sweep.js) |
| read-only verification of a fact against its source | [`lib/verify.js`](lib/verify.js) |
| the guard that rejects requests sent by other sites through the browser | `guard()` in [`server.js`](server.js) |
| what is tested | [`test/`](test) — 41 tests, `npm test`, throwaway vault, no network |

**Provenance.** Exported on 2026-11-20 from a private working copy. Real notes, facts and names (the tests use made-up ones) were removed, so the public history starts with the export.

## The problem

An agent that keeps its memory in Markdown files runs into the same issues sooner or later:

- **Notes grow.** Project logs reach 100+ KB, and reading them whole wastes the context window. The agent needs to
  search, look at a table of contents and read one section.
- **Statuses drift.** "Submitted", "deployed", "paid" get copied into several notes and go stale. The agent then
  reports old state with confidence.
- **The agent doesn't look.** Relevant memory exists, but nothing prompts the agent to check it before answering.
- **Secrets leak.** Personal notes can contain credentials, and anything injected into the context can be repeated
  back.

vault-app handles these with:

1. A **navigator** (`vault find → vault toc → vault show <note> '#section'`) and an Obsidian-like web UI with
   wikilinks, backlinks, an outline and a link graph.
2. **Facts**: one entity, one record, with a state, a source, a date, an edit history and a "re-check after N days" TTL.
   Notes reference facts with `{{fact:id}}` instead of copying the status text.
3. **Recall**: `vault-recall`, run from Claude Code's `UserPromptSubmit` hook, adds up to 1 KB of the most relevant
   facts and notes to each prompt. It runs locally, with no network calls and no LLM, and is designed to finish
   in under 150 ms.
4. **Redaction**: credentials are rejected when facts are written and removed from everything recall outputs.
   A sweep script checks this across all notes.
5. **Verification**: `vault verify` checks facts against their source. Each check comes from a whitelist (grep over
   ssh, `git log`, an HTTP GET, a local file grep) and is read-only.

## How it works

```
notes folder (~/claude-vault)        ~/.claude/skills/*/SKILL.md
  project/ reference/ feedback/ user/        │
  facts/facts.json  (source of truth)        │
  facts/FACTS.md    (generated view)         │
  facts/synonyms.md (recall dictionary)      │
            │                                │
            └──────────────┬─────────────────┘
                           │  fs.watch → in-memory index (links, headings, statuses, dates)
                 server.js (node:http, 127.0.0.1:4040)
                  │                 │
           web UI (public/)     bin/vault (CLI; facts/verify/index work without the server)
                                bin/vault-recall (hook, reads files directly)
```

- `server.js` uses only the Node standard library. It indexes Markdown files: frontmatter, `[[wikilinks]]`,
  Markdown links, headings with status emoji and dates, and backlinks. It serves a JSON API (`/api/tree`, `/api/note`,
  `/api/search`, `/api/graph`, `/api/facts`, `/api/fact`, `/api/save`, `/api/create`, `/api/rename`, `/api/delete`)
  and the static UI. "Delete" moves the note to `.trash/` inside the vault.
- Search ranks by line, not by file: it rewards terms that appear on the same line and the narrowest window of lines
  that contains all terms, so a large file doesn't win just by being large.
- `lib/facts.js` keeps facts in `facts/facts.json`, guarded by a lock file and written atomically. It regenerates
  `FACTS.md` on each change. States: `risk`, `blocked`, `wait`, `todo`, `later`, `done`, `info`. Each state has a
  default TTL (2 to 30 days), after which the fact is marked as needing a re-check. A fact's state is guessed from
  its status text when you don't set it.
- `lib/recall.js` does crude Russian/English stemming, maps phrases to concepts through a user-maintained synonyms
  file, scores facts and note descriptions with an inverted index and IDF, and boosts a note when several matched
  facts point to it. It returns at most 4 facts and 2 notes. Note metadata is cached in `$XDG_RUNTIME_DIR`, keyed by
  file mtimes.
- `lib/redact.js` hides known token formats (Anthropic/OpenAI, GitHub, Slack, AWS, Meta, Telegram, private keys),
  long mixed-case strings, and values that follow words like "password", "login" or "PIN".
- `lib/memindex.js` (`vault index --build`) writes a short memory index, `MEMORY.next.md` (10 KB at most), next to
  the existing one. It never overwrites `MEMORY.md`.
- `bin/vaultctl` starts and stops the server from Claude Code `SessionStart`/`SessionEnd` hooks. It keeps one server
  for any number of sessions, writes the PID of each `claude` process into a marker file, and the server exits on its
  own once no session process is alive. If the vault is a git repository, `vault-commit` takes a snapshot when a
  session starts and when it ends.

## Requirements

- Linux (the helper scripts use `bash`, `flock`, `ss`, `curl`, `ps`; `vault open` opens Firefox and
  "open in external editor" uses `xdg-open`).
- Node.js 20 or newer (it uses `fetch`, `node:test` and recursive `fs.watch`). Developed on Node 24.
- No runtime npm dependencies. `public/marked.js` is a vendored copy of [marked](https://github.com/markedjs/marked)
  (MIT). The `marked` entry in `package.json` only pins its version.

## Install and run

```bash
git clone <this repo> vault-app && cd vault-app
mkdir -p ~/bin && for f in vault vault-recall vaultctl vault-commit; do ln -sf "$PWD/bin/$f" ~/bin/$f; done

# point it at your notes (defaults: ~/claude-vault and ~/.claude/skills)
export VAULT_DIR=~/claude-vault
node server.js            # or: vaultctl start / vaultctl open
# → http://127.0.0.1:4040
```

Claude Code hooks (`~/.claude/settings.json`) that start the server with the first session, stop it after the last
one, and add recall to each prompt:

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "/path/to/vault-app/bin/vaultctl hook-start" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "/path/to/vault-app/bin/vaultctl hook-stop" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/path/to/vault-app/bin/vault-recall --hook" }] }]
  }
}
```

## Commands

```
vault find <query…>          full-text search: note, line number, snippet
vault ls [filter]            notes with size, age, in/out links
vault toc <note>             table of contents with status emoji and dates (for large logs)
vault show <note> [#part]    whole note or one section (matched by heading substring); {{fact:id}} is expanded
vault links <note>           backlinks ←, outgoing →, broken ✗
vault recent [n]             recently changed notes
vault issues                 oversized notes, broken links, orphans, missing frontmatter, stale facts
vault lint                   bloated "state" notes, logs nobody links to, notes without a last-updated line
vault save [message]         git snapshot of the notes folder
vault open [note] | vault path <note>

vault fact set <id> status=… value=… src=… note=<note> [by= since= title= tags= state= ttl= check= why=]
vault fact ok <id>           confirm "still true" without changes (refreshes the check date)
vault fact get|log|ref|rm <id>
vault fact ls [filter] [--stale] [--state=wait] [--all]
vault verify [id…] [--dry]   check facts against their source (read-only) and list stale ones
vault index --build          draft a short MEMORY.next.md (10 KB at most)

vault-recall "phrase"        what recall would add to a prompt (--why shows scores, --json for scripts)
vaultctl start|stop|restart|status|open|kill
node scripts/recall-secret-sweep.js   run recall over every note and fact and count leaked credentials
```

Web UI shortcuts: `Ctrl+K` search and command palette, `Ctrl+E` edit/read, `Ctrl+S` save, `Ctrl+N` new note,
`Ctrl+G` link graph, `Ctrl+\` toggle the right panel.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `VAULT_DIR` | `~/claude-vault` | notes folder |
| `SKILLS_DIR` | `~/.claude/skills` | skills shown next to notes |
| `VAULT_PORT` | `4040` | HTTP port (always bound to 127.0.0.1) |
| `VAULT_RUN_DIR` | `$XDG_RUNTIME_DIR/vault-app` | PID and session markers |
| `VAULT_AUTOEXIT` | unset | `1` makes the server exit when no session is alive (set by `vaultctl`) |
| `VAULT_USER` | OS user name | written as `by` when a fact is edited from the web UI |
| `VAULT_PROD_HOST`, `VAULT_PROD_FILE` | `prod`, `~/app/package.json` | target of the `check=prod_version:<expected>` preset |
| `VAULT_ON_LAST_EXIT` | unset | shell command run by `vaultctl hook-stop` after the last session closes |

Recall reads notes from `project/`, `reference/`, `feedback/` and `user/`, plus `facts/facts.json`.
Its synonyms file is `facts/synonyms.md`, one group per line:
`- canonical, variant, multi word variant → fact_id, note_name`.

## Tests

```bash
npm test          # node --test test/*.test.js
```

The tests build a throwaway vault with made-up notes and facts in a temp directory, start the server on a random
port, and cover facts, recall ranking, redaction, verify, the memory index and the CLI. They need no network.

## Limitations

- The UI, CLI messages, stemmer and stop-word list are in Russian. English queries work, but stemming for English is
  minimal.
- Recall is lexical (stems plus a hand-written synonyms file), not semantic, and has no embeddings.
- It is a single-user local tool with no authentication: any local process can call the API. It listens on
  127.0.0.1 only, so don't expose the port. Requests coming through the browser from other sites are rejected
  (Host allow-list against DNS rebinding, `Origin` / `Sec-Fetch-Site` checks on `/api/`, JSON-only POST bodies).
- The memory layout (`desk_*` hub notes, `feedback/` rules marked ⚡, `MEMORY.md` as the home note) follows one
  personal convention. The rest works with any folder of Markdown files.

## License

MIT, see [LICENSE](LICENSE).
