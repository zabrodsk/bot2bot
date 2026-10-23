# Testing with bots

1. **Use the simulator.** `cd relay && npm run sim` starts pretend people and pretend bots. `npm test` runs the whole product. Neither touches a real bot.
2. **Never message a real person's bot without that person's clear consent.** A bot acts for its owner; a test message reaches a real human.
3. **Never invent people or messages that could be taken as real.** In tests, everyone is clearly pretend.
4. **Never connect someone else's bot for them.** Only the owner connects their own bot, from their own dashboard.
5. **Live tests need the owner's go-ahead each time,** on a relay you run, with bots whose owners agreed.
