# claude-init

A small CLI for per-repo Claude Code setup: pick which MCP servers, plugins, claude.ai connectors, and skills are active in this repo, with macOS Keychain or 1Password for secret injection. User-scope defaults; per-repo overrides.

Designed to run **before** `claude` starts in a directory — wrap it into your `cc` alias and you'll be prompted to configure each new repo once.

## Why

Out of the box, Claude Code loads every user-scope MCP server, every installed plugin, and every claude.ai connector in every repo. MCPs that need tokens force you into `.env` files or global env vars. `claude-init`:

- Picks a subset of your discovered MCPs/skills/plugins/connectors to enable per repo.
- Stores API tokens in the Keychain or as `op://` references — no plain-text on disk, no global env-var soup.
- Resolves secrets per-repo first, falling back to user-scope defaults — set `DATABASE_URL` once, override only where needed.

## Install

```sh
git clone https://github.com/cpether/claude-init ~/projects/claude-init
mkdir -p ~/.local/bin
ln -s ~/projects/claude-init/bin/claude-init ~/.local/bin/claude-init
```

`~/.local/bin` is the per-user convention used by `pipx`, `uv`, `cargo`, and friends. If it's not already on your `PATH`, add this to your shell rc:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

(`/usr/local/bin/claude-init` or `/opt/homebrew/bin/claude-init` work fine if those are already your habit — claude-init doesn't care where it lives.)

For 1Password support, install the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) and sign in with `op signin`. Keychain works out of the box on macOS.

**A note on secret protection.** Stored secrets are protected against *other users* on your machine and *being committed to git*, but they are **not** protected against any process running as you — including `claude-init secret get`. The keychain ACL we use trusts `/usr/bin/security` (the macOS keychain CLI) by default, and any process you run can call `security find-generic-password -w` to read the value. This is the same threat model as `~/.aws/credentials` or `~/.npmrc`. Real per-app gating (Touch ID per read, restricted ACL) requires a native helper, which isn't shipped today. For high-value tokens, prefer 1Password with biometric auth enabled in the 1Password app (Settings → Developer → "Use Touch ID to authorize CLI sessions").

## Use it as a `cc` wrapper

If you already alias `cc` to launch Claude Code, drop a thin wrapper around it. The first time you `cc` into a new directory it prompts to set things up; from then on it's transparent.

```bash
# in ~/.zshrc or ~/.bashrc
cc() {
  claude-init check || return
  claude "$@"
}
```

`check` exits 0 in three cases: a manifest already exists, you've marked the dir to skip, or you said "not now". So `cc` flows straight into `claude` after.

When a manifest already exists, `check` also looks for **new user-, plugin-, or local-scope MCPs** added since the last setup. If any show up, you're prompted once to enable or disable them per-repo (defer with "no" to be asked again next session). claude.ai connectors are excluded from this check to keep startup snappy — they'd require an HTTP probe.

## Usage

```sh
claude-init init          # interactive wizard
claude-init check         # first-run gate (above)
claude-init mcp ...       # add, wrap, move, enable, or disable MCPs
claude-init secret ...    # list, set, get, or remove secrets
claude-init plugin ...    # enable or disable plugins per repo
claude-init discover      # JSON dump of MCPs/skills (debug)
claude-init state         # JSON dump of per-repo overrides (debug)
claude-init help mcp      # detailed MCP commands
```

## What the wizard writes

- **`.mcp.json`** at repo root — project-scope MCP definitions only. Committable; teammates need `claude-init` on PATH if a project MCP uses `claude-init exec`.
- **`.claude/settings.json`** — project MCP enable/disable state, plugin overrides, and `skillOverrides` (turn off skills you didn't pick).
- **`~/.claude.json` → projects[<repo>].disabledMcpServers** — per-repo disable list for user/local MCPs and claude.ai connectors.
- **`~/.claude.json` → projects[<repo>].mcpServers** — for `mcp add --scope local`.
- **`~/.claude.json` → mcpServers** — for `mcp add --scope user`.
- **`.claude/.claude-init.json`** — manifest of selected MCPs/skills + per-repo secret references (no values). Gitignored automatically when in a git repo.
- **`~/.claude/claude-init/manifest.json`** — user-scope secret references (shared defaults).

## Adding a new MCP

```sh
claude-init mcp add
```

Walks you through name, transport (stdio/http), command/args/env, scope (user/project/local), and any required secrets. For env entries, write `KEY` (no value) to mark it as a secret; `KEY=literal` for static values. The wizard then prompts to wire each secret to keychain or 1Password.

Default scope: **user** — same MCP definition everywhere, with secret values resolved per-project (with user-scope fallback).

## Changing an MCP's scope

```sh
claude-init mcp move           # interactive: pick the MCP, pick the target scope
claude-init mcp move <name> --to user   # non-interactive
```

Common moves:
- **Project → User**: stop committing the definition; have it available everywhere on your machine.
- **User → Project**: commit the definition so teammates get it. The wrapper command is rewritten from absolute path to PATH-based `claude-init` for portability.
- **Project → Local**: keep the same effect (this repo only) but uncommitted.

Wrapped entries (those using `claude-init exec`) have their command path adjusted automatically: absolute path for user/local, PATH-based `claude-init` for project (so teammates' `.mcp.json` resolves through their own PATH).

## Wrapping an existing MCP for secrets

```sh
claude-init mcp wrap <name>
```

Rewrites an existing user, project, or local MCP in place to run through `claude-init exec` when it has `${SECRET}` env references. This keeps the MCP in its current scope and only changes how its secrets are injected.

The `init` wizard also offers this migration when it discovers existing user, project, or local MCPs with `${SECRET}` env references.

### Wrapping `http`/`sse` servers

An `http` or `sse` server has no subprocess for the `exec` wrapper to inject env into — Claude Code opens the connection itself. When such a server references a secret in its `url` or `headers` (e.g. `"Authorization": "Basic $BITBUCKET_TOKEN"`), `wrap` converts the transport to a locally-spawned [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) stdio proxy:

```json
{
  "mcpServers": {
    "bitbucket": {
      "type": "stdio",
      "command": "claude-init",
      "args": ["exec", "--inject-argv", "BITBUCKET_TOKEN", "--", "npx", "-y", "mcp-remote",
               "https://mcp.atlassian.com/v1/mcp",
               "--header", "Authorization: Basic $BITBUCKET_TOKEN"],
      "env": {}
    }
  }
}
```

The secret is left as a **bare `$BITBUCKET_TOKEN`** on purpose. Claude Code expands `${VAR}` (braces) at config-parse time and **fails to load the config if the variable is missing** — but it ignores bare `$VAR`, so the reference survives the parser. `mcp-remote` does no variable expansion of its own (it forwards `--header` values verbatim), so `claude-init exec` resolves `BITBUCKET_TOKEN` from your backend and substitutes the value into the args just before spawning the proxy.

The leading **`--inject-argv`** flag is what opts this wrapper into that argv substitution. Only these proxy wrappers (`mcp-remote` and other argv-only consumers) carry it — plain stdio wraps omit it, so a literal `$VAR` in a stdio command's args is passed through untouched and the secret is delivered solely via the environment (never the command line). Without the flag, `claude-init exec` would set `BITBUCKET_TOKEN` in env but leave the `--header` value as the literal `$BITBUCKET_TOKEN` placeholder, which `mcp-remote` would forward verbatim.

Requirements / caveats:
- `npx` and `mcp-remote` must be on PATH when Claude Code starts.
- Because `mcp-remote` only accepts the header on the command line, the resolved token is present in the proxy process's argv at runtime (visible to `ps`) — unlike stdio wraps, which keep secrets in the environment.

## Secret resolution

When `claude-init exec` runs, it resolves each requested name in order:

1. Project manifest (`.claude/.claude-init.json` in the repo).
2. User manifest (`~/.claude/claude-init/manifest.json`).
3. Error.

So you can set `GITHUB_TOKEN` once at user scope, override it in a specific repo when you need a different account, and the same MCP definition Just Works.

## Backends

**macOS Keychain** — stored under service `claude-code-secrets` (shared by name) or `claude-code-secrets:<repo-hash>` (with `--isolate`). Use isolation when you want a project-specific value but for some reason can't put it in the project manifest.

**1Password (`op`)** — records an `op://vault/item/field` reference. At resolve-time, the helper invokes `op read`. The `op` CLI must be signed into your shell session.

## Generated `.mcp.json` example

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "claude-init",
      "args": ["exec", "GITHUB_TOKEN", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
      "env": {}
    }
  }
}
```

`command: "claude-init"` (PATH lookup, not absolute) so the file is portable across teammates' machines. The MCP command itself is unchanged — it just runs through the helper, which injects `GITHUB_TOKEN` from the configured backend before exec.

## Manifest format

`.claude/.claude-init.json` (per-repo):

```json
{
  "version": 1,
  "mcps":   ["github", "linear"],
  "skills": ["claude-api"],
  "secrets": {
    "GITHUB_TOKEN":   { "backend": "keychain", "service": "claude-code-secrets", "account": "GITHUB_TOKEN" },
    "LINEAR_API_KEY": { "backend": "op", "ref": "op://Personal/Linear/credential" }
  }
}
```

`~/.claude/claude-init/manifest.json` (user scope, same shape, only `secrets` is meaningful):

```json
{
  "version": 1,
  "secrets": {
    "DATABASE_URL": { "backend": "keychain", "service": "claude-code-secrets", "account": "DATABASE_URL" }
  }
}
```

No secret values are ever stored in either file.

## Limitations

- macOS only for the Keychain backend; 1Password works anywhere `op` runs.
- claude.ai connectors authenticate via your claude.ai account, not via `.mcp.json` — they can be enabled/disabled per-repo, but auth tokens aren't touched.
- Plugin-installed skills aren't yet enumerated — only `~/.claude/skills/`.
- Changes to `.mcp.json` / `.claude/settings.json` / `~/.claude.json` take effect on next `claude` launch in that directory. There's no live reload.
