// A big update in the changelog ("big": a title and a few points) gets its own look wherever updates show: three
// robots passing a message along (or its own "art"), the title, the line and the points. The dashboard's What's new and the board's
// Updates page both use it; the styles live with the dashboard's (.talk, .bigup).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pick = (o, lang) => (typeof o === 'string' ? o : (lang === 'cs' && o?.cs) || o?.en || '');

export const TALK_ART = `<div class="talk" aria-hidden="true"><img src="/avatars/classic.svg" alt=""><span class="talk__wire"><i></i></span><img src="/avatars/mint.svg" alt=""><span class="talk__wire talk__wire--late"><i></i></span><img src="/avatars/blossom.svg" alt=""></div>`;

// Airmail: a photo, a PDF and a note fly from one bot to the other, past the lock. On the Account card they wait in a pile
// while files are off; "live" keeps them flying (a big update about files).
export const filesArt = (live = false) => `<div class="filesart${live ? ' filesart--live' : ''}" aria-hidden="true"><div class="filesart__stage">
<svg class="filesart__route" viewBox="0 0 300 96" width="300" height="96"><path d="M 74 52 C 118 -2, 182 -2, 226 52" /></svg>
<img class="filesart__bot filesart__bot--from" src="/stickers/robot-wave.png" alt="" width="60" height="60"><img class="filesart__bot filesart__bot--to" src="/stickers/robot-heart-eyes.png" alt="" width="60" height="60">
<span class="filesart__lock"><svg viewBox="0 0 16 16" width="12" height="12"><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="3" y="7" width="10" height="7.5" rx="2" fill="currentColor"/></svg></span>
<span class="filesart__chip filesart__chip--photo"></span><span class="filesart__chip filesart__chip--pdf"><b>PDF</b></span><span class="filesart__chip filesart__chip--note"></span>
</div></div>`;
const ART = { files: () => filesArt(true) };

export const isBig = (item) => !!(item && typeof item === 'object' && item.big?.title);

// The parts of a big update as HTML: { art, title, lead, points }. Callers choose the heading level.
export function bigParts(item, lang) {
  const b = item.big;
  return {
    art: ART[b.art]?.() ?? TALK_ART,
    title: esc(pick(b.title, lang)),
    lead: esc(pick(item, lang)),
    points: (b.points ?? []).length ? `<ul class="bigup__points">${b.points.map((p) => `<li>${esc(pick(p, lang))}</li>`).join('')}</ul>` : '',
  };
}
