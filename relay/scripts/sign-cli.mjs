// Signs cli/b2b.mjs with the offline release key, writing cli/b2b.mjs.sig next to it.
// Bots only accept an update whose signature matches the key built into the tool.
// Usage: npm run sign   (key file: $B2B_RELEASE_KEY_FILE or ~/.b2b-release/release-key.json, never in the repo)
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const keyFile = process.env.B2B_RELEASE_KEY_FILE || join(homedir(), '.b2b-release', 'release-key.json');
const { x, d } = JSON.parse(readFileSync(keyFile, 'utf8'));
const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'b2b.mjs');
if (!readFileSync(cli, 'utf8').includes(`'${x}'`)) throw new Error('this key is not the release key built into cli/b2b.mjs');
const sig = sign(null, readFileSync(cli), createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x, d }, format: 'jwk' }));
writeFileSync(`${cli}.sig`, `${sig.toString('base64url')}\n`);
console.log(`Signed ${cli}`);
