# Cross-owner questions and contract reviews

A private-mode contact can ask your bot a question about a registered project. Your machine decides whether to answer and which files the answering session can read. Only questions explicitly addressed to a project use this policy. Without a policy for that contact and project, no answering or plan-only session starts. The question stays in your local audit, and your next session gets a notice. Ordinary questions, topic permissions and baskets keep their existing behavior.

This builds on topic questions, the project registry, the watcher's plan-only commands, owner-okay requests and handoff threads. It does not grant a contact permission to send implementation briefs to a project. `project allow` and the receiver policy serve separate purposes.

## Set a local policy

Register the project, then save a JSON policy. JSON keeps the CLI dependency-free. Only an attended owner session can set or remove policies.

```sh
b2b project add partner-api ~/code/partner-api
b2b question-policy set anna policy.json
b2b question-policy list
b2b question-policy remove anna
```

`policy.json`:

```json
{
  "may_ask_about": [
    { "project": "partner-api", "paths": ["docs/**", "openapi.yaml"] }
  ],
  "mode": "draft",
  "never_share": ["docs/internal/**", "customer data/**"],
  "budget_usd": 2,
  "rate_limit": 20
}
```

The policy is per contact in `~/.b2b/question-policies.json`. Its project names must already exist in `projects.json`. Paths support `*`, `**` and `?`, relative to that project's folder. Absolute paths and `..` are refused. A question without a project never uses this policy, even when it names only one project.

- `draft` is the default. The watcher saves the answer as an existing `propose` / `request` owner-okay draft. Your next session gets its request ID. Review it, then use `b2b request <id> --approve` or `--decline`. A watcher run cannot make that decision.
- `auto` sends a checked answer marked `auto`, but only for an allowed topic and when your existing basket rules permit it. Otherwise it creates a draft. On governance-enabled accounts, add the topic on the contact's dashboard first, then run `b2b allow anna "api"` to record the local topic permission. The CLI cannot widen dashboard permissions itself. Removing the topic or tightening the basket rules before the answer is sent withholds it.
- `forward` starts no answering session and saves the question for you.

The sender uses the existing question command:

```sh
b2b send anna/partner-api "Does /v2/leads accept 500 leads? Which auth header?" --ask --topic api
```

`notifyQuestionOwner(job, reason, request)` is the phone-card integration seam. Today it uses `saveForOwner`; it does not require the separate phone-approval feature.

## What the answering session can read

The ordinary agent wake runs `readInbox`. Its code recognizes a scoped question before project routing or session routing, saves it to the local question queue and acknowledges it. The agent sees no question text. The watcher picks up queued questions after the wake finishes. There is no watcher inbox preflight or cached substitute inbox. Attended inbox reads use the same queue. It resolves globs inside the registered folder and copies matching regular files into a fresh temporary folder. It follows no symlinks, refuses hard links or a file that changed identity while opening it. Files outside the policy never enter the snapshot.

The built-in exclusions include `.env`, `.env.*`, key files, `.ssh`, `.git`, credentials, `secrets`, customer-data folders, and agent configuration such as `AGENTS.md`, `CLAUDE.md`, `.claude` and `.codex`. Built-in exclusions ignore case. Your `never_share` globs add exclusions. Binary files and files matching the existing handoff secret detector are also skipped. The detector cannot recognize every secret, so allow only files you intend to share. A snapshot is limited to 500 files and 5 MB, with a 1 MB limit per file.

A temporary working directory alone is not a read boundary. The answering session uses the shared [read sandbox](READ-SANDBOX.md), with only the filtered snapshot as its project read root. Its files cannot read through symlinks into the original project. Writes go only to a private temporary provider home. The OS refuses shell execution.

Claude Code uses plan mode, Read/Grep/Glob, strict MCP configuration and JSON output. Hooks and slash commands are disabled. A temporary `CLAUDE_CONFIG_DIR` receives only the normal login's OAuth record and account metadata. The trusted watcher obtains that record through macOS Keychain or the provider's credential file. It copies neither MCP credentials nor project history. Codex uses a temporary `CODEX_HOME` containing only `auth.json`, with user config ignored and connected tools and shell tools disabled. The original provider homes stay unreadable to both children. Credential copies themselves are readable within the child, so this is not isolation of a provider from its own credentials.

Codex has no text-file Read tool with these flags. The watcher supplies the filtered file contents as marked source data in the prompt, limited to 60 KB. Larger snapshots are refused. Its native runtime and bundled code-mode helper are explicitly allowed; the whole installation or user home is not.

Both providers authenticated in small logged-in macOS runs. See the shared sandbox document for exact runtime allowances and the limits of that evidence. No API key is required for the tested OAuth installs. Custom login stores and provider layouts may fail closed. Linux and Windows have no supported OS read sandbox here, so scoped questions wait for the owner without an answering run. There is no unsandboxed fallback for questions.

The prompt marks the question and file contents as untrusted data. No bot2bot command is available to the answering session. The watcher takes its structured answer and handles sending or approval.

## Answer checks, limits and audit

The answer must name at least one file from the snapshot. Code rejects unknown citations, detected secrets, answers longer than 20 lines, and lines over 500 characters. This bounds even unfenced source dumps. It cannot prove the answer used its citations correctly or recognize every paraphrase and inline source fragment. Invalid output is withheld rather than partially sent.

The local daily counter counts distinct incoming questions per contact on a UTC day, including forwarded questions. Replay of the same message does not count twice. At `rate_limit`, subsequent questions start no answering run. Policy changes do not reset the day's counters. State writes use the existing cross-process lock.

Claude's `total_cost_usd` is recorded, and `--max-budget-usd` receives the remaining daily allowance. A run with unknown cost or an answer over budget is withheld; unknown cost blocks later paid runs that day. A crashed run leaves an unsettled reservation, preventing another run from spending against the same allowance. The provider may overshoot its own limit by one in-flight request; this is not a payment-provider spending cap.

Codex does not report an equivalent dollar cost. A Codex answering policy must explicitly set `"budget_usd": null`, keeping the daily question cap. A finite dollar budget starts no Codex answering session. Unknown costs are `null`, never reported as zero.

```sh
b2b question-audit
b2b question-audit @anna --json
b2b question-audit msg_EXAMPLE123
```

`~/.b2b/question-audit.json` keeps the sender's question, the receiver's decision and refusal reason, generated and sent answers, citations and known cost. The receiver keeps local refusals and draft outcomes. Once a reply arrives, the sender records the answer, citations and peer-reported cost. A forwarded or locally refused question sends no automatic refusal message; its reason is available only in the receiver's audit until their owner replies. An audit entry is not proof of a remote model's cost. Audit files have owner-only permissions and no automatic retention deletion yet; they contain message content after relay messages expire.

Private-mode questions, project names, answers, citation/cost fields and contract decisions travel inside the sealed payload. The relay sees routing and ciphertext. Old clients ignore the additional sealed field. Scoped answering and contract decision metadata require private mode on both sides. Existing governance draft previews are plaintext to the relay so the owner can review them, as with `propose` today. The final private-mode reply is end-to-end encrypted. Do not use draft mode if that preview exposure is unacceptable.

## Contract changes

Create an existing handoff package with `ask: review` and a fresh thread. Include a unified patch in a fenced `diff` block inside the package. No attachment path from the sender becomes a local path or command.

```sh
b2b handoff new --to anna --ask review --title "Add source to Lead"
# Fill the package and include the patch. Review it with your owner.
b2b contract propose anna/partner-api handoff.md --owner-ok
```

Contract packages use the existing inline handoff transport, so they must fit the 8,000-character message limit. The receiver checks impact in the same isolated snapshot and drafts a result package. The verdicts map to existing handoff verdicts: `accept` to `approve`, `accept with change` to `changes`, and `reject` to `blocked`. A reason belongs in the findings. Contract results always wait for owner approval, even under an auto question policy.

A forwarded proposal can be reviewed in the owner's own session. Send the reviewed result with:

```sh
b2b handoff new --reply-to msg_EXAMPLE123
# Fill the result package, with approve, changes or blocked and a reason.
b2b contract result msg_EXAMPLE123 result.md --owner-ok
```

After the result is sent and received, each owner reads the thread and signs the exact agreement:

```sh
b2b thread show t_EXAMPLE123 --brief
b2b contract status t_EXAMPLE123
b2b contract signoff t_EXAMPLE123 <agreement-sha256-from-status>
```

Each owner runs `signoff` on their own machine in an attended session. It records an explicit event and sends the signed, sealed decision to the thread's peer. A third contact cannot add a sign-off to that pair's thread. The agreement digest binds the exact proposal bytes and the exact result text. A changed result invalidates earlier sign-offs. Rejected results cannot be signed. A revised proposal needs a fresh thread.

`contract status` says not to merge until it has both sign-offs. For `accept with change`, both owners are approving the proposal together with the amendments in the result. Both still inspect and test their final edits. This is a decision record, not Git branch protection: the CLI never applies patches or invokes a merge, and cannot stop an owner merging outside bot2bot. A peer sign-off authenticates the peer bot's key and its claim that its owner approved, not an independent human signature.

## Verification

`test/cross-owner-questions.test.mjs` uses the real CLI and a local relay with pretend owners and fake agents. It exercises hostile questions against code-enforced boundaries: no policy, out-of-policy files, secret exclusions, symlinks, OS-denied absolute reads and shell execution, daily limits, source-length checks, citation validation and owner-only commands. It also covers sealed auto answers, approval drafts, both local audits, known and unknown costs, Codex count-only operation, and the complete contract/sign-off exchange without changing the source file.

These tests establish deterministic code behaviour for those cases. They do not establish 100% model refusal, factual answer quality, or a real two-machine exchange. Separate tiny live runs verify provider startup and authentication, as described in READ-SANDBOX.md. A full two-machine exchange and representative model red-teaming still require an authorized live run under [Testing with bots](../TESTING.md).
