// The emails the relay sends, as plain text plus a designed HTML version (Arc tokens, like the site).
// Email clients run no scripts, so a real copy button isn't possible. Instead the code is one big
// selectable block (one tap selects all of it in Apple Mail and iOS), the subject carries the code so
// Gmail offers its own "Copy code" and Apple offers to fill it in, and a button signs you in directly.

import { t } from './i18n.mjs';

const C = {
  ground: '#f3f5f8', surface: '#ffffff', ink: '#1a2230', muted: '#586377', line: '#e3e6eb',
  accent: '#2747c9', accentSubtle: '#eaeefc', darkAccentSubtle: '#1d2747', darkGround: '#0f141c', darkSurface: '#171d27', darkInk: '#e9ecf2', darkMuted: '#9aa3b5', darkLine: '#2a3242',
};
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// One centred card on the page ground. `preheader` is the grey preview line inbox lists show.
// `hero` is a picture that sits on a tinted panel at the top of the card.
function layout({ product, logo, home, preheader, body, tr, hero = '' }) {
  return `<!doctype html>
<html lang="${tr.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(product)}</title>
<style>
  body { margin: 0; padding: 0; background: ${C.ground}; }
  a { color: ${C.accent}; }
  .code { -webkit-user-select: all; user-select: all; }
  @media (max-width: 520px) { .card { padding: 28px 22px !important; } .code { font-size: 30px !important; letter-spacing: 6px !important; } }
  @media (prefers-color-scheme: dark) {
    body, .page { background: ${C.darkGround} !important; }
    .card { background: ${C.darkSurface} !important; border-color: ${C.darkLine} !important; }
    .ink { color: ${C.darkInk} !important; } .muted { color: ${C.darkMuted} !important; }
    .codebox { background: ${C.darkGround} !important; border-color: ${C.darkLine} !important; }
    .code { color: ${C.darkInk} !important; }
    .btn { background: ${C.darkInk} !important; } .btn a { color: ${C.darkGround} !important; }
    .rule { border-color: ${C.darkLine} !important; }
    .hero, .stepnum { background: ${C.darkAccentSubtle} !important; border-color: ${C.darkLine} !important; }
    .stepnum { color: ${C.darkInk} !important; }
    .callout { background: ${C.darkAccentSubtle} !important; }
    .accent { color: #a9b8f5 !important; }
  }
</style></head>
<body style="margin:0;padding:0;background:${C.ground};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>
<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.ground};">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
    <tr><td style="padding:0 4px 18px;">
      <a href="${esc(home)}" style="text-decoration:none;">
        ${logo ? `<img src="${esc(logo)}" width="28" height="28" alt="" style="display:inline-block;vertical-align:middle;border:0;border-radius:7px;">` : ''}
        <span class="ink" style="display:inline-block;vertical-align:middle;margin-left:${logo ? 8 : 0}px;font-family:${SANS};font-size:17px;font-weight:600;letter-spacing:-0.02em;color:${C.ink};">${esc(product)}</span>
      </a>
    </td></tr>
    ${hero ? `<tr><td class="hero" align="center" style="background:${C.accentSubtle};border:1px solid ${C.line};border-bottom:0;border-radius:18px 18px 0 0;padding:30px 0 6px;line-height:0;">${hero}</td></tr>` : ''}
    <tr><td class="card" style="background:${C.surface};border:1px solid ${C.line};${hero ? 'border-top:0;border-radius:0 0 18px 18px;padding:30px 36px 32px;' : 'border-radius:18px;padding:36px 36px 32px;'}">
      ${body}
    </td></tr>
    <tr><td class="muted" style="padding:18px 4px 0;font-family:${SANS};font-size:12px;line-height:1.6;color:${C.muted};">
      <a href="${esc(home)}" class="muted" style="color:${C.muted};text-decoration:none;">${esc(home.replace(/^https?:\/\//, ''))}</a> · ${esc(tr('Bot to bot. Your bot talks to their bot.'))}
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

const h1 = (text) => `<h1 class="ink" style="margin:0 0 10px;font-family:${SANS};font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.02em;color:${C.ink};">${esc(text)}</h1>`;
const p = (html, extra = '') => `<p class="muted" style="margin:0 0 22px;font-family:${SANS};font-size:15px;line-height:1.55;color:${C.muted};${extra}">${html}</p>`;
const button = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;"><tr>
  <td class="btn" style="background:${C.ink};border-radius:12px;"><a href="${esc(href)}" style="display:inline-block;padding:13px 22px;font-family:${SANS};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">${esc(label)}</a></td>
</tr></table>`;

// The same card, title, text and button for emails made outside this file (hosted-invites.mjs).
export const emailKit = { C, SANS, esc, layout, h1, p, button };

/** The sign-in email: the code first, then a one-tap sign-in button for the same browser. */
export function loginEmail({ product = 'bot2bot', code, url, minutes = 15, home, logo = '', lang = 'en' }) {
  const tr = t(lang);
  const subject = tr('Your {product} login code: {code}', { product, code });
  const text = `${tr('Your {product} login code is {code}', { product, code })}\n\n${tr('Or sign in with this link, in the same browser you started in: {url}', { url })}\n\n${tr("It expires in {minutes} minutes. If you didn't ask for it, you can ignore this email.", { minutes })}`;
  const body = `${h1(tr('Your login code'))}
${p(tr('Enter this code on the {product} sign-in page. It works for {minutes} minutes.', { product: esc(product), minutes }))}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;"><tr>
  <td class="codebox" align="center" style="background:${C.ground};border:1px solid ${C.line};border-radius:14px;padding:20px 12px;">
    <span class="code" style="font-family:${MONO};font-size:36px;line-height:1;font-weight:600;letter-spacing:10px;color:${C.ink};-webkit-user-select:all;user-select:all;">${esc(code)}</span>
  </td>
</tr></table>
${p(tr('Tap the code to select it, then copy.'), 'font-size:13px;margin:0 0 26px;text-align:center;')}
${p(tr('Or skip the code and sign in straight away. Open it in the browser where you asked for the code.'), 'margin:0 0 14px;')}
${button(url, tr('Sign in to {product}', { product }))}
<div class="rule" style="border-top:1px solid ${C.line};margin:4px 0 18px;"></div>
${p(tr("If you didn't ask for this, you can ignore this email. Nobody can sign in without this code or link."), 'font-size:13px;margin:0;')}`;
  return { subject, text, html: layout({ product, logo, home, preheader: tr('Your code is {code}. It expires in {minutes} minutes.', { code, minutes }), body, tr }) };
}

/** "Someone sent you a message", for people on the web inbox. */
export function messageEmail({ product = 'bot2bot', who, inboxUrl, home, logo = '', lang = 'en' }) {
  const tr = t(lang);
  const subject = tr('{who} sent you a message', { who });
  const text = `${tr('{who} sent you a message on {product}.', { who, product })}\n\n${tr('Read it and answer here: {url}', { url: inboxUrl })}\n\n${tr('You get this because you accepted their invitation. You can pause or block anyone from your inbox.')}`;
  const body = `${h1(tr('{who} sent you a message', { who }))}
${p(tr('Read it and answer on {product}.', { product: esc(product) }))}
${button(inboxUrl, tr('Open my inbox'))}
<div class="rule" style="border-top:1px solid ${C.line};margin:4px 0 18px;"></div>
${p(tr('You get this because you accepted their invitation. You can pause or block anyone from your inbox.'), 'font-size:13px;margin:0;')}`;
  return { subject, text, html: layout({ product, logo, home, preheader: tr('{who} sent you a message on {product}.', { who, product }), body, tr }) };
}

/** A one-minute screen recording of the whole Grok Bot setup, doorbell included (no sound, so it works in every language). */
export const DOORBELL_VIDEO = 'https://www.loom.com/share/a7b24335fd2a443b980e2ad27dacb5c5';

/** Sent once (see doorbellNudgeAtMs) when a Grok bot joined but still can't be woken: no doorbell yet ('make'), or one
 *  that never answered a test ring ('test'). Without a doorbell it opens with the setup video, which explains it
 *  better than any steps. There's no second one: the bot mentions it in chat when its owner uses bot2bot. */
export function doorbellEmail({ product = 'bot2bot', handle, stage = 'make', botUrl, home, logo = '', art = '', video = '', lang = 'en' }) {
  const tr = t(lang);
  const testing = stage === 'test';
  const subject = testing ? tr('One last step for @{handle}', { handle }) : tr('Set up @{handle} in one minute', { handle });
  const lead = testing ? tr("@{handle} has its doorbell, but it hasn't answered a test ring yet, so friends' bots may not be able to wake it.", { handle })
    : tr("@{handle} still can't be woken by friends' bots. This one-minute video shows the whole setup in Grok Bot.", { handle });
  const steps = testing ? [tr("Open your bot's page and press Ring my bot."), tr("Don't type to your bot for a minute. It should wake up on its own.")]
    : [tr("Open your bot's page on a computer."), tr("Copy POST to and key from your bot's b2b doorbell routine in Grok Bot. The page shows where.")];
  const cta = testing ? tr('Test the doorbell') : tr('Turn on the doorbell');
  const foot = tr('It takes about two minutes. This is the only email about it.');
  // Phones don't show a routine's webhook, so the one step that needs a computer can't be missed.
  const computerOnly = tr('Computer only');
  const computerTitle = tr('This needs Grok Bot on a Mac or PC.');
  const computerText = tr("Phones don't show the webhook.");
  const watch = tr('Watch how it’s done in Grok Bot (1 min)');
  const watchText = testing ? '' : `${watch}: ${DOORBELL_VIDEO}\n\n`;
  const text = `${lead}\n\n${watchText}${testing ? '' : `${computerOnly.toUpperCase()}: ${computerTitle} ${computerText}\n\n`}${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n${cta}: ${botUrl}\n\n${foot}`;
  const step = (n, x) => `<tr><td valign="top" width="40" style="padding:0 0 14px;"><div class="stepnum" style="width:28px;height:28px;border-radius:14px;background:${C.accentSubtle};color:${C.accent};font-family:${SANS};font-size:14px;font-weight:600;line-height:28px;text-align:center;">${n}</div></td>
  <td class="ink" valign="top" style="padding:4px 0 14px;font-family:${SANS};font-size:15px;line-height:1.5;color:${C.ink};">${esc(x)}</td></tr>`;
  const computer = testing ? '' : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;"><tr>
  <td class="callout" style="background:${C.accentSubtle};border:1px solid ${C.accent};border-radius:14px;padding:14px 16px;">
    <div style="margin:0 0 6px;"><span class="badge" style="display:inline-block;background:${C.accent};color:#ffffff;font-family:${SANS};font-size:12px;font-weight:600;line-height:1;padding:6px 10px;border-radius:999px;">&#128187;&nbsp; ${esc(computerOnly)}</span></div>
    <div class="ink" style="font-family:${SANS};font-size:15px;line-height:1.5;color:${C.ink};"><b>${esc(computerTitle)}</b> ${esc(computerText)}</div>
  </td>
</tr></table>`;
  const player = testing ? '' : `${video ? `<a href="${DOORBELL_VIDEO}" style="display:block;margin:0 0 8px;text-decoration:none;"><img src="${esc(video)}" width="100%" alt="${esc(watch)}" style="display:block;border:0;width:100%;max-width:100%;height:auto;border-radius:12px;border:1px solid ${C.line};"></a>` : ''}
${p(`<a class="accent" href="${DOORBELL_VIDEO}" style="color:${C.accent};text-decoration:none;font-weight:600;">&#9654;&nbsp; ${esc(watch)}</a>`, 'font-size:14px;margin:0 0 22px;')}`;
  const body = `${h1(testing ? tr('One last step: test the doorbell') : tr('The doorbell, in one minute'))}
${p(esc(lead))}
${player}
${computer}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;">${steps.map((x, i) => step(i + 1, x)).join('')}</table>
${button(botUrl, cta)}
${p(esc(foot), 'font-size:13px;margin:0;')}`;
  const hero = art ? `<img src="${esc(art)}" width="132" height="132" alt="${esc(tr('A sleepy robot'))}" style="display:inline-block;border:0;width:132px;height:132px;">` : '';
  return { subject, text, html: layout({ product, logo, home, preheader: testing ? tr("Turn on @{handle}'s doorbell so friends' bots can wake it.", { handle }) : tr("Turn on @{handle}'s doorbell, on a computer, so friends' bots can wake it.", { handle }), body, tr, hero }) };
}

/** Sent when a message has waited a day without its bot picking it up (see nudgeWaiting): who wrote, never what,
 *  and how to get it now. Once per batch of messages. */
// `noDoorbell`: nothing can wake this bot, so the email comes after a couple of hours and is about switching one on.
export function waitingEmail({ product = 'bot2bot', handle, who, count = 1, noDoorbell = false, hours = 2, botUrl, home, logo = '', art = '', lang = 'en' }) {
  const tr = t(lang);
  const subject = tr('{who} wrote to @{handle}', { who, handle });
  const title = tr.n(count, '{n} message is waiting for @{handle}|{n} messages are waiting for @{handle}', { handle });
  const lead = noDoorbell
    ? tr.n(hours, 'From {who}, an hour ago. @{handle} has no doorbell yet, so it only sees messages when you talk to it.|From {who}, {n} hours ago. @{handle} has no doorbell yet, so it only sees messages when you talk to it.', { who, handle })
    : tr("From {who}, over a day ago. @{handle} hasn't checked its messages since.", { who, handle });
  const ask = tr.n(count, 'To get it now, tell your bot:|To get them now, tell your bot:');
  const say = tr('“Check my bot2bot messages.”');
  const more = noDoorbell ? tr('Switch its doorbell on and it wakes up by itself next time. It takes a couple of minutes.') : tr("Its page shows how it can wake up on its own when a message comes.");
  const cta = noDoorbell ? tr('Switch on the doorbell') : tr("Open @{handle}'s page", { handle });
  const foot = tr('We never say what a message says. Messages wait up to 7 days.');
  const text = `${title}\n\n${lead}\n\n${ask} ${say}\n\n${more}\n${cta}: ${botUrl}\n\n${foot}`;
  const body = `${h1(title)}
${p(esc(lead))}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;"><tr>
  <td class="callout" style="background:${C.accentSubtle};border-radius:14px;padding:14px 16px;">
    <div class="muted" style="margin:0 0 4px;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.muted};">${esc(ask)}</div>
    <div class="ink" style="font-family:${SANS};font-size:16px;line-height:1.5;font-weight:600;color:${C.ink};">${esc(say)}</div>
  </td>
</tr></table>
${p(esc(more))}
${button(botUrl, cta)}
${p(esc(foot), 'font-size:13px;margin:0;')}`;
  const hero = art ? `<img src="${esc(art)}" width="132" height="132" alt="${esc(tr('A sleepy robot'))}" style="display:inline-block;border:0;width:132px;height:132px;">` : '';
  return { subject, text, html: layout({ product, logo, home, preheader: lead, body, tr, hero }) };
}

/** Sent once when a bot still hasn't updated its bot2bot tool a couple of hours after a contact's bot was refused
 *  because of it (it couldn't open their file yet, say). `who`: the names of the people waiting, up to three. */
export function updateEmail({ product = 'bot2bot', handle, who = [], botUrl, home, logo = '', art = '', lang = 'en' }) {
  const tr = t(lang);
  const names = who.length <= 1 ? (who[0] ?? '') : `${who.slice(0, -1).join(', ')} ${lang === 'cs' ? 'a' : 'and'} ${who.at(-1)}`;
  const subject = tr('@{handle} needs a quick update', { handle });
  const lead = names ? tr("{who} sent @{handle} something its bot2bot tool is too old to open.", { who: names, handle })
    : tr('Something is waiting for @{handle}, but its bot2bot tool is too old to open it.', { handle });
  const ask = tr('To update it, tell your bot:');
  const say = tr('“Update bot2bot and check my messages.”');
  const more = tr('It takes a minute. Nothing is lost: once it has updated, their bot hears and can send it again.');
  const cta = tr("Open @{handle}'s page", { handle });
  const foot = tr('We never say what a message says.');
  const text = `${subject}\n\n${lead}\n\n${ask} ${say}\n\n${more}\n${cta}: ${botUrl}\n\n${foot}`;
  const body = `${h1(subject)}
${p(esc(lead))}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;"><tr>
  <td class="callout" style="background:${C.accentSubtle};border-radius:14px;padding:14px 16px;">
    <div class="muted" style="margin:0 0 4px;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.muted};">${esc(ask)}</div>
    <div class="ink" style="font-family:${SANS};font-size:16px;line-height:1.5;font-weight:600;color:${C.ink};">${esc(say)}</div>
  </td>
</tr></table>
${p(esc(more))}
${button(botUrl, cta)}
${p(esc(foot), 'font-size:13px;margin:0;')}`;
  const hero = art ? `<img src="${esc(art)}" width="132" height="132" alt="${esc(tr('A thinking robot'))}" style="display:inline-block;border:0;width:132px;height:132px;">` : '';
  return { subject, text, html: layout({ product, logo, home, preheader: lead, body, tr, hero }) };
}

/** Sent once when bots paired on their own and this owner hasn't confirmed yet. `invited`: their bot made the invite
 *  (then it also suggests inviting from the dashboard next time); otherwise their bot accepted someone's invite. */
export function approveEmail({ product = 'bot2bot', who, mine, invited = false, url, home, logo = '', art = '', lang = 'en' }) {
  const tr = t(lang);
  const subject = invited ? tr('{who} accepted your invite', { who }) : tr('Confirm your connection with {who}', { who });
  const lead = invited ? tr('Your bot @{mine} invited {who}. Tap Yes, connect on your {product} page, and your bots can start talking.', { mine, who, product })
    : tr('Your bot @{mine} accepted an invite from {who}. Tap Yes, connect on your {product} page, and your bots can start talking.', { mine, who, product });
  const tip = invited ? tr('Next time, try inviting from your {product} page. You choose their basket and rules there, and there\'s nothing to confirm afterwards.', { product }) : '';
  const foot = invited ? tr("Didn't ask your bot to invite them? Tap No, remove instead.") : tr('Not someone you know? Tap No, remove instead.');
  const text = `${lead}\n\n${url}\n\n${tip ? `${tip}\n\n` : ''}${foot}`;
  const body = `${h1(subject)}
${p(esc(lead))}
${button(url, tr('Open {product}', { product }))}
${tip ? `<div class="rule" style="border-top:1px solid ${C.line};margin:4px 0 18px;"></div>
${p(esc(tip), 'font-size:13px;margin:0 0 10px;')}` : ''}
${p(esc(foot), 'font-size:13px;margin:0;')}`;
  const hero = art ? `<img src="${esc(art)}" width="132" height="132" alt="${esc(tr('A waving robot'))}" style="display:inline-block;border:0;width:132px;height:132px;">` : '';
  return { subject, text, html: layout({ product, logo, home, preheader: lead, body, tr, hero }) };
}

// The same card, heading, text and button for emails made elsewhere (the hosted feedback board).
export const emailParts = { layout, h1, p, button, esc, C, SANS };
