# Code review

Ask another coding bot to review a change, even on another provider or computer. A review is an `ask: review` handoff package addressed to a project. Its verdict is an `ask: result` package replying to that request. Task threads keep the history, and the existing question routing returns the result to the session that asked.

## Request and update

Run this in the author's repository. The branch must exist locally. Use `--brief` to include the task context. Without it, the package includes a short review brief naming the branch, base and focus. Tests are optional, and absent reports say "Not supplied by the author."

```sh
b2b review request anna --project acme-leads --branch lead-v2 --base main \
  --brief "Make lead retries safe after timeouts." --focus "security, tests" \
  --tests "npm test 42/42" --question "Can a retry insert a duplicate?" --owner-ok
b2b review update                         # latest review requested from this folder
b2b review update t_EXAMPLE123 --tests "npm test 44/44" --owner-ok
```

Use `--owner-ok` only after showing your owner the brief, tests, questions, refs and diff that leave the repo and getting their yes. `handoff share anna allow` grants the same contact permission as other packages. A watcher cannot set that rule or use `--owner-ok`. This command prepares no GitHub comment, PR or push.

Up to three `--question` values go with the brief. `--cost-cap` defaults to $1 across the review's rounds. An update keeps the thread, brief, focus and questions unless you replace them. It requires a result answering the previous package and sends the diff from the previous reviewed commit to the new branch head. Previous findings stay in the prompt so the reviewer can check unresolved issues. The third round is the last. A third non-approval result saves both positions for the author's next session as soon as it arrives, and also notifies the reviewer's owner. Another update is refused. The notification appears once per review on each computer.

## What leaves the repo

For another of your own bots, as identified by `your_own_bot`, the package contains an origin URL, branch and exact commit hashes. `git ls-remote` checks that the origin branch matches the requested commit. An unpushed branch is refused with a warning. You push it yourself.

The receiving watcher fetches only its local project's configured `origin`, after matching its URL against the request. It does not use a peer-supplied URL as a fetch target, switch branches or change working files. It checks the fetched head and creates the diff using pinned commit hashes. The reviewer must already have access to that origin and the base commit. Authentication is noninteractive. Fetch failure or mismatched refs holds the request for the owner.

For a different owner, the diff travels inside the end-to-end encrypted message. It is an encrypted `review.diff` attachment when their bot can receive files, with a checked SHA-256 ref. Otherwise it goes inside the package text. Reviews refuse plaintext contacts. The relay cannot see the brief, diff, branch, project, verdict, questions or private thread ID. It still sees the participants, reply correlation, receipt and file routing IDs and encrypted sizes, as with other private messages.

Diffs are limited to 64 KiB and checked by `findSecrets`, including this bot's own credentials. The whole handoff still has its 64 KiB and 2,000-word bounds. Inline packages must fit the normal 8,000-character message limit, including their diff and previous verdict. Split larger reviews or use a contact with files. Secret detection catches known patterns, not every possible secret.

## Reviewer permissions

The receiving owner first registers a project and allows the contact to send work there. Unknown projects, missing folders and disallowed senders start no session, exactly as in [Project routing](PROJECT-ROUTING.md).

```sh
b2b project add acme-leads ~/code/acme-leads --allow tom
# Optional, only in the owner's attended session:
b2b review allow tom --project acme-leads
b2b review disallow tom --project acme-leads
```

Automatic replies default to off, even when general handoff sharing is allowed. On Linux, Windows or another platform without a usable sandbox, an unconfined verdict for another owner always waits as a draft. `review allow` reports the missing sandbox on unsupported platforms. Its permission cannot bypass this check. Another of your own bots, identified by `your_own_bot`, may still receive an automatic verdict. The send command checks the current contact relationship, and older drafts without sandbox evidence also require owner approval for another owner. `review allow` is an explicit owner-only permission for this contact and project to receive read-only review verdicts. It does not allow other packages. An unattended run cannot change it. `--cost-cap 2` on `review allow` raises that receiver's ceiling to $2. The actual ceiling is the lower of the author's cap, receiver's cap and the ceiling already set for this review. A later update cannot raise it.

The watcher reuses the existing project runner with a review prompt and puts the provider inside the shared [read sandbox](READ-SANDBOX.md). It permits reads of this project and this review's copied files, plus the documented provider runtime and staged login. Read-only provider flags alone do not confine filesystem reads. Claude Code keeps plan mode, `Read Grep Glob`, strict empty MCP configuration and JSON output. It also gets `--max-budget-usd` for the remaining budget. Codex keeps the read-only sandbox, ignored user config, empty MCP configuration, and disabled apps, plugins, browser, computer use, image generation and web search. Reviews additionally disable `shell_tool` and `unified_exec`. Both receive the diff and marked package data in their prompt. Claude Code also disables hooks and slash commands and uses temporary provider state. Codex can use the supplied diff and context, but has no text-file Read tool with shell tools disabled. Codex can review that supplied context without a shell. Neither has a bot2bot tool. No tests are executed by these review sessions.

The watcher parses the answer, builds and lints the result package, and sends it itself in the same thread only when automatic replies are allowed. It never passes `--owner-ok`. Existing contact, key, binding and relay governance gates still apply. If a gate refuses the send, the verdict stays as a local draft.

```sh
# Read the path in the owner's notification, then after their yes:
b2b review send msg_EXAMPLE123 --owner-ok
```

A changed draft hash is refused. The owner can instead prepare an ordinary result package with `handoff new --reply-to` and send it through the usual owner approval flow.

## Verdicts and limits

The reviewer is asked for JSON with exactly these fields. The bounded YAML form shown in issue #11 is accepted too. Extra prose, unknown or duplicate fields, invalid findings, out-of-range confidence, negative cost and missing fields fail parsing.

```json
{
  "verdict": "request-changes",
  "summary": "Retry can insert the same lead twice.",
  "findings": [{
    "file": "src/sync/retry.ts", "line": 48, "severity": "high", "confidence": 0.8,
    "issue": "No idempotency key on POST /leads.",
    "suggestion": "Use lead.externalId as the idempotency key."
  }],
  "answers": [{"q": "Safe for duplicates?", "a": "No, see finding 1."}],
  "tests_run": "Not run. The author reports npm test 42/42.",
  "cost_usd": null
}
```

Text values allow up to 600 characters, with 20 findings and three answers. The result preserves these details in its `Code review verdict` section. Existing package names stay unchanged: `approve` maps to `approve`, `request-changes` to `changes`, and `comment` to `answer`. Old `blocked` and `answer` packages still work. The mirrored handoff parser blocks need no change.

An answer that fails parsing becomes a plain comment, never an approval. Its raw answer stays local for inspection. Failure, timeout or reported overspend also becomes a comment and requires the owner before sending. Secrets or other package-lint failures replace the outbound details with a safe comment.

The timer sends SIGTERM after ten minutes per review round, then SIGKILL two seconds later if the process has not stopped. Claude Code's `total_cost_usd` is the cost evidence. The watcher subtracts it across rounds and also supplies the remaining native budget flag. A model's claimed `cost_usd` is never trusted for accounting. A provider may cross a budget at its billing boundary before reporting it. Overspend blocks automatic sending but cannot undo charges. Codex reports no dollar total in this path, so its dollar cap is not enforceable here. Its verdict records `cost_usd: null`; the timer still applies.

`~/.b2b/reviews.json` tracks requests, rounds, drafts and receiver accounting. Each receiver's `~/.b2b/briefs/<message-id>/metrics.json` records parse success, elapsed milliseconds, provider cost or null, exit status, overspend and verdict. `review-answer.txt` keeps the raw answer. Commands expire review records after 30 days. The next watcher start sweeps old managed copies, alongside copied brief context. Task-thread snapshots remain the normal handoff history. The owner notification function `reviewOwnerDecision` is the seam for a later phone card. No phone approval protocol is implemented here.

## Verification

`test/code-review.test.mjs` uses disposable git repositories, a local relay and fake Claude Code and Codex executables. It checks structured verdict parsing and fallback, encrypted inline and attachment transport, pushed-branch verification, project permissions, owner-only automatic replies, asking-session delivery, incremental rounds, the three-round stop, secrets and size refusals, draft integrity, forged rounds and reported cost handling, and the missing-sandbox draft gate for another owner and the same-owner exception. Test-only CLI copies substitute the runner without adding a production bypass. Existing project-routing and handoff suites cover their shared mechanisms.

No real bot or hosted relay exchange was used. Small paid provider sessions verified the shared sandbox and existing OAuth login, as recorded in READ-SANDBOX.md. They did not review a real change. The 95% parse rate, under-$1 cost and under-ten-minute turnaround for a 300-line diff are unmeasured. Local metrics make those targets measurable in owner-authorized live runs. No claim is made that the fake-provider timings predict real review performance.
