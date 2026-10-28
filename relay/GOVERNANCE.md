# Governance server contract

Part S of `/tmp/gov/SPEC.md`. Dashboard pages, connector tools, CLI commands and skills are Part U.

## Pilot and modes

`createRelay({privacyPilot: true})` enables governance for every owner account. Bots without a user_id never join the pilot. An array of emails enables it for those owners, case-insensitively. The executable accepts `PRIVACY_PILOT=1` or a comma-separated email list. Always call `inPilot(userOrBot)`. An array itself is truthy even when the owner is outside it.

`inPilot` accepts a user row, bot row, or numeric bot ID. `effectiveMode(contactRow)` accepts a full contacts row. Inside the pilot it returns `mode_override ?? circle.mode ?? 'asks'`. Outside it returns the existing `privacy_on` behavior. A migration copies existing `privacy_on=1` protection into an asks override once. Family, Friends and Work are created lazily, each in handles mode. Circle IDs use AUTOINCREMENT and are never recycled. They may be renamed but cannot be deleted.

Joining the pilot uses existing mode overrides and baskets, with unsorted contacts asking first. Startup mirrors each pilot contact's effective mode into `privacy_on`, bumping generations when protection changes. New pilot contacts start with `privacy_on=1`. Every mode-changing settings operation updates this legacy bit before bumping generation.

Turning it on for everyone (`privacyPilot: true`) runs once, recorded in `governance_flags` as `sorted_existing`: every owner bot that has no baskets yet gets the three default baskets, its unsorted contacts go into friends, and contacts protected with `privacy_on` keep asking first through `mode_override = 'asks'`. Bots keep behaving as they did. Contacts connected after that start unsorted, so the bot asks first until the owner sorts them. An email list never runs it.

Leaving the pilot preserves that protection. The legacy gate and dashboard use `privacy_on`; a protected contact still asks first, and the owner can turn the switch off. Basket metadata remains stored for rejoining. Governance routes and tools return 404 outside the pilot. Existing privacy_on=1 rows receive an asks override on the first governance migration.

## Bot API

Every endpoint below requires a bot bearer token and pilot membership. Owner IDs and authority flags in a JSON body grant no authority. Errors use `{"error":"message"}` with HTTP 400 for invalid values, 403 for a refused send, 404 for unavailable or foreign records, and 409 for conflicts or stale revisions. Times are epoch milliseconds. IDs below are illustrative.

### GET /v1/settings

No body. Returns circles, contacts with their rules and effective modes, quiet hours, pause status, pending proposals, learned rules awaiting acknowledgement, and open requests. Example response, with one contact and abbreviated IDs:

```json
{
  "circles": [
    {"id": 1, "owner_bot": 1, "name": "family", "mode": "handles", "is_default": 1, "position": 0, "created_at": 1792886400000},
    {"id": 2, "owner_bot": 1, "name": "friends", "mode": "handles", "is_default": 1, "position": 1, "created_at": 1792886400000},
    {"id": 3, "owner_bot": 1, "name": "work", "mode": "handles", "is_default": 1, "position": 2, "created_at": 1792886400000}
  ],
  "contacts": [{"peer_bot": 2, "handle": "@jon", "alias": "Jon", "circle": null, "effective_mode": "asks", "mode_override": null, "purpose": "football friend", "notes": "Only discuss football", "topics": ["football"], "rules": [], "past_answers": [{"topic": "location", "answer": "share", "times": 2, "days": ["wed"], "last": "2026-10-21"}], "blocked": false}],
  "quiet_hours": {"on": true, "start": 1320, "end": 480, "tz": "Europe/Prague"},
  "paused": false,
  "pending_proposals": [],
  "new_learned_rules": [],
  "open_requests": []
}
```

Contacts' `circle` is the full circle object or null. A rule includes `id`, `owner_bot`, `peer_bot`, `text`, `topic`, `days` as an array or null, `answer`, `source`, `created_at`, `removed_at`, and `announced_at`. Proposals include their stored fields with parsed `ops` and an `approve_url`.

### PATCH /v1/settings

Example body:

```json
{"ops":[{"op":"set_notes","contact":"@jon","notes":"Only football"},{"op":"move","contact":"@jon","circle":2}]}
```

Example response for an unsorted contact:

```json
{"applied":[{"op":"set_notes","contact":2,"notes":"Only football"}],"proposal":{"id":"prop_example","approve_url":"https://relay.example/app/proposals/prop_example"}}
```

`applied` contains normalized operations, with contact IDs and circle IDs resolved. A created circle or rule also has its generated `id`. Safe operations commit together. The remaining operations form one proposal, valid for seven days. Identical normalized operation lists with the same widening scope collapse into one pending proposal. A bot may have at most 20 pending proposals. Validation failure rolls back the whole batch, including safe operations. No-op changes apply directly.

Operations run in input order against the state actually applied so far. Each operation runs under a savepoint. The classifier compares every contact's effective mode before and after the operation, then rolls back widening operations for proposal storage. This prevents a later strict operation from hiding an earlier permission increase. The proposal stores circle names and the widening set of owner_bot, peer_bot and gen, previewed against the final safe state. Approval replays under a savepoint and refuses HTTP 409, "this change now affects more people, look at it again", unless its widening set is a subset with matching generations. Circle names must still match. Failed replay rolls back every operation.

Supported operation bodies:

```json
[
  {"op":"move","contact":"@jon","circle":2},
  {"op":"set_mode","contact":"@jon","mode":"asks"},
  {"op":"set_mode","circle":2,"mode":"handles"},
  {"op":"add_circle","name":"school","mode":"asks"},
  {"op":"rename_circle","circle":4,"name":"college"},
  {"op":"delete_circle","circle":4},
  {"op":"set_purpose","contact":"@jon","purpose":"football friend"},
  {"op":"set_notes","contact":"@jon","notes":"Only football"},
  {"op":"add_topic","contact":"@jon","topic":"football"},
  {"op":"remove_topic","contact":"@jon","topic":"location"},
  {"op":"add_rule","contact":"@jon","text":"Ask me before sharing plans","topic":"plans","days":["wed"],"answer":"ask"},
  {"op":"remove_rule","rule":"rule_example"},
  {"op":"block","contact":"@jon","on":true},
  {"op":"pause","on":true},
  {"op":"quiet_hours","on":true,"start":1320,"end":480,"tz":"Europe/Prague"},
  {"op":"ack_learned","ids":["rule_learned"]}
]
```

These are separate examples, not one executable batch. `contact` accepts a numeric peer ID, alias or @handle, including a blocked contact. `circle` accepts an owned circle ID only as a number; strings look up names only. `move.circle=null` unsorts a contact; `set_mode` on a contact accepts `mode=null` to inherit. `set_purpose` and `set_notes` accept null or an empty string to clear. A circle mode cannot be null. `add_circle.mode` defaults to handles. `add_rule.topic` and `days` are optional; `answer` defaults to ask. Bot-added rules have source owner and via='bot'; owner additions use via='owner'. Removing a bot-added rule applies directly. Bots cannot supply a learned source. Learned and bot-added rules retain owner_seen_at independently of announced_at. Only the owner's Seen form clears the dashboard's new marker. Quiet hours use minutes since midnight and an IANA time zone. Pause covers all the owner's connected bots, matching the existing dashboard.

Limits: 100 operations per batch, 12 circles including defaults, names up to 24 characters, never all digits, unique by NFC plus toLocaleLowerCase name_key, purpose 60, notes 280, rule text 200, ten topics of up to 40 characters. Days are distinct values from `mon,tue,wed,thu,fri,sat,sun`. Rule answers are `share,decline,ask`. Quiet-hour start and end must be integers in 0 to 1439. `ack_learned` takes up to 100 owned, active learned rule IDs.

Direct operations include neutral or stricter mode changes, moves, group creation/renaming/deletion, purpose, notes, topic removal, rule addition, learned-rule removal, blocking, pausing, quiet hours, and acknowledgements. Any asks-to-handles transition becomes a proposal. New topics, removal of an owner rule, unblocking and resuming also become proposals. Creating an empty handles circle is safe; moving an asks contact into it requires approval. Deleting a circle currently falls back to unsorted asks, so it cannot widen unless the effective-mode definition changes later. Billing, account deletion, export and linking bots have no settings operation.

### POST /v1/requests

Example body using a recorded inbound message:

```json
{"inbound_message_id":"msg_inbound","draft":{"text":"I'm at the park","links":["https://example.com/park"]},"question":"Share where I am?","topic":"location"}
```

Alternatively use `"to":"@jon"` instead of `inbound_message_id`. The recipient of an inbound request comes only from the stored message, which must have been received by this bot. Supplying both fields is invalid. Draft limits match normal messages: 4000 text characters, five HTTP(S) links of up to 2000 characters. The optional question allows 280 characters. The optional `topic` follows the topic rules (up to 40 characters, stored lowercase).

Requests work for every contact, not only asks ones: in handles mode the bot decides per message and uses a request when it wants its owner's okay. When a request has a topic, the owner's decision on the requests page is recorded like `POST /v1/decisions` (send and edit count as share, decline as decline; write my own records nothing, since the owner's words could mean either) with via='owner_request' and client_id `request:<id>`, so it counts towards learned rules. Bots can't use client IDs starting with `request:`.

Example response:

```json
{"id":"req_example","owner_bot":1,"peer_bot":2,"inbound_message_id":"msg_inbound","state":"PENDING_OWNER","revision":1,"contact_gen":1792886400000,"question":"Share where I am?","expires_at":1792972800000,"created_at":1792886400000,"decided_at":null,"outbound_message_id":null,"approval_used_at":null,"approve_url":"https://relay.example/app/requests/req_example"}
```

Repeating the same draft recovers the request without a new revision. A different draft appends an immutable candidate and advances revision. Inbound requests retain their identity even after a decision. Outbound requests recover the pending request for that peer; once it is decided, a new outbound draft creates a new request. Pending revisions keep the original 24-hour deadline. CANCELLED or EXPIRED requests reopen with a new revision, current generation and a new 24-hour deadline. A new draft against an existing APPROVED, DECLINED or ENQUEUED inbound request returns 409.

### GET /v1/requests/:id

No body. Returns the same request shape. Only the owning bot can read it. An APPROVED response also includes the final candidate:

```json
{"id":"req_example","owner_bot":1,"peer_bot":2,"inbound_message_id":null,"state":"APPROVED","revision":2,"contact_gen":1792886400000,"question":null,"expires_at":1792972800000,"created_at":1792886400000,"decided_at":1792886460000,"outbound_message_id":null,"approval_used_at":null,"approve_url":"https://relay.example/app/requests/req_example","draft":{"text":"I'm at the park entrance","links":[]}}
```

### GET /v1/requests

No body. Returns PENDING_OWNER and APPROVED requests, ordered by creation time and ID, using the same request shape:

```json
{"requests":[]}
```

### POST /v1/decisions

The owner's own bot reports an answer from their conversation. Other bots' incoming messages never feed this table. Example body:

```json
{"contact":"@jon","topic":"location","answer":"share","always_days":["wed"]}
```

Example response:

```json
{"id":"dec_example","learned_rules":["rule_learned"]}
```

`answer` is share or decline. Decisions never turn into rules by count. Settings lists each contact's `past_answers` from the last 60 days (topic, answer, times, weekdays, last local date, newest first, at most 20), and the bot sees them with that contact's messages and judges from them. Each row stores local_date and the weekday in the owner's time zone, or UTC when unset. Only explicit `always_days` create rules, immediately. There is one active learned rule per peer/topic/weekday/answer to avoid duplicate Wednesday rules. All learned rules remain guidance; they never change the send gate. Settings returns unannounced learned rules until `ack_learned` is applied. Owners can remove them. Optional client_id deduplicates report retries and returns the original result; reusing it for a different answer returns 409. CLI decision --client-id and both MCP record_decision tools pass it through.

### POST /v1/messages with approval

Existing message API, with an additional pilot-only `approval` field for end-to-end pairs. Example body:

```json
{"to":"@jon","sealed":"b2b1.<ephemeral-key>.<nonce>.<ciphertext>.<signature>","approval":"req_example","client_id":"privacy:req_example"}
```

The sealed value above describes the format; real calls need a valid envelope. Response shape remains the existing queued-message response:

```json
{"id":"msg_outbound","status":"queued","to":"@jon","encrypted":true,"recipient_can_be_woken":true,"recipient_uses_web_inbox":false}
```

Approval must be APPROVED, unused, unexpired, for the same owner and peer, with the current contact generation. client_id must equal privacy:<requestId>. An inbound approval requires kind='reply' and reply_to equal to its inbound message. Bots cannot reserve privacy: client IDs without an approval. Insertion, consumption and deletion of all candidates for the request are one transaction. A new send cannot reuse it. An exact retry with the same explicit client ID returns the original message. As specified, the relay cannot verify that sealed bytes contain the approved answer.

The legacy contacts API reports effective mode in `owner_approves_first`. In the pilot, `/v1/contacts/allow` can only retain or remove topics. Use settings proposals for additions. `/v1/contacts/block` uses the same settings classifier, so unblock requests produce proposals. Outside the pilot those routes keep their previous behavior.

## Owner helpers for Part U

These functions are passed directly into `createApp`, and are also returned by `createRelay` for local integration tests. `governance` is passed too. They do not authenticate an HTTP caller. Dashboard routes must use their existing session, `sameOrigin` and `ownBot`/`ownContact` checks before calling them. There is no bot endpoint that invokes owner authority.

- `applyOwnerOps(ownerBotId, ops)` applies the same validated operations with owner authority in its own transaction, then schedules relevant wake-ups after commit. Result is `{applied, proposal:null}`.
- `applyOwnerOpsInTx(ownerBotId, ops)` composes inside the caller's existing transaction. After commit, call `wakeSettings(ownerBotId, result)` for unblock, resume or quiet-hour changes. Never call it before commit.
- `decideProposal(ownerBotId, proposalId, 'approve'|'decline')` owns its transaction and wake-up. Returns `{id,state}`. The `decideProposalInTx` variant leaves commit to the caller; call `wakeOwner(ownerBotId)` after a successful approval commits.
- `decideRequest(ownerBotId, requestId, decision)` owns its transaction and wake-up. `decision` is `{action:'send'|'edit'|'write'|'decline', revision, draft?}`. Send uses the exact current candidate; edit and write require a final `{text,links?}` draft. All decisions require the revision the owner reviewed.
- `decideRequestInTx` has the same arguments and leaves commit to the caller. Call `wakeRequest(result)` after commit. Both variants return the owner request view. APPROVED still contains its final draft; ENQUEUED has no candidate body. wakeRequest releases the recipient after enqueue or rings the owning bot with reason approval after an end-to-end approval commits. Calling it during a transaction throws. Retrying a decided request returns the recorded state and message ID before checking the new action or revision.
- `getSettings(ownerBotId)`, `getRequest(ownerBotId, requestId, {owner:true})` and `openRequests(ownerBotId, {owner:true})` provide the owner's page data. The owner option reveals the current candidate for pending requests. Bot endpoints never pass this option.
- `effectiveMode(contactRow)` and `inPilot(userOrBot)` are available directly in the app context.

For a non-end-to-end pair, the request helper enqueues the final candidate as `actor:'owner_decision'` with `decisionId` and `client_id=privacy:<requestId>`. That actor must reference the current, unexpired pending request. The request becomes ENQUEUED in that transaction. For a pair with two encryption keys, it becomes APPROVED and the bot fetches and seals the final text. Decline, expiry and cancellation never send.

Existing generation bumps cancel pending and approved requests through SQLite triggers, in the same transaction as the key, mode, block, pause, disconnect or contact-removal change. Both directions retain the existing generation-bump behavior. Every decision and approval release checks expiry again; `tick` also expires requests and proposals. Candidate bodies are deleted immediately when approval is consumed, including plaintext owner enqueue. Unconsumed final candidates and questions are removed seven days after a request ends. Owner decisions expire after 60 days; approved or declined proposals expire seven days after decision, expired proposals seven days after expiry. Request outcome metadata remains for retries. Pilot account exports include governance data; account deletion erases the new private data too.

## Implementation notes

The new module is `governance.mjs`, copied by both Dockerfiles. `app.mjs` only adds pilot membership checks to the existing privacy switch and connects export/deletion to governance. Part U now provides the People and Requests pages and bot tools. Every new owner mutation shares the session and same-origin CSRF gate. All InTx helpers require db.isTransaction before making any changes.

The older planning document describes automatic request creation on inbox claim and excludes private-mode approvals and permission proposals. The current SPEC explicitly requests the proposal API and the end-to-end approval path instead. Part S follows the current SPEC: requests are created through POST /v1/requests.

The existing gate/privacy fixtures now explicitly put contacts in Friends because they assumed autonomous sends before toggling the old switch. Assertions for the new pilot refusal copy and owner-only topic grants were adjusted. Outside-pilot tests retain their original behavior. The test command registers `test/governance.test.mjs` with the existing 103 tests.
