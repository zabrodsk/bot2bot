// Feedback: one general question for everyone, then one question about a single part of bot2bot. The part is one
// this person really uses (`when`), and nobody gets the same question twice. Answers are Yes / Mostly / No.
// Add a question by adding a line; keep it short and about one thing. Czech sits next to the English.
export const FEEDBACK_QUESTIONS = [
  { id: 'setup', en: 'Was connecting your Grok Bot easy?', cs: 'Bylo připojení vašeho Grok Bota snadné?', when: (c) => c.bots > 0 },
  { id: 'doorbell', en: 'Does your bot wake up when a friend writes?', cs: 'Probudí se váš bot, když vám přítel napíše?', when: (c) => c.doorbell },
  { id: 'right-messages', en: 'Does your bot tell you about the right messages, and only those?', cs: 'Říká vám bot o těch správných zprávách, a jen o nich?', when: (c) => c.received > 0 },
  { id: 'answers-itself', en: 'Does your bot answer the right things on its own?', cs: 'Odpovídá váš bot sám na ty správné věci?', when: (c) => c.received >= 3 },
  { id: 'wants', en: "When a friend's bot writes, is it clear what they want from you?", cs: 'Když napíše bot přítele, je jasné, co od vás chce?', when: (c) => c.received > 0 },
  { id: 'asks-first', en: 'When your bot asks you first, is it at the right moments?', cs: 'Když se vás bot nejdřív zeptá, je to ve správnou chvíli?', when: (c) => c.asked > 0 },
  { id: 'invite', en: 'Was inviting a friend easy?', cs: 'Bylo pozvání přítele snadné?', when: (c) => c.invited > 0 },
  { id: 'names', en: 'Is it easy to name your friends the way you call them?', cs: 'Jde snadno pojmenovat přátele tak, jak jim říkáte?', when: (c) => c.contacts > 0 },
  { id: 'baskets', en: 'Do baskets help you decide what your bot handles on its own?', cs: 'Pomáhají vám košíky určit, co bot vyřídí sám?', when: (c) => c.sorted > 0 },
  { id: 'in-control', en: 'Do you feel in control of what your bot shares?', cs: 'Máte pod kontrolou, co váš bot sdílí?', when: (c) => c.contacts > 0 },
  { id: 'quiet-hours', en: 'Do quiet hours work the way you expect?', cs: 'Funguje vám noční klid tak, jak čekáte?', when: (c) => c.quiet },
  { id: 'encryption', en: 'Is it clear which chats are end-to-end encrypted?', cs: 'Je jasné, které chaty jsou šifrované end-to-end?', when: () => true },
  { id: 'phone', en: 'Can you do everything you need from your phone?', cs: 'Zvládnete z telefonu všechno, co potřebujete?', when: () => true },
  { id: 'updates', en: 'Do you notice when bot2bot gets better?', cs: 'Všimnete si, když se bot2bot zlepší?', when: (c) => c.sawUpdate },
  { id: 'free-limit', en: 'Are 50 free messages a day enough for you?', cs: 'Stačí vám 50 zpráv denně zdarma?', when: (c) => c.freePlan },
  { id: 'czech', en: 'Does the Czech in bot2bot sound natural?', cs: 'Zní čeština v bot2bot přirozeně?', when: (c) => c.lang === 'cs' },
];
export const QUESTION_BY_ID = new Map(FEEDBACK_QUESTIONS.map((q) => [q.id, q]));
// The next question for this person: the ones that fit what they use, in an order of their own (so people
// don't all get the same one first), skipping any they were already asked.
export function nextQuestion(ctx, askedIds, seed) {
  const asked = new Set(askedIds);
  const score = (id) => { let h = 2166136261 ^ seed; for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
  return FEEDBACK_QUESTIONS.filter((q) => !asked.has(q.id) && q.when(ctx)).sort((a, b) => score(a.id) - score(b.id))[0] ?? null;
}
