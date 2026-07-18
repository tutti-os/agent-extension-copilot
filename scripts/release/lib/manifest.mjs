import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  isRelativePackagePath,
  requireSafeSegment,
  requireSemver,
  requireString
} from "./format.mjs";

export const manifestSchemaVersion = "tutti.agent.manifest.v2";
export const profileSchemas = Object.freeze({
  discovery: "tutti.agent.discovery.v1",
  tools: "tutti.agent.tools.v1",
  capabilities: "tutti.agent.capabilities.v1",
  composer: "tutti.agent.composer.v1",
  events: "tutti.agent.events.v1"
});

const allowedPackageExtensions = new Set([
  ".json",
  ".md",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);
const presentationAssetExtensions = new Set([
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);
const presentationAssetLimit = 256 << 10;
const packageDocumentation = new Set(["AGENTS.md"]);
const passiveSVGElements = new Set([
  "circle",
  "defs",
  "desc",
  "g",
  "lineargradient",
  "path",
  "rect",
  "stop",
  "svg",
  "text",
  "title"
]);
const allowedPlaceholders = new Set([
  "${projectRoot}",
  "${installRoot}",
  "${platform}"
]);

export async function validatePackage(packageDir, expectedAgentKey) {
  const manifestPath = path.join(packageDir, "tutti.agent.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest, expectedAgentKey);
  await validatePackageEntries(packageDir);
  await validateReferencedFiles(packageDir, manifest);
  await validateDeclaredFiles(packageDir, manifest);
  return manifest;
}
export function validateManifest(manifest, expectedAgentKey) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("agent manifest must be an object");
  }
  rejectUnknownKeys(
    manifest,
    new Set([
      "schemaVersion",
      "agentKey",
      "version",
      "name",
      "description",
      "icon",
      "maskIcon",
      "heroImage",
      "runtime",
      "profiles",
      "localizationInfo"
    ]),
    "manifest"
  );
  if (manifest.schemaVersion !== manifestSchemaVersion) {
    throw new Error(
      `agent manifest schemaVersion must be ${manifestSchemaVersion}`
    );
  }
  manifest.agentKey = requireSafeSegment(
    manifest.agentKey,
    "manifest agentKey"
  );
  if (expectedAgentKey && manifest.agentKey !== expectedAgentKey) {
    throw new Error(
      `manifest agentKey ${manifest.agentKey} does not match ${expectedAgentKey}`
    );
  }
  manifest.version = requireSemver(manifest.version, "manifest version");
  requireString(manifest.name, "manifest name");
  if (manifest.description !== undefined) {
    requireString(manifest.description, "manifest description");
  }
  validateIcon(manifest.icon);
  if (manifest.maskIcon !== undefined) {
    validateMaskIcon(manifest.maskIcon);
  }
  if (manifest.heroImage !== undefined) {
    validateHeroImage(manifest.heroImage);
  }
  validateRuntime(manifest.runtime);
  validateProfiles(manifest.profiles);
  validateLocalizationInfo(manifest.localizationInfo);
  return manifest;
}

function validateIcon(icon) {
  if (!icon || typeof icon !== "object" || icon.type !== "asset") {
    throw new Error("manifest icon.type must be asset");
  }
  rejectUnknownKeys(icon, new Set(["type", "src"]), "manifest icon");
  requireRelativePath(icon.src, "manifest icon.src");
}

function validateHeroImage(heroImage) {
  if (
    !heroImage ||
    typeof heroImage !== "object" ||
    heroImage.type !== "asset"
  ) {
    throw new Error("manifest heroImage.type must be asset");
  }
  rejectUnknownKeys(heroImage, new Set(["type", "src"]), "manifest heroImage");
  requireRelativePath(heroImage.src, "manifest heroImage.src");
}

function validateMaskIcon(maskIcon) {
  if (!maskIcon || typeof maskIcon !== "object" || maskIcon.type !== "asset") {
    throw new Error("manifest maskIcon.type must be asset");
  }
  rejectUnknownKeys(maskIcon, new Set(["type", "src"]), "manifest maskIcon");
  requireRelativePath(maskIcon.src, "manifest maskIcon.src");
}

function validateRuntime(runtime) {
  if (!runtime || typeof runtime !== "object") {
    throw new Error("manifest runtime is required");
  }
  rejectUnknownKeys(runtime, new Set(["kind", "install", "launch"]), "runtime");
  if (runtime.kind !== "standard-acp") {
    throw new Error("manifest runtime.kind must be standard-acp");
  }
  validateInstall(runtime.install);
  if (!runtime.launch || typeof runtime.launch !== "object") {
    throw new Error("manifest runtime.launch is required");
  }
  rejectUnknownKeys(
    runtime.launch,
    new Set(["executable", "args"]),
    "runtime launch"
  );
  validateTemplateArgument(
    requireString(runtime.launch.executable, "runtime launch executable"),
    "runtime launch executable"
  );
  if (
    !runtime.launch.executable.startsWith("${installRoot}/") ||
    runtime.launch.executable.split("/").includes("..")
  ) {
    throw new Error("runtime launch executable must stay under ${installRoot}");
  }
  validateArgv(runtime.launch.args ?? [], "runtime launch args");
}

function validateInstall(install) {
  if (!install || typeof install !== "object") {
    throw new Error("manifest runtime.install is required");
  }
  rejectUnknownKeys(install, new Set(["runner", "args"]), "runtime install");
  if (!new Set(["npm", "pnpm", "uv"]).has(install.runner)) {
    throw new Error("runtime install runner must be npm, pnpm, or uv");
  }
  validateArgv(install.args, "runtime install args");
  const expectedPrefix = {
    npm: ["install", "--prefix", "${installRoot}"],
    pnpm: ["add", "--dir", "${installRoot}"],
    uv: ["pip", "install", "--target", "${installRoot}"]
  }[install.runner];
  if (install.runner === "npm" || install.runner === "pnpm") {
    if (
      install.args.length !== expectedPrefix.length + 1 ||
      !expectedPrefix.every((argument, index) => install.args[index] === argument) ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(
        install.args.at(-1)
      )
    ) {
      throw new Error(
        "npm/pnpm install must use the safe local form with one exact package@version"
      );
    }
  } else {
    if (
      install.args.length !== expectedPrefix.length + 1 ||
      !expectedPrefix.every((argument, index) => install.args[index] === argument) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9._+-]*)?$/u.test(
        install.args.at(-1)
      )
    ) {
      throw new Error(
        "uv install must use the safe local form with one exact package==version"
      );
    }
  }
}

function validateArgv(argv, label) {
  if (!Array.isArray(argv)) throw new Error(`${label} must be an array`);
  for (const [index, argument] of argv.entries()) {
    validateTemplateArgument(
      requireString(argument, `${label}[${index}]`),
      `${label}[${index}]`
    );
  }
}

function validateTemplateArgument(argument, label) {
  if (/[|;&`\n\r<>]/u.test(argument) || argument.includes("$(")) {
    throw new Error(`${label} contains forbidden shell syntax`);
  }
  for (const match of argument.matchAll(/\$\{[^}]+\}/gu)) {
    if (!allowedPlaceholders.has(match[0])) {
      throw new Error(`${label} contains unsupported placeholder ${match[0]}`);
    }
  }
}

function validateProfiles(profiles) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new Error("manifest profiles is required");
  }
  rejectUnknownKeys(profiles, new Set(Object.keys(profileSchemas)), "manifest profiles");
  for (const [kind, file] of Object.entries(profiles)) {
    if (!Object.hasOwn(profileSchemas, kind)) {
      throw new Error(`manifest profiles.${kind} is unsupported`);
    }
    requireRelativePath(file, `manifest profiles.${kind}`);
  }
  if (!profiles.discovery) {
    throw new Error("manifest profiles.discovery is required");
  }
}

function validateLocalizationInfo(localizationInfo) {
  if (!localizationInfo || typeof localizationInfo !== "object") {
    throw new Error("manifest localizationInfo is required");
  }
  rejectUnknownKeys(
    localizationInfo,
    new Set(["defaultLocale", "defaultFile", "additionalLocales"]),
    "localizationInfo"
  );
  requireString(
    localizationInfo.defaultLocale,
    "localizationInfo defaultLocale"
  );
  requireRelativePath(
    localizationInfo.defaultFile,
    "localizationInfo defaultFile"
  );
  const additional = localizationInfo.additionalLocales ?? [];
  if (!Array.isArray(additional)) {
    throw new Error("localizationInfo additionalLocales must be an array");
  }
  for (const [index, locale] of additional.entries()) {
    if (!locale || typeof locale !== "object" || Array.isArray(locale)) {
      throw new Error(`additionalLocales[${index}] must be an object`);
    }
    rejectUnknownKeys(
      locale,
      new Set(["locale", "file"]),
      `additionalLocales[${index}]`
    );
    requireString(locale?.locale, `additionalLocales[${index}].locale`);
    requireRelativePath(locale?.file, `additionalLocales[${index}].file`);
  }
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unsupported field ${key}`);
    }
  }
}

async function validateReferencedFiles(packageDir, manifest) {
  const references = [
    [manifest.icon.src, null, true],
    ...(manifest.maskIcon ? [[manifest.maskIcon.src, null, true]] : []),
    ...(manifest.heroImage ? [[manifest.heroImage.src, null, true]] : []),
    [manifest.localizationInfo.defaultFile, null, false],
    ...(manifest.localizationInfo.additionalLocales ?? []).map((entry) => [
      entry.file,
      null,
      false
    ]),
    ...Object.entries(manifest.profiles).map(([kind, file]) => [
      file,
      profileSchemas[kind],
      false
    ])
  ];
  for (const [relativePath, expectedSchema, presentationAsset] of references) {
    const filePath = resolvePackagePath(packageDir, relativePath);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile() || info.size === 0) {
      throw new Error(
        `referenced package file is missing or empty: ${relativePath}`
      );
    }
    if (expectedSchema) {
      const profile = JSON.parse(await readFile(filePath, "utf8"));
      if (profile.schemaVersion !== expectedSchema) {
        throw new Error(
          `${relativePath} schemaVersion must be ${expectedSchema}`
        );
      }
    }
    if (presentationAsset) {
      await validatePresentationAsset(filePath, relativePath, info.size);
    }
  }
}

async function validatePresentationAsset(filePath, relativePath, size) {
  if (!presentationAssetExtensions.has(path.extname(filePath).toLowerCase())) {
    throw new Error(`unsupported presentation asset type: ${relativePath}`);
  }
  if (size > presentationAssetLimit) {
    throw new Error(`presentation asset exceeds 256 KiB: ${relativePath}`);
  }
  if (path.extname(filePath).toLowerCase() !== ".svg") return;
  const bytes = await readFile(filePath);
  let contents;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes).toLowerCase();
  } catch {
    throw new Error(`presentation SVG must be valid UTF-8: ${relativePath}`);
  }
  if (
    /<!doctype|<!entity|<style\b/iu.test(contents) ||
    /\son[a-z0-9_.:-]*\s*=/iu.test(contents) ||
    /\b(?:href|src)\s*=/iu.test(contents)
  ) {
    throw new Error(`presentation SVG contains active or remote content: ${relativePath}`);
  }
  for (const match of contents.matchAll(/url\(([^)]*)\)/giu)) {
    const value = match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2");
    if (!/^#[A-Za-z_][A-Za-z0-9_.:-]*$/u.test(value)) {
      throw new Error(`presentation SVG contains active or remote content: ${relativePath}`);
    }
  }
  for (const match of contents.matchAll(/<\/?\s*([A-Za-z][A-Za-z0-9]*)\b/gu)) {
    if (!passiveSVGElements.has(match[1])) {
      throw new Error(`presentation SVG element is not passive: ${match[1]}`);
    }
  }
}

async function validateDeclaredFiles(packageDir, manifest) {
  const declared = new Set([
    "tutti.agent.json",
    manifest.icon.src,
    ...(manifest.maskIcon ? [manifest.maskIcon.src] : []),
    ...(manifest.heroImage ? [manifest.heroImage.src] : []),
    manifest.localizationInfo.defaultFile,
    ...(manifest.localizationInfo.additionalLocales ?? []).map((entry) => entry.file),
    ...Object.values(manifest.profiles)
  ]);
  for (const file of packageDocumentation) {
    const info = await stat(path.join(packageDir, file)).catch(() => null);
    if (info?.isFile()) declared.add(file);
  }
  for (const file of await collectPackageFiles(packageDir)) {
    if (!declared.has(file)) {
      throw new Error(`agent package contains undeclared file: ${file}`);
    }
  }
}

async function collectPackageFiles(root, relativeDir = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, relativeDir), {
    withFileTypes: true
  })) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectPackageFiles(root, relativePath)));
    } else if (entry.isFile()) {
      result.push(relativePath);
    }
  }
  return result;
}

async function validatePackageEntries(root, relativeDir = "") {
  const entries = await readdir(path.join(root, relativeDir), {
    withFileTypes: true
  });
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (/[\\\n\r\0]/u.test(relativePath)) {
      throw new Error(`agent package contains unsafe path: ${relativePath}`);
    }
    const absolutePath = path.join(root, relativePath);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `agent package must not contain symlinks: ${relativePath}`
      );
    }
    if (entry.isDirectory()) {
      await validatePackageEntries(root, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `agent package contains unsupported entry: ${relativePath}`
      );
    }
    if (!allowedPackageExtensions.has(path.extname(entry.name).toLowerCase())) {
      throw new Error(
        `agent package contains forbidden file type: ${relativePath}`
      );
    }
    const info = await stat(absolutePath);
    if ((info.mode & 0o111) !== 0) {
      throw new Error(
        `agent package contains executable file: ${relativePath}`
      );
    }
  }
}

function requireRelativePath(value, label) {
  const normalized = requireString(value, label);
  if (!isRelativePackagePath(normalized)) {
    throw new Error(`${label} must be a relative package path`);
  }
  return normalized;
}

function resolvePackagePath(packageDir, relativePath) {
  const resolved = path.resolve(packageDir, relativePath);
  if (!resolved.startsWith(`${path.resolve(packageDir)}${path.sep}`)) {
    throw new Error(`package reference escapes package root: ${relativePath}`);
  }
  return resolved;
}
