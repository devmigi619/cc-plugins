# claude-plugins

migi's personal [Claude Code](https://code.claude.com) plugin marketplace.

## Install

```
/plugin marketplace add devmigi619/claude-plugins
/plugin install session-manager@claude-plugins
```

Update later with `/plugin marketplace update`.

## Plugins

### session-manager

Manage Claude Code sessions from the prompt with `/session`. Runs inside a `UserPromptSubmit`
hook, so it never reaches the model — zero tokens, no round trip.

```
/session project [all]        List sessions in the current project (all: include hidden)
/session global [all]         List sessions across all projects
/session hidden               List only hidden sessions
/session hide <id>            Hide from listings (reversible, deletes nothing)
/session unhide <id>          Unhide
/session rm <id> [<id> ...]   Permanently delete one or more sessions
/session rename <id> <name>   Set a custom title
/session help                 Show help
```

`<id>` accepts any unique prefix of a session id.

Notes:

- `hide` only adds the id to `~/.claude/session-manager-hidden.json`. Session
  files are never touched and stay resumable.
- `rename` appends a `custom-title` record to the transcript; nothing is rewritten.
- `rm` deletes everything Claude Code names after the session id: the
  `projects/<proj>/<id>.jsonl` transcript, its `<id>/` sidecar directory,
  `session-env/<id>/`, and `file-history/<id>/`. `sessions/<pid>.json` is left
  alone — it is keyed by pid and cleared on exit.
- `rm` refuses to delete the session you are currently in. With several ids it
  deletes the rest and reports what it skipped.

Requires `node` on PATH.

## Development

Sources live in this repo. The copies under `~/.claude/plugins/` are extracted
per commit — edits there are discarded on the next update, so change things
here and push.

```
node plugins/session-manager/hooks/session-manager.js --selftest
```
