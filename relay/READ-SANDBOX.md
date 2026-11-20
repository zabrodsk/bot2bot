# Read sandbox

`confinedRun` is the shared macOS runner for watcher-started code reviews and scoped question answers. A provider's read-only mode prevents writes but does not limit which files it can read. This runner adds a `sandbox-exec` profile around the provider process and its descendants.

Reviews allow the registered project folder and that review's own copied files folder. Questions allow only their filtered snapshot, never the source project. The ordinary project-planning runner is unchanged. Its answer stays on the owner's machine.

## Profile

`readSandboxProfile` generates this profile. `ROOT...` represents each explicitly supplied, realpath-resolved read folder. `HOME` is a fresh mode-0700 temporary directory. `READ...` and `EXEC...` are the exact executable paths described below, with JSON string escaping. There are no user-controlled profile fragments.

```scheme
(version 1)
(allow default)
(deny file-read-data)
(deny file-write*)
(deny process-exec)
(deny network*)
(allow network-outbound (remote tcp "*:443") (remote udp "*:53"))
(allow network* (local unix-socket) (remote unix-socket))
(allow file-read-data
  (subpath "/System/Library")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/Library/Apple")
  (subpath "/private/etc/ssl")
  (subpath "/private/var/db/timezone")
  (subpath "ROOT...")
  (subpath "HOME")
  (literal "/")
  (literal "/private/etc/hosts")
  (literal "/private/etc/resolv.conf")
  (literal "/private/etc/localtime")
  (literal "/private/etc/services")
  (literal "/dev/null")
  (literal "/dev/random")
  (literal "/dev/urandom")
  (literal "READ..."))
(allow file-write* (subpath "HOME") (literal "/dev/null"))
(allow process-exec (literal "EXEC..."))
```

The system directories supply libraries, frameworks, public runtime resources, certificates and timezone data. Claude Code 2.1.311 hung at startup without the timezone directory, because `/etc/localtime` resolves there. The root literal permits listing the filesystem root. File metadata and ordinary process and Mach service operations retain the default allowance. This is a filesystem read and write boundary, not isolation from every macOS service.

The profile intentionally grants `/System/Library`, not `/System`: the latter includes the data-volume alias `/System/Volumes/Data`. Tests check that an outside file is denied through that alias as well as its normal path, a `../` path and a symlink inside the allowed folder.

For a native Claude installation, the executable allowance is its exact resolved binary. A script installation also permits the Node executable running bot2bot. For npm Codex installations, the runner resolves the native binary within that package's known vendor layout. It allows that exact binary and its adjacent `codex-code-mode-host`, when installed. It does not grant the parent bin directory, the whole installation tree, `/bin/sh`, or other shell executables. Unknown layouts fail rather than expanding access automatically.

Outbound TCP is limited to port 443 and DNS UDP to port 53. Provider HTTPS endpoints use changing addresses, so this does not restrict HTTPS by hostname. Local Unix sockets support provider runtime IPC. There is no general inbound TCP listener allowance. Proxy settings and arbitrary inherited environment variables are not passed through.

## Existing login, temporary state

The trusted watcher reads the normal login before starting the confined child. It never writes to the owner's provider homes.

| Provider | What the watcher reads | What the child can read |
| --- | --- | --- |
| Claude Code | `~/.claude.json`, or `.claude.json` under `CLAUDE_CONFIG_DIR`; the `Claude Code-credentials` Keychain item, with the provider's config-directory hash suffix when applicable; `.credentials.json` as a fallback | A temporary `.claude.json` containing only `hasCompletedOnboarding` and `oauthAccount`; a temporary `.credentials.json` containing only `claudeAiOauth` |
| Codex | `auth.json` under `CODEX_HOME` or `~/.codex` | A temporary copy of `auth.json` |

The Keychain lookup uses `/usr/bin/security find-generic-password` in the trusted parent, through macOS security services. Its output is parsed in memory, never logged or put into command arguments. Other Claude Keychain fields, including MCP OAuth credentials and trusted-device tokens, are omitted. The child receives no Keychain database allowance and cannot execute `security`. A separate diagnostic proved that allowing only `~/Library/Keychains/login.keychain-db` made direct sandboxed Keychain queries work; the final design avoids that broader exposure by staging just the provider login.

Neither child can read the original `~/.claude`, `~/.codex`, original `.claude.json`, bot2bot state, or other projects unless the owner explicitly registered such a folder as a project read root. Exact runtime binaries remain allowed if installed under a provider home. Session transcripts, history, settings, plugins and skills from the provider home are not copied. The staged credentials and Claude account metadata are readable to the provider and its reading tools. The profile cannot distinguish a provider's own credential read from a model-requested read in the same process. So the watcher checks every confined answer before anything is drafted or sent: if it contains a piece (16 characters or more) of the staged login, as it is, with spaces or line breaks in it, reversed, or as base64 or hex, the answer is discarded, nothing leaves the computer, and the owner is told. This stops the plain leak. It is not proof against every encoding a model could invent, which is one reason an answer for another owner goes through the owner unless they chose otherwise.

Only PATH, HOME, TMPDIR, XDG_RUNTIME_DIR, USER, LANG, B2B_UNATTENDED and the selected provider's runtime variables are passed. An existing `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `OPENAI_API_KEY` is passed only to its own provider. Login does not require one of these variables on the tested OAuth installations.

Claude uses plan mode, only Read/Grep/Glob, strict MCP configuration, disabled hooks and slash commands, no session persistence, and `--setting-sources project,local`. Its temporary config prevents loading user settings. Codex ignores user configuration and disables connected apps, plugins, browser, computer, image, web, shell and multi-agent tools. Its runtime output file goes in the temporary home. Codex without shell tools has no text-file Read tool in the tested version. Its native image reader remains available within the OS read boundary. Question prompts therefore carry the filtered snapshot text, bounded to 60 KB; review prompts carry the diff and handoff context.

Credential files have mode 0600. Temporary state is removed after success, provider failure or timeout, and on ordinary watcher exit and handled termination signals. SIGKILL, a process crash or a power loss can leave a private temporary directory behind. OAuth refreshes affect only the temporary copy; they are not written back. Expired, revoked or custom login stores can therefore fail and require the owner to restore their normal provider login. Codex's optional keyring-only credential store and nonstandard vendor layouts have not been verified or implemented as fallbacks.

## No sandbox

On Linux, Windows or a machine without `sandbox-exec`, `confinedRun` returns `confined: false` with "No sandbox". Scoped questions start no answering provider and notify the owner. Review sessions may still produce local drafts using their original read-only flags. A verdict without recorded confinement cannot be sent automatically to another owner, even with `review allow`. The send command rechecks the current `your_own_bot` relationship. Another of the same owner's bots is the explicit exception. Owner-approved draft sending remains available.

A sandbox startup or provider login failure on macOS produces no automatic outbound verdict or answer. No attempt retries outside the sandbox.

## Verification on 2026-11-17

Twenty-four tiny real provider starts were used, including startup diagnostics and two deliberately wider read-control runs. Every run used a scratch working directory and temporary provider state. Claude runs used `--setting-sources project,local`. No real bot, hosted relay or two-owner message exchange was involved. Original provider files were read only for login staging. Each run removed its staged login afterward.

The final production helper was tested with Claude Code 2.1.311 and Codex 0.169.0, after narrowing `/System` to `/System/Library` and enabling the network restrictions above.

- A Claude Code session authenticated using the staged normal Keychain OAuth login, read `INSIDE_CANARY_781` from `work/inside.txt`, and reported the exact outside error: `EPERM: operation not permitted, open '<temp folder>/outside.txt'`. It exited 0 and reported $0.046686. The model used was the CLI's default, `claude-opus-5-5`.
- A Codex session authenticated using the normal `auth.json` copy and returned the `INSIDE_CANARY_781` marker from the scratch project's `AGENTS.md`, which was not present in its prompt. It exited 0. Its exact limitation was: "No Read tool is available, so I could not read either file or obtain an exact outside error." This proves startup, login and loading an allowed project file. No dollar cost was reported. A separate native-image-reader run below provides the direct outside-read refusal without enabling a shell.

- A Codex session used its native `view_image` tool under the same final profile, with shell tools still disabled. It reported "Inside read: succeeded." and then "unable to read image at <temp folder>/outside.png: Operation not permitted (os error 1)". It authenticated with the normal staged login and exited 0. This proves an actual Codex tool can read an allowed file and is denied an outside file. The preceding image probe reached the same outside denial but used an invalid inside PNG; this run corrected the fixture.

`test/read-sandbox.test.mjs` runs Node under the same generated OS profile and proves an allowed read succeeds while outside reads, symlink and data-volume aliases, shell execution and project writes return EPERM. It also checks login-field minimization and unsupported-platform refusal. `test/cross-owner-questions.test.mjs` runs fake providers inside the actual profile on macOS. Review transport tests use disposable CLI copies with a test-only runner substitute. There is no production environment switch that bypasses the sandbox.

These checks do not establish factual review quality, resistance to every prompt injection, a 95% parse rate on real reviews, or production review cost and latency targets.
