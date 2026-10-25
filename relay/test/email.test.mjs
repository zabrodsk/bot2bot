// The designed emails: the code is in the subject (so mail apps offer "Copy code"), selectable in the
// body, and everything people type in is escaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginEmail, messageEmail } from '../email.mjs';

test('login email: code in subject, text and a selectable block, plus a sign-in button', () => {
  const m = loginEmail({ product: 'bot2bot', code: '123456', url: 'https://x.example/login/link?t=l_abc', home: 'https://x.example', logo: 'https://x.example/icon-192.png' });
  assert.equal(m.subject, 'Your bot2bot login code: 123456');
  assert.match(m.text, /code is 123456/);
  assert.match(m.html, /class="code"[^>]*user-select:all[^>]*>123456</);
  assert.match(m.html, /href="https:\/\/x\.example\/login\/link\?t=l_abc"/);
  assert.match(m.html, /Your code is 123456\. It expires in 15 minutes\./);
  assert.match(m.html, /prefers-color-scheme: dark/);
});

test('message email escapes names', () => {
  const m = messageEmail({ product: 'bot2bot', who: '<b>Eve</b>', inboxUrl: 'https://x.example/app/inbox', home: 'https://x.example' });
  assert.doesNotMatch(m.html, /<b>Eve<\/b>/);
  assert.match(m.html, /&lt;b&gt;Eve&lt;\/b&gt; sent you a message/);
});
