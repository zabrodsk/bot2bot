# Context handoffs

Version 0.23.0 adds task packages and threads alongside session delivery. See [SESSION-DELIVERY.md](SESSION-DELIVERY.md) for Claude Code channels, Codex resume and reply routing. These changes must be deployed before clients can use the new relay APIs.

## Send work and return a result

```sh
b2b handoff new --to anna --title "Review the API change"
b2b handoff lint handoff.md
# Review the package with its owner before using --owner-ok.
b2b handoff send anna handoff.md --owner-ok

# The recipient reads the latest package before acting.
b2b thread show t_EXAMPLE123 --brief
b2b handoff new --reply-to msg_EXAMPLE123
b2b handoff reply msg_EXAMPLE123 result.md --owner-ok
b2b thread close t_EXAMPLE123
```

Use the actual filenames and IDs printed by the commands. `handoff` without a subcommand retains its existing meaning: drain messages saved for this session. A routed package retains its thread, and its result returns to the session that sent the original question.

A package contains bounded YAML front matter and seven Markdown sections: Goal, Current state, Decisions, Open questions, Constraints, What I need from you, and How to verify. The parser accepts scalar fields, lists and flat inline objects, not general YAML. Result packages use `ask: result`, a verdict, findings and refs, with Summary, Findings and How to verify sections. Lint checks required fields, 2,000 words, 64 KiB, known secret patterns, the current bot's secrets, and attachment hashes. It cannot prove that arbitrary text contains no secret or that the recipient has credentials for a private repository.

Sharing defaults to asking the owner for each contact. An attended owner can set `handoff share <contact> allow`; a watcher cannot grant permission or use `--owner-ok`. These rules are local to the bot. Quick-connect `send_handoff` requires explicit owner approval on each call.

## Transport

Coding agents receive an encrypted attachment when both endpoints use private mode. Grok Bot also gets inline content when it fits. Clients without file access receive the package inline. Quick connect and web inbox traffic is plaintext to the relay, and the commands say so. Capability `repo: true` means the client can work with repositories, not that it can access any particular repository.

`--attach` includes files referenced by the package. A `b2b-file` ref must name an attached file and match its SHA-256 when supplied. An inline package must fit the normal 8,000-character message limit. Larger packages need attachment support or must be shortened.

The instructions appear in the CLI wake prompt, generated AGENTS.md/SOUL.md blocks, Cursor's always-applied `.cursor/rules/bot2bot.mdc`, the Grok skill and doorbell routine, and MCP tools. Incoming text remains marked as another bot's data, not executable instructions.

## History and retention

Private threads live under `~/.b2b`. Atomic writes and a shared process lock preserve concurrent updates. Package snapshots are immutable, content-addressed files. Expiration removes managed copies that no retained thread references; it does not remove the owner's original files. History has no silent thread-count or event-count eviction. A brief is paginated after its latest package; follow the printed `--after` cursor to read remaining messages.

Plaintext thread history is held by the relay and bound to the two participating bot identities. Another contact cannot attach messages to it or read it. Owner contact approvals, blocks and pauses still apply. `send --thread` and MCP `send_message.thread` carry the thread; replies inherit it. Private messages keep thread identifiers inside their encrypted payload and never send top-level relay thread metadata.

Both stores retain active threads for 30 days after their last new message. Local closed threads remain for seven days. Closing a relay thread caps its remaining lifetime at seven days and stops new messages; retries do not extend retention. A relay thread cannot be reopened; create a new one. Ordinary relay messages keep their existing seven-day retention.

Relay APIs:

- `GET /v1/threads/:thread`: authorized, paginated plaintext history.
- `GET /v1/threads/:thread?brief=1`: latest package plus later messages, with `next_after` when another page exists.
- `POST /v1/threads/:thread/close`: idempotent close for both participants.

MCP provides `send_handoff`, `thread_brief` and `thread_close`. Private stdio MCP additionally provides `receive_session_messages` and `bind_contact`; a hosted connector cannot address local provider sessions.

## Verification scope

The local simulator covers encrypted attachments and inline fallback, result replies, session routing, channel notifications and disconnects, Codex resume arguments, secret and ref rejection, consent, concurrent persistence, expiration, pair isolation, pagination and quick-connect tools. Email-invite tests use a fake mailer and verify the owner's exact review-and-send step.

Real provider acceptance remains a separate test: Claude Code to Codex, Codex to Claude Code, Claude Code to Grok, Cursor to Claude Code, and OpenClaw to Codex, each waiting, idle and closed. The issue's acceptance target is at least four successful continuations in five runs per pair without asking again for context already in the package. Local simulated delivery does not establish that target. [TESTING-RULES.md](../TESTING-RULES.md) requires explicit permission for each live test and names of the user's own bots. Desktop channel support and concurrent turns in an active Codex session are not established by the simulator.
