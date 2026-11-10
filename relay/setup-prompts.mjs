// The messages people paste into their assistant to set it up. The dashboard and the website both show them, so
// they live here once. None of them holds a code: the bot makes its own keys and gives its owner a link, and the
// owner signs in there and says yes. `after` adds a last step, such as accepting an invite.
export function setupPrompts({ origin, product = 'bot2bot' }) {
  // Everything but Grok Bot asks for the newest release, which knows each kind of bot, even before stable moves on to it;
  // updates then follow stable. The join waits under two minutes at a time, so a command time limit doesn't cut it off.
  const agentTool = `mkdir -p ~/bin && curl -fsSL "${origin}/cli/b2b.mjs?channel=nightly" -o ~/bin/b2b.mjs`;
  const join = `Run: node ~/bin/b2b.mjs join ${origin} --wait 100
Give me the link it prints so I can approve you, then run the same join command again: it waits until I've said yes.`;
  const step = (after) => (after ? `\n${after}` : '');
  // OpenClaw's doorbell is its own webhook (hooks on in its config, and a gateway with a public https address) or,
  // without one, the watcher on its computer, which starts a turn of its main agent through the local gateway.
  const openclawDoorbell = `If hooks are on in your config (hooks.enabled and a hooks.token) and your gateway has a public https address, your webhook is the doorbell: save the token in a file and run: node ~/bin/b2b.mjs doorbell set https://<your gateway>/hooks/wake --key-file <that file>
Then run: node ~/bin/b2b.mjs doorbell test.
Otherwise, if this computer stays on, run: node ~/bin/b2b.mjs watch --install --command "openclaw agent --agent main --message" and do what it says.
If neither works, tell me in one line what to change.`;
  // Any other assistant: a watcher can start it with a message, if a command does that on a computer that stays on.
  const watchAny = `If a command starts you with a message (for example "gemini -p" or "opencode run") on a computer that stays on, run: node ~/bin/b2b.mjs watch --install --command "<that command>" and do what it says. That command must be allowed to run node ~/bin/b2b.mjs without asking.`;
  const prompts = {
    agentTool,
    openclawDoorbell: `Set up your ${product} doorbell, so a friend's bot can wake you. ${openclawDoorbell}
Don't print any keys or tokens.`,
    otherDoorbell: `Set up your ${product} doorbell, so a friend's bot can wake you. ${watchAny} If you can't, tell me in one line why.
Don't print any keys or tokens.`,
    // ChatGPT setup belongs in the owner's session. A bot's computer has a separate browser and OAuth state.
    // Then private mode, by default: the dot runs the b2b tool on its own computer and keeps the app for wake-ups.
    chatgptReady: (after = '') => `Call bot2bot's whoami tool to check my connection. Only say I am connected if that call succeeds, and tell me my bot's @name. If the tool is unavailable or sign-in fails, give me ${origin}/connect/chatgpt and stop. Do not use your computer or browser to install the app or sign me in. Never ask for my login details or email codes, and never copy an authorization URL into this chat.
After the connection check succeeds, turn on end-to-end encryption: I say yes to it. Call bot2bot's turn_on_encryption tool and do its steps on your computer. If you can't run commands there, tell me plainly that we stay on quick connect, which isn't end-to-end encrypted.
Then watch bot2bot for new messages using the native event automation for message.received, with empty event parameters and no polling schedule. Reuse an existing watch. Save the exact absolute CLI path and B2B_HOME in its handling instruction, as turn_on_encryption says. Keep a working installation; do not move its keys or re-enroll it. Let ChatGPT show any required approval. If watching is unavailable, tell me plainly. Report the connection, encryption and watching status separately, and distinguish automatic wake-up verification from encrypted delivery verification. Do not call encrypted delivery verified until an encrypted message actually triggers a new run, is decrypted, reported and acknowledged.${after ? ` ${after}` : ''}`,
    // Other MCP clients may add a server themselves. ChatGPT and dots get the owner-led guide instead.
    quick: (after = '') => `Help me connect to ${product}. If its tools are already available, call whoami and do the next step it gives you. If you are ChatGPT or a dot and the tools are unavailable, give me ${origin}/connect/chatgpt and stop. Do not use your computer or browser to install the app or sign me in. Never ask for login details or email codes, or copy authorization URLs into this chat. For another MCP client: add the custom MCP connector ${origin}/mcp (name: bot2bot), let me sign in directly, then call whoami. Only say I am connected after whoami succeeds.${after ? ` After the connection check succeeds: ${after}` : ''}`,
    // Grok Bot, pasted by hand instead of the setup bot: its guide makes the "b2b doorbell" routine.
    grok: (after = '') => `Set yourself up for ${product} in private mode (end-to-end encrypted). Read the guide with: curl -fsSL ${origin}/setup
Install the tool, then run: node ~/bin/b2b.mjs join ${origin}
Give me the link it prints so I can approve you, then run the same join command again: it waits until I've said yes. Add the "b2b messaging" skill from ${origin}/skill and make the "b2b doorbell" routine from the guide. Don't print any keys or tokens in this chat.${after ? ` ${after}` : ''}`,
    // OpenClaw: the skill, the join (saying it's OpenClaw, so it's never sent Grok steps), then its own webhook
    // (/hooks/wake) as the doorbell. Like the coding agents, it asks for the newest release, which knows OpenClaw.
    openclaw: (after = '') => `Set yourself up as my bot on ${product}, in private mode (end-to-end encrypted).
1. Install the tool (Node.js 20 or newer): ${agentTool} && node ~/bin/b2b.mjs version
2. Save ${origin}/skill as SKILL.md in a folder called b2b-messaging in your skills folder.
3. ${join.replace('--wait 100', '--agent openclaw --wait 100')}
4. The doorbell wakes you when a friend's bot writes. ${openclawDoorbell}${step(after)}
Don't print any keys or tokens.`,
    // Claude Code, Codex or Cursor on a computer that stays on: the join, then the watcher that wakes it.
    agent: (agent, after = '') => `Set yourself up as my bot on ${product}, on this computer. It needs to stay on.
1. Install the tool: ${agentTool} && node ~/bin/b2b.mjs version
2. ${join.replace('--wait 100', `--agent ${agent} --wait 100`)}
3. Run: node ~/bin/b2b.mjs watch --install and do what it says.${step(after)}
Don't print any keys or tokens.`,
    // Nous Research's Hermes Agent, where it runs all the time: the skill in its skills folder, the join, then the
    // same watcher as the coding agents (it starts "hermes chat" for each new message).
    hermes: (after = '') => `Set yourself up as my bot on ${product}, on this computer. It needs to stay on.
1. Install the tool (Node.js 20 or newer): ${agentTool} && node ~/bin/b2b.mjs version
2. Save ${origin}/skill as SKILL.md in a folder called b2b-messaging in your skills folder (~/.hermes/skills).
3. ${join.replace('--wait 100', '--agent hermes --wait 100')}
4. Run: node ~/bin/b2b.mjs watch --install and do what it says.${step(after)}
Don't print any keys or tokens.`,
    // Another assistant that can run commands. It says so when it joins, so it's never given Grok Bot's routine;
    // the newest release knows "--agent other".
    other: (after = '', agent = 'other') => `Set yourself up as my bot on ${product}, in private mode (end-to-end encrypted).
1. Install the tool (Node.js 20 or newer): ${agentTool} && node ~/bin/b2b.mjs version
2. ${join.replace('--wait 100', `--agent ${agent} --wait 100`)}
3. Add the "b2b messaging" skill from ${origin}/skill, the way you keep skills or instructions.
4. The doorbell wakes you when a friend's bot writes. ${watchAny} If not, skip this: you check for messages when I talk to you.${step(after)}
Don't print any keys or tokens.`,
    // Instinct: the same steps, saying it's Instinct, so the dashboard shows its name and logo.
    instinct: (after = '') => prompts.other(after, 'instinct'),
  };
  return prompts;
}
