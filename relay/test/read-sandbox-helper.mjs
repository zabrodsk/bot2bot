// Test-only CLI copies. No production environment variable can bypass confinement or read the real login.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function sandboxCli(mode = 'real') {
  const path = join(mkdtempSync(join(tmpdir(), 'b2b-sandbox-cli-')), 'b2b.mjs');
  let source = readFileSync(join(import.meta.dirname, '../cli/b2b.mjs'), 'utf8');
  source = source.replace('function sandboxLogin(', 'function unusedSandboxLogin(');
  source = source.replace('// ───── end shared read sandbox ─────', `function sandboxLogin() { return {}; }\n// ───── end shared read sandbox ─────`);
  if (mode !== 'real') {
    source = source.replace('function readSandboxAvailable()', 'function unusedReadSandboxAvailable()').replace('function confinedRun(', 'function unusedConfinedRun(');
    source = source.replace('// ───── end shared read sandbox ─────', `
function readSandboxAvailable() { return ${mode === 'fake'}; }
function confinedRun(agent, command, args) { return ${mode === 'fake' ? "{ confined: true, command, args, env: { ...process.env, B2B_UNATTENDED: '1' }, cleanup() {} }" : "{ confined: false, reason: 'No sandbox: test platform.' }"}; }
// ───── end shared read sandbox ─────`);
  }
  writeFileSync(path, source); return path;
}
