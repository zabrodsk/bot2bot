// Usage: node relay/evals/review-eval.mjs [runs per provider, 1-10] [both|claude-code|codex] [--no-update|--ring]
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { lintHandoff } from '../handoff.mjs';
import { createRelay } from '../server.mjs';
import { ADMIN, connectHandled, listen, login, waitFor } from '../test/helpers.mjs';

const cliPath = fileURLToPath(new URL('../cli/b2b.mjs', import.meta.url));
const exec = promisify(execFile);
const readJson = (path) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const providers = { 'claude-code': 'claude', codex: 'codex' };
const count = Number(process.argv[2] ?? 1);
const direction = process.argv[3] ?? 'both';
const mode = process.argv[4];
const ring = mode === '--ring';
const runUpdate = mode === undefined;
assert(Number.isInteger(count) && count >= 1 && count <= 10, 'Choose 1 to 10 runs per provider.');
assert(direction === 'both' || Object.hasOwn(providers, direction), 'Choose both, claude-code or codex.');
assert(mode === undefined || mode === '--no-update' || ring, 'Choose --no-update or --ring.');
assert(!ring || count === 1, 'Use one run per provider for the doorbell smoke test. The wake turn uses a model too.');
assert(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'), 'The cross-owner eval requires macOS sandbox-exec.');

const cleanEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME'].flatMap((key) =>
  process.env[key] ? [[key, process.env[key]]] : []));
const ownerHome = homedir();
const codexHome = process.env.CODEX_HOME || join(ownerHome, '.codex');
if (direction !== 'claude-code') {
  const auth = readJson(join(codexHome, 'auth.json'));
  assert(auth.tokens && !auth.OPENAI_API_KEY, 'This eval expects a Codex ChatGPT login because Codex does not enforce a dollar cap.');
}
const claudeDir = process.env.CLAUDE_CONFIG_DIR;
const claudeMetadata = readJson(claudeDir ? join(claudeDir, '.claude.json') : join(ownerHome, '.claude.json')).oauthAccount;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'b2b-review-eval-')));
const cleanup = [];
let watcher;
let shuttingDown;
async function stopWatcher() {
  if (!watcher) return;
  const child = watcher;
  watcher = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}
function shutdown() {
  return shuttingDown ??= (async () => {
    await stopWatcher();
    for (const fn of cleanup.reverse()) await fn();
    rmSync(root, { recursive: true, force: true });
  })();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { void shutdown().then(() => process.exit(130)); });

const fixture = {
  'dispatch.mjs': `
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeliveryError extends Error {
  constructor(message, { status, retryable, cause } = {}) {
    super(message, { cause });
    this.name = 'DeliveryError';
    this.status = status;
    this.retryable = retryable ?? false;
  }
}

function retryDelay(response, clock) {
  const header = response.headers.get('Retry-After');
  if (!header) return null;
  if (/^\\d+$/.test(header)) return Number(header) * 1000;
  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - clock()) : null;
}

async function post({ endpoint, token, event, fetcher, timeoutMs, clock }) {
  let response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
        'X-Event-Type': event.type,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (cause) {
    throw new DeliveryError('Webhook connection failed', { cause, retryable: true });
  }

  const status = response.status;
  if (status >= 200 && status < 300) {
    await response.body?.cancel();
    return { status };
  }

  const error = new DeliveryError('Webhook returned HTTP ' + status, {
    status,
    retryable: status === 429 || status >= 500,
  });
  error.retryAfterMs = retryDelay(response, clock);
  await response.body?.cancel();
  throw error;
}

export function createDispatcher({
  endpoint,
  token,
  fetcher = fetch,
  clock = Date.now,
  delay = sleep,
  timeoutMs = 5000,
  attempts = 3,
  minDelayMs = 200,
  maxDelayMs = 10000,
}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new TypeError('Webhook URL must use HTTPS');
  if (!token) throw new TypeError('Webhook token required');
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError('attempts must be a positive integer');
  }

  return async function dispatch(event) {
    if (!event.id || !event.type) throw new TypeError('Event ID and type required');

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await post({ endpoint: url, token, event, fetcher, timeoutMs, clock });
        return { ...result, attempts: attempt };
      } catch (error) {
        if (!error.retryable || attempt === attempts) throw error;
        const backoff = error.retryAfterMs ?? minDelayMs * 2 ** (attempt - 1);
        await delay(Math.min(backoff, maxDelayMs));
      }
    }
  };
}
`,
  'worker.mjs': `
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createWorker({
  queue,
  dispatch,
  logger,
  clock = Date.now,
  batchSize = 25,
  leaseMs = 60000,
}) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError('batchSize must be a positive integer');
  }

  async function deliver(item, counters) {
    const started = clock();
    try {
      const result = await dispatch(item.event);
      await queue.complete(item.id, item.lease, {
        httpStatus: result.status,
        attempts: result.attempts,
        deliveredAt: clock(),
      });
      counters.delivered += 1;
      logger.info('webhook delivered', {
        id: item.id,
        elapsedMs: clock() - started,
      });
    } catch (error) {
      if (error.retryable) {
        await queue.release(item.id, item.lease, {
          availableAt: clock() + 60000,
          error: errorText(error),
        });
        counters.retry += 1;
      } else {
        await queue.fail(item.id, item.lease, { error: errorText(error) });
        counters.failed += 1;
      }
      logger.warn('webhook delivery failed', {
        id: item.id,
        error: errorText(error),
      });
    }
  }

  return async function work({ signal } = {}) {
    const counters = { delivered: 0, failed: 0, retry: 0, released: 0 };
    if (signal?.aborted) return counters;
    const items = await queue.claim({ limit: batchSize, leaseMs, now: clock() });

    let index = 0;
    try {
      for (; index < items.length - 1 && !signal?.aborted; index++) {
        await deliver(items[index], counters);
      }
    } finally {
      for (const remaining of items.slice(index)) {
        await queue.release(remaining.id, remaining.lease, { availableAt: clock() });
        counters.released += 1;
      }
    }
    return counters;
  };
}

export async function drain(worker, { limit = 5, signal } = {}) {
  const total = { delivered: 0, failed: 0, retry: 0, released: 0 };

  for (let batch = 0; batch < limit && !signal?.aborted; batch++) {
    const counts = await worker({ signal });
    for (const key of Object.keys(total)) total[key] += counts[key];
    if (counts.delivered + counts.failed + counts.retry === 0) break;
  }

  return total;
}
`,
  'subscriptions.mjs': `
const EVENT_TYPES = new Set([
  'invoice.created',
  'invoice.paid',
  'invoice.voided',
]);

function normalizeEventTypes(types) {
  if (!Array.isArray(types) || !types.length) {
    throw new TypeError('Choose at least one event type');
  }
  const unique = [...new Set(types)];
  for (const type of unique) {
    if (!EVENT_TYPES.has(type)) throw new TypeError('Unsupported event: ' + type);
  }
  return unique;
}

function normalizeEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError('Use an HTTPS URL with no credentials or fragment');
  }
  return url.href;
}

export function createSubscriptions({ store, clock = Date.now, nextId }) {
  async function subscribe({ organizationId, endpoint, eventTypes }) {
    if (!organizationId) throw new TypeError('Organization required');
    const subscription = {
      id: nextId(),
      organizationId,
      endpoint: normalizeEndpoint(endpoint),
      eventTypes: normalizeEventTypes(eventTypes),
      enabled: true,
      createdAt: clock(),
    };
    await store.insert(subscription);
    return subscription;
  }

  async function setEnabled({ id, organizationId, enabled }) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    const current = await store.find(id);
    if (!current || current.organizationId !== organizationId) return null;
    const changed = { ...current, enabled, updatedAt: clock() };
    await store.update(id, changed);
    return changed;
  }

  async function listForEvent({ organizationId, type }) {
    if (!EVENT_TYPES.has(type)) return [];
    const subscriptions = await store.listForOrganization(organizationId);
    return subscriptions.filter((sub) => sub.enabled && sub.eventTypes.includes(type));
  }

  return { subscribe, setEnabled, listForEvent };
}
`,
  'enqueue.mjs': `
export function createEnqueuer({ subscriptions, queue, clock = Date.now }) {
  return async function enqueue({ organizationId, event }) {
    if (!organizationId || !event.id || !event.type) {
      throw new TypeError('Organization, event ID and type required');
    }

    const targets = await subscriptions.listForEvent({
      organizationId,
      type: event.type,
    });
    if (!targets.length) return { enqueued: 0 };

    const availableAt = clock();
    const entries = targets.map((target) => ({
      organizationId,
      subscriptionId: target.id,
      destination: target.endpoint,
      availableAt,
      event: {
        id: event.id,
        type: event.type,
        payload: event.payload,
      },
    }));

    const enqueued = await queue.insertUnique(entries, {
      key: ['subscriptionId', 'event.id'],
    });
    return { enqueued };
  };
}
`,
  'README.md': `
# Invoice webhooks

Each organization can register an HTTPS endpoint for the invoice events it needs.
The billing service gives each event a stable ID before adding it to the queue.
An endpoint may create a record as soon as it receives a POST and before it
returns a response. Receivers support the Idempotency-Key header and deduplicate
requests with the same key. They may also ask senders to back off with Retry-After.

## Running the worker

The service drains up to five batches per job. The queue gives the worker a lease
for every claimed item. On success, complete it. On retryable errors, release it
with a new availability time. On other errors, move it to the failure queue for
inspection. Release any unprocessed work when a job is interrupted.

Each queue adapter must provide these operations:

| Method | Result |
| --- | --- |
| claim | The next available entries and a lease for each |
| complete | Marks an entry delivered with HTTP status and attempt count |
| release | Makes an entry available at the specified time |
| fail | Stores the entry in the failure queue for operators |

## Event payload

Events have an ID, event type and an invoice payload. The invoice payload is an
immutable snapshot taken at the moment the billing service commits a change.
Subscription changes apply when a later event is enqueued. A delivery attempt
never changes the snapshot already in the queue.

The endpoint responds with any 2xx status after it has accepted the event. A 429
or 5xx response can be retried. Other 4xx codes go to the failure queue.

## Metrics

The job logs delivery latency with the queue item ID. It reports totals for
deliveries, retries, failed items and released leases. The authorization token
and event payload stay out of logs.
`,
};

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...cleanEnv, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}
function stageClaudeLogin(home) {
  const config = join(home, '.claude');
  const source = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? claudeDir ?? '';
  let credentials;
  // macOS searches a different Keychain list once HOME points at the eval bot.
  // Read the OAuth record in the trusted parent and use the watcher's file fallback.
  const suffix = source ? '-' + createHash('sha256').update(source.normalize('NFC')).digest('hex').slice(0, 8) : '';
  try {
    const output = execFileSync('/usr/bin/security', [
      'find-generic-password', '-a', userInfo().username, '-w', '-s', `Claude Code-credentials${suffix}`,
    ], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    credentials = JSON.parse(output);
  } catch {
    credentials = readJson(join(source || join(ownerHome, '.claude'), '.credentials.json'));
  }
  assert(credentials?.claudeAiOauth, 'Claude Code needs a local OAuth login.');
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, '.credentials.json'), JSON.stringify({ claudeAiOauth: credentials.claudeAiOauth }), { mode: 0o600 });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: claudeMetadata }), { mode: 0o600 });
}
function buildRepo() {
  const cwd = join(root, 'author-repo');
  mkdirSync(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'eval@example.invalid');
  git(cwd, 'config', 'user.name', 'Review eval');
  git(cwd, 'commit', '-qm', 'Empty base', '--allow-empty');
  git(cwd, 'checkout', '-qb', 'webhooks');
  for (const [name, source] of Object.entries(fixture)) writeFileSync(join(cwd, name), source.trimStart());
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'Add invoice webhook delivery');
  const lines = git(cwd, 'diff', '--numstat', 'main', 'webhooks').split('\n')
    .reduce((sum, line) => sum + Number(line.split('\t')[0]), 0);
  assert(lines >= 270 && lines <= 330, `Expected about 300 added lines, got ${lines}`);
  console.log(JSON.stringify({ fixture_added_lines: lines }));
  return cwd;
}

async function localStorage() {
  const blobs = new Map();
  const storage = await listen(async (req, res) => {
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      blobs.set(req.url.split('?')[0], Buffer.concat(chunks));
      res.writeHead(200).end();
    } else if (req.method === 'DELETE') {
      blobs.delete(req.url.split('?')[0]);
      res.writeHead(204).end();
    } else {
      const body = blobs.get(req.url.split('?')[0]);
      res.writeHead(body ? 200 : 404).end(body);
    }
  });
  cleanup.push(() => { storage.s.close(); storage.s.closeAllConnections(); });
  return { alpha: true, s3: { endpoint: storage.url, bucket: 'review-eval', region: 'auto', keyId: 'eval', secret: 'eval', style: 'path' } };
}

async function localRelay(files) {
  let relay;
  const pending = new Set();
  const { s, url } = await listen((req, res) => {
    const done = Promise.allSettled([once(res, 'close'), relay.handle(req, res)]);
    pending.add(done);
    void done.then(() => pending.delete(done));
  });
  const mail = [];
  relay = createRelay({
    files, publicUrl: url, dbPath: join(root, 'relay.db'),
    adminToken: ADMIN, allowLocalWebhooks: true, limits: { watchHoldMs: 200 },
    mailer: async (message) => { mail.push(message); },
  });
  let tick;
  const timer = setInterval(() => {
    tick ??= relay.tick().catch(() => {}).finally(() => { tick = null; });
  }, 100);
  cleanup.push(async () => {
    clearInterval(timer);
    const closed = once(s, 'close');
    s.close();
    s.closeAllConnections();
    // Closing the socket can still leave a watch response's close handler in the queue.
    await Promise.all([closed, tick, ...pending]);
    relay.db.close();
  });
  return { relay, url, mail };
}

async function createBot(relay, platform, project) {
  const handle = platform === 'codex' ? 'codexeval' : 'claudeeval';
  const b = await login(relay, `${handle}@example.com`);
  const created = await b('/app/bots', { method: 'POST', form: { handle } });
  assert.equal(created.status, 303, `Local bot creation returned ${created.status}.`);
  const app = (await b('/app')).text;
  const home = join(root, handle);
  mkdirSync(home, { mode: 0o700 });
  const env = { ...cleanEnv, HOME: home, B2B_HOME: home, B2B_FILES: join(home, 'files') };
  const cli = async (cwd, extra, ...args) => {
    try {
      return (await exec(process.execPath, [cliPath, ...args], { cwd, env: { ...env, ...extra }, timeout: 30_000 })).stdout;
    } catch (error) {
      // The start code and enrollment credentials must stay out of the eval output.
      const detail = args[0] === 'enroll' ? '' : (error.stdout || error.stderr || '').trim();
      throw new Error(`b2b ${args.slice(0, 2).filter((_, i) => args[0] !== 'enroll' || i === 0).join(' ')} failed (${error.code ?? error.signal}): ${detail}`);
    }
  };
  await cli(project, {}, 'enroll', relay.url, app.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]);
  const botId = (await b('/app')).text.match(/\/app\/bots\/(\d+)/)[1];
  assert.equal(readJson(join(home, 'config.json')).relay, relay.url);
  relay.relay.db.prepare('UPDATE bots SET platform = ? WHERE id = ?').run(platform.replace('-', '_'), Number(botId));
  if (platform === 'claude-code' && direction !== 'codex') stageClaudeLogin(home);
  if (platform === 'codex' && direction !== 'claude-code') {
    const isolated = join(home, '.codex');
    mkdirSync(isolated, { mode: 0o700 });
    writeFileSync(join(isolated, 'auth.json'), readFileSync(join(codexHome, 'auth.json')), { mode: 0o600 });
  }
  return { b, botId, handle, home, env, cli, platform };
}

function startWatcher(bot, bin, project) {
  const loginEnv = bot.platform === 'codex' ? { CODEX_HOME: join(bot.home, '.codex') } : {};
  watcher = spawn(process.execPath, [cliPath, 'watch', '--agent', bot.platform, '--bin', bin, ...(ring ? ['--only-b2b'] : [])], {
    cwd: project, env: { ...bot.env, ...loginEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const stream of [watcher.stdout, watcher.stderr]) {
    stream.setEncoding('utf8').on('data', (text) => { log = (log + text).slice(-12000); });
  }
  return () => log;
}

function foundBugs(verdict, isUpdate) {
  const findings = verdict.findings;
  const bugs = [];
  if (!isUpdate && findings.some((f) => f.file.endsWith('dispatch.mjs') && /idempoten|deduplicat/i.test(f.issue + ' ' + f.suggestion))) bugs.push('A');
  if (findings.some((f) => f.file.endsWith('worker.mjs') && /off.by.one|(?:last|final) (?:claimed |queue )?(?:item|entry|element|webhook)|length\s*-\s*1|single.item/i.test(f.issue + ' ' + f.suggestion))) bugs.push('B');
  return bugs;
}

async function runReview({ relay, author, reviewer, bin, cwd, project, session, sequence, prior }) {
  const authorEnv = { B2B_SESSION: session, B2B_SESSION_AGENT: author.platform };
  let logs = () => '';
  if (ring) {
    logs = startWatcher(reviewer, bin, project);
    await waitFor(async () => (await reviewer.b(`/app/bots/${reviewer.botId}/state`)).json().watching, 10_000);
  }
  const started = performance.now();
  const args = prior ? ['update', prior.thread] : [
    'request', '@' + reviewer.handle, '--project', 'invoices', '--branch', 'webhooks', '--base', 'main',
    '--brief', 'Review the addition of invoice webhook subscriptions and delivery.',
    '--focus', 'Correctness, data integrity and queue behavior.',
    '--tests', 'No author tests supplied.',
    '--question', 'Is this ready for a worker rollout?',
  ];
  const sent = await author.cli(cwd, authorEnv, 'review', ...args);
  const message = sent.match(/Sent (msg_[\w-]+)/)?.[1];
  const outgoing = Object.values(readJson(join(author.home, 'reviews.json')).outgoing).find((row) => row.message === message);
  assert(outgoing, 'The author request did not save an outgoing review.');
  if (prior) assert.equal(outgoing.thread, prior.thread);

  // Use the same inbox entry point as a normal wake. Keep generic welcome/wake turns
  // out of the paid calls so the only model runs are the actual confined reviews.
  const state = () => readJson(join(reviewer.home, 'reviews.json'));
  const record = { author: author.platform, reviewer: reviewer.platform, sequence, round: outgoing.round, ring };
  try {
    if (ring) await waitFor(() => state().incoming?.[outgoing.thread]?.message === message, 100_000);
    else await reviewer.cli(project, { B2B_UNATTENDED: '1' }, 'inbox', '--via', 'watch');
    const request = relay.relay.db.prepare('SELECT status, sealed, text, thread_id, project FROM messages WHERE id = ?').get(message);
    assert(request?.status === 'delivered' && request.sealed && !request.text && !request.thread_id && !request.project,
      'The relay did not deliver the sealed request to the reviewer inbox.');
    if (!ring) logs = startWatcher(reviewer, bin, project);
    await waitFor(() => {
      if (watcher.exitCode !== null || watcher.signalCode !== null) throw new Error('Watcher exited.');
      if ((readJson(join(reviewer.home, 'for-owner.json')).lines ?? []).some((x) => x.line.includes(message) && x.line.includes('started nothing'))) {
        throw new Error('Watcher held the review before starting the provider.');
      }
      return (state().incoming?.[outgoing.thread]?.metrics ?? []).find((m) => m.message === message);
    }, 610_000);
    const metrics = state().incoming[outgoing.thread].metrics.find((m) => m.message === message);
    const draft = state().drafts[message];
    const verdict = draft.verdict;
    Object.assign(record, {
      confined: metrics.read_confined, parsed: metrics.parsed, provider_seconds: metrics.duration_ms / 1000,
      cost_usd: metrics.cost_usd, exit_code: metrics.exit_code, over_budget: metrics.over_budget,
      verdict: verdict.verdict, bugs: foundBugs(verdict, !!prior),
    });
    const reply = await waitFor(() => {
      const row = relay.relay.db.prepare(`SELECT id, sealed, text, thread_id, project FROM messages
        WHERE reply_to = ? AND from_bot = ? AND to_bot = ?`).get(message, Number(reviewer.botId), Number(author.botId));
      if (row && state().drafts[message]?.sent) return row;
      if (draft.auto_blocked || (readJson(join(reviewer.home, 'for-owner.json')).lines ?? [])
        .some((x) => x.line.includes(outgoing.thread) && x.line.includes('waiting as a draft'))) {
        throw new Error('Automatic verdict stayed in a draft.');
      }
    }, 65_000);
    assert(reply.sealed && !reply.text && !reply.thread_id && !reply.project, 'The relay saw private review content.');
    const unrelated = { ...authorEnv, B2B_SESSION: randomUUID() };
    const inbox = await author.cli(cwd, unrelated, 'inbox', '--json');
    assert(!inbox.split('\n').filter(Boolean).map(JSON.parse).some((x) => x.type === 'message' && x.id === reply.id));
    const other = JSON.parse(await author.cli(cwd, unrelated, 'handoff', '--json'));
    assert.equal(other.items.length, 0, 'An unrelated session received the verdict.');
    const received = JSON.parse(await author.cli(cwd, authorEnv, 'handoff', '--json'));
    const item = received.items.find((x) => x.id === reply.id);
    assert(item && item.thread === outgoing.thread && item.reply_to === message && item.handoff?.ask === 'result', 'The verdict did not reach the requesting session.');
    const thread = readJson(join(author.home, 'threads.json')).threads[outgoing.thread];
    const event = thread?.events.find((e) => e.msg === item.id && e.dir === 'in');
    assert(event?.path, 'The author did not save the received verdict package in the thread.');
    const result = lintHandoff(readFileSync(event.path, 'utf8'));
    assert(result.ok && result.meta.in_reply_to === outgoing.packageId, 'The received package did not validate against the request.');
    assert.deepEqual(JSON.parse(result.sections['code review verdict']), verdict);
    record.routed = true;
  } catch (error) {
    record.routed = false;
    record.error = error.message;
    if (ring) record.woke = logs().includes('ring: starting');
    // Provider diagnostics can include environment details. Print only known, non-secret signals.
    record.diagnostics = logs().split('\n').filter((line) =>
      /not logged in|invalid api key|oauth token has expired|login required|tim(?:e|ed) out|budget exceeded|usage limit|cannot locate the installed|operation not permitted/i.test(line))
      .map((line) => line.match(/not logged in|invalid api key|oauth token has expired|login required|tim(?:e|ed) out|budget exceeded|usage limit|cannot locate the installed|operation not permitted/i)[0]);
  } finally {
    record.round_trip_seconds = Math.round(performance.now() - started) / 1000;
    console.log(JSON.stringify(record));
    await stopWatcher();
  }
  const withinBudget = reviewer.platform === 'codex' || (typeof record.cost_usd === 'number' && record.cost_usd < 1);
  assert(record.routed && record.parsed && record.confined && withinBudget && !record.over_budget && record.round_trip_seconds < 600,
    'Stopped after a failed review. Diagnose it before spending on another run.');
  return outgoing;
}

async function main() {
  const cwd = buildRepo();
  const project = join(root, 'reviewer-repo');
  git(root, 'clone', '-q', '--single-branch', '--branch', 'main', cwd, project);
  const files = await localStorage();
  const relay = await localRelay(files);
  const bots = {};
  const bins = {};
  for (const [platform, program] of Object.entries(providers)) {
    bots[platform] = await createBot(relay, platform, project);
    if (direction === 'both' || direction === platform) {
      bins[platform] = execFileSync('/usr/bin/which', [program], { env: cleanEnv, encoding: 'utf8' }).trim();
      console.log(JSON.stringify({ provider: platform, version: execFileSync(bins[platform], ['--version'], {
        cwd: project, env: bots[platform].env, encoding: 'utf8',
      }).trim() }));
    }
  }
  const [claude, codex] = Object.values(bots);
  await connectHandled(claude, codex, codex.handle);
  for (const [from, to] of [[claude, codex], [codex, claude]]) {
    await from.cli(cwd, {}, 'handoff', 'share', '@' + to.handle, 'allow');
    await from.cli(project, {}, 'project', 'add', 'invoices', project, '--allow', '@' + to.handle);
    await from.cli(project, {}, 'review', 'allow', '@' + to.handle, '--project', 'invoices');
  }
  for (const [platform, bin] of Object.entries(bins)) {
    const reviewer = bots[platform];
    const author = reviewer === claude ? codex : claude;
    const session = randomUUID();
    const options = { relay, author, reviewer, bin, cwd, project, session };
    let prior;
    for (let sequence = 1; sequence <= count; sequence++) prior = await runReview({ ...options, sequence });
    // Do one incremental review using the last Claude result and its remaining native budget.
    if (runUpdate && platform === 'claude-code') {
      const original = git(cwd, 'rev-parse', 'webhooks');
      const path = join(cwd, 'dispatch.mjs');
      const source = readFileSync(path, 'utf8');
      writeFileSync(path, source.replace("'X-Event-Type': event.type,", "'X-Event-Type': event.type,\n        'Idempotency-Key': event.id,"));
      try {
        git(cwd, 'commit', '-qam', 'Use stable webhook idempotency key');
        await runReview({ ...options, sequence: count, prior });
      } finally {
        git(cwd, 'reset', '--hard', original);
      }
    }
  }
}
try { await main(); } finally { await shutdown(); }
