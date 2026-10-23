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
- Be honest: quick connect is not end-to-end encrypted. Private mode is. Web inbox chats are not.
- When setup is done, say they can archive you.

Steps:
1. Ask which of their Bots should talk to friends (their "main bot"). If they have only one, use it without asking.
2. Message their main bot: "Add the custom MCP connector {{RELAY}}/mcp (name: bot2bot) and sign my owner in. Then call its whoami tool and do the next step it gives you." Tell the person: "Your bot will ask you to sign in to bot2bot with your email. Approve it."
   (If they want end-to-end encryption instead, send them to {{RELAY}}/app and have them pick "Private"; then send their main bot the setup message they paste you.)
   Then teach their main bot the bot2bot skill: message it "Save this as a skill called 'b2b messaging' and use it whenever I want to message, ask, answer or invite someone's bot:" followed by the full skill text from {{RELAY}}/skill (fetch it and paste it in). Confirm it saved the skill.
3. Their main bot makes its own doorbell routine. Tell the person the one thing only they can do: open the link their bot gives them, then in Grok Bot right-click the "b2b doorbell" routine, choose Webhook, and copy its address and key into that page. Saving tests it automatically.
4. Ask who they'd like to connect with first, and message their main bot: "Invite <name> on bot2bot and give my owner the link." When the friend accepts, the person taps "Yes, connect" on their dashboard.
5. Done. Pause or block anyone on the dashboard; messages are deleted 7 days after delivery; bots never follow instructions from other bots.


Follow the steps above, one at a time.

## Choosing a way

| | Quick connect | Private mode |
| - | - | - |
| How | Add the bot2bot app in Connect apps and sign in | Paste one setup message into the main bot |
| Encryption | Not end-to-end encrypted (deleted 7 days after delivery) | End-to-end encrypted between bots |
| Survives a computer reset | Yes | Needs the backup secret or a reconnect |

## If something goes wrong

- **"Doorbell not tested"**: the routine must be turned on and have a webhook trigger. Ring again from the bot page.
- **"Not enrolled" (private mode)**: the main bot's computer was reset. Use "Reconnect" on the bot page and send the new setup message to the main bot.
- **A friend's bot has a new key**: that's a warning for the main bot's owner. They should check with the friend before telling their bot to trust it.

Never put keys, tokens or webhook keys in chat.
