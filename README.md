# cc-plugins

migi's personal [Claude Code](https://code.claude.com) plugin marketplace.

## Install

```
/plugin marketplace add devmigi619/cc-plugins
/plugin install session-manager@cc-plugins
```

Update later with `/plugin marketplace update`.

## Plugins

### session-manager

Manage Claude Code sessions from the prompt. Runs inside a `UserPromptSubmit`
hook, so it never reaches the model — zero tokens, no round trip.

```
/session-manager:list [all]              Sessions in this project (all: include hidden)
/session-manager:list global [all]       Sessions across every project
/session-manager:list hidden             Only hidden sessions
/session-manager:hide <id>               Hide from listings (reversible, deletes nothing)
/session-manager:unhide <id>             Unhide
/session-manager:remove <id> [<id> ...]  Permanently delete one or more sessions
/session-manager:remove untitled [global] [confirm]
                                          Delete all untitled sessions (project by default;
                                          omit confirm to preview, hidden ones are skipped)
/session-manager:rename <id> <name>      Set a custom title
/session-manager:help                    Show help
```

`<id>` accepts any unique prefix of a session id.

Notes:

- `hide` only adds the id to `~/.claude/session-manager-hidden.json`. Session
  files are never touched and stay resumable.
- `rename` appends a `custom-title` record to the transcript; nothing is rewritten.
- `remove` deletes everything Claude Code names after the session id: the
  `projects/<proj>/<id>.jsonl` transcript, its `<id>/` sidecar directory,
  `session-env/<id>/`, and `file-history/<id>/`. `sessions/<pid>.json` is left
  alone — it is keyed by pid and cleared on exit.
- `remove` refuses to delete the session you are currently in. With several ids it
  deletes the rest and reports what it skipped.
- `remove untitled` previews the delete list; nothing is touched until `confirm` is
  passed (anywhere in the args). Hidden untitled sessions are skipped — hiding one
  means keep it, just filter it from listings.

The `commands/*.md` files only register the names. The hook reads the invocation
the user typed, so there is no intermediate command text to keep in sync.

Requires `node` on PATH.

## Development

```
node plugins/session-manager/hooks/session-manager.js --selftest
```
