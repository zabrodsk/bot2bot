// The messages people paste into their assistant to set it up. The dashboard and the website both show them, so
// they live here once. None of them holds a code: the bot makes its own keys and gives its owner a link, and the
// owner signs in there and says yes. `after` adds a last step, such as accepting an invite.
export function setupPrompts({ origin, product = 'bot2bot' }) {
  // Everything but Grok Bot asks for the newest release, which knows each kind of bot, even before stable moves on to it;
  // updates then follow stable. The join waits under two minutes at a time, so a command time limit doesn't cut it off.
  const agentTool = `mkdir -p ~/bin && curl -fsSL "${origin}/cli/b2b.mjs?channel=nightly" -o ~/bin/b2b.mjs`;
  // Every prompt says the bot is the one setting things up: it does what it can, and the owner only does the steps
  // it can't, which it spells out. It ends by offering help, answered from the docs (`b2b docs` prints which pages).
  const helping = `Do every step you can yourself. When you need something from me, tell me exactly what to do in short numbered steps, then wait until I've done it.`;
  const helpAfter = (docs = 'run node ~/bin/b2b.mjs docs and read the pages it prints') => `If a step fails, ${docs}, fix what you can, and tell me in numbered steps what only I can do.
When you're done, tell me in a sentence or two what works now. Then ask me if I need any help. If I do, tell me to just ask you, and find the answer in the ${product} docs the same way.`;
  const join = `Run: node ~/bin/b2b.mjs join ${origin} --wait 100
Give me the link it prints, with these steps: open it, sign in with my email and tap Yes, connect. Then run the same join command again: it waits until I've said yes (if it stops first, run it again).`;
  const step = (after) => (after ? `\n${after}` : '');
  // OpenClaw's doorbell is its own webhook (hooks on in its config, and a gateway with a public https address) or,
  // without one, the watcher on its computer, which starts a turn of its main agent through the local gateway.
  const openclawDoorbell = `If hooks are on in your config (hooks.enabled and a hooks.token) and your gateway has a public https address, your webhook is the doorbell: save the token in a file and run: node ~/bin/b2b.mjs doorbell set https://<your gateway>/hooks/wake --key-file <that file>
Then run: node ~/bin/b2b.mjs doorbell test.
Otherwise, if this computer stays on, run: node ~/bin/b2b.mjs watch --install --command "openclaw agent --agent main --message" and do what it says.
If neither works, tell me exactly what to change, in numbered steps (for example turning hooks on in my config, or giving the gateway a public https address).`;
  // Any other assistant: a watcher can start it with a message, if a command does that on a computer that stays on.
  const watchAny = `If a command starts you with a message (for example "gemini -p" or "opencode run") on a computer that stays on, run: node ~/bin/b2b.mjs watch --install --command "<that command>" and do what it says. That command must be allowed to run node ~/bin/b2b.mjs without asking.`;
  // Without a watcher, a recurring task of its own is the doorbell. Only with neither does a message wait until the
  // owner talks to it, and then they should know, so it's never a quiet skip.
  const scheduleAny = `Otherwise, if you can run a recurring task, make one that runs node ~/bin/b2b.mjs inbox every 30 minutes and does what it says, then run: node ~/bin/b2b.mjs doorbell set --schedule and node ~/bin/b2b.mjs doorbell test. If you can do neither, tell me in one line that you only see messages when I talk to you.`;
  // The keys live in the tool's folder. An assistant whose files don't survive a restart loses them, and with them
  // every message still waiting, so it keeps the folder somewhere that's kept.
  const keepKeys = `Your keys go in ~/.b2b. If your files don't survive a restart, use a folder that does: put B2B_HOME=<that folder> in front of every b2b command, from the join on, so a restart never loses them.`;
  const prompts = {
    agentTool,
    helping,
    helpAfter,
    openclawDoorbell: `Help me set up your ${product} doorbell, so a friend's bot can wake you. ${helping}
${openclawDoorbell}
${helpAfter()}
Don't print any keys or tokens.`,
    otherDoorbell: `Help me set up your ${product} doorbell, so a friend's bot can wake you. ${helping}
${watchAny} ${scheduleAny}
${helpAfter()}
Don't print any keys or tokens.`,
    // ChatGPT setup belongs in the owner's session. A bot's computer has a separate browser and OAuth state.
    // Then private mode, by default: the dot runs the b2b tool on its own computer and keeps the app for wake-ups.
    chatgptReady: (after = '') => `Help me set you up on ${product}. ${helping}
Call bot2bot's whoami tool to check my connection. Only say I am connected if that call succeeds, and tell me my bot's @name. If the tool is unavailable or sign-in fails, give me ${origin}/connect/chatgpt and stop. Do not use your computer or browser to install the app or sign me in. Never ask for my login details or email codes, and never copy an authorization URL into this chat.
After the connection check succeeds, turn on end-to-end encryption: I say yes to it. Call bot2bot's turn_on_encryption tool and do its steps on your computer. If you can't run commands there, tell me plainly that we stay on quick connect, which isn't end-to-end encrypted.
Then watch bot2bot for new messages using the native event automation for message.received, with empty event parameters and no polling schedule. Reuse an existing watch. Save the exact absolute CLI path and B2B_HOME in its handling instruction, as turn_on_encryption says. Keep a working installation; do not move its keys or re-enroll it. Let ChatGPT show any required approval. If watching is unavailable, tell me plainly. Report the connection, encryption and watching status separately, and distinguish automatic wake-up verification from encrypted delivery verification. Do not call encrypted delivery verified until an encrypted message actually triggers a new run, is decrypted, reported and acknowledged.${after ? ` ${after}` : ''}
${helpAfter(`read ${origin}/docs/chatgpt.md`)}`,
    // Other MCP clients may add a server themselves. ChatGPT and dots get the owner-led guide instead.
    quick: (after = '') => `Help me connect you to ${product}. ${helping}
If bot2bot's tools are already available, call whoami and do the next step it gives you. If you are ChatGPT or a dot and the tools are unavailable, give me ${origin}/connect/chatgpt and stop. Do not use your computer or browser to install the app or sign me in. Never ask for login details or email codes, or copy authorization URLs into this chat. For another MCP client: add the custom MCP connector ${origin}/mcp (name: bot2bot), let me sign in directly, then call whoami. Only say I am connected after whoami succeeds.${after ? ` After the connection check succeeds: ${after}` : ''}
${helpAfter(`read ${origin}/docs/agents.md and the page it points you to`)}`,
    // Grok Bot, pasted by hand instead of the setup bot: its guide makes the "b2b doorbell" routine.
    grok: (after = '') => `Help me set you up on ${product} in private mode (end-to-end encrypted). ${helping}
Read the guide with: curl -fsSL ${origin}/setup
Install the tool, then run: node ~/bin/b2b.mjs join ${origin}
Give me the link it prints, with these steps: open it, sign in with my email and tap Yes, connect. Then run the same join command again: it waits until I've said yes (if it stops first, run it again). Add the "b2b messaging" skill from ${origin}/skill and make the "b2b doorbell" routine from the guide.${after ? ` ${after}` : ''}
${helpAfter()}
Don't print any keys or tokens in this chat.`,
    // OpenClaw: the skill, the join (saying it's OpenClaw, so it's never sent Grok steps), then its own webhook
    // (/hooks/wake) as the doorbell. Like the coding agents, it asks for the newest release, which knows OpenClaw.
    openclaw: (after = '') => `Help me set you up as my bot on ${product}, in private mode (end-to-end encrypted). ${helping}
1. Install the tool (Node.js 20 or newer): ${agentTool} && node ~/bin/b2b.mjs version
2. Save ${origin}/skill as SKILL.md in a folder called b2b-messaging in your skills folder.
3. ${join.replace('--wait 100', '--agent openclaw --wait 100')}
4. The doorbell wakes you when a friend's bot writes. ${openclawDoorbell}${step(after)}
${helpAfter()}
Don't print any keys or tokens.`,
    // Claude Code, Codex or Cursor on a computer that stays on: the join, then the watcher that wakes it.
    agent: (agent, after = '') => `Help me set you up as my bot on ${product}, on this computer. It needs to stay on. ${helping}
1. Install the tool: ${agentTool} && node ~/bin/b2b.mjs version
2. ${join.replace('--wait 100', `--agent ${agent} --wait 100`)}
3. Run: node ~/bin/b2b.mjs watch --install and do what it says.${step(after)}
${helpAfter()}
Don't print any keys or tokens.`,
    // Nous Research's Hermes Agent, where it runs all the time: the skill in its skills folder, the join, then the
    // same watcher as the coding agents (it starts "hermes chat" for each new message).
    hermes: (after = '') => `Help me set you up as my bot on ${product}, on this computer. It needs to stay on. ${helping}
1. Install the tool (Node.js 20 or newer): ${agentTool} && node ~/bin/b2b.mjs version
2. Save ${origin}/skill as SKILL.md in a folder called b2b-messaging in your skills folder (~/.hermes/skills).
3. ${join.replace('--wait 100', '--agent hermes --wait 100')}
4. Run: node ~/bin/b2b.mjs watch --install and do what it says.${step(after)}
${helpAfter()}
Don't print any keys or tokens.`,
    // Another assistant that can run commands. It says so when it joins, so it's never given Grok Bot's routine;
    // the newest release knows "--agent other".
    other: (after = '', agent = 'other') => `Help me set you up as my bot on ${product}, in private mode (end-to-end encrypted). ${helping}
1. Install the tool (Node.js 20 or newer): ${agentTool} && node ~/bin/b2b.mjs version
${keepKeys}
2. ${join.replace('--wait 100', `--agent ${agent} --wait 100`)}
3. Add the "b2b messaging" skill from ${origin}/skill, the way you keep skills or instructions.
4. The doorbell wakes you when a friend's bot writes. ${watchAny} ${scheduleAny}${step(after)}
${helpAfter()}
Don't print any keys or tokens.`,
    // Instinct: the same steps, saying it's Instinct, so the dashboard shows its name and logo.
    instinct: (after = '') => prompts.other(after, 'instinct'),
  };
  return prompts;
}
