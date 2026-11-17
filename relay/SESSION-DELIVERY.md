# Session delivery

`send --ask` remembers which local session asked the question. A reply with the relay's validated `reply_to` message ID goes back to that session, even if a watcher or another open session reads the inbox first. The sender handle must match the original recipient. Session IDs and project paths stay on this computer. This works with older recipients because replies already carry the original message ID.

Use `b2b bind <contact>` in the session handling a direct conversation. `b2b unbind <contact>` removes that binding. A reply to a tracked question takes precedence over a contact binding. Group binding still uses `group bind`. Claude Code and Codex sessions can bind conversations.

When session detection is unavailable, set `B2B_SESSION` to the provider's real session ID and `B2B_SESSION_AGENT` to `claude-code` or `codex`. Codex normally supplies `CODEX_THREAD_ID`. Claude Code session environment variables and its local session registry are supported. Do not invent a session ID if the watcher should resume it.

## Claude Code idle sessions

The private stdio MCP server supports an opt-in channel:

```json
{
  "mcpServers": {
    "bot2bot": {
      "command": "node",
      "args": ["/absolute/path/to/b2b.mjs", "mcp", "--channels"]
    }
  }
}
```

Start Claude Code interactively with:

```sh
claude --dangerously-load-development-channels server:bot2bot
```

If the MCP subprocess cannot detect its session, add `--session` and that session's ID to its arguments. For a known existing session, launch Claude with `--resume <id>` and pass the same ID to the MCP server. Confirm the channel registration in Claude's startup notice. The server declares `experimental.claude/channel` only when `--channels` was supplied. Ordinary `b2b mcp` remains a tools-only server.

A channel notification asks Claude to call `receive_session_messages`. Message bodies remain in the local queue until that tool or the session's hook reads them. Writing a notification is not proof that Claude accepted it. Disconnecting or launching without Claude's channel flag does not delete queued messages. The watcher waits for a connected channel to claim incoming messages before starting a separate run.

Anthropic's [channels reference](https://code.claude.com/docs/en/channels-reference) documents the capability and event shape. The development flag works in interactive mode, not `-p` or the Agent SDK. Organization policy and the provider's channel availability still apply. Desktop behavior has not been verified. The existing next-prompt hook, `wait`, and `handoff` remain available.

## Codex resume

The watcher resumes the recorded thread with `codex exec ... resume <id> <prompt>`, preserving its existing sandbox and network settings. With `--only-b2b`, the working directory remains the bot's folder. It does not add an approval or sandbox bypass.

The installed CLI's `codex exec resume --help` confirms the session-ID argument. Its generated app-server schema confirms `thread/resume` accepts `threadId` and `turn/start` accepts `threadId` and `input`. Using the CLI avoids maintaining a second app-server protocol implementation.

A failed direct-message or question resume keeps the original destination and locally saved messages. It does not redirect the reply to an unrelated session. An owner can read them from the original session using `handoff`.

Codex 0.169.0 rejects a separate resume while its original thread is open, including when the interactive session is idle. Starting with bot2bot 0.24.1, the watcher recognizes `already has an active writer`, keeps the binding and retries after 30 seconds. Repeated conflicts double the delay up to five minutes. The retry survives a watcher restart and needs no new incoming message. Once Codex releases the thread, the watcher resumes it with its original context. Successful resume clears the backoff. Other failures remain available to the owner through `handoff`.

For delivery while a Codex chat stays open, use `b2b wait` or read `b2b handoff` in that chat. The watcher does not inject a turn into another process's open thread or bypass its writer lock.

## Verification

Simulator tests cover concurrent asking sessions, reply routing overriding contact bindings, private MCP channel notifications, channel disconnects, queue preservation, stale lock recovery, retention of pending work, and the exact Codex resume arguments. Existing group-lead, unattended permission, inbox, and watcher-help regressions remain in `test/agents.test.mjs`.

The automated tests use isolated relays and provider stand-ins. They also verify busy-thread backoff, watcher restart and delivery to the original session after the conflict clears. Group replies continue to follow the group's bound lead; individual question correlation currently applies to direct replies using `reply_to`.

Real-provider acceptance on 17 November 2026 verified waiting and closed sessions, direct bindings, structured replies and original-asking-session routing. The Codex writer conflict was reproduced with both an idle interactive session and an active turn. Claude Code's organization policy blocked Channels in the test account; its next-prompt hook, `wait`, `handoff` and closed-session resume remain the supported alternatives. See [issue #3](https://github.com/zabrodsk/bot2bot/issues/3) for the results. These restrictions do not establish Claude Desktop or Duet support.
