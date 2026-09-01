#!/usr/bin/env node
// session-manager — list, hide, rename, delete Claude Code sessions.
// Runs as a UserPromptSubmit hook: intercepts "/session-manager:<verb>" prompts,
// never forwards them to the model. The command files under commands/ only
// register the names; the hook reads the invocation the user typed.
// Hidden sessions are a registry entry (session-manager-hidden.json), not a file
// move — reversible, no data touched.

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

const NS = 'session-manager';

const HELP = `${NS} commands:
  /${NS}:list [all]                 Sessions in the current project (all: include hidden)
  /${NS}:list global [all]          Sessions across every project
  /${NS}:list hidden                Only hidden sessions
  /${NS}:hide <id>                  Hide from listings (reversible, deletes nothing)
  /${NS}:unhide <id>                Unhide
  /${NS}:remove <id> [<id> ...]     Delete sessions and their leftover directories
  /${NS}:remove untitled [global] [confirm]
                                    Delete all untitled sessions (current project unless
                                    global; omit confirm to preview, hidden ones are skipped)
  /${NS}:rename <id> <name>         Set a custom title
  /${NS}:help                       Show this help
id accepts any unique prefix of the session id.`;

function sortByRecency(a, b) {
  return (b.lastTimestamp || '').localeCompare(a.lastTimestamp || '');
}

// Everything Claude Code names after a session id. Siblings of projects/, so
// they're derived from its parent rather than hardcoded to ~/.claude.
function sessionArtifacts(sessionFile, sessionId, baseDir) {
  return [
    sessionFile.replace(/\.jsonl$/, ''),              // projects/<proj>/<id>/  sidecar
    path.join(baseDir, 'session-env', sessionId),
    path.join(baseDir, 'file-history', sessionId),
  ];
}

// ponytail: sessions/<pid>.json holds a sessionId too, but it's keyed by pid and
// Claude Code clears it on exit — no dead entries observed, so we leave it alone.
function deleteSession(m, hidden, baseDir) {
  fs.unlinkSync(m.file);
  for (const p of sessionArtifacts(m.file, m.id, baseDir)) {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  hidden.delete(m.id);
}

// The hook sees the invocation the user typed, not the command file's body, so
// this parses "/session-manager:<verb> <args>" straight from the prompt.
const INVOCATION = new RegExp(`^/?${NS}:(\\S+)\\s*([\\s\\S]*)$`);

function run(prompt, cwd, projectsDir, currentSessionId) {
  const m0 = INVOCATION.exec(prompt.trim());
  if (!m0) return `Not a ${NS} command. Run /${NS}:help.`;
  const verb = m0[1];
  const args = m0[2].trim() ? m0[2].trim().split(/\s+/) : [];
  const hidden = loadHidden();

  if (verb === 'help') return HELP;

  if (verb === 'list') {
    // list [all] | list global [all] | list hidden
    const scope = args[0] === 'global' || args[0] === 'hidden' ? args[0] : 'project';
    const showAll = args.includes('all');

    if (scope === 'hidden') {
      const all = listProjectDirs(projectsDir).flatMap(pd => listSessionsInProject(projectsDir, pd));
      const sessions = all.filter(s => hidden.has(s.id)).sort(sortByRecency);
      if (!sessions.length) return 'No hidden sessions.';
      const rows = sessions.map(s => [s.id.slice(0, 8), s.title || '(untitled)', s.lastTimestamp || '-', s.projDir]);
      return fmtTable(rows, ['ID', 'Name', 'Last Active', 'Project']);
    }

    let sessions = scope === 'global'
      ? listProjectDirs(projectsDir).flatMap(pd => listSessionsInProject(projectsDir, pd))
      : listSessionsInProject(projectsDir, currentProjectDirName(cwd));
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
        ...(scope === 'global' ? [s.projDir] : []),
      ];
    });
    const headers = ['ID', 'Name', 'Last Active', 'Msgs', 'Flag', ...(scope === 'global' ? ['Project'] : [])];
    return fmtTable(rows, headers);
  }

  if (verb === 'hide' || verb === 'unhide') {
    const id = args[0];
    if (!id) return `Usage: /${NS}:${verb} <id>`;
    const matches = findSessionFile(projectsDir, id);
    if (!matches.length) return `No session found matching id "${id}".`;
    if (matches.length > 1) return `Ambiguous id "${id}", matches: ${matches.map(m => m.id.slice(0, 12)).join(', ')}. Use a longer prefix.`;
    const fullId = matches[0].id;
    if (verb === 'hide') {
      if (hidden.has(fullId)) return `Session ${fullId.slice(0, 8)} already hidden.`;
      hidden.add(fullId);
      saveHidden(hidden);
      return `Hid session ${fullId.slice(0, 8)}. Still resumable, just filtered from listings. Undo: /${NS}:unhide ${fullId.slice(0, 8)}`;
    } else {
      if (!hidden.has(fullId)) return `Session ${fullId.slice(0, 8)} isn't hidden.`;
      hidden.delete(fullId);
      saveHidden(hidden);
      return `Unhid session ${fullId.slice(0, 8)}.`;
    }
  }

  if (verb === 'remove') {
    // 'confirm' can appear anywhere in args, so strip it before reading positional args.
    let ids = args.filter(a => a !== 'confirm');
    const confirmed = args.includes('confirm');
    if (ids[0] === 'untitled') {
      const scope = ids[1] === 'global'
        ? listProjectDirs(projectsDir).flatMap(pd => listSessionsInProject(projectsDir, pd))
        : listSessionsInProject(projectsDir, currentProjectDirName(cwd));
      ids = scope.filter(s => !s.title && !hidden.has(s.id)).map(s => s.id);
      if (!ids.length) return 'No untitled sessions.';
      if (!confirmed) {
        return `Would delete ${ids.length} untitled session${ids.length === 1 ? '' : 's'}: ${ids.map(i => i.slice(0, 8)).join(', ')}\nRun again with "confirm" to delete.`;
      }
    }
    if (!ids.length) return `Usage: /${NS}:remove <id> [<id> ...] | /${NS}:remove untitled [global] confirm`;
    const baseDir = path.dirname(projectsDir);
    const deleted = [];
    const skipped = [];
    for (const id of ids) {
      const matches = findSessionFile(projectsDir, id);
      if (!matches.length) { skipped.push(`${id}: no match`); continue; }
      if (matches.length > 1) {
        skipped.push(`${id}: ambiguous (${matches.map(m => m.id.slice(0, 12)).join(', ')})`);
        continue;
      }
      const m = matches[0];
      if (currentSessionId && m.id === currentSessionId) {
        skipped.push(`${id}: current session, exit or switch first`);
        continue;
      }
      deleteSession(m, hidden, baseDir);
      deleted.push(`${m.id.slice(0, 8)} (${m.projDir})`);
    }
    if (deleted.length) saveHidden(hidden);
    const lines = [];
    if (deleted.length) lines.push(`Deleted ${deleted.length}: ${deleted.join(', ')}`);
    if (skipped.length) lines.push(`Skipped ${skipped.length}: ${skipped.join('; ')}`);
    return lines.join('\n');
  }

  if (verb === 'rename') {
    const id = args[0];
    const newName = args.slice(1).join(' ');
    if (!id || !newName) return `Usage: /${NS}:rename <id> <name>`;
    const matches = findSessionFile(projectsDir, id);
    if (!matches.length) return `No session found matching id "${id}".`;
    if (matches.length > 1) return `Ambiguous id "${id}", matches: ${matches.map(m => m.id.slice(0, 12)).join(', ')}. Use a longer prefix.`;
    const m = matches[0];
    fs.appendFileSync(m.file, JSON.stringify({ type: 'custom-title', customTitle: newName, sessionId: m.id }) + '\n');
    return `Renamed session ${m.id.slice(0, 8)} to "${newName}".`;
  }

  return `Unknown command "${verb}". Run /${NS}:help.`;
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
      if (!INVOCATION.test(prompt)) { process.exit(0); return; }
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
  // Mirror the real layout: projects/ is a sibling of session-env/ and file-history/,
  // which is how deleteSession() finds them.
  const projectsDir = path.join(tmp, 'projects');
  const projA = 'proj-A';
  const dirA = path.join(projectsDir, projA);
  fs.mkdirSync(dirA, { recursive: true });
  const id1 = '11111111-aaaa-bbbb-cccc-000000000001';
  const id2 = '22222222-aaaa-bbbb-cccc-000000000002';
  const id3 = '33333333-aaaa-bbbb-cccc-000000000003';
  fs.writeFileSync(path.join(dirA, id1 + '.jsonl'),
    JSON.stringify({ type: 'custom-title', customTitle: 'alpha', sessionId: id1 }) + '\n' +
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z' }) + '\n');
  fs.writeFileSync(path.join(dirA, id2 + '.jsonl'),
    JSON.stringify({ type: 'user', timestamp: '2026-01-02T00:00:00Z' }) + '\n');
  fs.writeFileSync(path.join(dirA, id3 + '.jsonl'),
    JSON.stringify({ type: 'user', timestamp: '2026-01-03T00:00:00Z' }) + '\n');

  // list
  const sessions = listSessionsInProject(projectsDir, projA);
  assert.strictEqual(sessions.length, 3);
  assert.strictEqual(sessions.find(s => s.id === id1).title, 'alpha');

  // prefix match
  assert.strictEqual(findSessionFile(projectsDir, id1.slice(0, 8)).length, 1);
  assert.strictEqual(findSessionFile(projectsDir, '1111').length, 1);

  // hide via run(), then verify filtered from project listing but present in hidden listing
  // cwd must sanitize to the project dir name ("proj-A" has no chars the sanitizer touches)
  const projCwd = projA;
  run(`/session-manager:hide ${id1.slice(0, 8)}`, projCwd, projectsDir, null);
  const listed = run('/session-manager:list', projCwd, projectsDir, null);
  assert(!listed.includes('alpha'), 'hidden session must not appear in default listing');
  const listedAll = run('/session-manager:list all', projCwd, projectsDir, null);
  assert(listedAll.includes('alpha'), 'all flag must include hidden session');
  const hiddenList = run('/session-manager:list hidden', projCwd, projectsDir, null);
  assert(hiddenList.includes('alpha'));
  run(`/session-manager:unhide ${id1.slice(0, 8)}`, projCwd, projectsDir, null);
  const listed2 = run('/session-manager:list', projCwd, projectsDir, null);
  assert(listed2.includes('alpha'), 'unhidden session must reappear');

  // rm refuses the current session and leaves it on disk
  const refused = run(`/session-manager:remove ${id1.slice(0, 8)}`, projCwd, projectsDir, id1);
  assert(refused.includes('current session'), refused);
  assert(fs.existsSync(path.join(dirA, id1 + '.jsonl')));

  // rm takes the transcript plus every directory named after the session
  const artifacts = [
    path.join(dirA, id2),                        // projects/<proj>/<id>/ sidecar
    path.join(tmp, 'session-env', id2),
    path.join(tmp, 'file-history', id2),
  ];
  for (const p of artifacts) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'file-history', id2, 'snap@v1'), 'x');
  run(`/session-manager:remove ${id2.slice(0, 8)}`, projCwd, projectsDir, null);
  assert(!fs.existsSync(path.join(dirA, id2 + '.jsonl')));
  for (const p of artifacts) assert(!fs.existsSync(p), `artifact must be gone: ${p}`);

  // multi-id rm: deletes what it can, reports what it can't, in one pass
  const multi = run(`/session-manager:remove ${id3.slice(0, 8)} deadbeef ${id1.slice(0, 8)}`, projCwd, projectsDir, id1);
  assert(!fs.existsSync(path.join(dirA, id3 + '.jsonl')), 'id3 must be deleted');
  assert(fs.existsSync(path.join(dirA, id1 + '.jsonl')), 'current session must survive a batch');
  assert(multi.includes('Deleted 1'), multi);
  assert(multi.includes('Skipped 2'), multi);
  assert(multi.includes('no match'), multi);
  assert(multi.includes('current session'), multi);

  // remove untitled: preview by default, deletes only on confirm, skips hidden and current
  const id6 = '66666666-aaaa-bbbb-cccc-000000000006';
  const id7 = '77777777-aaaa-bbbb-cccc-000000000007'; // hidden + untitled — must survive
  for (const id of [id6, id7]) {
    fs.writeFileSync(path.join(dirA, id + '.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-01-04T00:00:00Z' }) + '\n');
  }
  run(`/session-manager:hide ${id7.slice(0, 8)}`, projCwd, projectsDir, null);

  const preview = run('/session-manager:remove untitled', projCwd, projectsDir, null);
  assert(preview.includes('Would delete 1'), preview);
  assert(preview.includes(id6.slice(0, 8)), preview);
  assert(!preview.includes(id7.slice(0, 8)), 'hidden untitled session must not appear in preview: ' + preview);
  assert(fs.existsSync(path.join(dirA, id6 + '.jsonl')), 'preview alone must not delete anything');

  const skippedCurrent = run('/session-manager:remove untitled confirm', projCwd, projectsDir, id6);
  assert(fs.existsSync(path.join(dirA, id6 + '.jsonl')), 'current session must survive an untitled sweep');
  assert(skippedCurrent.includes('current session'), skippedCurrent);

  const swept = run('/session-manager:remove untitled confirm', projCwd, projectsDir, null);
  assert(swept.includes('Deleted 1'), swept);
  assert(!fs.existsSync(path.join(dirA, id6 + '.jsonl')), 'id6 must be deleted');
  assert(fs.existsSync(path.join(dirA, id7 + '.jsonl')), 'hidden untitled session must survive the sweep');

  const noneLeft = run('/session-manager:remove untitled', projCwd, projectsDir, null);
  assert.strictEqual(noneLeft, 'No untitled sessions.', noneLeft);

  // global scope reaches every project; 'confirm' works regardless of position
  const projB = 'proj-B';
  const dirB = path.join(projectsDir, projB);
  fs.mkdirSync(dirB, { recursive: true });
  const id9 = '99999999-aaaa-bbbb-cccc-000000000009';
  const id10 = 'a0a0a0a0-aaaa-bbbb-cccc-000000000010';
  for (const id of [id9, id10]) {
    fs.writeFileSync(path.join(dirB, id + '.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-01-05T00:00:00Z' }) + '\n');
  }
  const globalSwept = run('/session-manager:remove untitled confirm global', projCwd, projectsDir, null);
  assert(globalSwept.includes('Deleted 2'), globalSwept);
  assert(!fs.existsSync(path.join(dirB, id9 + '.jsonl')), 'id9 must be deleted via global sweep');
  assert(!fs.existsSync(path.join(dirB, id10 + '.jsonl')), 'id10 must be deleted via global sweep');
  assert(fs.existsSync(path.join(dirA, id7 + '.jsonl')), 'hidden untitled session must still survive after global sweep');

  fs.rmSync(tmp, { recursive: true, force: true });  // takes hiddenFile with it
  console.log('OK — all session-manager selftest assertions passed');
}
