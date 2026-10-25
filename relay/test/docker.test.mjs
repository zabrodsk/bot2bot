// Both images copy an explicit file list. A module missing from it crashes the server on start
// (it happened once with email.mjs), so every server module must be in both Dockerfiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const relay = join(dirname(fileURLToPath(import.meta.url)), '..');
const modules = readdirSync(relay).filter((f) => f.endsWith('.mjs'));

test('every server module is copied into both Docker images', () => {
  for (const file of [join(relay, 'Dockerfile'), join(relay, '..', 'Dockerfile')]) {
    const docker = readFileSync(file, 'utf8');
    for (const m of modules) assert.match(docker, new RegExp(`\\b${m.replace('.', '\\.')}\\b`), `${m} is missing from ${file}`);
  }
});
