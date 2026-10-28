// The emails the relay sends, as plain text plus a designed HTML version (Arc tokens, like the site).
// Email clients run no scripts, so a real copy button isn't possible. Instead the code is one big
// selectable block (one tap selects all of it in Apple Mail and iOS), the subject carries the code so
// Gmail offers its own "Copy code" and Apple offers to fill it in, and a button signs you in directly.

import { t } from './i18n.mjs';

const C = {
  ground: '#f3f5f8', surface: '#ffffff', ink: '#1a2230', muted: '#586377', line: '#e3e6eb',
  accent: '#2747c9', darkGround: '#0f141c', darkSurface: '#171d27', darkInk: '#e9ecf2', darkMuted: '#9aa3b5', darkLine: '#2a3242',
};
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// One centred card on the page ground. `preheader` is the grey preview line inbox lists show.
function layout({ product, logo, home, preheader, body, tr }) {
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
    <tr><td class="card" style="background:${C.surface};border:1px solid ${C.line};border-radius:18px;padding:36px 36px 32px;">
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
