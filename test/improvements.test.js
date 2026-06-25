const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-init-test-'));
const home = path.join(tmpRoot, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;

const picker = require('../lib/picker');
const wizard = require('../lib/wizard');
const migrate = require('../lib/migrate');
const writers = require('../lib/writers');
const detectNew = require('../lib/detect-new');
const manifestLib = require('../lib/manifest');

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function makeRepo(name) {
  const repo = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  // The CLI canonicalises cwd via realpath (e.g. /var → /private/var on macOS); mirror that so
  // project-scope keys written to ~/.claude.json match what the spawned CLI looks up.
  return fs.realpathSync(repo);
}

function setClaudeJson(data) {
  writeJson(path.join(home, '.claude.json'), data);
}

function mockPicker(overrides = {}) {
  picker.confirm = overrides.confirm || (async () => true);
  picker.select = overrides.select || (async ({ choices }) => choices[0].value);
  picker.input = overrides.input || (async ({ default: def = '' }) => def);
  picker.password = overrides.password || (async () => 'secret');
  picker.checkbox = overrides.checkbox || (async ({ choices }) =>
    choices.filter((choice) => choice.checked).map((choice) => choice.value));
}

async function testUserMcpsStayUserScoped() {
  const repo = makeRepo('user-scope');
  setClaudeJson({
    mcpServers: {
      user_mcp: { type: 'stdio', command: 'node', args: ['server.js'], env: {} },
    },
  });

  mockPicker({
    checkbox: async ({ message }) => {
      if (message.startsWith('User-scope MCPs')) return ['user_mcp'];
      return [];
    },
  });
  await wizard.runInit({ root: repo, isGit: true });
  assert.strictEqual(fs.existsSync(path.join(repo, '.mcp.json')), false);
  assert.deepStrictEqual((readJson(path.join(home, '.claude.json')).projects || {})[repo].disabledMcpServers, undefined);

  mockPicker({
    checkbox: async ({ message }) => {
      if (message.startsWith('User-scope MCPs')) return [];
      return [];
    },
  });
  await wizard.runInit({ root: repo, isGit: true });
  assert.strictEqual(fs.existsSync(path.join(repo, '.mcp.json')), false);
  assert.deepStrictEqual(readJson(path.join(home, '.claude.json')).projects[repo].disabledMcpServers, ['user_mcp']);

  mockPicker({
    checkbox: async ({ message }) => {
      if (message.startsWith('User-scope MCPs')) return ['user_mcp'];
      return [];
    },
  });
  await wizard.runInit({ root: repo, isGit: true });
  assert.deepStrictEqual(readJson(path.join(home, '.claude.json')).projects[repo].disabledMcpServers, undefined);
}

async function testInitWrapsUserMcpInPlace() {
  const repo = makeRepo('user-wrap-in-place');
  writeJson(path.join(repo, '.claude', '.claude-init.json'), {
    version: 1,
    mcps: [],
    skills: [],
    secrets: {
      TOKEN: { backend: 'op', ref: 'op://Test/Token/credential' },
    },
  });
  setClaudeJson({
    mcpServers: {
      user_secret_mcp: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { TOKEN: '${TOKEN}' },
      },
    },
  });

  mockPicker({
    checkbox: async ({ message }) => {
      if (message.startsWith('User-scope MCPs')) return ['user_secret_mcp'];
      if (message.startsWith('Migrate user entries')) return ['user_secret_mcp'];
      return [];
    },
    select: async ({ choices }) => {
      const useExisting = choices.find((choice) => choice.value === 'use');
      return (useExisting || choices[0]).value;
    },
  });

  await wizard.runInit({ root: repo, isGit: true });
  assert.strictEqual(fs.existsSync(path.join(repo, '.mcp.json')), false);
  const userMcp = readJson(path.join(home, '.claude.json')).mcpServers.user_secret_mcp;
  assert.match(userMcp.command, /claude-init$/);
  assert.deepStrictEqual(userMcp.args, ['exec', 'TOKEN', '--', 'node', 'server.js']);
  assert.deepStrictEqual(userMcp.env, {});
}

async function testProjectMcpStateIsReplaced() {
  const repo = makeRepo('project-state');
  setClaudeJson({});
  writeJson(path.join(repo, '.mcp.json'), {
    mcpServers: {
      project_mcp: { type: 'stdio', command: 'node', args: ['project.js'], env: {} },
    },
  });

  mockPicker({
    checkbox: async ({ message }) => {
      if (message.startsWith('Project-scope MCPs')) return [];
      return [];
    },
  });
  await wizard.runInit({ root: repo, isGit: true });
  let settings = readJson(path.join(repo, '.claude', 'settings.json'));
  assert.deepStrictEqual(settings.disabledMcpjsonServers, ['project_mcp']);
  assert.strictEqual(settings.enabledMcpjsonServers, undefined);

  mockPicker({
    checkbox: async ({ message }) => {
      if (message.startsWith('Project-scope MCPs')) return ['project_mcp'];
      return [];
    },
  });
  await wizard.runInit({ root: repo, isGit: true });
  settings = readJson(path.join(repo, '.claude', 'settings.json'));
  assert.deepStrictEqual(settings.enabledMcpjsonServers, ['project_mcp']);
  assert.strictEqual(settings.disabledMcpjsonServers, undefined);
}

async function testSkippedSecretLeavesProjectMcpUnchanged() {
  const repo = makeRepo('skipped-secret');
  setClaudeJson({});
  const original = {
    mcpServers: {
      secret_mcp: {
        type: 'stdio',
        command: 'node',
        args: ['secret.js'],
        env: { TOKEN: '${TOKEN}' },
      },
    },
  };
  writeJson(path.join(repo, '.mcp.json'), original);

  mockPicker({
    checkbox: async ({ message }) => {
      if (message.startsWith('Project-scope MCPs')) return ['secret_mcp'];
      if (message.startsWith('Migrate project entries')) return ['secret_mcp'];
      return [];
    },
    select: async ({ choices }) => {
      const skip = choices.find((choice) => choice.value === 'skip');
      return skip ? skip.value : choices[0].value;
    },
  });
  await wizard.runInit({ root: repo, isGit: true });
  assert.deepStrictEqual(readJson(path.join(repo, '.mcp.json')), original);
}

async function testInitMigratesProjectDollarEnvReference() {
  const repo = makeRepo('project-dollar-env');
  writeJson(path.join(repo, '.claude', '.claude-init.json'), {
    version: 1,
    mcps: [],
    skills: [],
    secrets: {
      GRAFANA_SERVICE_ACCOUNT_TOKEN: { backend: 'op', ref: 'op://Test/Grafana/credential' },
    },
  });
  setClaudeJson({});
  writeJson(path.join(repo, '.mcp.json'), {
    mcpServers: {
      grafana: {
        command: 'uvx',
        args: ['mcp-grafana'],
        env: {
          GRAFANA_URL: 'https://adaptavist.grafana.net',
          GRAFANA_SERVICE_ACCOUNT_TOKEN: '$GRAFANA_SERVICE_ACCOUNT_TOKEN',
        },
      },
    },
  });

  mockPicker({
    checkbox: async ({ message }) => {
      if (message.startsWith('Project-scope MCPs')) return ['grafana'];
      if (message.startsWith('Migrate project entries')) return ['grafana'];
      return [];
    },
    select: async ({ choices }) => {
      const useExisting = choices.find((choice) => choice.value === 'use');
      return (useExisting || choices[0]).value;
    },
  });

  await wizard.runInit({ root: repo, isGit: true });
  const migrated = readJson(path.join(repo, '.mcp.json')).mcpServers.grafana;
  assert.strictEqual(migrated.command, 'claude-init');
  assert.deepStrictEqual(migrated.args, [
    'exec',
    'GRAFANA_SERVICE_ACCOUNT_TOKEN',
    '--',
    'uvx',
    'mcp-grafana',
  ]);
  assert.deepStrictEqual(migrated.env, {
    GRAFANA_URL: 'https://adaptavist.grafana.net',
  });
}

function testProjectMcpEnableDisableCliUsesSettingsJson() {
  const repo = makeRepo('cli-project-enable');
  setClaudeJson({});
  writeJson(path.join(repo, '.mcp.json'), {
    mcpServers: {
      project_mcp: { type: 'stdio', command: 'node', args: ['project.js'], env: {} },
    },
  });

  let result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'claude-init'), 'mcp', 'disable', 'project_mcp'], {
    cwd: repo,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  let settings = readJson(path.join(repo, '.claude', 'settings.json'));
  assert.deepStrictEqual(settings.disabledMcpjsonServers, ['project_mcp']);
  assert.strictEqual(readJson(path.join(home, '.claude.json')).projects, undefined);

  result = spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'claude-init'), 'mcp', 'enable', 'project_mcp'], {
    cwd: repo,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  settings = readJson(path.join(repo, '.claude', 'settings.json'));
  assert.deepStrictEqual(settings.enabledMcpjsonServers, ['project_mcp']);
  assert.strictEqual(settings.disabledMcpjsonServers, undefined);
}

async function testCopiedUserShimCleanup() {
  const repo = makeRepo('shim-cleanup');
  setClaudeJson({
    mcpServers: {
      shim_mcp: {
        type: 'stdio',
        command: 'node',
        args: ['shim.js'],
        env: { TOKEN: '${TOKEN}' },
      },
    },
  });
  writeJson(path.join(repo, '.mcp.json'), {
    mcpServers: {
      shim_mcp: {
        type: 'stdio',
        command: 'claude-init',
        args: ['exec', 'TOKEN', '--', 'node', 'shim.js'],
        env: { TOKEN: '${TOKEN}' },
      },
    },
  });

  mockPicker({
    confirm: async () => true,
    checkbox: async ({ message }) => {
      if (message.startsWith('User-scope MCPs')) return ['shim_mcp'];
      return [];
    },
  });
  await wizard.runInit({ root: repo, isGit: true });
  assert.strictEqual(fs.existsSync(path.join(repo, '.mcp.json')), false);
  const userMcp = readJson(path.join(home, '.claude.json')).mcpServers.shim_mcp;
  assert.match(userMcp.command, /claude-init$/);
  assert.deepStrictEqual(userMcp.args, ['exec', 'TOKEN', '--', 'node', 'shim.js']);
  assert.deepStrictEqual(userMcp.env, {});
}

async function testShimCleanupRespectsInjectArgvFlag() {
  // Regression: when BOTH copies are wrapped, the unwrapped-command fallback must not stand in for
  // equivalence — it's blind to --inject-argv. A working flagful project wrapper and a flag-stripped
  // (broken) user copy are NOT interchangeable, so cleanup must not drop the project copy.
  const repo = makeRepo('shim-flag');
  const httpCfg = {
    url: 'https://mcp.atlassian.com/v1/mcp',
    type: 'http',
    headers: { Authorization: 'Basic $BITBUCKET_TOKEN' },
  };
  const good = migrate.rewrap(httpCfg, migrate.planMigration(httpCfg), {
    execCommand: 'claude-init',
    mappings: [{ envKey: 'BITBUCKET_TOKEN', secretName: 'BITBUCKET_TOKEN' }],
  });
  assert.ok(good.args.includes('--inject-argv'));
  const broken = { ...good, args: good.args.filter((a) => a !== '--inject-argv') };

  // project copy = working (flagful); user copy = broken (flag stripped).
  writeJson(path.join(repo, '.mcp.json'), { mcpServers: { bitbucket: good } });
  setClaudeJson({ mcpServers: { bitbucket: broken } });

  let prompted = false;
  mockPicker({ confirm: async () => { prompted = true; return true; } });

  const changed = await wizard.cleanupMaterializedUserShims(
    repo, [{ name: 'bitbucket' }], [{ name: 'bitbucket' }], {},
  );
  assert.strictEqual(changed, false, 'must not clean up a non-equivalent both-wrapped pair');
  assert.strictEqual(prompted, false, 'must not even prompt to remove the working project copy');
  const stillThere = readJson(path.join(repo, '.mcp.json')).mcpServers.bitbucket;
  assert.ok(stillThere.args.includes('--inject-argv'), 'working project wrapper must be preserved');
}

async function testRunInitRecordsKnownSnapshot() {
  const repo = makeRepo('known-snapshot');
  setClaudeJson({
    mcpServers: {
      first_mcp: { type: 'stdio', command: 'node', args: ['a.js'], env: {} },
      second_mcp: { type: 'stdio', command: 'node', args: ['b.js'], env: {} },
    },
  });
  mockPicker({
    checkbox: async ({ message }) => {
      if (message.startsWith('User-scope MCPs')) return ['first_mcp'];
      return [];
    },
  });
  await wizard.runInit({ root: repo, isGit: true });
  const data = readJson(manifestLib.manifestPath(repo));
  assert.ok(data.known, 'expected manifest.known to be written');
  assert.deepStrictEqual(data.known.user, ['first_mcp', 'second_mcp']);
  assert.deepStrictEqual(data.known.plugin, []);
  assert.deepStrictEqual(data.known.local, []);
  assert.ok(!('claudeai' in data.known), 'claude.ai is excluded from detection');
}

function testDetectFlagsNewUserMcp() {
  const repo = makeRepo('detect-user');
  setClaudeJson({
    mcpServers: {
      old_mcp: { type: 'stdio', command: 'node', args: ['a.js'], env: {} },
      new_mcp: { type: 'stdio', command: 'node', args: ['b.js'], env: {} },
    },
  });
  const manifestData = {
    version: 1,
    mcps: ['old_mcp'],
    skills: [],
    secrets: {},
    known: { user: ['old_mcp'], plugin: [], local: [] },
  };
  const result = detectNew.detect(repo, manifestData);
  assert.strictEqual(result.isLegacy, false);
  assert.strictEqual(result.hasAny, true);
  assert.deepStrictEqual(result.newByScope.user, ['new_mcp']);
  assert.deepStrictEqual(result.newByScope.plugin, []);
}

function testDetectQuietWhenNothingNew() {
  const repo = makeRepo('detect-quiet');
  setClaudeJson({
    mcpServers: {
      stable_mcp: { type: 'stdio', command: 'node', args: ['a.js'], env: {} },
    },
  });
  const manifestData = {
    version: 1,
    mcps: ['stable_mcp'],
    skills: [],
    secrets: {},
    known: { user: ['stable_mcp'], plugin: [], local: [] },
  };
  const result = detectNew.detect(repo, manifestData);
  assert.strictEqual(result.hasAny, false);
}

function testDetectLegacyManifestBootstrap() {
  const repo = makeRepo('detect-legacy');
  setClaudeJson({
    mcpServers: {
      something: { type: 'stdio', command: 'node', args: ['a.js'], env: {} },
    },
  });
  const manifestData = { version: 1, mcps: [], skills: [], secrets: {} };
  const result = detectNew.detect(repo, manifestData);
  assert.strictEqual(result.isLegacy, true);
  assert.strictEqual(result.hasAny, false);
  assert.deepStrictEqual(result.baseline.user, ['something']);
}

function testDetectFlagsNewLocalMcp() {
  const repo = makeRepo('detect-local');
  setClaudeJson({
    mcpServers: {},
    projects: {
      [repo]: {
        mcpServers: {
          local_new: { type: 'stdio', command: 'node', args: ['l.js'], env: {} },
        },
      },
    },
  });
  const manifestData = {
    version: 1,
    mcps: [], skills: [], secrets: {},
    known: { user: [], plugin: [], local: [] },
  };
  const result = detectNew.detect(repo, manifestData);
  assert.deepStrictEqual(result.newByScope.local, ['local_new']);
}

async function testCheckDisablesNewMcpWhenUnchecked() {
  const repo = makeRepo('check-disable');
  const initialManifest = {
    version: 1,
    mcps: ['old_mcp'],
    skills: [],
    secrets: {},
    known: { user: ['old_mcp'], plugin: [], local: [] },
  };
  writeJson(manifestLib.manifestPath(repo), initialManifest);
  setClaudeJson({
    mcpServers: {
      old_mcp: { type: 'stdio', command: 'node', args: ['a.js'], env: {} },
      brand_new: { type: 'stdio', command: 'node', args: ['n.js'], env: {} },
    },
  });

  mockPicker({
    confirm: async () => true,
    checkbox: async () => [],
  });
  const data = readJson(manifestLib.manifestPath(repo));
  const result = await detectNew.handleCheck(repo, data);
  assert.strictEqual(result.action, 'saved');
  const updatedManifest = readJson(manifestLib.manifestPath(repo));
  assert.deepStrictEqual(updatedManifest.known.user, ['brand_new', 'old_mcp']);
  const projectEntry = readJson(path.join(home, '.claude.json')).projects[repo];
  assert.deepStrictEqual(projectEntry.disabledMcpServers, ['brand_new']);
}

async function testCheckLeavesEnabledNewMcpAlone() {
  const repo = makeRepo('check-enable');
  writeJson(manifestLib.manifestPath(repo), {
    version: 1,
    mcps: ['old_mcp'],
    skills: [],
    secrets: {},
    known: { user: ['old_mcp'], plugin: [], local: [] },
  });
  setClaudeJson({
    mcpServers: {
      old_mcp: { type: 'stdio', command: 'node', args: ['a.js'], env: {} },
      brand_new: { type: 'stdio', command: 'node', args: ['n.js'], env: {} },
    },
  });

  mockPicker({
    confirm: async () => true,
    checkbox: async ({ choices }) => choices.filter((c) => c.checked).map((c) => c.value),
  });
  const data = readJson(manifestLib.manifestPath(repo));
  const result = await detectNew.handleCheck(repo, data);
  assert.strictEqual(result.action, 'saved');
  const updatedManifest = readJson(manifestLib.manifestPath(repo));
  assert.deepStrictEqual(updatedManifest.known.user, ['brand_new', 'old_mcp']);
  assert.ok(updatedManifest.mcps.includes('brand_new'), 'enabled user MCP should be added to manifest.mcps');
  const projectEntry = readJson(path.join(home, '.claude.json')).projects || {};
  const disabled = (projectEntry[repo] || {}).disabledMcpServers || [];
  assert.deepStrictEqual(disabled, []);
}

async function testCheckDeferKeepsKnownStable() {
  const repo = makeRepo('check-defer');
  writeJson(manifestLib.manifestPath(repo), {
    version: 1,
    mcps: ['old_mcp'],
    skills: [],
    secrets: {},
    known: { user: ['old_mcp'], plugin: [], local: [] },
  });
  setClaudeJson({
    mcpServers: {
      old_mcp: { type: 'stdio', command: 'node', args: ['a.js'], env: {} },
      brand_new: { type: 'stdio', command: 'node', args: ['n.js'], env: {} },
    },
  });

  mockPicker({
    confirm: async () => false,
    checkbox: async ({ choices }) => choices.filter((c) => c.checked).map((c) => c.value),
  });
  const data = readJson(manifestLib.manifestPath(repo));
  const result = await detectNew.handleCheck(repo, data);
  assert.strictEqual(result.action, 'deferred');
  const updatedManifest = readJson(manifestLib.manifestPath(repo));
  assert.deepStrictEqual(updatedManifest.known.user, ['old_mcp'], 'known must not change on defer');
}

async function testCheckLegacyManifestBootstrapsSilently() {
  const repo = makeRepo('check-legacy');
  writeJson(manifestLib.manifestPath(repo), {
    version: 1,
    mcps: [],
    skills: [],
    secrets: {},
  });
  setClaudeJson({
    mcpServers: {
      stuff: { type: 'stdio', command: 'node', args: ['x.js'], env: {} },
    },
  });

  mockPicker();
  const data = readJson(manifestLib.manifestPath(repo));
  const result = await detectNew.handleCheck(repo, data);
  assert.strictEqual(result.action, 'bootstrap');
  const updatedManifest = readJson(manifestLib.manifestPath(repo));
  assert.ok(updatedManifest.known, 'legacy manifest should be bootstrapped with known');
  assert.deepStrictEqual(updatedManifest.known.user, ['stuff']);
}

function testMcpMoveRefreshesKnown() {
  const repo = makeRepo('move-refreshes-known');
  setClaudeJson({
    mcpServers: {},
    projects: {
      [repo]: {
        mcpServers: {
          floater: { type: 'stdio', command: 'node', args: ['f.js'], env: {} },
        },
      },
    },
  });
  writeJson(manifestLib.manifestPath(repo), {
    version: 1,
    mcps: [],
    skills: [],
    secrets: {},
    known: { user: [], plugin: [], local: ['floater'] },
  });

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'bin', 'claude-init'), 'mcp', 'move', 'floater', '--to', 'user'],
    { cwd: repo, env: { ...process.env, HOME: home }, encoding: 'utf8' },
  );
  assert.strictEqual(result.status, 0, result.stderr);

  const updatedManifest = readJson(manifestLib.manifestPath(repo));
  assert.deepStrictEqual(updatedManifest.known.user, ['floater'], 'user-scope known should include moved MCP');
  assert.deepStrictEqual(updatedManifest.known.local, [], 'old scope entry should be cleaned up');
}

async function testCheckNoopAfterMove() {
  const repo = makeRepo('check-noop-after-move');
  setClaudeJson({
    mcpServers: {},
    projects: {
      [repo]: {
        mcpServers: {
          mover: { type: 'stdio', command: 'node', args: ['m.js'], env: {} },
        },
      },
    },
  });
  writeJson(manifestLib.manifestPath(repo), {
    version: 1,
    mcps: [],
    skills: [],
    secrets: {},
    known: { user: [], plugin: [], local: ['mover'] },
  });

  const moveResult = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'bin', 'claude-init'), 'mcp', 'move', 'mover', '--to', 'user'],
    { cwd: repo, env: { ...process.env, HOME: home }, encoding: 'utf8' },
  );
  assert.strictEqual(moveResult.status, 0, moveResult.stderr);

  let prompted = false;
  mockPicker({
    checkbox: async () => { prompted = true; return []; },
    confirm: async () => { prompted = true; return true; },
  });
  const data = readJson(manifestLib.manifestPath(repo));
  const detectResult = await detectNew.handleCheck(repo, data);
  assert.strictEqual(detectResult.action, 'noop', 'a scope move should not re-trigger detection');
  assert.strictEqual(prompted, false);
}

async function testCheckNoopWhenNothingNew() {
  const repo = makeRepo('check-noop');
  writeJson(manifestLib.manifestPath(repo), {
    version: 1,
    mcps: ['x'],
    skills: [],
    secrets: {},
    known: { user: ['x'], plugin: [], local: [] },
  });
  setClaudeJson({
    mcpServers: { x: { type: 'stdio', command: 'node', args: ['x.js'], env: {} } },
  });

  let prompted = false;
  mockPicker({
    checkbox: async () => { prompted = true; return []; },
    confirm: async () => { prompted = true; return true; },
  });
  const data = readJson(manifestLib.manifestPath(repo));
  const result = await detectNew.handleCheck(repo, data);
  assert.strictEqual(result.action, 'noop');
  assert.strictEqual(prompted, false, 'should not prompt when nothing is new');
}

function testHttpMigrationPlanAndRewrap() {
  const cfg = {
    url: 'https://mcp.atlassian.com/v1/mcp',
    type: 'http',
    headers: { Authorization: 'Basic $BITBUCKET_TOKEN' },
  };
  const plan = migrate.planMigration(cfg);
  assert.strictEqual(plan.canMigrate, true);
  assert.strictEqual(plan.transport, 'http');
  assert.deepStrictEqual(plan.secrets, ['BITBUCKET_TOKEN']);

  const wrapped = migrate.rewrap(cfg, plan, {
    execCommand: 'claude-init',
    mappings: [{ envKey: 'BITBUCKET_TOKEN', secretName: 'BITBUCKET_TOKEN' }],
  });
  assert.deepStrictEqual(wrapped, {
    type: 'stdio',
    command: 'claude-init',
    args: [
      // --inject-argv opts this mcp-remote wrapper into argv substitution; stdio wrappers omit it.
      'exec', '--inject-argv', 'BITBUCKET_TOKEN', '--',
      'npx', '-y', 'mcp-remote',
      'https://mcp.atlassian.com/v1/mcp',
      // Bare $VAR (not ${VAR}): Claude Code ignores it at parse time; exec injects the value at launch.
      '--header', 'Authorization: Basic $BITBUCKET_TOKEN',
    ],
    env: {},
  });

  // A braced ${VAR} in the source config is normalised to the bare form so Claude Code never expands it.
  // rewrapHttp reads headers from the plan (not cfg), so the plan must be recomputed from the braced
  // config — otherwise this reuses the non-braced plan above and the assertion passes without exercising
  // braced normalisation at all.
  const bracedCfg = {
    url: 'https://mcp.atlassian.com/v1/mcp',
    type: 'http',
    headers: { Authorization: 'Basic ${BITBUCKET_TOKEN}' },
  };
  const bracedPlan = migrate.planMigration(bracedCfg);
  const braced = migrate.rewrap(bracedCfg, bracedPlan, {
    execCommand: 'claude-init',
    mappings: [{ envKey: 'BITBUCKET_TOKEN', secretName: 'BITBUCKET_TOKEN' }],
  });
  assert.ok(braced.args.includes('Authorization: Basic $BITBUCKET_TOKEN'));

  // A backend secret stored under a different name keeps the header's env key but remaps the lookup.
  const remapped = migrate.rewrap(cfg, plan, {
    execCommand: 'claude-init',
    mappings: [{ envKey: 'BITBUCKET_TOKEN', secretName: 'ATLASSIAN_PAT' }],
  });
  // The opt-in flag sits at index 1, so the remapped secret token follows it.
  assert.strictEqual(remapped.args[1], '--inject-argv');
  assert.strictEqual(remapped.args[2], 'BITBUCKET_TOKEN=ATLASSIAN_PAT');
  assert.ok(remapped.args.includes('Authorization: Basic $BITBUCKET_TOKEN'));

  // http with no secret references is still rejected — nothing to inject.
  const noRefs = migrate.planMigration({ url: 'https://example.com/mcp', type: 'http' });
  assert.strictEqual(noRefs.canMigrate, false);

  // Regression (Finding 2): a literal OData-style $option in the URL is NOT a secret. A bogus secret
  // here would make a non-secret URL migration-eligible and prompt for a credential that doesn't exist.
  const odata = migrate.planMigration({ url: 'https://api.example/mcp?$filter=status', type: 'http' });
  assert.strictEqual(odata.canMigrate, false, '$filter in a URL must not be treated as a secret');

  // …but genuine env-style ($TENANT) and braced (${API_TOKEN}) URL refs are still detected.
  assert.deepStrictEqual(migrate.collectUrlSecretRefs('https://$TENANT.example/mcp?$filter=x'), ['TENANT']);
  assert.deepStrictEqual(migrate.collectUrlSecretRefs('https://api.example/${API_TOKEN}'), ['API_TOKEN']);
}

function testInjectArgSecrets() {
  const resolved = [
    { envKey: 'BITBUCKET_TOKEN', value: 'p@ss$word' },
    { envKey: 'TENANT', value: 'acme' },
  ];
  const out = migrate.injectArgSecrets(
    ['--header', 'Authorization: Basic $BITBUCKET_TOKEN', 'https://$TENANT.example/${TENANT}', '$BITBUCKET_TOKEN_EXTRA'],
    resolved,
  );
  assert.deepStrictEqual(out, [
    '--header',
    'Authorization: Basic p@ss$word',
    'https://acme.example/acme',
    '$BITBUCKET_TOKEN_EXTRA', // word-boundary guard: a longer identifier is not substituted
  ]);

  // A value containing $-sequences must be inserted literally (not treated as replace() patterns).
  assert.deepStrictEqual(migrate.injectArgSecrets(['x=$A'], [{ envKey: 'A', value: '$1$&' }]), ['x=$1$&']);

  // Single-pass guard: a value that contains another key's reference must be inserted literally, not
  // rescanned. With A=abc$B and B=XYZ, the arg $A resolves to the literal abc$B — never abcXYZ.
  assert.deepStrictEqual(
    migrate.injectArgSecrets(['$A'], [{ envKey: 'A', value: 'abc$B' }, { envKey: 'B', value: 'XYZ' }]),
    ['abc$B'],
  );

  // No resolved secrets → args pass through untouched.
  assert.deepStrictEqual(migrate.injectArgSecrets(['$A', 'b'], []), ['$A', 'b']);
}

function testArgvInjectionIsOptIn() {
  // Regression (Finding 1): argv substitution must be gated behind --inject-argv. A plain stdio wrapper
  // (env secret TOKEN + a literal $TOKEN arg) must NOT carry the flag, so exec leaves its argv untouched
  // and never materialises the secret into the command line (which `ps` would expose).
  const stdioCfg = { type: 'stdio', command: 'node', args: ['server.js', '$TOKEN'], env: { TOKEN: '$TOKEN' } };
  const stdioPlan = migrate.planMigration(stdioCfg);
  const stdioWrapped = migrate.rewrap(stdioCfg, stdioPlan, {
    execCommand: 'claude-init',
    mappings: [{ envKey: 'TOKEN', secretName: 'TOKEN' }],
  });
  assert.ok(!stdioWrapped.args.includes(migrate.INJECT_ARGV_FLAG), 'stdio wrappers must not opt into argv injection');

  // parseExecArgv splits the opt-in flag from the secret tokens and reports the injection decision.
  assert.deepStrictEqual(
    migrate.parseExecArgv(['--inject-argv', 'BITBUCKET_TOKEN']),
    { secretTokens: ['BITBUCKET_TOKEN'], injectArgv: true },
  );
  assert.deepStrictEqual(
    migrate.parseExecArgv(['TOKEN', 'OTHER=NAME']),
    { secretTokens: ['TOKEN', 'OTHER=NAME'], injectArgv: false },
  );

  // The flag survives a secret-name remap (the `mcp move` path) so the wrapper keeps injecting.
  const httpWrapped = migrate.rewrap(
    { url: 'https://mcp.atlassian.com/v1/mcp', type: 'http', headers: { Authorization: 'Basic $BITBUCKET_TOKEN' } },
    migrate.planMigration({ url: 'https://mcp.atlassian.com/v1/mcp', type: 'http', headers: { Authorization: 'Basic $BITBUCKET_TOKEN' } }),
    { execCommand: 'claude-init', mappings: [{ envKey: 'BITBUCKET_TOKEN', secretName: 'BITBUCKET_TOKEN' }] },
  );
  const remapped = migrate.rewriteWrappedTokens(httpWrapped, [{ envKey: 'BITBUCKET_TOKEN', secretName: 'ATLASSIAN_PAT' }]);
  assert.ok(remapped.args.includes(migrate.INJECT_ARGV_FLAG), 'remap must preserve --inject-argv');
  assert.deepStrictEqual(migrate.readWrappedTokens(remapped), [{ envKey: 'BITBUCKET_TOKEN', secretName: 'ATLASSIAN_PAT' }]);

  // The flag is part of equivalence identity: a working wrapper (with --inject-argv) and an otherwise
  // identical broken one (flag stripped) must NOT be equivalent. Collision cleanup (`mcp move`) relies
  // on this — otherwise it could drop the working copy and keep one that forwards a literal $TOKEN.
  const flagless = { ...httpWrapped, args: httpWrapped.args.filter((a) => a !== migrate.INJECT_ARGV_FLAG) };
  assert.ok(!migrate.equivalent(httpWrapped, flagless), 'flag presence must affect equivalence');
  assert.ok(migrate.equivalent(httpWrapped, { ...httpWrapped, args: [...httpWrapped.args] }), 'identical wrappers stay equivalent');
}

async function testWrapsHttpServerViaMcpRemote() {
  const repo = makeRepo('http-wrap');
  writeJson(path.join(repo, '.claude', '.claude-init.json'), {
    version: 1,
    mcps: [],
    skills: [],
    secrets: {
      BITBUCKET_TOKEN: { backend: 'op', ref: 'op://Test/Bitbucket/credential' },
    },
  });
  setClaudeJson({
    mcpServers: {
      bitbucket: {
        url: 'https://mcp.atlassian.com/v1/mcp',
        type: 'http',
        headers: { Authorization: 'Basic $BITBUCKET_TOKEN' },
      },
    },
  });

  mockPicker({
    select: async ({ choices }) => {
      const useExisting = choices.find((choice) => choice.value === 'use');
      return (useExisting || choices[0]).value;
    },
  });

  const projData = manifestLib.read(repo);
  const result = await wizard.wrapMcpByName(repo, 'bitbucket', projData);
  assert.strictEqual(result.status, 'wrapped');

  const wrapped = readJson(path.join(home, '.claude.json')).mcpServers.bitbucket;
  assert.match(wrapped.command, /claude-init$/);
  assert.deepStrictEqual(wrapped.args, [
    'exec', '--inject-argv', 'BITBUCKET_TOKEN', '--',
    'npx', '-y', 'mcp-remote',
    'https://mcp.atlassian.com/v1/mcp',
    '--header', 'Authorization: Basic $BITBUCKET_TOKEN',
  ]);
  assert.strictEqual(wrapped.type, 'stdio');
  assert.strictEqual(wrapped.url, undefined, 'stale http url must be dropped');
  assert.strictEqual(wrapped.headers, undefined, 'stale headers must be dropped');
}

function testInvalidJsonIsNotOverwritten() {
  const repo = makeRepo('invalid-json');
  const target = path.join(repo, '.mcp.json');
  fs.writeFileSync(target, '{ invalid json');
  assert.throws(
    () => writers.writeProjectMcpJson(repo, [{ name: 'x', command: 'node', args: [], env: {} }]),
    /invalid JSON/,
  );
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{ invalid json');
}

(async () => {
  await testUserMcpsStayUserScoped();
  await testInitWrapsUserMcpInPlace();
  await testProjectMcpStateIsReplaced();
  await testSkippedSecretLeavesProjectMcpUnchanged();
  await testInitMigratesProjectDollarEnvReference();
  testProjectMcpEnableDisableCliUsesSettingsJson();
  await testCopiedUserShimCleanup();
  await testShimCleanupRespectsInjectArgvFlag();
  await testRunInitRecordsKnownSnapshot();
  testDetectFlagsNewUserMcp();
  testDetectQuietWhenNothingNew();
  testDetectLegacyManifestBootstrap();
  testDetectFlagsNewLocalMcp();
  await testCheckDisablesNewMcpWhenUnchecked();
  await testCheckLeavesEnabledNewMcpAlone();
  await testCheckDeferKeepsKnownStable();
  await testCheckLegacyManifestBootstrapsSilently();
  testMcpMoveRefreshesKnown();
  await testCheckNoopAfterMove();
  await testCheckNoopWhenNothingNew();
  testHttpMigrationPlanAndRewrap();
  testInjectArgSecrets();
  testArgvInjectionIsOptIn();
  await testWrapsHttpServerViaMcpRemote();
  testInvalidJsonIsNotOverwritten();
  console.log('improvements tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
