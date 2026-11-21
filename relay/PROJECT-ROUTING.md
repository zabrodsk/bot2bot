# Project routing

A project is a folder on the receiving computer. The owner registers its name and chooses which contacts can send there.

```sh
b2b project add acme-leads ~/code/acme-leads --allow mine
b2b project allow acme-leads anna
b2b send my-codex/acme-leads "Here are the scoring notes."
b2b send my-codex "Implement the scoring rules in scoring.md." --project acme-leads --do
```

Use `--do` when you want the receiving bot to start work. Put the task in the message text. `--want` gives the bot extra context and can be used with or without `--do`. `handoff send` also accepts both ways of naming a project and supports `--do`.

A project name is 1 to 64 characters using lowercase letters, digits, dots, dashes or underscores. Private MCP `send_message` and `send_handoff` take `project` and `task`. Chat apps use the same fields in `send_to_bot`. In private mode both fields travel inside the sealed message. Chat app and quick-connect sends carry them as plain metadata, which the relay erases with the message.

## What happens when a message arrives

| Message | What Claude Code and Codex do |
|---|---|
| No task or project | The message waits in the inbox. |
| Task, no project | The watcher starts a new chat in the bot's default folder. |
| Task for a project | The watcher continues the most recently active chat in that folder, or starts one if the folder has no chats. |
| Project message without a task | It waits for the owner's next session or prompt in that folder. |

The owner's own bots can start tasks as soon as the watcher picks them up. A contact's task waits for approval on the owner's linked phone. If the owner declines, the card expires, or no phone is available, the task stays waiting and the sender gets a reply.

When a task finishes, the watcher replies to its original message. The owner sees a line with the command to resume the chat. In ChatGPT, Claude and other chat apps connected through `/send`, ask for the result in the sending connection using the message ID returned by the send.

Group messages, replies to tracked questions, code reviews and scoped questions follow their own delivery rules.

## Set up and manage projects

```sh
b2b project list
b2b project disallow acme-leads anna
b2b project route <message-id> acme-leads
b2b project drop <message-id>
b2b project remove acme-leads
```

`project add` uses the current directory if you omit the folder. `--allow mine` adds the owner's current bot contacts. Run project commands in a session the owner opened.

If a project name is unknown, its folder is missing or the sender lacks access, the message stays held. The owner can fix the project, allow the sender, or use `project route` to release a message to a project once. Similar names are suggestions.

Run `b2b waiting` to see briefs for the current project's folder or a subfolder. Claude Code and Codex check again on each prompt. In Codex, trust the bot2bot command in `/hooks` to enable this check. Use `b2b project load` to read their contents. Older plans already saved on disk can still be opened from the brief.
