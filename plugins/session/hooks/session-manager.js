#!/usr/bin/env node
// /session command — list, hide, rename, delete Claude Code sessions.
// Runs as a UserPromptSubmit hook: intercepts "/session ..." prompts,
// never forwards them to the model. Hidden sessions are a registry entry
// (session-manager-hidden.json), not a file move — reversible, no data touched.

const fs = require('fs');
const path = require('path');
const os = require('os');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
// let, not const: --selftest redirects this at a temp path so tests never touch the real registry.
let hiddenFile = path.join(claudeDir, 'session-manager-hidden.json');

function currentProjectDirName(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function loadHidden() {
  try {
    const raw = JSON.parse(fs.readFileSync(hiddenFile, 'utf8'));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch (e) {
    return new Set();
  }
}

function saveHidden(set) {
  fs.mkdirSync(path.dirname(hiddenFile), { recursive: true });
  fs.writeFileSync(hiddenFile, JSON.stringify([...set], null, 2));
}

function getSessionMeta(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  let title = null;
  let lastTimestamp = null;
  let msgCount = 0;
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch (e) { continue; }
    if (d.type === 'custom-title' && d.customTitle) title = d.customTitle;
    if (d.timestamp) lastTimestamp = d.timestamp;
    if (d.type === 'user' || d.type === 'assistant') msgCount++;
  }
  return { title, lastTimestamp, msgCount };
}

function listProjectDirs(projectsDir) {
  if (!fs.existsSync(projectsDir)) return [];
  return fs.readdirSync(projectsDir).filter(f =>
    fs.statSync(path.join(projectsDir, f)).isDirectory()
  );
}

function listSessionsInProject(projectsDir, projDirName) {
  const dir = path.join(projectsDir, projDirName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const id = f.replace(/\.jsonl$/, '');
      return { id, projDir: projDirName, ...getSessionMeta(path.join(dir, f)) };
    });
}

function findSessionFile(projectsDir, idPrefix) {
  const matches = [];
  for (const projDir of listProjectDirs(projectsDir)) {
    const dir = path.join(projectsDir, projDir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && f.startsWith(idPrefix));
    for (const f of files) {
      matches.push({ projDir, file: path.join(dir, f), id: f.replace(/\.jsonl$/, '') });
    }
  }
  return matches;
}

function fmtTable(rows, headers) {
  if (!rows.length) return null;
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)));
  const line = arr => arr.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [line(headers), line(widths.map(w => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const HELP = `/session commands:
  /session project [all]        List sessions in current project (all: include hidden)
  /session global [all]          List sessions across all projects (all: include hidden)
  /session hidden                List only hidden sessions
  /session hide <id>             Hide session from listings (reversible, deletes nothing)
  /session unhide <id>           Unhide session
  /session rm <id>                Permanently delete session
  /session rename <id> <name>    Set a custom title for session
  /session help                   Show this help
id accepts any unique prefix of the session id.`;

function sortByRecency(a, b) {
  return (b.lastTimestamp || '').localeCompare(a.lastTimestamp || '');
}

function run(prompt, cwd, projectsDir, currentSessionId) {
  const parts = prompt.trim().split(/\s+/);
  const sub = parts[1];
  const hidden = loadHidden();

  if (!sub) {
    return 'Specify a scope: `/session project` or `/session global`. Run `/session help` for all commands.';
  }

  if (sub === 'help') return HELP;

  if (sub === 'project' || sub === 'global') {
    const showAll = parts[2] === 'all';
    let sessions;
    if (sub === 'project') {
      sessions = listSessionsInProject(projectsDir, currentProjectDirName(cwd));
    } else {
      sessions = listProjectDirs(projectsDir).flatMap(pd => listSessionsInProject(projectsDir, pd));
    }
    if (!showAll) sessions = sessions.filter(s => !hidden.has(s.id));
    sessions.sort(sortByRecency);
    if (!sessions.length) return 'No sessions found.';
    const rows = sessions.map(s => {
      const flags = [];
      if (s.id === currentSessionId) flags.push('current');
      if (hidden.has(s.id)) flags.push('hidden');
      return [
        s.id.slice(0, 8),
        s.title || '(untitled)',
        s.lastTimestamp || '-',
        s.msgCount,
        flags.join(','),
        ...(sub === 'global' ? [s.projDir] : []),
      ];
    });
    const headers = ['ID', 'Name', 'Last Active', 'Msgs', 'Flag', ...(sub === 'global' ? ['Project'] : [])];
    return fmtTable(rows, headers);
  }

  if (sub === 'hidden') {
    const all = listProjectDirs(projectsDir).flatMap(pd => listSessionsInProject(projectsDir, pd));
    const sessions = all.filter(s => hidden.has(s.id)).sort(sortByRecency);
    if (!sessions.length) return 'No hidden sessions.';
    const rows = sessions.map(s => [s.id.slice(0, 8), s.title || '(untitled)', s.lastTimestamp || '-', s.projDir]);
    return fmtTable(rows, ['ID', 'Name', 'Last Active', 'Project']);
  }

  if (sub === 'hide' || sub === 'unhide') {
    const id = parts[2];
    if (!id) return `Usage: /session ${sub} <id>`;
    const matches = findSessionFile(projectsDir, id);
    if (!matches.length) return `No session found matching id "${id}".`;
    if (matches.length > 1) return `Ambiguous id "${id}", matches: ${matches.map(m => m.id.slice(0, 12)).join(', ')}. Use a longer prefix.`;
    const fullId = matches[0].id;
    if (sub === 'hide') {
      if (hidden.has(fullId)) return `Session ${fullId.slice(0, 8)} already hidden.`;
      hidden.add(fullId);
      saveHidden(hidden);
      return `Hid session ${fullId.slice(0, 8)}. Still resumable, just filtered from listings. Undo: /session unhide ${fullId.slice(0, 8)}`;
    } else {
      if (!hidden.has(fullId)) return `Session ${fullId.slice(0, 8)} isn't hidden.`;
      hidden.delete(fullId);
      saveHidden(hidden);
      return `Unhid session ${fullId.slice(0, 8)}.`;
    }
  }

  if (sub === 'rm') {
    const id = parts[2];
    if (!id) return 'Usage: /session rm <id>';
    const matches = findSessionFile(projectsDir, id);
    if (!matches.length) return `No session found matching id "${id}".`;
    if (matches.length > 1) return `Ambiguous id "${id}", matches: ${matches.map(m => m.id.slice(0, 12)).join(', ')}. Use a longer prefix.`;
    const m = matches[0];
    if (currentSessionId && m.id === currentSessionId) {
      return `Refusing to delete the session you're currently in (${m.id.slice(0, 8)}). Exit or switch first.`;
    }
    fs.unlinkSync(m.file);
    const sideDir = m.file.replace(/\.jsonl$/, '');
    if (fs.existsSync(sideDir)) fs.rmSync(sideDir, { recursive: true, force: true });
    hidden.delete(m.id);
    saveHidden(hidden);
    return `Deleted session ${m.id.slice(0, 8)} from ${m.projDir}.`;
  }

  if (sub === 'rename') {
    const id = parts[2];
    const newName = parts.slice(3).join(' ');
    if (!id || !newName) return 'Usage: /session rename <id> <name>';
    const matches = findSessionFile(projectsDir, id);
    if (!matches.length) return `No session found matching id "${id}".`;
    if (matches.length > 1) return `Ambiguous id "${id}", matches: ${matches.map(m => m.id.slice(0, 12)).join(', ')}. Use a longer prefix.`;
    const m = matches[0];
    fs.appendFileSync(m.file, JSON.stringify({ type: 'custom-title', customTitle: newName, sessionId: m.id }) + '\n');
    return `Renamed session ${m.id.slice(0, 8)} to "${newName}".`;
  }

  return `Unknown /session command "${sub}". Run /session help.`;
}

module.exports = { run, findSessionFile, listSessionsInProject, listProjectDirs, currentProjectDirName, fmtTable };

if (require.main === module && !process.argv.includes('--selftest')) {
  let input = '';
  process.stdin.on('data', c => input += c);
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input);
      const prompt = (data.prompt || '').trim();
      if (!/^\/session\b/.test(prompt)) { process.exit(0); return; }
      const cwd = data.cwd || process.cwd();
      const currentSessionId = data.transcript_path
        ? path.basename(data.transcript_path, '.jsonl')
        : null;
      const out = run(prompt, cwd, path.join(claudeDir, 'projects'), currentSessionId);
      process.stdout.write(JSON.stringify({ decision: 'block', reason: out }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: 'session command error: ' + e.message }));
    }
  });
}

// ponytail: minimum runnable check — `node session-manager.js --selftest`
if (process.argv.includes('--selftest')) {
  const assert = require('assert');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-mgr-test-'));
  hiddenFile = path.join(tmp, 'session-manager-hidden.json');  // never the user's real registry
  const projA = 'proj-A';
  const dirA = path.join(tmp, projA);
  fs.mkdirSync(dirA, { recursive: true });
  const id1 = '11111111-aaaa-bbbb-cccc-000000000001';
  const id2 = '22222222-aaaa-bbbb-cccc-000000000002';
  fs.writeFileSync(path.join(dirA, id1 + '.jsonl'),
    JSON.stringify({ type: 'custom-title', customTitle: 'alpha', sessionId: id1 }) + '\n' +
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z' }) + '\n');
  fs.writeFileSync(path.join(dirA, id2 + '.jsonl'),
    JSON.stringify({ type: 'user', timestamp: '2026-01-02T00:00:00Z' }) + '\n');

  // list
  const sessions = listSessionsInProject(tmp, projA);
  assert.strictEqual(sessions.length, 2);
  assert.strictEqual(sessions.find(s => s.id === id1).title, 'alpha');

  // prefix match
  assert.strictEqual(findSessionFile(tmp, id1.slice(0, 8)).length, 1);
  assert.strictEqual(findSessionFile(tmp, '1111').length, 1);

  // hide via run(), then verify filtered from project listing but present in hidden listing
  // cwd must sanitize to the project dir name ("proj-A" has no chars the sanitizer touches)
  const projCwd = projA;
  run(`/session hide ${id1.slice(0, 8)}`, projCwd, tmp, null);
  const listed = run('/session project', projCwd, tmp, null);
  assert(!listed.includes('alpha'), 'hidden session must not appear in default listing');
  const listedAll = run('/session project all', projCwd, tmp, null);
  assert(listedAll.includes('alpha'), 'all flag must include hidden session');
  const hiddenList = run('/session hidden', projCwd, tmp, null);
  assert(hiddenList.includes('alpha'));
  run(`/session unhide ${id1.slice(0, 8)}`, projCwd, tmp, null);
  const listed2 = run('/session project', projCwd, tmp, null);
  assert(listed2.includes('alpha'), 'unhidden session must reappear');

  // rm refuses current session
  const refused = run(`/session rm ${id1.slice(0,8)}`, tmp, tmp, id1);
  assert(refused.includes('Refusing'));
  assert(fs.existsSync(path.join(dirA, id1 + '.jsonl')));

  // rm deletes otherwise
  run(`/session rm ${id2.slice(0,8)}`, tmp, tmp, null);
  assert(!fs.existsSync(path.join(dirA, id2 + '.jsonl')));

  fs.rmSync(tmp, { recursive: true, force: true });  // takes hiddenFile with it
  console.log('OK — all session-manager selftest assertions passed');
}
