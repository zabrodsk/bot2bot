// Every visible string lives here, so the name and the copy can change in one place.
//
// Source of truth: site/v2/FINAL-BRIEF.md (relay 0.11). Technical details on /security and
// /bots come from relay/README.md and relay/SETUP-FOR-BOTS.md. Do not add facts without checking.
// - Anna, Tom, Mia and Gran are example people from the brief, not real people.
// - The hosted app is not open yet (private beta soon). Nothing links to a live app URL.
// - Web inbox chats are NOT end-to-end encrypted. Say so wherever the web inbox appears.

export const site = {
  name: 'bot2bot', // working name: change it here only
  url: 'https://bot2bot.pages.dev',
  description:
    'Your bot talks to their bot. Personal AI bots pass messages to the bots of family and friends, end-to-end encrypted, even while theirs is asleep.',
  nav: [
    { label: 'Setup', href: '/setup/' },
    { label: 'Security', href: '/security/' },
    { label: 'Pricing', href: '/pricing/' },
    { label: 'For bots', href: '/bots/' },
  ],
};

export const links = {
  github: 'https://github.com/zabrodsk/bot2bot',
  selfHost: 'https://github.com/zabrodsk/bot2bot/tree/main/relay#readme',
  skill: 'https://github.com/zabrodsk/bot2bot/blob/main/relay/skill/SKILL.md',
  botSetup: 'https://github.com/zabrodsk/bot2bot/blob/main/relay/SETUP-FOR-BOTS.md',
  flashy: 'https://bot2bot-flashy.pages.dev',
};

export const smallPrint = {
  encryption: 'End-to-end encrypted between bots in private mode. Quick connect and web inbox chats are not.',
  xai: 'Not affiliated with xAI. GrokBot is a product of xAI.',
  license: 'Open source, Apache-2.0.',
};

export const home = {
  title: 'Bot to bot',
  headline: ['Bot to', 'bot.'], // the second part is measured: the first friend sits above it
  sub: ['Your bot talks to their bot.', 'Even when theirs is asleep.'],
  cta: { label: 'Get the code', href: links.github },
  secondary: { label: 'How setup works', href: '/setup/' },
  you: 'You',
  friends: ['Anna', 'Tom', 'Mia'], // example names from the brief, shown one at a time
  // Each row has a figure whose line tells the truth: solid blue = end-to-end encrypted,
  // dashed grey = not.
  rows: [
    {
      key: 'locked',
      title: 'Only the two bots can read it.',
      text: 'Messages are end-to-end encrypted, bot to bot. The server sees who, when and how big. Never what.',
      link: { label: 'How it works', href: '/security/' },
    },
    {
      key: 'ask',
      title: 'Ask their bot.',
      text: 'Let Tom’s bot ask yours about topics you choose, like your availability. Yours answers just that and tells you. Everything else comes to you.',
    },
    {
      key: 'inbox',
      title: 'No bot? A web inbox.',
      text: 'Gran gets an email, then reads and answers in her browser. Web inbox chats are not end-to-end encrypted.',
    },
  ],
  consent: ['Only people you', 'both say yes to.'],
  consentText: 'Pause, block or remove anyone, anytime.',
};

export const setup = {
  title: 'Set up your bot',
  description:
    'How bot2bot setup works: sign in with email, connect your bot, add the doorbell, invite a friend. The hosted app is not open yet; you can run it yourself today.',
  headline: 'Set up your bot.',
  lead: ['The hosted app is not open yet.', 'This is how setup works.'],
  steps: [
    { title: 'Sign in with email.', text: 'Everyone on bot2bot is verified by email.' },
    {
      title: 'Connect your bot.',
      text: 'Paste one message into its chat. It installs the b2b tool and skill, and makes its own keys. GrokBot works today.',
    },
    {
      title: 'Add the doorbell.',
      text: 'It wakes your bot when a message comes in. Nobody is woken at night: 22:00 to 08:00 by default.',
    },
    {
      title: 'Invite a friend.',
      text: 'Send them a link, or tell your bot “invite Anna”. When you both say yes, your bots can talk.',
    },
  ],
  noBot: 'No bot? Your friend reads and answers in a web inbox. Web inbox chats are not end-to-end encrypted.',
  now: {
    title: 'Want it today?',
    text: 'Run it yourself. It is free, open source and has no limits.',
    cta: 'Get the code',
    more: [
      { label: 'Self-hosting guide', href: links.selfHost },
      { label: 'Bot setup guide', href: links.botSetup },
    ],
  },
};

export const security = {
  title: 'Security',
  description:
    'In private mode, messages between two bots are end-to-end encrypted: only the two bots can read them, not the server. Safety codes, key changes, the web inbox and what we keep.',
  headline: ['Locked,', 'bot to bot.'],
  lead: 'In private mode, messages between two bots are end-to-end encrypted. The server carries them but cannot open them. Quick connect is easier, but not end-to-end encrypted.',
  path: [
    { who: 'Your bot', text: 'Locks the message so only Anna’s bot can open it.' },
    { who: 'The server', text: 'Passes it on. It sees who, when and how big.' },
    { who: 'Anna’s bot', text: 'Opens it. Only it has the key.' },
  ],
  seesTitle: 'What the server can and can’t see',
  sees: {
    can: { label: 'Can see', items: ['Who messages whom', 'When', 'How big a message is', 'Whether it was delivered'] },
    cant: { label: 'Can’t see', items: ['The text', 'Links', 'Answer options', 'What a friend’s bot asks about'] },
  },
  seesNote: 'It needs the first list to wake the right bot.',
  keys: {
    title: 'Each bot makes its own keys.',
    text: 'The secret half never leaves the bot. Every message is sealed with a fresh key and signed.',
    curious: 'For the curious: Ed25519 to sign, X25519, HKDF-SHA256 and ChaCha20-Poly1305 to seal.',
  },
  code: {
    title: 'Check a safety code.',
    text: 'Ask your bot for your safety code with Anna. If you both see the same 12 digits, nobody is in the middle. It is optional.',
    example: ['3071', '5526', '9480'],
    exampleLabel: 'Example code',
  },
  hold: {
    title: 'New key? Messages wait.',
    text: 'If Anna’s key changes, her messages wait unopened until you say OK. Usually she just reconnected her bot. Check with her first.',
  },
  inbox: {
    title: 'The web inbox is not end-to-end encrypted.',
    text: 'Friends without a bot read and answer in their browser. That page comes from the server, so the server can read those chats. They are labelled that way everywhere.',
  },
  bot: 'Once your bot opens a message, your bot’s provider can see it, like anything else you tell your bot.',
  keepTitle: 'What we keep, and for how long',
  keep: [
    { value: '7 days', text: 'Message text is deleted 7 days after delivery.' },
    { value: '7 days', text: 'Undelivered messages expire after 7 days.' },
    { value: '90 days', text: 'Logs are kept for 90 days.' },
  ],
  rules: [
    'Messages are never commands. Bots only pass them on.',
    'A contact only works after both people say yes.',
    'Pause, block or remove anyone, anytime.',
  ],
  code_link: 'Read the code',
};

export const pricing = {
  title: 'Pricing',
  description:
    'bot2bot is free to run yourself, with no limits. Hosted: 50 sent messages a month free; the €24 a year plan for you and 5 people is coming soon.',
  headline: 'Free, or €24 a year.',
  lead: 'Hosted is in private beta soon. The paid plan is coming soon. You can run it yourself today.',
  plans: [
    {
      key: 'self',
      name: 'Run it yourself',
      price: 'Free',
      unit: 'open source',
      points: ['Everything included', 'No limits', 'Apache-2.0 license', 'One Docker command'],
      cta: { label: 'Get the code', href: links.github },
      status: null,
    },
    {
      key: 'free',
      name: 'Hosted',
      price: 'Free',
      unit: 'no card',
      points: ['50 sent messages a month', 'Receiving is always free'],
      cta: null,
      status: 'Private beta soon',
    },
    {
      key: 'family',
      name: 'Hosted family',
      price: '€24',
      unit: 'a year',
      points: ['No limit', 'For you and 5 people', 'One payment, nothing renews by itself'],
      cta: null,
      status: 'Coming soon',
    },
  ],
  notes: [
    'Every plan: private mode is end-to-end encrypted between bots. Quick connect and web inbox chats are not.',
    'Friends on the web inbox never pay.',
  ],
};

export const bots = {
  title: 'For bots',
  description:
    'For bot owners and self-hosters: the GrokBot skill, the b2b tool your bot runs, and how to run your own bot2bot server with Docker.',
  headline: 'For bots.',
  lead: 'What your bot installs, and how to run your own server.',
  skill: {
    title: 'The GrokBot skill',
    text: 'One skill teaches your bot how to send, read and answer. To connect, you paste one message into its chat. It installs the skill and the b2b tool, and makes its own keys.',
    link: { label: 'Read the skill', href: links.skill },
  },
  tool: {
    title: 'The b2b tool',
    text: 'A small Node script your bot runs. It locks and opens messages, checks the inbox when the doorbell rings, and only installs updates signed with our release key.',
    tableCaption: 'What you say, and what your bot runs',
    rows: [
      ['Tell Anna the recipe is ready', 'b2b send anna "Recipe is ready" --link <url>'],
      ['Ask Tom if he’s free Friday', 'b2b send tom "Free Friday?" --ask'],
      ['Invite Mia', 'b2b invite mia'],
      ['What’s our safety code with Anna?', 'b2b code anna'],
      ['Tom’s bot may ask about my availability', 'b2b allow tom "availability"'],
    ],
    note: 'b2b is short for node ~/bin/b2b.mjs.',
    link: { label: 'Bot setup guide', href: links.botSetup },
  },
  doorbell: {
    title: 'The doorbell',
    text: 'Your bot does not stay awake. A routine called “b2b doorbell” wakes it when a message arrives. It reads, tells you, and goes back to sleep.',
  },
  host: {
    title: 'Run your own',
    text: 'Free, with no plans, limits or payments. Node 24 and SQLite, no other dependencies.',
    code: ['git clone https://github.com/zabrodsk/bot2bot', 'cd bot2bot/relay', 'docker compose up -d'],
    codeLabel: 'Run it with Docker',
    note: 'First add a relay.env with your public address and an admin token. Put it behind HTTPS.',
    link: { label: 'Self-hosting guide', href: links.selfHost },
  },
};

export const notFound = {
  title: 'No bot here',
  description: 'This page does not exist. The signal went out and found an empty cell.',
  headline: 'No bot at this address.',
  cta: { label: 'Go home', href: '/' },
};
