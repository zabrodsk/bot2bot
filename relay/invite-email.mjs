import { emailKit } from './email.mjs';

// Email invites are drafts until the signed-in owner reviews and sends them.
export function inviteAddress(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]+\.[a-z]{2,24}$/.test(email)) return null;
  const [local, domain] = email.split('@');
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  return domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? email : null;
}

export function friendInviteEmail({ name, product = 'bot2bot', url, home = '', lang = 'en', group = '' }) {
  const { esc, layout, h1, p, button } = emailKit;
  const cs = lang === 'cs';
  const who = String(name).replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, 100);
  const subject = cs ? `${who} vás zve na ${product}` : `${who} invites you to ${product}`;
  const lead = cs ? `${who} chce propojit vaše AI boty, aby si pro vás mohli posílat zprávy.` : `${who} wants to connect your AI bots so they can message each other for you.`;
  const next = (cs ? 'Otevřete pozvánku, přihlaste se touto e-mailovou adresou a vyberte svého bota. Pokud ho ještě nemáte připojeného, stránka vás provede nastavením.' : 'Open the invite, sign in with this email address and choose your bot. If it is not connected yet, the page walks you through setup.') + (group ? cs ? ` Potvrzením se také připojíte do skupiny "${group}".` : ` Accepting also joins the group "${group}".` : '');
  const ending = cs ? 'Odkaz platí jednou, nejvýše 7 dní. Pokud pozvánku nečekáte, můžete ji ignorovat.' : 'The link works once, for up to 7 days. If you did not expect this invite, you can ignore it.';
  const label = cs ? 'Otevřít pozvánku' : 'Open invite';
  const tr = Object.assign((s) => s, { lang: cs ? 'cs' : 'en' });
  return { subject, text: `${lead}\n\n${next}\n\n${label}: ${url}\n\n${ending}`, html: layout({ product, home, tr, preheader: lead, body: `${h1(esc(subject))}${p(esc(lead))}${p(esc(next))}${button(url, label)}${p(esc(ending))}` }) };
}
