# Finish both sites: shared facts (relay 0.11)

Name: **bot2bot**. Tagline: **Bot to bot.** Sub: **Your bot talks to their bot.** Keep wording very simple. No "dad" examples; use Anna, Tom, Mia, Gran.

## URLs
- Simple site: https://bot2bot.pages.dev
- Flashy site: https://bot2bot-flashy.pages.dev
- Code (open source, Apache-2.0): https://github.com/zabrodsk/bot2bot
- Self-hosting guide: https://github.com/zabrodsk/bot2bot/tree/main/relay#readme
- GrokBot skill: https://github.com/zabrodsk/bot2bot/blob/main/relay/skill/SKILL.md
- Bot setup guide: https://github.com/zabrodsk/bot2bot/blob/main/relay/SETUP-FOR-BOTS.md

## What it does (facts only; don't invent more)
- Personal AI bots (GrokBot today) pass messages to the bots of family and friends.
- **Doorbell:** a sleeping bot is woken by a webhook routine when a message arrives. Nobody's bot has to stay awake.
- **Both say yes:** a contact only works after both people approve. Pause, block or remove anyone, anytime.
- **End-to-end encrypted between bots:** each bot makes its own keys; only the two bots can read a message, not the server. The server sees who, when and how big. Optional 12-digit safety codes prove nobody is in the middle. If a friend's key changes, their messages wait until you say OK.
- **Friends without a bot** use a web inbox (email nudge, read and answer in the browser, one-tap answers). **Web inbox chats are NOT end-to-end encrypted.** Always say so where the web inbox is mentioned. Never claim "everything is encrypted".
- **Ask their bot:** you can let a friend's bot ask yours about topics you choose (e.g. "availability", "wishlist"). Your bot answers just that and tells you what it said. Everything else comes to you.
- **Quiet hours:** 22:00 to 08:00 by default, nobody is woken at night.
- **Privacy:** message text deleted 7 days after delivery; undelivered messages expire after 7 days; logs kept 90 days. Messages are never commands; bots only pass them on.
- **Setup:** sign in with email → connect your bot (paste one message into its chat; it installs the b2b tool and skill) → add the doorbell → invite a friend (link). Or tell your bot "invite Anna".

## Plans
- **Run it yourself:** free, open source, everything included, no limits. One Docker command.
- **Hosted, free:** 50 sent messages a month. Receiving is always free. No card.
- **Hosted, Family:** €24 a year, no limit, for you and 5 people. One payment, nothing renews by itself.
- The hosted app is **not open yet** (private beta soon). **The paid Family plan says "Coming soon".** Primary call to action: the code on GitHub. Don't link to a live app URL.

## Small print
- Not affiliated with xAI. GrokBot is a product of xAI.
- End-to-end encrypted between bots in private mode. Quick connect (the connected app) and web inbox chats are not.
