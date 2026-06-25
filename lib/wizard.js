const fs = require('fs');
const path = require('path');
const scopeMove = require('./scope-move');
const manifest = require('./manifest');
const userManifest = require('./user-manifest');
const discover = require('./discover');
const projectState = require('./project-state');
const writers = require('./writers');
const picker = require('./picker');
const secretsResolve = require('./secrets-resolve');
const migrate = require('./migrate');
const detectNew = require('./detect-new');
const jsonFile = require('./json-file');
const backends = {
  keychain: require('./backends/keychain'),
  op: require('./backends/op'),
};

function bold(s) { return `\x1b[1m${s}\x1b[22m`; }
function dim(s) { return `\x1b[2m${s}\x1b[22m`; }
function green(s) { return `\x1b[32m${s}\x1b[39m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[39m`; }
function red(s) { return `\x1b[31m${s}\x1b[39m`; }

function selfPath() {
  return fs.realpathSync(path.resolve(__dirname, '..', 'bin', 'claude-init'));
}

async function configureSecret(envKey, repoRoot, projData) {
  // Returns { storedAs } when the user wired up a secret, or null if skipped.
  // storedAs may differ from envKey when the user picked "store under a different name."
  const existing = secretsResolve.resolve(repoRoot, envKey);
  let scope;
  let actualName = envKey;
  if (existing) {
    console.log('');
    const choice = await picker.select({
      message: `${bold(envKey)} is set at ${existing.scope} scope:`,
      choices: [
        { name: 'Use existing value', value: 'use' },
        { name: 'Override for this repo', value: 'override' },
        { name: 'Store under a different name (this MCP needs a separate value)', value: 'rename' },
        { name: 'Skip this secret', value: 'skip' },
      ],
    });
    if (choice === 'use') return { storedAs: envKey };
    if (choice === 'skip') return null;
    if (choice === 'override') {
      scope = 'project';
    } else {
      actualName = await picker.input({
        message: `New secret name (used in keychain/op, distinct from ${envKey}):`,
        validate: (v) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) && v !== envKey) || 'use a different identifier (letters, digits, underscores)',
      });
      scope = await picker.select({
        message: `Where to store ${bold(actualName)}?`,
        choices: [
          { name: 'User scope (shared across all your projects)', value: 'user' },
          { name: 'Project scope (this repo only)', value: 'project' },
        ],
      });
    }
  } else {
    console.log('');
    scope = await picker.select({
      message: `Where to store ${bold(envKey)}?`,
      choices: [
        { name: 'User scope (shared across all your projects)', value: 'user' },
        { name: 'Project scope (this repo only)', value: 'project' },
        { name: 'Skip', value: 'skip' },
      ],
    });
    if (scope === 'skip') return null;
  }
  const backend = await picker.select({
    message: `Backend for ${actualName}:`,
    choices: [
      { name: 'macOS Keychain', value: 'keychain' },
      { name: '1Password (op://...)', value: 'op' },
    ],
  });
  let ref;
  let isolated = false;
  if (backend === 'keychain') {
    const value = await picker.password({ message: `Value for ${actualName}:` });
    if (!value) { console.log(dim(`  empty — skipped ${actualName}`)); return null; }
    if (scope === 'project') {
      isolated = await picker.confirm({ message: 'Isolate this secret per-repo?', default: false });
    }
    ref = backends.keychain.set({ name: actualName, value, isolated, repoHash: manifest.repoHash(repoRoot) });
  } else {
    const opRef = await picker.input({
      message: `1Password reference for ${actualName}:`,
      validate: (v) => v.startsWith('op://') || 'must start with op://',
    });
    ref = backends.op.set({ name: actualName, opRef });
  }
  const entry = { ...ref, isolated: isolated || undefined };
  if (scope === 'project') {
    projData.secrets = projData.secrets || {};
    projData.secrets[actualName] = entry;
  } else {
    const ud = userManifest.load();
    ud.secrets = ud.secrets || {};
    ud.secrets[actualName] = entry;
    userManifest.write(ud);
  }
  console.log(green(`  stored ${actualName} (${scope}, ${backend})`));
  return { storedAs: actualName };
}

async function pickProjectActions(projectMcps, root) {
  const settings = jsonFile.readOr(path.join(root, '.claude', 'settings.json'), {});
  const disabledList = settings.disabledMcpjsonServers || [];
  const explicitlyDisabled = new Set(disabledList);

  console.log('');
  const enabledNames = await picker.checkbox({
    message: `Project-scope MCPs in .mcp.json — enable per repo (unselect to disable):`,
    choices: projectMcps.map((m) => ({
      name: m.name,
      value: m.name,
      checked: !explicitlyDisabled.has(m.name),
      description: m.claudeInitWrapped
        ? 'wrapped via claude-init exec'
        : (m.requiredSecrets.length ? `uses ${m.requiredSecrets.join(', ')}` : ''),
    })),
  });

  const allWithPlans = projectMcps.map((m) => {
    const cfg = writers.readProjectServer(root, m.name);
    return { name: m.name, cfg, plan: migrate.planMigration(cfg || {}) };
  });
  const migrateCandidates = allWithPlans.filter((x) => x.plan.canMigrate);
  const skipped = allWithPlans.filter((x) =>
    !x.plan.canMigrate && x.plan.reason && /argv|http|already/.test(x.plan.reason),
  );

  let toMigrate = [];
  if (migrateCandidates.length > 0) {
    console.log('');
    toMigrate = await picker.checkbox({
      message: `Migrate project entries to claude-init exec? (removes \${VAR} env coupling)`,
      hint: '↑/↓ move · space toggle · enter confirm · q skip · default: none',
      choices: migrateCandidates.map((x) => ({
        name: x.name,
        value: x.name,
        description: `secrets ${x.plan.secrets.join(', ')}${x.plan.argvWarnings.length ? ` · argv \${${x.plan.argvWarnings.join(', ${')}} also referenced` : ''}`,
      })),
    });
  }

  if (skipped.length > 0) {
    console.log(dim('\n  project entries not auto-migrateable:'));
    for (const x of skipped) console.log(dim(`    ${x.name}: ${x.plan.reason}`));
  }

  return {
    enabledNames,
    disabledNames: projectMcps.map((m) => m.name).filter((n) => !enabledNames.includes(n)),
    toMigrate,
    migrateCandidates,
    skipped,
  };
}

function migrationCandidatesForScope(root, mcps, scope) {
  return mcps.map((m) => {
    const cfg = scope === 'project'
      ? writers.readProjectServer(root, m.name)
      : scopeMove.entryAtScope(root, scope, m.name);
    return { name: m.name, cfg, plan: migrate.planMigration(cfg || {}) };
  });
}

async function pickScopedMigrations(mcps, root, scope, label) {
  if (mcps.length === 0) return { toMigrate: [], migrateCandidates: [], skipped: [] };
  const allWithPlans = migrationCandidatesForScope(root, mcps, scope);
  const migrateCandidates = allWithPlans.filter((x) => x.plan.canMigrate);
  const skipped = allWithPlans.filter((x) =>
    !x.plan.canMigrate && x.plan.reason && /argv|http|already/.test(x.plan.reason),
  );
  let toMigrate = [];
  if (migrateCandidates.length > 0) {
    console.log('');
    toMigrate = await picker.checkbox({
      message: `Migrate ${label} entries to claude-init exec? (removes \${VAR} env coupling)`,
      hint: '↑/↓ move · space toggle · enter confirm · q skip · default: none',
      choices: migrateCandidates.map((x) => ({
        name: x.name,
        value: x.name,
        description: `secrets ${x.plan.secrets.join(', ')}${x.plan.argvWarnings.length ? ` · argv \${${x.plan.argvWarnings.join(', ${')}} also referenced` : ''}`,
      })),
    });
  }
  if (skipped.length > 0) {
    console.log(dim(`\n  ${label} entries not auto-migrateable:`));
    for (const x of skipped) console.log(dim(`    ${x.name}: ${x.plan.reason}`));
  }
  return { toMigrate, migrateCandidates, skipped };
}

async function wrapLocatedMcp(root, name, scope, cfg, plan, projData, logLabel = scope) {
  const mappings = [];
  for (const envKey of plan.secrets) {
    const result = await configureSecret(envKey, root, projData);
    if (!result) {
      return { status: 'skipped', skippedSecret: envKey };
    }
    mappings.push({ envKey, secretName: result.storedAs });
  }
  const execCommand = scope === 'project' ? 'claude-init' : selfPath();
  const newCfg = migrate.rewrap(cfg, plan, { execCommand, mappings });
  const writtenCfg = {
    type: newCfg.type || 'stdio',
    command: newCfg.command,
    args: newCfg.args,
    env: newCfg.env,
  };
  if (scope === 'project') {
    writers.writeProjectMcpJson(root, [{
      name,
      ...writtenCfg,
      requiredSecrets: [],
    }]);
  } else {
    scopeMove.writeToScope(root, scope, name, writtenCfg);
  }
  if (plan.argvWarnings.length) {
    console.log(yellow(`  warning: argv references ${plan.argvWarnings.map((v) => '${' + v + '}').join(', ')} remain — Claude Code will expand from your shell env at parse time`));
  }
  return { status: 'wrapped', scope, name, logLabel, argvWarnings: plan.argvWarnings, transport: plan.transport };
}

async function wrapMcpByName(root, name, projData) {
  const located = scopeMove.locateEntry(root, name);
  if (!located) throw new Error(`MCP "${name}" not found in user, project, or local scope for ${root}`);
  if (migrate.isClaudeInitWrapped(located.cfg)) {
    return { name, scope: located.scope, status: 'already-wrapped' };
  }
  const plan = migrate.planMigration(located.cfg);
  if (!plan.canMigrate) throw new Error(`cannot wrap "${name}": ${plan.reason}`);
  return wrapLocatedMcp(root, name, located.scope, located.cfg, plan, projData);
}

async function applyScopedMigrations(root, plan, projData, scope, label) {
  const migrated = [];
  if (plan.toMigrate.length === 0) return migrated;
  for (const name of plan.toMigrate) {
    const candidate = plan.migrateCandidates.find((x) => x.name === name);
    if (!candidate) continue;
    console.log(yellow(`\nMigrating ${label} ${name} — configuring secrets…`));
    const result = await wrapLocatedMcp(root, name, scope, candidate.cfg, candidate.plan, projData, label);
    if (result.status === 'skipped') {
      console.log(dim(`  skipped ${label} ${name}; ${result.skippedSecret} was not configured.`));
      continue;
    }
    console.log(green(`  migrated ${label} ${name}`));
    migrated.push(name);
  }
  return migrated;
}

async function applyProjectMigrations(root, projectMcps, plan, projData) {
  return applyScopedMigrations(root, plan, projData, 'project', 'project');
}

async function cleanupMaterializedUserShims(root, projectMcps, userMcps, state) {
  const userByName = new Map(userMcps.map((m) => [m.name, m]));
  let changed = false;
  for (const projectMcp of projectMcps) {
    const userMcp = userByName.get(projectMcp.name);
    if (!userMcp) continue;
    const projectCfg = writers.readProjectServer(root, projectMcp.name);
    const userCfg = scopeMove.entryAtScope(root, 'user', projectMcp.name);
    if (!projectCfg || !userCfg) continue;
    const projectUnwrapped = migrate.unwrap(projectCfg);
    const userUnwrapped = migrate.unwrap(userCfg);
    const sameUnderlyingCommand =
      projectUnwrapped.command === userUnwrapped.command
      && JSON.stringify(projectUnwrapped.args || []) === JSON.stringify(userUnwrapped.args || []);
    // The sameUnderlyingCommand fallback compares only the unwrapped trailing command, which is blind to
    // exec-token differences like --inject-argv (those live before `--`). So only trust it for the case it
    // was meant for: a project wrapper generated from an UNwrapped user MCP. When the user copy is also
    // wrapped, require full (flag-aware) equivalence — otherwise cleanup could drop a working project
    // wrapper and keep a flag-stripped user copy that forwards a literal $TOKEN to mcp-remote.
    const looksGenerated = migrate.equivalent(projectCfg, userCfg)
      || (migrate.isClaudeInitWrapped(projectCfg) && !migrate.isClaudeInitWrapped(userCfg) && sameUnderlyingCommand);
    if (!looksGenerated) continue;
    const ok = await picker.confirm({
      message: `${projectMcp.name} looks like a user MCP copied into .mcp.json by an older claude-init version. Move it back to user scope and remove the project copy?`,
      default: true,
    }).catch(() => false);
    if (!ok) continue;

    if (migrate.isClaudeInitWrapped(projectCfg) && !migrate.isClaudeInitWrapped(userCfg)) {
      const adjusted = scopeMove.adjustWrapperPath(projectCfg, 'user');
      const tokens = migrate.readWrappedTokens(adjusted) || [];
      const env = { ...(adjusted.env || {}) };
      for (const token of tokens) delete env[token.envKey];
      scopeMove.writeToScope(root, 'user', projectMcp.name, { ...adjusted, env });
    }
    writers.removeFromProjectMcpJson(root, [projectMcp.name]);
    projectState.clearProjectMcpjsonState(root, [projectMcp.name]);
    const wasProjectDisabled = (state.disabledMcpjsonServers || []).includes(projectMcp.name);
    projectState.setDisabledMcps(root, [projectMcp.name], wasProjectDisabled ? [projectMcp.name] : []);
    console.log(green(`  cleaned up project shim for ${projectMcp.name}`));
    changed = true;
  }
  return changed;
}

async function runInit({ root, isGit }) {
  console.log(bold('claude-init') + dim(' — ' + root + (isGit ? '' : ' (no git)')));

  const existing = manifest.read(root);
  if (existing) {
    const proceed = await picker.confirm({
      message: 'A claude-init manifest exists. Re-run the wizard?',
      default: true,
    });
    if (!proceed) { console.log(dim('No changes.')); return; }
  }

  console.log(dim('discovering MCPs and skills…'));
  let mcps = discover.discoverMcps(root);
  const skills = discover.discoverSkills();
  let state = projectState.getProjectState(root);

  const initialProjectMcps = mcps.filter((m) => m.source === 'project');
  const initialUserMcps = discover.discoverUserMcps();
  if (initialProjectMcps.length > 0 && initialUserMcps.length > 0) {
    const cleaned = await cleanupMaterializedUserShims(root, initialProjectMcps, initialUserMcps, state);
    if (cleaned) {
      mcps = discover.discoverMcps(root);
      state = projectState.getProjectState(root);
    }
  }

  const userMcps = mcps.filter((m) => m.source === 'user');
  const projectMcps = mcps.filter((m) => m.source === 'project');
  const localMcps = mcps.filter((m) => m.source === 'local');
  const claudeaiMcps = mcps.filter((m) => m.source === 'claudeai');
  const pluginGroups = {};
  for (const m of mcps.filter((x) => x.source === 'plugin')) {
    if (!pluginGroups[m.pluginName]) pluginGroups[m.pluginName] = [];
    pluginGroups[m.pluginName].push(m.name);
  }
  const installedPluginIds = discover.discoverInstalledPlugins().map((p) => p.id);
  const pluginIds = [...new Set([...installedPluginIds, ...Object.keys(pluginGroups)])];

  if (mcps.length === 0 && skills.length === 0 && pluginIds.length === 0) {
    console.log('Nothing to configure: no user/project MCPs, no plugins, no claude.ai connectors, no skills.');
    return;
  }

  // 1. user-scope MCPs to enable in this repo
  let selectedUserMcpNames = [];
  if (userMcps.length > 0) {
    const currentlyDisabled = new Set(state.disabledMcpServers || []);
    selectedUserMcpNames = await picker.checkbox({
      message: 'User-scope MCPs to enable in this repo (unselect to disable per-repo):',
      choices: userMcps.map((m) => ({
        name: m.name,
        value: m.name,
        checked: !currentlyDisabled.has(m.name),
        description: m.requiredSecrets.length ? `needs ${m.requiredSecrets.join(', ')}` : '',
      })),
    });
  }

  let userPlan = { toMigrate: [], migrateCandidates: [], skipped: [] };
  if (userMcps.length > 0) {
    userPlan = await pickScopedMigrations(userMcps, root, 'user', 'user');
  }

  // 2. project-scope MCPs (.mcp.json) — enable/disable + optional ${VAR} migration
  let projectPlan = { enabledNames: [], disabledNames: [], toMigrate: [], migrateCandidates: [] };
  if (projectMcps.length > 0) {
    projectPlan = await pickProjectActions(projectMcps, root);
  }

  // Collision check: user-scope name collides with an existing project-scope entry
  const projectNames = new Set(projectMcps.map((m) => m.name));
  const collisions = selectedUserMcpNames.filter((n) => projectNames.has(n));
  if (collisions.length > 0) {
    console.log(red(`\nName collision: ${collisions.join(', ')} exists at both user and project scope.`));
    console.log(dim('Project takes precedence in Claude Code. Wrapping skipped to avoid overwriting the project entry.'));
    console.log(dim('Tip: `claude-init mcp move <name> --to user` (or vice versa) resolves it.'));
    selectedUserMcpNames = selectedUserMcpNames.filter((n) => !collisions.includes(n));
  }

  // 2b. local-scope MCPs — enable/disable + optional ${VAR} migration
  let localToEnable = localMcps.map((m) => m.name);
  let localPlan = { toMigrate: [], migrateCandidates: [], skipped: [] };
  if (localMcps.length > 0) {
    const currentlyDisabled = new Set(state.disabledMcpServers || []);
    localToEnable = await picker.checkbox({
      message: 'Local-scope MCPs (~/.claude.json projects[<root>]) — enable in this repo:',
      choices: localMcps.map((m) => ({
        name: m.name,
        value: m.name,
        checked: !currentlyDisabled.has(m.name),
        description: m.claudeInitWrapped
          ? 'wrapped via claude-init exec'
          : (m.requiredSecrets.length ? `uses ${m.requiredSecrets.join(', ')}` : ''),
      })),
    });
    localPlan = await pickScopedMigrations(localMcps, root, 'local', 'local');
  }

  // 3. plugins (whole-plugin per-repo enable/disable)
  let pluginsToEnable = pluginIds;
  if (pluginIds.length > 0) {
    const currentlyDisabled = new Set(Object.entries(state.enabledPlugins).filter(([, v]) => v === false).map(([k]) => k));
    pluginsToEnable = await picker.checkbox({
      message: 'Plugins enabled in this repo (unselect to disable the WHOLE plugin per-repo):',
      choices: pluginIds.map((id) => ({
        name: id,
        value: id,
        checked: !currentlyDisabled.has(id),
        description: pluginGroups[id] ? `provides MCP: ${pluginGroups[id].join(', ')}` : 'no MCP servers',
      })),
    });
  }

  // 4. claude.ai connectors
  let claudeaiToEnable = claudeaiMcps.map((m) => m.name);
  if (claudeaiMcps.length > 0) {
    const currentlyDisabled = new Set(state.disabledMcpServers || []);
    claudeaiToEnable = await picker.checkbox({
      message: 'claude.ai connectors enabled in this repo (unselect to disable per-repo):',
      choices: claudeaiMcps.map((m) => ({
        name: m.name,
        value: m.name,
        checked: !currentlyDisabled.has(m.name),
      })),
    });
  }

  // 5. skills
  let selectedSkills = skills.map((s) => s.name);
  if (skills.length > 0) {
    const prev = existing && existing.skills;
    const prevSet = new Set(prev || skills.map((s) => s.name));
    selectedSkills = await picker.checkbox({
      message: 'Skills enabled in this repo (unselect to turn off per-repo):',
      choices: skills.map((s) => ({
        name: s.name,
        value: s.name,
        checked: prevSet.has(s.name),
        description: s.description ? s.description.slice(0, 80) : '',
      })),
    });
  }

  // 6. persist selected user-scope MCP names in the manifest for display/history only
  const projData = existing || { version: 1, mcps: [], skills: [], secrets: {} };
  projData.mcps = selectedUserMcpNames;
  projData.skills = selectedSkills;
  projData.secrets = projData.secrets || {};

  // 6b. apply user migrations (mutates ~/.claude.json mcpServers in place)
  const userMigrated = await applyScopedMigrations(root, userPlan, projData, 'user', 'user');

  // 7. apply project migrations (mutates .mcp.json entries in place)
  const projectMigrated = await applyProjectMigrations(root, projectMcps, projectPlan, projData);

  // 7b. apply local migrations (mutates ~/.claude.json projects[].mcpServers in place)
  const localMigrated = await applyScopedMigrations(root, localPlan, projData, 'local', 'local');

  // 10. plugins
  for (const id of pluginIds) {
    const wantEnabled = pluginsToEnable.includes(id);
    const isCurrentlyDisabled = state.enabledPlugins[id] === false;
    if (!wantEnabled && !isCurrentlyDisabled) projectState.setPluginState(root, id, 'disable');
    else if (wantEnabled && isCurrentlyDisabled) projectState.setPluginState(root, id, 'unset');
  }

  // 11. user/local/claude.ai MCPs use disabledMcpServers; project MCPs use .claude/settings.json.
  if (userMcps.length > 0) {
    const allNames = userMcps.map((m) => m.name);
    const toDisable = allNames.filter((n) => !selectedUserMcpNames.includes(n));
    projectState.setDisabledMcps(root, allNames, toDisable);
  }
  if (claudeaiMcps.length > 0) {
    const allNames = claudeaiMcps.map((m) => m.name);
    const toDisable = allNames.filter((n) => !claudeaiToEnable.includes(n));
    projectState.setDisabledMcps(root, allNames, toDisable);
  }
  if (localMcps.length > 0) {
    const allNames = localMcps.map((m) => m.name);
    const toDisable = allNames.filter((n) => !localToEnable.includes(n));
    projectState.setDisabledMcps(root, allNames, toDisable);
  }

  if (projectMcps.length > 0) {
    projectState.setProjectMcpjsonState(
      root,
      projectMcps.map((m) => m.name),
      projectPlan.enabledNames,
    );
  }

  // 12. settings.json — skill overrides only; project MCP state is handled above.
  const skillOverrides = {};
  const enabledSkillSet = new Set(selectedSkills);
  for (const s of skills) {
    if (!enabledSkillSet.has(s.name)) skillOverrides[s.name] = 'off';
    else skillOverrides[s.name] = null;
  }
  writers.mergeSettingsJson(root, {
    skillOverrides,
  });

  // 13. .gitignore — never commit per-user files
  if (isGit) {
    writers.addToGitignore(root, '.claude/.claude-init.json', 'claude-init manifest (per-user secret refs, no values)');
    writers.addToGitignore(root, '.claude/settings.local.json', 'Claude Code per-user settings (permissions allowlists, etc.)');
  }

  // 14. manifest — record current per-scope MCP names so future `check` runs
  // can spot anything newly added.
  detectNew.recordKnown(projData, detectNew.snapshot(root));
  manifest.write(root, projData);

  // 15. summary
  const pluginsDisabled = pluginIds.filter((id) => !pluginsToEnable.includes(id));
  const claudeaiDisabled = claudeaiMcps.map((m) => m.name).filter((n) => !claudeaiToEnable.includes(n));
  const skillsOff = skills.map((s) => s.name).filter((n) => !selectedSkills.includes(n));
  console.log('\n' + bold('Summary'));
  console.log(`  root: ${root}${isGit ? '' : dim(' (no git)')}`);
  if (selectedUserMcpNames.length) console.log(`  ${green('user MCPs enabled:')} ${selectedUserMcpNames.join(', ')}`);
  if (projectPlan.enabledNames.length) console.log(`  ${green('project MCPs enabled:')} ${projectPlan.enabledNames.join(', ')}`);
  if (projectPlan.disabledNames.length) console.log(`  ${yellow('project MCPs disabled:')} ${projectPlan.disabledNames.join(', ')}`);
  if (userMigrated.length) console.log(`  ${green('user migrated to claude-init:')} ${userMigrated.join(', ')}`);
  if (projectMigrated.length) console.log(`  ${green('project migrated to claude-init:')} ${projectMigrated.join(', ')}`);
  if (localMigrated.length) console.log(`  ${green('local migrated to claude-init:')} ${localMigrated.join(', ')}`);
  if (collisions.length) console.log(`  ${red('skipped (collision):')} ${collisions.join(', ')}`);
  if (pluginsDisabled.length) console.log(`  ${yellow('plugins disabled:')} ${pluginsDisabled.join(', ')} ${dim('(whole plugin)')}`);
  if (claudeaiDisabled.length) console.log(`  ${yellow('claude.ai disabled:')} ${claudeaiDisabled.join(', ')}`);
  const localDisabled = localMcps.map((m) => m.name).filter((n) => !localToEnable.includes(n));
  if (localToEnable.length) console.log(`  ${green('local MCPs enabled:')} ${localToEnable.join(', ')}`);
  if (localDisabled.length) console.log(`  ${yellow('local MCPs disabled:')} ${localDisabled.join(', ')}`);
  if (selectedSkills.length) console.log(`  ${green('skills enabled:')} ${selectedSkills.join(', ')}`);
  if (skillsOff.length) console.log(`  ${dim('skills off:')} ${skillsOff.join(', ')}`);
  console.log(dim('\n  changes apply on next Claude Code launch in this directory.'));
}

module.exports = { runInit, configureSecret, wrapMcpByName, cleanupMaterializedUserShims };
