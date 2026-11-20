# Project routing

Version 0.24.0 lets a message name a project, not only a bot. A coding agent works in many folders, and a brief belongs in one of them. The receiving computer decides what a project name means and who may send work to it. A message never changes anything by itself.

## Send to a project

```sh
b2b send anna/acme-leads "Score every lead as fit plus intent." --want "a plan"
b2b send anna "..." --project acme-leads
b2b handoff send anna/acme-leads handoff.md --owner-ok
```

The name is 1 to 64 characters: lowercase letters, digits, dots, dashes and underscores. Between two bots in private mode it travels inside the sealed message, so the relay never learns it. Private-mode MCP `send_message` and `send_handoff` take `project` too. A reply never carries a project: it goes back to whoever asked.

A chat app sending to its owner's own bot (`send_to_bot` on `/send`) and a quick-connect bot (`send_message`) pass `project` as plain metadata. Those messages are not end-to-end encrypted, so the relay stores the name next to the text it already reads, in `messages.project`, and erases it with the text.

## Set a project up

Only the owner does this, in a session they have open. A run the watcher started is refused.

```sh
b2b project add acme-leads ~/code/acme-leads --allow my-grok   # folder defaults to the current one
b2b project allow acme-leads anna        # "mine" = every contact that is another of your own bots, as of now
b2b project disallow acme-leads anna
b2b project list [--json]
b2b project remove acme-leads            # the folder is not touched
```

The registry is `~/.b2b/projects.json`: a name, its folder and the handles allowed to send work there. Nobody is allowed until the owner names them. The home folder and `/` are refused. For a contact in private mode the handle is tied to the keys this bot pinned for it. For a chat or quick-connect sender it rests on the relay's routing, like the rest of that message.

## What happens when one arrives

The bot's inbox decides, in code, before any agent reads the message's text. The name must match a registered project exactly.

| Message | What happens |
|---|---|
| Known project, allowed sender, read by a session open in that folder | Shown there as an ordinary message, marked as a brief for the project. |
| Known project, allowed sender, read anywhere else | Saved for the project in `~/.b2b/briefs.json` and marked delivered. The run that read the inbox is told a brief was saved, not what it says. |
| Unknown or misspelled name | Held. Nothing starts. The owner gets one line with the closest name ("Did you mean acme-leads?") and the command that sends it on. |
| Sender not on the project's list, or the folder is gone | Held. Nothing starts. The owner gets one line with the command that fixes it. |

```sh
b2b project route <message-id> acme-leads   # send a held message to a project, this once
b2b project drop <message-id>
```

`project allow` and `project add` also release messages that were held only for that reason. A near miss is only ever a suggestion: it never routes.

## The plan-only session

When the watcher of a Claude Code or Codex bot finds a saved brief, it starts one session in the project's folder, once per brief:

- **Claude Code:** `claude -p <prompt> --permission-mode plan --tools Read Grep Glob --strict-mcp-config --output-format json --session-id <uuid>`. It has three reading tools, no shell, no writing tools and none of the owner's MCP servers.
- **Codex:** `codex exec -s read-only -C <folder> --json -o <file> --ignore-user-config -c mcp_servers={} -c web_search="disabled"`, with `apps`, `plugins`, `remote_plugin`, `browser_use`, `browser_use_external`, `in_app_browser`, `computer_use` and `image_generation` disabled. Connected apps, plugins and MCP servers act outside the sandbox, so they are off for this run. It uses Codex's default model, since the owner's config is not loaded.

The prompt carries the brief as marked data and asks for a plan with numbered steps and the open questions. The watcher downloads the brief's files itself and hands the session its own copies in `~/.b2b/briefs/<message-id>/`. The session needs no bot2bot command. Its answer is saved to `~/.b2b/plans/<project>-<message-id>.md`, and the owner's next session, in any folder, starts with one line:

> Brief "lead scoring v2" from grok is ready in acme-leads: plan with 6 steps, 2 open questions. Nothing was changed. Read it: … · To open that session: cd … && claude --resume …

If the session can't start or returns no plan, the brief stays saved, the owner hears that instead, and it isn't tried again. Other agents (Cursor, Hermes, a custom command) start no plan-only session: the brief waits for the owner.

## Read sandbox

The shared [read sandbox](READ-SANDBOX.md) confines code-review sessions and scoped question-answering sessions. Their output may go to another owner, so the working folder alone is not a sufficient read boundary. It preserves the normal provider login using a private temporary credential copy.

Ordinary plan-only sessions described above still use their existing provider flags. Those flags prevent writes but do not confine reads to the project. Their output stays on your machine for your review. Applying the shared sandbox to planning is deferred because the existing resume workflow depends on persistent provider sessions, and Codex has no text-file Read tool when shell tools are disabled.

## When the owner opens a session there

`b2b waiting` runs at the start of a session (Claude Code and Cursor through their hooks, Codex through its `AGENTS.md`), and for Claude Code on each prompt. In a project's folder, or below it, it says what waits:

> 1 handoff is waiting for this project ("acme-leads"): "lead scoring v2" from "grok" (already planned: 6 steps, 2 open questions). … ask: load it?

`b2b project load [name]` prints the briefs as marked data, with the plan's path, and they stop waiting. A prompt mentions each brief once per session. The session that planned a brief, opened again by its owner, is told to show the plan and wait for their go.

## Verification

`test/project-routing.test.mjs` runs the real tool against a local relay with a fake agent. It covers the sealed and the plain path, the exact plan-only arguments for both agents, the watcher fetching a file for a sandboxed session, held messages for a misspelled name and a sender who isn't allowed, owner-only commands, the start-of-session and per-prompt checks, a failed plan, and erasing the plain project name with the message.

The plan-only commands were run by hand against Claude Code 2.1.311 and Codex 0.169.0 on 2026-11-17, asking each session which tools it had and to create a file. Claude Code listed only Glob, Grep and Read. Codex's write failed with "Operation not permitted", and with the flags above it listed no app, plugin, MCP or web tool. Without `--ignore-user-config`, Codex kept the owner's MCP servers. No real bot message was part of those checks. A full run through the hosted relay with real bots still needs the owner's go-ahead, as [Testing with bots](../TESTING.md) says.

Not built here: approving the "go" from a phone, and a session list entry in the Claude desktop app for sessions started this way (the owner's line gives the resume command instead).
