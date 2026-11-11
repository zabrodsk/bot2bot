// Bounded operational metadata. No handles, labels or message content.
import { ASSISTANT } from './platforms.mjs';
import { JOIN_AS } from './doorbells.mjs';
const platforms = new Set(['sender', 'grokbot', 'web', 'chatgpt', 'openclaw', 'other', ...Object.keys(ASSISTANT), ...Object.values(JOIN_AS)]);
export function messagePlatform(bot) {
  const platform = bot.platform || (bot.vendor === 'web' ? 'web' : bot.vendor === 'grokbot' ? 'grokbot' : 'other');
  return platforms.has(platform) ? platform : 'other';
}
export function messageRoute(sender, recipient, group = false) {
  if (group) return 'group';
  if (sender.user_id != null && sender.user_id === recipient.user_id) return sender.platform === 'sender' && sender.vendor === 'connector' ? 'chat_to_own' : 'own_to_own';
  return 'cross_owner';
}
