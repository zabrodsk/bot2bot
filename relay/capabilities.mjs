// What a bot can do with a handoff package, from what it said it is when it joined (bots.platform, recorded by
// POST /v1/join --agent, the dashboard or the connected app's name) and how it connects (bots.vendor). Other bots'
// tools read it in /v1/contacts to pick how a package travels: as an end-to-end encrypted attachment, or inline.
// Only these capabilities are shared with contacts, never which app the bot is.
//   files: can save and read an attached file (null = not known, so nothing relies on it)
//   repo:  can use repositories; credentials and access to a particular repository must be checked separately
//   shell: can run the b2b tool (thread show --brief and the rest)
//   transport: attachment (package as an E2EE file, short note in the message), attachment+inline (the same, plus
//   the package in the message when it fits, for a bot that can't open repos), inline (package is the message text)
export const CAPABILITIES_SPEC = 'b2b-capabilities/1';
const CODING = new Set(['claude_code', 'codex', 'cursor', 'hermes', 'openclaw', 't3code']);

export function capabilityProfile(bot) {
  const p = (files, repo, shell, transport) => ({ spec: CAPABILITIES_SPEC, files, repo, shell, transport });
  if (!bot) return p(null, false, false, 'inline');
  // A web inbox is a person reading in a browser; a quick connect app has no files and no shell of ours.
  if (bot.vendor === 'web' || bot.vendor === 'connector') return p(false, false, false, 'inline');
  if (CODING.has(bot.platform)) return p(true, true, true, 'attachment');
  // Grok Bot and Cue: cloud computers with a terminal and files, seen sending and saving files, but no
  // access to the owner's repositories.
  if (!bot.platform || bot.platform === 'grok' || bot.platform === 'cue') return p(true, false, true, 'attachment+inline');
  // A dot in private mode, Instinct, other assistants: they run the tool, but whether they can open a saved file
  // isn't known, so the package goes in the (still end-to-end encrypted) message.
  return p(null, false, true, 'inline');
}
