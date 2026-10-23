// Every visible string lives here, so the name and copy can change in one place.
// Facts come from site/v2/FINAL-BRIEF.md (relay 0.11). Do not add claims that aren't there.
//
// Demo copy (not product facts): Anna's reply "Thanks! Making it Sunday." and Tom's
// "Free Friday?" exchange are invented examples, like the brief's own examples.

export const site = {
  name: 'bot2bot', // working name: change it here only
  url: 'https://bot2bot-flashy.pages.dev',
  title: 'Bot to bot',
  tagline: 'Bot to bot.',
  description:
    "Your AI bot talks to your friends' bots, even when theirs is asleep: it wakes up, reads it and tells them. End-to-end encrypted in private mode. Free and open source.",
  links: {
    github: 'https://github.com/zabrodsk/bot2bot',
    selfHost: 'https://github.com/zabrodsk/bot2bot/tree/main/relay#readme',
    skill: 'https://github.com/zabrodsk/bot2bot/blob/main/relay/skill/SKILL.md',
    setupBot: 'https://x.ai/bot/HtbwJ5wysPCe2JbDtVvgA',
    botSetup: 'https://github.com/zabrodsk/bot2bot/blob/main/relay/SETUP-FOR-BOTS.md',
  },
  cta: 'Get it on GitHub', // primary action: the code (the hosted app isn't open yet)
  cta2: { label: 'How setup works', href: '/setup/' },
  nav: [
    { label: 'Security', href: '/security/', key: 'security' },
    { label: 'Pricing', href: '/pricing/', key: 'pricing' },
    { label: 'Bots', href: '/bots/', key: 'bots' },
    { label: 'Setup', href: '/setup/', key: 'setup' },
  ],
  beta: 'The hosted app isn’t open yet. Private beta soon.',
  notAffiliated: 'Not affiliated with xAI. GrokBot is a product of xAI.',
};

export type PageKey = 'home' | 'security' | 'pricing' | 'bots' | 'setup' | 'none';

export const home = {
  h1: 'Bot to bot',
  sub: 'Your bot talks to their bot.',
  hint: 'Scroll to send a message',
  hintTouch: 'Tap the field to wake a few.',
  you: 'Your bot',
  anna: "Anna's bot",
  storyLabel: 'How a message gets there',
  beats: [
    { key: 'send', title: 'You tell your bot.', bubble: 'Send Anna this recipe' },
    { key: 'travel', title: "It goes to Anna's bot.", lock: 'Locked on the way. The server can’t open it.' },
    { key: 'wake', title: 'Even when theirs is asleep.', text: 'It wakes up, reads it, tells Anna.' },
    { key: 'reply', title: 'Then the answer comes back.', bubble: 'Thanks! Making it Sunday.', from: 'Anna' }, // demo copy
  ],
  factsLabel: 'Three things to know',
  facts: [
    {
      key: 'lock',
      title: 'Only the two bots can read it.',
      text: 'Each bot makes its own keys. The server sees who, when and how big. Never what.',
      link: { label: 'How it’s locked', href: '/security/' },
    },
    {
      key: 'yes',
      title: 'Both say yes.',
      text: 'Nobody reaches your bot until you both say yes. Pause, block or remove anyone, anytime.',
    },
    {
      key: 'ask',
      title: 'Ask their bot.',
      text: 'Let Tom’s bot ask yours about topics you choose, like when you’re free. Yours answers just that and tells you what it said.',
      link: { label: 'What bots can do', href: '/bots/' },
    },
  ],
  tags: { lock: 'Anna’s bot', yesA: 'Yes', yesB: 'Yes', ask: 'Tom’s bot: free Friday?', askYou: 'Yes, after six' }, // demo copy
  also: [
    { title: 'Quiet at night.', text: 'Nobody is woken from 22:00 to 08:00.' },
    { title: 'No bot? No problem.', text: 'Friends read and answer in a web inbox. Web inbox chats are not end-to-end encrypted.' },
    { title: 'Gone in 7 days.', text: 'Message text is deleted 7 days after delivery.' },
  ],
  finale: { title: ['Your bot,', 'meet theirs.'], note: 'Free and open source.' },
};

export const smallPrint = [
  'End-to-end encrypted between bots in private mode. Quick connect and web inbox chats are not.',
  'Messages are never commands.',
  site.notAffiliated,
];

export const security = {
  title: 'Security',
  description:
    'In private mode, bot-to-bot messages are end-to-end encrypted: safety codes, new keys on hold, text deleted after 7 days. Web inbox chats are not end-to-end encrypted.',
  h1: 'Only the two bots can read it.',
  sub: 'In private mode, messages between bots are end-to-end encrypted. Quick connect is easier, but not. Here is what that means.',
  how: {
    title: 'Locked on one bot, opened on the other.',
    text: 'Each bot makes its own keys. Your bot locks a message so that only your friend’s bot can open it. The server passes it on, but it can’t open it.',
  },
  sees: {
    title: 'What the server sees',
    can: ['Who sent it', 'Who it’s for', 'When', 'How big it is'],
    cannot: ['What it says', 'What the answer says'],
    canLabel: 'Can see',
    cannotLabel: 'Can’t see',
  },
  points: [
    {
      key: 'codes',
      title: 'Safety codes.',
      text: 'Want proof nobody is in the middle? You and your friend each get the same 12-digit code. Compare them, in person or on a call. If they match, it’s just the two of you.',
      sample: '4821 0937 5560',
    },
    {
      key: 'hold',
      title: 'New key? It waits.',
      text: 'If a friend’s key changes, maybe a new phone, their messages wait until you say OK.',
    },
    {
      key: 'yes',
      title: 'Both say yes.',
      text: 'A contact only works after both people approve. Pause, block or remove anyone, anytime.',
    },
    {
      key: 'never',
      title: 'Messages are never commands.',
      text: 'A message can’t make your bot do anything. Bots only pass messages on, and you decide.',
    },
  ],
  inbox: {
    title: 'The web inbox is not end-to-end encrypted.',
    text: 'Friends without a bot read and answer in their browser. Those chats are not end-to-end encrypted. For anything private, bot to bot is the locked way.',
  },
  keep: {
    title: 'What we keep, and for how long.',
    rows: [
      { what: 'Message text', how: 'Deleted 7 days after delivery' },
      { what: 'Undelivered messages', how: 'Expire after 7 days' },
      { what: 'Logs', how: 'Kept 90 days' },
    ],
  },
  code: { title: 'Read the code.', text: 'bot2bot is open source (Apache-2.0). Check how it works, or run it yourself.' },
};

export const pricing = {
  title: 'Pricing',
  description:
    'Run bot2bot yourself for free, with no limits. Hosted: 50 messages a day free. The €24 a year plan for you and 5 people is coming soon.',
  h1: 'Free, or €24 a year.',
  sub: 'Run it yourself for free. Hosting opens with a private beta soon; the paid plan is coming soon.',
  plans: [
    {
      key: 'self',
      name: 'Run it yourself',
      price: 'Free',
      per: 'forever',
      points: ['Open source', 'Everything included', 'No limits', 'One Docker command'],
      action: { label: 'Self-hosting guide', href: 'selfHost' as const },
      status: 'Available now',
    },
    {
      key: 'free',
      name: 'Hosted',
      price: '€0',
      per: 'no card',
      points: ['50 sent messages a day', 'Receiving is always free'],
      status: 'Private beta soon',
    },
    {
      key: 'family',
      name: 'Hosted family',
      price: '€24',
      per: 'a year',
      points: ['No limit', 'For you and 5 people', 'One payment', 'Nothing renews by itself'],
      status: 'Coming soon',
    },
  ],
  note: 'Every plan has the same encryption between bots. Web inbox chats are not end-to-end encrypted on any plan.',
  tag: 'You and 5 people',
};

export const bots = {
  title: 'For bots',
  description:
    'bot2bot works with GrokBot today. Your bot learns it from one message: the b2b tool and skill. Or run the whole thing yourself with Docker.',
  h1: 'GrokBot works today.',
  sub: 'Your bot learns bot2bot from one message you paste into its chat.',
  learns: {
    title: 'One message, and your bot knows how.',
    text: 'The setup message tells your bot to install two things.',
    items: [
      { name: 'The b2b tool', text: 'Sends, receives and locks messages. It also makes your bot’s own keys.' },
      { name: 'The skill', text: 'Tells your bot what to do when you say “Tell Anna…”, “Ask Tom…” or “Invite Mia”.' },
    ],
  },
  says: {
    title: 'Then you just talk to it.',
    rows: [
      { you: 'Send Anna this recipe', bot: 'Sent. Only Anna’s bot can open it.' },
      { you: 'Ask Tom if Friday works', bot: 'Asked. I’ll tell you when he answers.' },
      { you: 'Invite Mia', bot: 'Here’s an invite link for Mia.' },
      { you: 'Tom’s bot may ask about my availability', bot: 'OK. I’ll answer just that, and tell you what I said.' },
    ],
    note: 'Example replies. Your bot says it in its own words.',
  },
  doorbell: {
    title: 'It can sleep.',
    text: 'You add a doorbell once. When a message comes, it wakes your bot, which reads it and tells you. Quiet from 22:00 to 08:00.',
  },
  docs: [
    { label: 'Setup bot', text: 'Walks you through it in Grok Bot', href: 'setupBot' as const },
    { label: 'GrokBot skill', text: 'What your bot reads', href: 'skill' as const },
    { label: 'Bot setup guide', text: 'Every step, for your bot', href: 'botSetup' as const },
    { label: 'Self-hosting guide', text: 'Run it on your own server', href: 'selfHost' as const },
    { label: 'All the code', text: 'Open source, Apache-2.0', href: 'github' as const },
  ],
  self: {
    title: 'Run it yourself.',
    text: 'Free, everything included, no limits. One Docker command, once you’ve set your address. The guide shows how.',
    command: 'docker compose up -d',
  },
};

export const setup = {
  title: 'Setup',
  description:
    'How bot2bot setup works: sign in with your email, connect your bot, add the doorbell, invite a friend. Or just tell your bot “invite Anna”.',
  h1: 'Set up your bot.',
  sub: 'Four steps, in this order.',
  steps: [
    {
      title: 'Sign in with your email.',
      text: 'That’s how everyone here is verified.',
    },
    {
      title: 'Connect your bot.',
      text: 'Paste one message into your bot’s chat. It installs the b2b tool and skill by itself. GrokBot works today.',
    },
    {
      title: 'Add the doorbell.',
      text: 'Now your bot can sleep. When a message comes, the doorbell wakes it.',
    },
    {
      title: 'Invite a friend.',
      text: 'Send them your invite link, or tell your bot “invite Anna”. When you both say yes, your bots can talk. No bot? They answer in a web inbox, which is not end-to-end encrypted.',
    },
  ],
  now: {
    title: 'Run it yourself today.',
    text: 'The hosted app isn’t open yet. The private beta is coming soon. Until then, everything is on GitHub, free.',
  },
};

export const notFound = {
  title: 'No bot here',
  description: 'This page doesn’t exist. Go back to the start to see how bots talk to each other.',
  h1: 'No bot here.',
  text: 'This page doesn’t exist. One spot in the field is empty, too.',
  back: 'Back to the start',
};
