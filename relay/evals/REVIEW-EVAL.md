# Issue #11 live review eval

2026-11-20. macOS arm64, bot2bot CLI 0.29.0, Claude Code 2.1.311 and codex-cli 0.170.0. Both reviewers used their normal OAuth logins through the read sandbox. Codex used ChatGPT sign-in.

Run from the repo root with Node 24 or newer and both provider CLIs installed.

```sh
node relay/evals/review-eval.mjs 10 both
node relay/evals/review-eval.mjs 1 both --ring
```

The fixture adds 291 lines for invoice webhook delivery. A is the missing idempotency header on retried POSTs. B is the loop bound that skips the last leased item in each batch. A finding counts when it identifies the matching problem in the affected file.

Two temporary bots had distinct local owners and separate home directories. Requests and verdicts traveled as encrypted attachments over a loopback relay with a temporary database. The benchmark ran the reviewer's unattended inbox command before starting the watcher to keep generic wake turns out of the timing and cost. The doorbell checks let the real provider claim the request on a ring. In both cases the author issued a single CLI command with an explicit session ID. A different session then claimed the reply to verify it was queued for the asking session, where the eval read and validated it. Turnaround starts at `review request` or `review update` and ends when that session reads the verdict.

## Criteria

| Criterion | Result |
| --- | --- |
| One author command, verdict in that session, no owner forwarding | Met locally. 20/20 requests, 1/1 update and 3/3 doorbell checks reached only the asking session. |
| At least 95% of verdicts parse | Met. 24/24 scored verdicts parsed in the documented JSON shape. |
| A ~300-line diff costs under $1 and returns in under 10 minutes | Claude met both targets. Ten benchmark requests cost $0.153–$0.177 each and took 37.2–46.3 s. Codex benchmark requests took 23.7–36.1 s. Codex reported no USD cost, so its cost target remains unverified. |

## Benchmark requests

| Run | Codex → Claude parsed | Seconds | USD | Bugs | Claude → Codex parsed | Seconds | USD | Bugs |
| ---: | :---: | ---: | ---: | :--- | :---: | ---: | ---: | :--- |
| 1 | Yes | 37.2 | 0.153 | A, B | Yes | 30.9 | — | A, B |
| 2 | Yes | 46.3 | 0.169 | A, B | Yes | 29.9 | — | A, B |
| 3 | Yes | 45.5 | 0.161 | A, B | Yes | 34.2 | — | A, B |
| 4 | Yes | 43.2 | 0.168 | A, B | Yes | 36.1 | — | A, B |
| 5 | Yes | 45.8 | 0.177 | A, B | Yes | 27.7 | — | A, B |
| 6 | Yes | 43.4 | 0.173 | A, B | Yes | 30.8 | — | A, B |
| 7 | Yes | 37.5 | 0.156 | A, B | Yes | 32.1 | — | A, B |
| 8 | Yes | 43.4 | 0.164 | A, B | Yes | 25.5 | — | A, B |
| 9 | Yes | 38.5 | 0.164 | A, B | Yes | 23.7 | — | A, B |
| 10 | Yes | 40.3 | 0.161 | A, B | Yes | 30.6 | — | A, B |

## Update and doorbell checks

| Run | Parsed | Seconds | Review USD | Bugs |
| --- | :---: | ---: | ---: | :--- |
| Codex → Claude, update after adding the idempotency header | Yes | 20.3 | 0.126 | B |
| Codex → Claude, real doorbell | Yes | 46.3 | 0.162 | A, B |
| Claude → Codex, real doorbell | Yes | 45.3 | — | A, B |
| Claude → Codex, final eval script with real doorbell | Yes | 47.6 | — | A, B |

The update used the original thread. Claude reported $0.279 across its two rounds. Claude's reported review subtotal was $2.109 including the doorbell review and a $0.175 pilot that parsed and found A and B before an eval attachment assertion aborted verification. Two earlier Claude starts reported $0 when the temporary home changed the Keychain lookup. The Claude wake turn and all Codex turns had no reported USD figure.

Eval fixes covered OAuth staging, checking the saved attachment in the author's thread and draining open relay requests before closing SQLite. No review implementation changes were needed. `npm test` in `relay` passed 543 tests with one skip. Interactive author hooks and delivery across two real machines remain to be tested.
