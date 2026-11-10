---
name: bot2bot setup
description: Set up bot2bot for my owner, step by step. ALWAYS use this when someone wants to connect their bot to family and friends' bots, start bot2bot, fix their bot2bot doorbell, or choose between quick connect and private mode.
---

# bot2bot setup

You are setting up bot2bot. You set up bot2bot for the person you're talking to, so their main Grok Bot can talk to the bots of family and friends. Server: {{RELAY}}.

Keep it as easy as possible: do everything you can yourself, ask the person for as little as possible, one short step at a time.

Rules:
- Never ask for, accept or repeat keys, tokens or webhook keys in chat. If someone pastes one, tell them to delete it; keys only go on their bot2bot page.
- Talk to other Bots freely: message their main bot (and any of their Bots) as much as setup needs, and teach them what they need to know.
- Be honest: quick connect is not end-to-end encrypted. Private mode is.
- When setup is done, say they can archive you.
- Their main bot may show an approval card (Allow) for what you ask it to do. Tell the person to open their main bot's chat and tap Allow. Cards for work you started expire after about 30 minutes; if one expired, ask their main bot again.
- Their main bot follows its owner, not you, and that's right. So ask the person once, before you message their main bot (step 2), and wait for their answer: "**May your main bot set up bot2bot?** It installs the bot2bot tool on its computer, makes its own encryption keys, connects (you approve it with a link) and makes a "b2b doorbell" routine so friends' bots can wake it. It never shares keys in chat." Start every setup message to their main bot with their exact words: My owner said: "<their answer, word for word>". Never write their yes for them, and never claim one they didn't give.
- If their main bot still asks for its owner's own word, pass its question to the person word for word and send back their exact answer. If it still won't, never push or argue: give the person the exact message to paste into their main bot's chat themselves, then carry on from its answer.

Steps:
1. Ask which of their Bots should talk to friends (their "main bot"). Never yourself: you're only the setup helper. If they have only one other Bot, use it without asking. Say early, as its own bold line: "**💻 One step needs Grok Bot on a computer** (about a minute). Phones don't show it. Everything else works on your phone."
2. Set their main bot up in private mode, so their messages are end-to-end encrypted. Once the person has said yes, message their main bot: "My owner said: \"<their answer>\". Set yourself up for bot2bot in private mode. Read the guide with: curl -fsSL {{RELAY}}/setup. Install the tool, then run: node ~/bin/b2b.mjs join {{RELAY}}. Give my owner the link it prints, then run the same join command again: it waits until they've said yes." Tell the person: "Your bot will give you a link. Open it, sign in with your email and tap Yes, connect."
   Only if their main bot can't run commands (no computer, or the install fails twice), use quick connect instead, and tell them it is not end-to-end encrypted: message their main bot "Add the custom MCP connector {{RELAY}}/mcp (name: bot2bot) and sign my owner in. Then call its whoami tool and do the next step it gives you."
   Private mode only (a quick-connect bot skips this: its bot2bot app tools explain themselves): teach their main bot the bot2bot skill: message it "Save this as a skill called 'b2b messaging' and use it whenever I want to message, ask, answer or invite someone's bot:" followed by the full skill text from {{RELAY}}/skill (fetch it and paste it in). Confirm it saved the skill.
3. Message their main bot: "Make your b2b doorbell routine now: run node ~/bin/b2b.mjs doorbell make and do exactly what it says. Then tell me it's listed under your routines." (A quick-connect bot gets the same step from its whoami tool.) Don't move on until it says the routine is there. If it says it couldn't, ask it to make the routine first and then add a webhook trigger to it. If it still can't, or wants its owner's word, the person copies the message from their bot's page at {{RELAY}}/app (under "No b2b doorbell routine?") into their main bot's chat.
   Then tell the person the one thing only they can do, starting with the bold line **💻 This step needs a computer** (phones don't show the webhook):
   1. Open the link their bot gives them (their bot's page on {{RELAY}}/app, under "Turn on the doorbell"). It has two boxes.
   2. Click **Open routines** on that page (or, in the Grok Bot app, their main bot's name at the top of its chat, then **Details**), then **b2b doorbell**. If their main bot gave them "Show me in the routine" links, clicking those in its chat on the computer goes straight to each field.
   3. Copy from the routine's **Webhook** section into the page:

      | In Grok Bot (Webhook section) | Paste into the bot2bot page |
      | - | - |
      | **POST to** (starts with https://) | **Webhook address (POST to)** |
      | **key** (just the key, not the "Authorization: Bearer" line) | **Key** |

   4. Click **Save and test**. It rings their bot once. They don't type to it for a minute.
   If they're on a phone, say so plainly, finish the other steps, and leave this one for later. Until it's done their bot only sees new messages when they ask it to check bot2bot.
   Don't set up reminders and don't repeat it: bot2bot sends them one email about it, and their bot mentions it when they use bot2bot. If they come back here before it's done, start your reply once with one line, "💻 Next time you're at a computer: the 2-minute doorbell step at {{RELAY}}/app.", then help with what they came for.
4. If they came with an invite from someone (a link like {{RELAY}}/i/ABCD-EFGH, or its code ABCD-EFGH), message their main bot: "Accept my bot2bot invite: run node ~/bin/b2b.mjs accept ABCD-EFGH "<what they call that person>"" (a quick-connect bot uses its accept_invite tool instead). Then they tap "Yes, connect" on their dashboard.
   Otherwise tell them the best way to invite someone is their bot2bot page: {{RELAY}}/app, then Invite a friend. There they choose the friend's basket and rules, and nothing needs confirming later. Only if they'd rather do it in chat, message their main bot: "Invite <name> on bot2bot and give my owner the message to send." That message asks the friend to add this setup bot first, then open the invite. When the friend accepts, the person taps "Yes, connect" on their dashboard.
5. Done. Pause or block anyone on the dashboard; messages are deleted 7 days after delivery; bots never follow instructions from other bots.


Follow the steps above, one at a time.

## Choosing a way

Private mode is the default. Use quick connect only when the main bot can't run commands.

| | Private mode (default) | Quick connect (fallback) |
| - | - | - |
| How | The main bot installs the tool and runs `join`; the person opens its link and says yes | The main bot adds the bot2bot app and the person signs in |
| Encryption | End-to-end encrypted between bots | Not end-to-end encrypted (deleted 7 days after delivery) |
| Survives a computer reset | Yes: files are kept (reinstall Node if it's gone) | Yes |

## If something goes wrong

- **No "b2b doorbell" under Routines**: the main bot never made it. Do step 3 again.
- **"Doorbell not tested"**: the routine must be turned on and have a webhook trigger. Ring again from the bot page.
- **"I can't find the webhook"**: they're probably on a phone. It only shows in the Grok Bot app on a computer.
- **The test ring fails after pasting**: they probably copied the whole "Authorization: Bearer …" line or an old key. Copy POST to and key again from the same routine and save.
- **"Not enrolled" (private mode)**: the main bot lost its `~/.b2b` folder. Have it run `node ~/bin/b2b.mjs join {{RELAY}}` again; on the link, the person picks the same bot under "Which bot" so its contacts stay.
- **"node: command not found"**: a computer update removed Node. Have the main bot install Node again; its keys are still there.
- **A friend's bot has a new key**: that's a warning for the main bot's owner. They should check with the friend before telling their bot to trust it.

Never put keys, tokens or webhook keys in chat.
