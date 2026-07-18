import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { validatePackage } from './release/lib/manifest.mjs';
const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [path.join(root, 'scripts', 'package.mjs')], { stdio: 'inherit' });
const packageDir = path.join(root, 'build', 'tutti-agent', 'package');
const manifest = JSON.parse(await readFile(path.join(packageDir, 'tutti.agent.json'), 'utf8'));
const evidence = JSON.parse(await readFile(path.join(root, 'docs', 'probes', 'copilot-1.0.71.json'), 'utf8'));
const capabilities = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.capabilities), 'utf8')).declared;
const composer = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.composer), 'utf8'));
const discovery = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.discovery), 'utf8'));
const tools = JSON.parse(await readFile(path.join(packageDir, manifest.profiles.tools), 'utf8')).tools;
if (manifest.schemaVersion !== 'tutti.agent.manifest.v2' || manifest.agentKey !== 'copilot' || manifest.version !== '1.0.0') throw new Error('invalid manifest identity');
const targetIdentity = {
  agentTargetId: `extension:${manifest.agentKey}`,
  provider: `acp:${manifest.agentKey}`
};
if (targetIdentity.agentTargetId !== 'extension:copilot' || targetIdentity.provider !== 'acp:copilot') throw new Error('invalid derived Target identity');
const expectedInstall = ['install', '--prefix', '${installRoot}', '@github/copilot@1.0.71'];
if (manifest.runtime?.install?.runner !== 'npm' || JSON.stringify(manifest.runtime.install.args) !== JSON.stringify(expectedInstall)) throw new Error('Copilot runtime must be exactly pinned under installRoot');
if (manifest.runtime?.launch?.executable !== '${installRoot}/node_modules/.bin/copilot' || manifest.runtime.launch.args?.join('\0') !== '--acp\0--stdio') throw new Error('invalid Copilot ACP launch contract');
const discoveryCandidate = discovery.candidates?.[0];
if (discovery.candidates?.length !== 1 || JSON.stringify(discoveryCandidate?.binaryNames) !== JSON.stringify(['copilot']) || JSON.stringify(discoveryCandidate?.version?.args) !== JSON.stringify(['--version']) || discoveryCandidate?.version?.constraint !== '>=1.0.71 <2.0.0' || JSON.stringify(discoveryCandidate?.launchArgs) !== JSON.stringify(['--acp', '--stdio']) || discoveryCandidate?.probe?.kind !== 'acp-initialize' || discoveryCandidate?.probe?.timeoutMs !== 5000) throw new Error('invalid Copilot local discovery contract');
if (evidence.runtime.package !== '@github/copilot@1.0.71' || evidence.runtime.registryVersion !== '1.0.71' || evidence.runtime.registryBin?.copilot !== 'npm-loader.js' || evidence.probe.initialize.protocolVersion !== 1 || evidence.probe.initialize.agentInfo.version !== '1.0.71') throw new Error('runtime evidence does not match the pinned ACP contract');
if (evidence.revalidatedAt !== '2026-07-18' || evidence.revalidation?.runtimeInstall !== 'isolated exact npm prefix' || evidence.revalidation?.versionOutput !== 'GitHub Copilot CLI 1.0.71.' || evidence.revalidation?.initializeProtocolVersion !== 1 || evidence.revalidation?.initializeAgentVersion !== '1.0.71' || !evidence.revalidation?.initializeAuthMethodIds?.includes('copilot-login') || evidence.revalidation?.sessionNew?.status !== 'error' || evidence.revalidation?.sessionNew?.error?.code !== -32000 || evidence.revalidation?.sessionNew?.error?.message !== 'Authentication required' || evidence.revalidation?.paidPromptSent !== false || evidence.revalidation?.secretMaterialRecorded !== false) throw new Error('independent runtime revalidation evidence is missing or unsafe');
const promptCapabilities = evidence.probe.initialize.agentCapabilities.promptCapabilities;
if (capabilities.imageInput !== promptCapabilities.image || capabilities.audioInput !== promptCapabilities.audio || capabilities.embeddedContext !== promptCapabilities.embeddedContext || capabilities.resume !== evidence.probe.initialize.agentCapabilities.loadSession || capabilities.modelSelection !== evidence.probe.sessionNew.modelsFieldPresent) throw new Error('declared capabilities exceed ACP probe evidence');
if (capabilities.interrupt !== false || Object.hasOwn(evidence.probe.initialize.agentCapabilities, 'interrupt')) throw new Error('interrupt must remain disabled without advertised ACP evidence');
const probedModes = new Map(evidence.probe.sessionNew.modes.availableModes.map((mode) => [mode.id, mode]));
if (capabilities.permissionModes !== (probedModes.size > 0)) throw new Error('permission mode capability must match ACP session evidence');
for (const mode of composer.permissionModes) {
  if (!probedModes.has(mode.runtimeId)) throw new Error(`composer permission mapping lacks ACP mode evidence: ${mode.runtimeId}`);
}
const autopilotMode = composer.permissionModes.find((mode) => mode.runtimeId === 'https://agentclientprotocol.com/protocol/session-modes#autopilot');
if (autopilotMode?.semantic !== 'full-access' || !/enables allow-all/i.test(probedModes.get(autopilotMode.runtimeId)?.description || '')) throw new Error('Autopilot full-access mapping requires explicit ACP mode evidence');
const unsupportedModeMappings = composer.permissionModes.filter((mode) => mode.runtimeId !== autopilotMode.runtimeId);
if (unsupportedModeMappings.length !== 0) throw new Error('Agent and Plan semantics are not established by the ACP probe');
if (tools.length !== 0 || evidence.probe.toolEvidence.toolIdsObserved.length !== 0) throw new Error('tool mappings require ACP payload evidence');
if (!evidence.probe.notifications.availableCommandsUpdateObserved || evidence.probe.notifications.availableCommandCountInSanitizedProbe < 1 || Object.hasOwn(composer, 'commands')) throw new Error('slash commands must remain runtime-owned available_commands_update snapshots');
await validatePackage(packageDir, 'copilot');
await rejectExecutables(packageDir);
async function rejectExecutables(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${item}`);
    if (entry.isDirectory()) { await rejectExecutables(item); continue; }
    if ((await stat(item)).mode & 0o111) throw new Error(`executable is forbidden: ${item}`);
  }
}
