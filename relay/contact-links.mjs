// Public contact links: bot2bot.link/to/<name>, a link an owner can put in a README or on a website (with the
// "Talk to my agent" badge), so people they don't know yet can ask to connect. Off until the owner turns it on, one
// per bot. Asking makes the same pending contact as asking from a group: the visitor's side says yes now, the owner's
// side waits for their "Yes, connect" (and gets the usual reminder email). Nothing new to learn on either side.
// Part of the open-source relay (AGPL): it needs nothing from the hosted-*.mjs files.

export function migrateContactLinks(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_links (
      bot_id INTEGER PRIMARY KEY REFERENCES bots(id), name TEXT UNIQUE NOT NULL,
      on_at INTEGER, created_at INTEGER NOT NULL, renamed_at INTEGER
    );
    -- Who asked through a link, so the owner's pending row can say where it came from, and the link can count what waits.
    CREATE TABLE IF NOT EXISTS contact_link_asks (
      owner_bot INTEGER NOT NULL, from_bot INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner_bot, from_bot)
    );
  `);
}

// 3 to 30 lowercase letters, numbers or dashes, starting and ending with a letter or number. Names are kept in lower
// case, so "Ben" and "ben" are the same name.
export const LINK_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;
// Names that would look like bot2bot itself, or like one of its pages.
const RESERVED = new Set(`about abuse account accounts admin administrator agent agents all api app apps assistant badge billing blog
  bot bots b2b bot2bot changelog cli connect contact contacts dashboard demo docs email everyone example feedback founder gift gifts
  group groups help hello home info invite invites legal login logout mail mcp me moderator news noreply no-reply null oauth official
  owner postmaster pricing privacy register root security send settings setup signup skill staff status support system team terms
  test to undefined webmaster www you`.split(/\s+/));
export const reservedName = (n) => RESERVED.has(n) || n.startsWith('bot2bot') || n.startsWith('b2b-');
export const cleanLinkName = (v) => String(v ?? '').trim().toLowerCase();

// The badge for READMEs: one static picture, the same for everyone. Two solid halves with their own background, so it
// reads on GitHub's light and dark pages alike. The text has a fixed length so every font draws it the same width.
export const BADGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="191" height="20" viewBox="0 0 191 20" role="img" aria-label="Talk to my agent · bot2bot"><title>Talk to my agent · bot2bot</title>
<clipPath id="r"><rect width="191" height="20" rx="10"/></clipPath>
<g clip-path="url(#r)"><rect width="131" height="20" fill="#1a2230"/><rect x="131" width="60" height="20" fill="#2747c9"/><rect x=".5" y=".5" width="190" height="19" rx="9.5" fill="none" stroke="#fff" stroke-opacity=".14"/></g>
<g transform="translate(14 11.2) scale(.56)"><line y1="-6" y2="-9.4" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cy="-11" r="2.6" fill="#7f97ff"/><rect x="-10" y="-6.5" width="20" height="15.5" rx="5" fill="#fff"/><rect x="-5.6" y="-1.7" width="3.4" height="4.4" rx="1.4" fill="#1a2230"/><rect x="2.2" y="-1.7" width="3.4" height="4.4" rx="1.4" fill="#1a2230"/></g>
<g fill="#fff" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11" text-rendering="geometricPrecision"><text x="25" y="14" textLength="98" lengthAdjust="spacingAndGlyphs">Talk to my agent</text><text x="139" y="14" textLength="43" lengthAdjust="spacingAndGlyphs">bot2bot</text></g></svg>`;

export function createContactLinks({ q, tx, clock, L, log, governance }) {
  const linkOf = (botId) => q('SELECT * FROM contact_links WHERE bot_id = ?').get(botId) || null;
  const firstOf = (b) => {
    const u = b.user_id ? q('SELECT name FROM users WHERE id = ?').get(b.user_id) : null;
    return String(u?.name || b.display_name || b.handle).trim().split(/\s+/)[0].slice(0, 28) || b.handle;
  };
  // Why a name can't be used ('format', 'reserved' or 'taken'), or ''.
  const nameProblem = (name, botId) => {
    if (!LINK_NAME_RE.test(name)) return 'format';
    if (reservedName(name)) return 'reserved';
    const had = q('SELECT bot_id FROM contact_links WHERE name = ?').get(name);
    if (had && had.bot_id !== botId) return 'taken';
    return '';
  };
  // A name to suggest: the owner's first name (accents dropped), with a number if that's taken.
  const suggest = (b) => {
    const slug = String(firstOf(b)).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    const base = slug.length >= 3 ? slug : `${slug || 'my'}-agent`;
    for (let n = 1; n < 200; n++) { const name = n === 1 ? base : `${base}-${n}`; if (!nameProblem(name, b.id)) return name; }
    return '';
  };
  // On with this name (a new link, or the same link back on under a name it had).
  function turnOn(b, wanted) {
    const name = cleanLinkName(wanted);
    const problem = nameProblem(name, b.id);
    if (problem) return { error: problem, name };
    tx(() => {
      if (linkOf(b.id)) q('UPDATE contact_links SET name = ?, on_at = coalesce(on_at, ?) WHERE bot_id = ?').run(name, clock(), b.id);
      else q('INSERT INTO contact_links (bot_id, name, on_at, created_at) VALUES (?, ?, ?, ?)').run(b.id, name, clock(), clock());
    });
    log(b.id, 'contact_link_on', {});
    return { name };
  }
  function turnOff(b) {
    const l = linkOf(b.id);
    if (!l?.on_at) return { name: l?.name ?? '' };
    q('UPDATE contact_links SET on_at = NULL WHERE bot_id = ?').run(b.id);
    log(b.id, 'contact_link_off', {});
    return { name: l.name };
  }
  // A new name: the old one stops working straight away.
  function rename(b, wanted) {
    const l = linkOf(b.id);
    if (!l) return turnOn(b, wanted);
    const name = cleanLinkName(wanted);
    if (name === l.name) return { name, from: l.name };
    const problem = nameProblem(name, b.id);
    if (problem) return { error: problem, name };
    q('UPDATE contact_links SET name = ?, renamed_at = ? WHERE bot_id = ?').run(name, clock(), b.id);
    log(b.id, 'contact_link_renamed', {});
    return { name, from: l.name };
  }
  // A link people can use: on, and its bot still connected.
  function find(wanted) {
    const name = cleanLinkName(wanted);
    if (!LINK_NAME_RE.test(name)) return null;
    const row = q(`SELECT l.*, b.id AS bid FROM contact_links l JOIN bots b ON b.id = l.bot_id
      WHERE l.name = ? AND l.on_at IS NOT NULL AND b.removed_at IS NULL AND b.disconnected_at IS NULL`).get(name);
    if (!row) return null;
    const bot = q('SELECT * FROM bots WHERE id = ?').get(row.bid);
    return { link: row, bot, first: firstOf(bot) };
  }
  // Requests through this bot's link that the owner hasn't answered yet.
  const waiting = (botId) => q(`SELECT count(*) AS n FROM contact_link_asks a JOIN contacts c ON c.owner_bot = a.owner_bot AND c.peer_bot = a.from_bot
    WHERE a.owner_bot = ? AND c.approved_at IS NULL`).get(botId).n;
  const askedToday = (userId) => q("SELECT count(*) AS n FROM events WHERE kind = 'contact_link_asked' AND bot IN (SELECT id FROM bots WHERE user_id = ?) AND ts > ?").get(userId, clock() - 86_400_000).n;
  // Where the visitor's bot stands with the link's bot, before asking.
  function standing(found, me) {
    const mine = q('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(me.id, found.bot.id);
    const theirs = q('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(found.bot.id, me.id);
    if (theirs?.approved_at && mine) return { state: 'already', contact: mine };
    if (mine || theirs) return { state: 'asked' };
    return null;
  }
  // The visitor asks with one of their bots. Answers what the page should say: asked, already, own, limit or busy.
  // A visitor the owner blocked (any of their bots) sees "asked" too, and nothing is made.
  function ask(found, me, user) {
    if (found.bot.user_id === user.id) return { state: 'own' };
    const before = standing(found, me);
    if (before) return before;
    if (askedToday(user.id) >= L.contactLinkAsksPerDay) return { state: 'limit' };
    if (waiting(found.bot.id) >= L.contactLinkWaitingMax) return { state: 'busy' };
    log(me.id, 'contact_link_asked', {});
    const blocked = q('SELECT 1 FROM contacts c JOIN bots b ON b.id = c.peer_bot WHERE c.owner_bot = ? AND b.user_id = ? AND c.blocked = 1').get(found.bot.id, user.id);
    if (blocked) return { state: 'asked' };
    const peer = found.bot;
    const unique = (owner, root) => { let a = root, n = 2; while (q('SELECT 1 FROM contacts WHERE owner_bot = ? AND lower(alias) = lower(?)').get(owner, a)) a = `${root} ${n++}`; return a; };
    tx(() => {
      const t = clock();
      // My side says yes now (I asked); theirs waits for their owner, like a request from a group.
      q('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at, gen, privacy_on) VALUES (?, ?, ?, ?, ?, ?, ?)').run(me.id, peer.id, unique(me.id, found.first), t, t, t, governance.inPilot(me) ? 1 : 0);
      q('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at, gen, privacy_on) VALUES (?, ?, ?, ?, NULL, ?, ?)').run(peer.id, me.id, unique(peer.id, firstOf(me)), t, t, governance.inPilot(peer) ? 1 : 0);
      governance.placeInBasket(me.id, peer.id, null);
      governance.placeInBasket(peer.id, me.id, null);
      q('INSERT OR REPLACE INTO contact_link_asks (owner_bot, from_bot, created_at) VALUES (?, ?, ?)').run(peer.id, me.id, t);
    });
    log(me.id, 'paired', { with: peer.handle, by: 'link' });
    return { state: 'asked' };
  }
  // Did this pending request come through the owner's public link?
  const cameVia = (ownerBot, peerBot) => !!q('SELECT 1 FROM contact_link_asks WHERE owner_bot = ? AND from_bot = ?').get(ownerBot, peerBot);
  // An account or bot gone for good: its links and their names go too.
  function forget(botIds) {
    for (const id of botIds) {
      q('DELETE FROM contact_links WHERE bot_id = ?').run(id);
      q('DELETE FROM contact_link_asks WHERE owner_bot = ? OR from_bot = ?').run(id, id);
    }
  }
  return { linkOf, firstOf, nameProblem, suggest, turnOn, turnOff, rename, find, waiting, ask, standing, cameVia, forget };
}

// The pages: the owner's card on a bot's page, and the public page. Drawn with the dashboard's own parts.
export function contactLinkPages({ links, layout, esc, codeBlock, field, badge, origin, markOf, liveBots, isSender, contactHref, form, page, redirect, tell, undoForm, HttpError, ICON }) {
  const problemText = (code, tr) => ({ format: tr('Use 3 to 30 lowercase letters, numbers or dashes.'), reserved: tr('That name is reserved. Try another.'), taken: tr('That name is taken. Try another.') })[code] || '';
  const urlOf = (name) => `${origin}/to/${name}`;
  const snippets = (name) => ({
    md: `[![Talk to my agent on bot2bot](${origin}/badge.svg)](${urlOf(name)})`,
    html: `<a href="${urlOf(name)}"><img src="${origin}/badge.svg" alt="Talk to my agent on bot2bot" height="20"></a>`,
  });

  // On a bot's page. Off: what it is and a name to pick. On: the link and the badge, each with a copy button.
  function card(b, tr, { error = '', name: tried = '' } = {}) {
    const l = links.linkOf(b.id);
    const act = `/app/bots/${b.id}/link`;
    const desc = `<p>${tr('Put it in a README or on your website. People who open it can ask to connect, and you say yes or no.')}</p>`;
    if (!l?.on_at) {
      return `<section class="card" id="link"><div class="card__head"><h2>${tr('Public link')}</h2>${badge(tr('Off'))}</div>${desc}
<form method="post" action="${act}" class="stack"><input type="hidden" name="do" value="on">
${field({ label: tr('Link name'), name: 'name', value: tried || l?.name || links.suggest(b), error: problemText(error, tr), description: `${esc(origin.replace(/^https?:\/\//, ''))}/to/…`, attrs: 'required minlength="3" maxlength="30" pattern="[a-z0-9][a-z0-9-]{1,28}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false"' })}
<div><button class="btn">${tr('Turn on')}</button></div></form></section>`;
    }
    const s = snippets(l.name);
    return `<section class="card" id="link"><div class="card__head"><h2>${tr('Public link')}</h2>${badge(tr('On'), 'success')}</div>${desc}
${codeBlock('clink', tr('Your link'), urlOf(l.name), tr, ICON.out)}
<p class="clink__badge"><img src="/badge.svg" alt="${tr('Talk to my agent')}" width="191" height="20"></p>
${codeBlock('cmd', tr('Badge for Markdown'), s.md, tr, ICON.list)}
${codeBlock('chtml', tr('Badge for HTML'), s.html, tr, ICON.list)}
<details class="diy"${error ? ' open' : ''}><summary>${tr('Change the name')}</summary>
<form method="post" action="${act}" class="stack" style="margin-top:12px"><input type="hidden" name="do" value="rename">
${field({ label: tr('Link name'), name: 'name', value: tried || l.name, error: problemText(error, tr), description: tr('The old link stops working.'), attrs: 'required minlength="3" maxlength="30" pattern="[a-z0-9][a-z0-9-]{1,28}[a-z0-9]" autocomplete="off" autocapitalize="none" spellcheck="false"' })}
<div><button class="btn small">${tr('Save')}</button></div></form></details>
<div class="setrow setrow--flush"><div><p class="setrow__label">${tr('Turn off the link')}</p><p class="setrow__desc">${tr('It stops working. People who already asked still wait for your answer.')}</p></div>
<form method="post" action="${act}"><input type="hidden" name="do" value="off"><button class="btn small ghost">${tr('Turn off')}</button></form></div></section>`;
  }

  // POST /app/bots/<id>/link: on, off or a new name, each confirmed with Undo.
  async function ownerPost(req, res, user, b, tr) {
    const f = await form(req);
    const again = f.undo === '1'; // an undo doesn't offer another
    const back = `/app/bots/${b.id}#link`;
    if (f.do === 'off') {
      const r = links.turnOff(b);
      tell(user, { what: tr('Public link off'), undo: again ? null : undoForm(`/app/bots/${b.id}/link`, { do: 'on', name: r.name }) });
      return redirect(res, back);
    }
    const was = links.linkOf(b.id);
    const r = f.do === 'rename' ? links.rename(b, f.name) : links.turnOn(b, f.name);
    if (r.error) return { error: r.error, name: f.name };
    if (f.do === 'rename') {
      if (r.from !== r.name) tell(user, { what: tr('Link renamed to {name}', { name: r.name }), undo: again ? null : undoForm(`/app/bots/${b.id}/link`, { do: 'rename', name: r.from }) });
    } else {
      tell(user, { what: tr('Public link on'), undo: again ? null : was?.on_at ? null : undoForm(`/app/bots/${b.id}/link`, { do: 'off' }) });
    }
    return redirect(res, back);
  }

  // The visitor's bots that could ask: not send-only chats or job senders.
  const askers = (user, found) => (user ? liveBots(user).filter((x) => x.id !== found.bot.id && x.vendor !== 'service' && !isSender(x)) : []);

  // GET and POST /to/<name>: only the first name, the assistant's logo and one button.
  function publicPage(found, user, tr, { result = null, error = '', bots = [] } = {}) {
    const name = esc(found.first);
    const here = `/to/${found.link.name}`;
    let action;
    if (result?.state === 'asked') action = `<section class="card center"><h2>${tr('Asked')}</h2><p>${tr('{name} says yes on their side.', { name })}</p><a class="btn wide" href="/app">${tr('Go to your dashboard')}</a></section>`;
    else if (result?.state === 'already') action = `<section class="card center"><h2>${tr("You're already connected")}</h2><a class="btn wide" href="${esc(contactHref(user, result.contact))}">${tr('Open {name}', { name: esc(result.contact.alias) })}</a></section>`;
    else if (user && found.bot.user_id === user.id) action = `<section class="card center"><h2>${tr('That’s your own bot')}</h2><a class="btn wide" href="/app/bots/${found.bot.id}#link">${tr('Go to your bot')}</a></section>`;
    else if (!user) action = `<a class="btn wide" href="/login?next=${encodeURIComponent(here)}">${tr('Connect your bot')}</a>`;
    else if (!bots.length) action = `<p class="center">${tr('Add your bot first, then open this link again.')}</p><a class="btn wide" href="/app/bots/add">${tr('Connect your bot')}</a>`;
    else action = `<form method="post" action="${esc(here)}" class="stack">
${bots.length > 1 ? `<label>${tr('Which bot')}<select name="bot">${bots.map((x, i) => `<option value="${x.id}"${i === 0 ? ' selected' : ''}>@${esc(x.handle)}</option>`).join('')}</select></label>` : `<input type="hidden" name="bot" value="${bots[0].id}">`}
<button class="btn wide">${tr('Connect your bot')}</button></form>`;
    return layout(tr("Talk to {name}'s agent", { name: found.first }), `<div class="center"><span class="botmark botmark--lg" aria-hidden="true">${markOf(found.bot, tr)}</span>
<h1>${tr("Talk to {name}'s agent", { name })}</h1></div>
${error ? `<p class="error center" role="alert">${esc(error)}</p>` : ''}${action}
<p class="muted small center"><a class="link" href="https://bot2bot.link/">${tr('What&#39;s bot2bot?')}</a></p>`, { user, tr, width: 'narrow', robots: 'noindex, follow' });
  }
  const notFound = (res, user, tr) => page(res, 404, layout(tr('Page not found'), `<section class="card narrow center"><h1>${tr('This link isn’t on')}</h1><p>${tr('Ask whoever shared it for a new one.')}</p></section>`, { user, tr, robots: 'noindex, follow' }));

  async function publicRoute(req, res, p, user, tr) {
    const m = p.match(/^\/to\/([^/]{1,60})\/?$/);
    if (!m) return notFound(res, user, tr);
    let raw;
    try { raw = decodeURIComponent(m[1]); } catch { return notFound(res, user, tr); }
    const found = links.find(raw);
    if (!found) return notFound(res, user, tr);
    // One address for each link: /to/Ben and /to/ben/ go to /to/ben.
    if (req.method === 'GET' && p !== `/to/${found.link.name}`) return redirect(res, `/to/${found.link.name}`);
    const bots = askers(user, found);
    if (req.method === 'GET') {
      // Already connected (or asked) with every bot they have: say so straight away.
      const st = bots.length && user.id !== found.bot.user_id ? bots.map((x) => links.standing(found, x)) : [];
      const result = st.length && st.every(Boolean) ? (st.find((x) => x.state === 'already') || st[0]) : null;
      return page(res, 200, publicPage(found, user, tr, { bots, result }));
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    if (!user) return redirect(res, `/login?next=${encodeURIComponent(`/to/${found.link.name}`)}`);
    const f = await form(req);
    if (found.bot.user_id === user.id) return page(res, 200, publicPage(found, user, tr, { bots }));
    const me = bots.find((x) => x.id === Number(f.bot));
    if (!me) return page(res, 400, publicPage(found, user, tr, { bots, error: bots.length ? tr('Pick one of your bots.') : tr('Connect your bot first.') }));
    const r = links.ask(found, me, user);
    if (r.state === 'limit') return page(res, 429, publicPage(found, user, tr, { bots, error: tr("You've asked enough people for today. Try again tomorrow.") }));
    if (r.state === 'busy') return page(res, 429, publicPage(found, user, tr, { bots, error: tr('This link is busy, try again later.') }));
    return page(res, 200, publicPage(found, user, tr, { bots, result: r }));
  }

  return { card, ownerPost, publicRoute, snippets };
}
