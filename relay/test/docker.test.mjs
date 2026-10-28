// Both images copy every server module with one wildcard (relay/*.mjs). An explicit list once missed a module
// (email.mjs) and the server crashed on start; the wildcard also means the open-source relay (without the
// hosted-*.mjs files) and the hosted one build from the same Dockerfiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const relay = join(dirname(fileURLToPath(import.meta.url)), '..');
const images = [[join(relay, 'Dockerfile'), ''], [join(relay, '..', 'Dockerfile'), 'relay/']];

test('both Docker images copy every server module with a wildcard, hosted parts or not', () => {
  // The hosted image (repo root) isn't part of the open-source copy; the relay's own image always is.
  for (const [file, prefix] of images.filter(([f]) => existsSync(f))) {
    const docker = readFileSync(file, 'utf8');
    assert.match(docker, new RegExp(`^COPY ${prefix.replace('/', '\\/')}\\*\\.mjs \\./$`, 'm'), `${file} copies ${prefix}*.mjs`);
    // No module named one by one (a hosted file listed by name would break the open-source build).
    const copies = docker.split('\n').filter((l) => l.startsWith('COPY ')).join('\n');
    for (const m of readdirSync(relay).filter((f) => f.endsWith('.mjs'))) assert.doesNotMatch(copies, new RegExp(`\\b${m.replace('.', '\\.')}\\b`), `${m} is listed by name in ${file}`);
    assert.match(docker, /CMD \["node", "server\.mjs"\]/);
  }
});
