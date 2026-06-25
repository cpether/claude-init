// Sentinel placed right after `exec` (before the secret tokens) by wrappers whose downstream command
// reads secrets from argv rather than env — currently only the mcp-remote/HTTP proxy (see rewrapHttp).
// Argv substitution is OPT-IN behind this flag so a plain stdio wrapper never materialises a resolved
// secret into its argv: a literal $VAR in a stdio arg stays literal and is not exposed via `ps`.
const INJECT_ARGV_FLAG = '--inject-argv';

// Splits an exec invocation's token region (everything between `exec` and `--`) into the secret tokens
// and the argv-injection opt-in. Control flags start with `--`; secret tokens never do (they are
// [ENV_KEY=]NAME identifiers), so unknown flags are simply ignored rather than treated as secrets.
function parseExecArgv(region) {
  const secretTokens = [];
  let injectArgv = false;
  for (const t of region || []) {
    if (t === INJECT_ARGV_FLAG) { injectArgv = true; continue; }
    if (typeof t === 'string' && t.startsWith('--')) continue;
    secretTokens.push(t);
  }
  return { secretTokens, injectArgv };
}

function isClaudeInitWrapped(cfg) {
  if (!cfg || !Array.isArray(cfg.args)) return false;
  if (typeof cfg.command !== 'string') return false;
  if (!/(^|\/)claude-init$/.test(cfg.command)) return false;
  return cfg.args[0] === 'exec' && cfg.args.includes('--');
}

function unwrap(cfg) {
  if (!isClaudeInitWrapped(cfg)) return { ...cfg, secretTokens: [] };
  const dashIdx = cfg.args.indexOf('--');
  return {
    type: 'stdio',
    command: cfg.args[dashIdx + 1],
    args: cfg.args.slice(dashIdx + 2),
    env: cfg.env || {},
    secretTokens: cfg.args.slice(1, dashIdx),
  };
}

function collectSecretsFromEnv(env) {
  // Returns env keys that have $VAR or ${VAR}-shaped values. The default "secret name" for each
  // is the env key itself; the wizard may override via mappings at rewrap time.
  const secrets = [];
  const stripEnvKeys = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string') continue;
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(v)
        || /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}$/.test(v)) {
      secrets.push(k);
      stripEnvKeys.push(k);
    }
  }
  return { secrets, stripEnvKeys };
}

function parseTokensFromWrapped(secretTokens) {
  // Wrapped configs carry secret tokens as `NAME` or `ENV_KEY=NAME`.
  const out = [];
  for (const tok of secretTokens || []) {
    if (typeof tok === 'string' && tok.startsWith('--')) continue; // control flag (e.g. --inject-argv), not a secret
    if (tok.includes('=')) {
      const eq = tok.indexOf('=');
      out.push({ envKey: tok.slice(0, eq), secretName: tok.slice(eq + 1) });
    } else {
      out.push({ envKey: tok, secretName: tok });
    }
  }
  return out;
}

function normalize(cfg) {
  const u = unwrap(cfg);
  const env = { ...(u.env || {}) };
  const { stripEnvKeys, secrets: envSecretKeys } = collectSecretsFromEnv(env);
  for (const k of stripEnvKeys) delete env[k];
  // Unwrapped env-only form: each $VAR/${VAR} value is canonicalised to {envKey: K, secretName: K} — the wizard's
  // default migration policy renames source-of-value to the env key. A literal mapping in the wrapped form
  // (e.g. `GSAT=GRAFANA_DEV_TOKEN`) preserves whatever the user chose.
  const mappings = [
    ...envSecretKeys.map((k) => ({ envKey: k, secretName: k })),
    ...parseTokensFromWrapped(u.secretTokens),
  ];
  mappings.sort((a, b) => (a.envKey + '|' + a.secretName).localeCompare(b.envKey + '|' + b.secretName));
  // The --inject-argv opt-in changes runtime behaviour (argv substitution), so it's part of identity:
  // two wrappers with identical command/args/secrets but differing flag state are NOT equivalent —
  // otherwise collision cleanup could keep a flagless wrapper that forwards a literal $TOKEN to mcp-remote.
  const { injectArgv } = parseExecArgv(u.secretTokens);
  return {
    type: u.type || (u.url ? 'http' : 'stdio'),
    command: u.command,
    args: u.args || [],
    env,
    mappings,
    url: u.url,
    injectArgv,
  };
}

function stableStringify(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
  }
  return JSON.stringify(obj);
}

function equivalent(a, b) {
  if (!a || !b) return false;
  const na = normalize(a);
  const nb = normalize(b);
  return stableStringify(na) === stableStringify(nb);
}

// Matches a $VAR or ${VAR} (optionally ${VAR:-default}) secret reference embedded anywhere in a string.
// Returns a fresh stateful regex each call so callers never trip over a shared lastIndex.
function secretRefRe() {
  return /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
}

function collectSecretRefs(...strings) {
  const out = [];
  for (const s of strings) {
    if (typeof s !== 'string') continue;
    for (const m of s.matchAll(secretRefRe())) {
      const name = m[1] || m[2];
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

// URLs legitimately carry literal $-sequences — OData query options like `?$filter=…`, `$select`, `$top`
// — so a bare lowercase $ref must NOT be mistaken for a secret (that would prompt for a bogus secret and
// rewrite a non-secret URL). A bare ref counts only when it's env-style (uppercase/underscore/digits,
// e.g. $API_TOKEN, $TENANT); a braced ${VAR} is always an explicit placeholder (`${` is not valid in a
// real URL, where `{` `}` must be percent-encoded) and is honoured in any case.
function collectUrlSecretRefs(url) {
  if (typeof url !== 'string') return [];
  const out = [];
  for (const m of url.matchAll(secretRefRe())) {
    const braced = m[1];
    const bare = m[2];
    if (!braced && !/^[A-Z_][A-Z0-9_]*$/.test(bare)) continue; // literal $lowercase in URL — not a secret
    const name = braced || bare;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// Rewrites every ${VAR} reference to the bare $VAR form. Claude Code expands ${VAR} (and hard-fails on a
// missing one) at config-parse time but leaves bare $VAR untouched, so the bare form survives the parser.
// claude-init exec then injects the resolved value into the argv at launch (see injectArgSecrets).
function toBareRef(str) {
  if (typeof str !== 'string') return str;
  return str.replace(secretRefRe(), (_, braced, bare) => '$' + (braced || bare));
}

// Substitutes the resolved value for each $KEY / ${KEY} occurrence in a command argv. mcp-remote (and
// argv-only consumers like it) read secrets straight from the command line, not the environment, so the
// exec wrapper has to materialise the value into the args itself just before spawning the proxy.
// `resolved` is [{ envKey, value }]. A SINGLE pass over the original arg (one combined regex, function
// replacer) is essential: replacing key-by-key would rescan freshly inserted values, so a value that
// itself contains a $-reference (e.g. A=abc$B with a key B) would be rewritten again. One pass consumes
// each match and resumes past the inserted text, and the function replacer keeps literal $-sequences intact.
function injectArgSecrets(args, resolved) {
  const byKey = new Map();
  for (const r of resolved || []) {
    if (r && typeof r.envKey === 'string') byKey.set(r.envKey, r.value);
  }
  if (byKey.size === 0) return (args || []).slice();
  // Longest key first so overlapping names (FOO vs FOO_BAR) prefer the longer match.
  const alt = [...byKey.keys()]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const re = new RegExp('\\$\\{(' + alt + ')\\}|\\$(' + alt + ')(?![A-Za-z0-9_])', 'g');
  return (args || []).map((arg) => {
    if (typeof arg !== 'string') return arg;
    return arg.replace(re, (_, braced, bare) => byKey.get(braced || bare));
  });
}

// http/sse servers have no subprocess to inject env into, so the bare exec wrapper has nothing to wrap.
// We convert the transport to a locally-spawned mcp-remote stdio proxy. mcp-remote forwards --header
// values verbatim (it does no env expansion of its own), so the secret is left as a bare $VAR that
// claude-init exec resolves and substitutes into the argv before launch.
function planHttpMigration(cfg) {
  const headers = cfg.headers || {};
  const headerValues = Object.values(headers).filter((v) => typeof v === 'string');
  // URL refs use strict (env-style/braced) detection so literal query options like `?$filter=` aren't
  // mistaken for secrets; header values keep loose detection (a $token in a header is always a ref).
  const secrets = [];
  for (const name of [...collectUrlSecretRefs(cfg.url), ...collectSecretRefs(...headerValues)]) {
    if (!secrets.includes(name)) secrets.push(name);
  }
  if (secrets.length === 0) {
    return { canMigrate: false, reason: 'no $VAR or ${VAR} references in url/headers — nothing to migrate' };
  }
  if (typeof cfg.url !== 'string' || !cfg.url) {
    return { canMigrate: false, reason: 'http transport has no url to proxy' };
  }
  return {
    canMigrate: true,
    transport: 'http',
    secrets,
    stripEnvKeys: [],
    argvWarnings: [],
    http: { url: cfg.url, headers },
  };
}

function planMigration(cfg) {
  if (cfg.url || cfg.type === 'http' || cfg.type === 'sse') {
    return planHttpMigration(cfg);
  }
  if (isClaudeInitWrapped(cfg)) {
    return { canMigrate: false, reason: 'already wrapped through claude-init exec' };
  }
  const { secrets, stripEnvKeys } = collectSecretsFromEnv(cfg.env || {});
  const argvVars = new Set();
  const argvPattern = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g;
  for (const a of cfg.args || []) {
    if (typeof a !== 'string') continue;
    for (const m of a.matchAll(argvPattern)) argvVars.add(m[1] || m[2]);
  }
  if (secrets.length === 0 && argvVars.size === 0) {
    return { canMigrate: false, reason: 'no $VAR or ${VAR} references — nothing to migrate' };
  }
  if (secrets.length === 0) {
    return {
      canMigrate: false,
      reason: `only argv references found (${[...argvVars].join(', ')}); claude-init exec injects via env, not argv`,
    };
  }
  return {
    canMigrate: true,
    secrets,
    stripEnvKeys,
    argvWarnings: [...argvVars],
  };
}

// Converts an http/sse server (per planHttpMigration) into a claude-init exec → mcp-remote stdio proxy.
// The injected env key must match the bare $VAR left in the headers/url, so tokens are keyed by envKey;
// only the backend secretName may differ (e.g. when the wizard stored it under a different name).
function rewrapHttp(plan, { execCommand, mappings }) {
  const effectiveMappings = mappings && mappings.length > 0
    ? mappings
    : (plan.secrets || []).map((k) => ({ envKey: k, secretName: k }));
  const tokens = [];
  for (const { envKey, secretName } of effectiveMappings) {
    const tok = envKey === secretName ? secretName : `${envKey}=${secretName}`;
    if (!tokens.includes(tok)) tokens.push(tok);
  }
  const proxyArgs = ['npx', '-y', 'mcp-remote', toBareRef(plan.http.url)];
  for (const [name, value] of Object.entries(plan.http.headers || {})) {
    if (typeof value !== 'string') continue;
    proxyArgs.push('--header', `${name}: ${toBareRef(value)}`);
  }
  return {
    type: 'stdio',
    command: execCommand,
    // mcp-remote reads --header/url secrets from argv, so opt into argv injection at exec time.
    args: ['exec', INJECT_ARGV_FLAG, ...tokens, '--', ...proxyArgs],
    env: {},
  };
}

function rewrap(cfg, plan, { execCommand, mappings }) {
  if (plan && plan.transport === 'http') {
    return rewrapHttp(plan, { execCommand, mappings });
  }
  const newEnv = { ...(cfg.env || {}) };
  for (const k of plan.stripEnvKeys) delete newEnv[k];
  // Default mappings: each env key is its own secret name. Caller may pass explicit mappings to remap.
  const effectiveMappings = mappings && mappings.length > 0
    ? mappings
    : (plan.secrets || []).map((k) => ({ envKey: k, secretName: k }));
  const tokens = [];
  for (const { envKey, secretName } of effectiveMappings) {
    const tok = envKey === secretName ? secretName : `${envKey}=${secretName}`;
    if (!tokens.includes(tok)) tokens.push(tok);
  }
  return {
    type: 'stdio',
    command: execCommand,
    args: ['exec', ...tokens, '--', cfg.command, ...(cfg.args || [])],
    env: newEnv,
  };
}

function readWrappedTokens(cfg) {
  if (!isClaudeInitWrapped(cfg)) return null;
  const dashIdx = cfg.args.indexOf('--');
  return parseTokensFromWrapped(cfg.args.slice(1, dashIdx));
}

function rewriteWrappedTokens(cfg, mappings) {
  if (!isClaudeInitWrapped(cfg)) throw new Error('not a claude-init exec wrapped config');
  const dashIdx = cfg.args.indexOf('--');
  // Preserve control flags (e.g. --inject-argv) — only the secret tokens are being remapped here.
  const flags = cfg.args.slice(1, dashIdx).filter((t) => typeof t === 'string' && t.startsWith('--'));
  const trailing = cfg.args.slice(dashIdx);
  const tokens = mappings.map(({ envKey, secretName }) =>
    envKey === secretName ? secretName : `${envKey}=${secretName}`,
  );
  return { ...cfg, args: ['exec', ...flags, ...tokens, ...trailing] };
}

module.exports = {
  INJECT_ARGV_FLAG,
  parseExecArgv,
  isClaudeInitWrapped,
  unwrap,
  normalize,
  equivalent,
  planMigration,
  collectUrlSecretRefs,
  rewrap,
  injectArgSecrets,
  readWrappedTokens,
  rewriteWrappedTokens,
};
