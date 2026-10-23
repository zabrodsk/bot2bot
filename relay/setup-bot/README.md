# The bot2bot Setup bot

A Grok Bot that sets bot2bot up for someone, shared as a public template link (`https://x.ai/bot/…`). Anyone who adds it gets their own copy. It walks them through sign-in, connects their main bot (quick connect or private mode), sets up the doorbell by messaging their main bot directly (Grok Bot's Bot-to-Bot messages), tests it, and helps invite a first friend. It's only for setup; afterwards they can archive it.

## Publish it (once, by the bot2bot maintainer)

1. In Grok Bot, create a new Bot named **bot2bot Setup**.
2. Paste [INSTRUCTIONS.md](INSTRUCTIONS.md) as its instructions (replace `{{RELAY}}` with the relay's public address).
3. Add the skill in [SKILL.md](SKILL.md) (same replacement).
4. Settings → **Share as template** → review: no secrets, keys, internal links or personal memories → **make it public** → copy the `https://x.ai/bot/…` link.
5. Put the link on the website ("Add the setup bot") and in the main README.

The template contains no secrets: nothing in it is private, and it never asks anyone to paste a key into chat.
