import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { validatePackage } from "../lib/manifest.mjs";
import { buildCatalog } from "../lib/catalog.mjs";
import { buildRelease } from "../lib/release.mjs";
import { verifyRelease } from "../lib/verify.mjs";
import { buildVersions } from "../lib/versions.mjs";

const temporaryRoots = new Set();
const repositoryRoot = path.resolve(import.meta.dirname, "..", "..", "..");
test.afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) => rm(root, { recursive: true, force: true }))
  );
  temporaryRoots.clear();
});

test("builds a reproducible signed Copilot extension release", async () => {
  const root = await temporaryRoot();
  const packageDir = await writeFixture(path.join(root, "package"));
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPath = path.join(root, "public.pem");
  await writeFile(
    publicKeyPath,
    keys.publicKey.export({ type: "spki", format: "pem" })
  );
  const options = {
    agentKey: "copilot",
    packageDir,
    outputDir: path.join(root, "out"),
    baseUrl: "https://example.test/tutti-agent-releases",
    version: "1.0.0",
    signingKeyId: "tutti-copilot-release-v1",
    privateKey,
    publishedAt: "2026-07-17T00:00:00Z",
    gitSha: "abc123"
  };
  const sourceManifest = await readFile(
    path.join(packageDir, "tutti.agent.json")
  );
  const first = await buildRelease(options);
  const firstArtifact = await readFile(first.artifactPath);
  await chmod(path.join(packageDir, "profiles", "discovery.json"), 0o600);
  const second = await buildRelease(options);
  assert.deepEqual(await readFile(second.artifactPath), firstArtifact);
  assert.deepEqual(
    await readFile(path.join(packageDir, "tutti.agent.json")),
    sourceManifest
  );
  await verifyRelease({
    releaseFile: second.releaseJsonPath,
    artifact: second.artifactPath,
    publicKeyFile: publicKeyPath,
    signingKeyId: "tutti-copilot-release-v1",
    packageDir
  });
  const versions = await buildVersions({
    releaseFile: second.releaseJsonPath,
    minTuttiVersion: "0.0.0",
    output: path.join(root, "out", "agents", "copilot", "versions.json")
  });
  const catalog = await buildCatalog({
    versionsFile: [versions.outputPath],
    output: path.join(root, "out", "catalog.json")
  });
  assert.equal(catalog.catalog.agents[0].agentKey, "copilot");
  assert.equal(
    catalog.catalog.agents[0].versionsUrl,
    "https://example.test/tutti-agent-releases/agents/copilot/versions.json"
  );
});

test("requires a stable release publication timestamp", async () => {
  const root = await temporaryRoot();
  const packageDir = await writeFixture(path.join(root, "package"));
  const keys = generateKeyPairSync("ed25519");
  await assert.rejects(
    buildRelease({
      agentKey: "copilot",
      packageDir,
      outputDir: path.join(root, "out"),
      baseUrl: "https://example.test/tutti-agent-releases",
      version: "1.0.0",
      signingKeyId: "tutti-copilot-release-v1",
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" })
    }),
    /publishedAt/u
  );
});

test("rejects executable package content", async () => {
  const packageDir = await fixture();
  const executable = path.join(packageDir, "profiles", "discovery.json");
  await chmod(executable, 0o755);
  await assert.rejects(validatePackage(packageDir, "copilot"), /executable file/u);
});

test("rejects symlinks", async () => {
  const packageDir = await fixture();
  await symlink("assets/icon.svg", path.join(packageDir, "linked-icon.svg"));
  await assert.rejects(validatePackage(packageDir, "copilot"), /symlinks/u);
});

test("rejects unsafe and escaping package paths", async () => {
  const packageDir = await fixture();
  await writeFile(path.join(packageDir, "unsafe\nname.md"), "unsafe\n");
  await assert.rejects(validatePackage(packageDir, "copilot"), /unsafe path/u);

  const secondPackageDir = await fixture();
  await updateManifest(secondPackageDir, (manifest) => {
    manifest.icon.src = "../icon.svg";
  });
  await assert.rejects(
    validatePackage(secondPackageDir, "copilot"),
    /relative package path/u
  );
});

test("rejects undeclared package files", async () => {
  const packageDir = await fixture();
  await writeFile(path.join(packageDir, "notes.md"), "not declared\n");
  await assert.rejects(validatePackage(packageDir, "copilot"), /undeclared file/u);
});

test("rejects scripts, WASM, and runtime binaries", async () => {
  for (const [name, contents] of [
    ["normalizer.js", "export default {};\n"],
    ["normalizer.wasm", Buffer.from([0, 97, 115, 109])],
    ["copilot", "runtime binary\n"]
  ]) {
    const packageDir = await fixture();
    await writeFile(path.join(packageDir, name), contents);
    await assert.rejects(
      validatePackage(packageDir, "copilot"),
      /forbidden file type/u
    );
  }
});

test("rejects unpinned, extra, and global runtime installation arguments", async () => {
  for (const args of [
    ["install", "--prefix", "${installRoot}", "@github/copilot@latest"],
    [
      "install",
      "--prefix",
      "${installRoot}",
      "@github/copilot@1.0.71",
      "another-package@latest"
    ],
    ["install", "--global", "@github/copilot@1.0.71"]
  ]) {
    const packageDir = await fixture();
    await updateManifest(packageDir, (manifest) => {
      manifest.runtime.install.args = args;
    });
    await assert.rejects(
      validatePackage(packageDir, "copilot"),
      /safe local form/u
    );
  }
});

test("rejects unsupported manifest fields in repository and release validators", async () => {
  const cases = [
    ["manifest provider", (manifest) => { manifest.provider = "acp:conflict"; }],
    ["icon metadata", (manifest) => { manifest.icon.remoteUrl = "https://example.test/icon.svg"; }],
    ["hero metadata", (manifest) => { manifest.heroImage.remoteUrl = "https://example.test/hero.svg"; }],
    ["runtime command", (manifest) => { manifest.runtime.postInstall = { command: "echo unsafe" }; }],
    ["install cwd", (manifest) => { manifest.runtime.install.cwd = "${projectRoot}"; }],
    ["launch shell", (manifest) => { manifest.runtime.launch.shell = true; }],
    ["profile kind", (manifest) => { manifest.profiles.renderer = "profiles/renderer.json"; }],
    ["locale fallback", (manifest) => { manifest.localizationInfo.fallback = "en"; }],
    ["locale metadata", (manifest) => { manifest.localizationInfo.additionalLocales[0].label = "Chinese"; }]
  ];
  for (const [label, mutate] of cases) {
    const packageDir = await extensionFixture();
    await updateManifest(packageDir, mutate);
    await assert.rejects(
      validatePackage(packageDir, "copilot"),
      /unsupported field/u,
      `${label} must be rejected by the release validator`
    );
    assert.throws(
      () => execFileSync(
        "python3",
        [path.join(repositoryRoot, "scripts", "validate_agent_extension.py"), packageDir],
        { encoding: "utf8", stdio: "pipe" }
      ),
      /unsupported field/u,
      `${label} must be rejected by the repository validator`
    );
  }
});

test("rejects oversized and active presentation assets", async () => {
  const oversizedPackageDir = await fixture();
  await writeFile(
    path.join(oversizedPackageDir, "assets", "hero-image.svg"),
    Buffer.alloc((256 << 10) + 1, 32)
  );
  await assert.rejects(
    validatePackage(oversizedPackageDir, "copilot"),
    /exceeds 256 KiB/u
  );

  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect onerror="alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="//example.test/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.test/a.css";</style></svg>',
    '<!DOCTYPE svg [<!ENTITY remote SYSTEM "https://example.test/a">]><svg xmlns="http://www.w3.org/2000/svg"><text>&remote;</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://example.test/a.svg#paint)"/></svg>'
  ]) {
    const packageDir = await fixture();
    await writeFile(path.join(packageDir, "assets", "icon.svg"), svg);
    await assert.rejects(
      validatePackage(packageDir, "copilot"),
      /active or remote content|element is not passive/u
    );
  }
});

test("keeps the release workflow credentials and mutable writes constrained", async () => {
  const releaseWorkflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "release.yml"),
    "utf8"
  );
  const checkWorkflow = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "check.yml"),
    "utf8"
  );
  const signingIndex = releaseWorkflow.indexOf("Build signed immutable release");
  const awsIndex = releaseWorkflow.indexOf("Configure AWS credentials");
  assert.ok(signingIndex >= 0 && awsIndex > signingIndex, "AWS credentials must be acquired only after signing");
  assert.doesNotMatch(releaseWorkflow.slice(0, signingIndex), /TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY/u);
  assert.doesNotMatch(
    releaseWorkflow.slice(awsIndex),
    /TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY/u,
    "the private key must not overlap AWS credentials or public verification"
  );
  assert.match(releaseWorkflow, /GITHUB_REF.*refs\/heads\/main/u);
  assert.match(releaseWorkflow, /RUNNER_TEMP.*tutti-agent-extension-public\.pem/u);
  assert.match(releaseWorkflow, /get-object --bucket "\$\{BUCKET\}" --key "\$\{versions_key\}" \/tmp\/current-versions\.json/u);
  assert.match(releaseWorkflow, /--versions-file \/tmp\/current-versions-catalog\.json/u);
  assert.match(releaseWorkflow, /latest_artifact_url/u);
  for (const workflow of [releaseWorkflow, checkWorkflow]) {
    for (const line of workflow.split("\n").filter((value) => /^\s*uses:/u.test(value))) {
      assert.match(line, /@[0-9a-f]{40}(?:\s+#\s+v\d+)?$/u, `action must be pinned by commit: ${line.trim()}`);
    }
  }
});

async function temporaryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "agent-extension-release-test-"));
  temporaryRoots.add(root);
  return root;
}

async function fixture() {
  return writeFixture(path.join(await temporaryRoot(), "package"));
}

async function extensionFixture() {
  const packageDir = path.join(await temporaryRoot(), "package");
  await cp(path.join(repositoryRoot, "extension"), packageDir, { recursive: true });
  return packageDir;
}

async function updateManifest(packageDir, mutate) {
  const manifestPath = path.join(packageDir, "tutti.agent.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  mutate(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function writeFixture(packageDir) {
  await mkdir(path.join(packageDir, "profiles"), { recursive: true });
  await mkdir(path.join(packageDir, "assets"), { recursive: true });
  await mkdir(path.join(packageDir, "locales"), { recursive: true });
  await writeFile(
    path.join(packageDir, "tutti.agent.json"),
    `${JSON.stringify(
      {
        schemaVersion: "tutti.agent.manifest.v1",
        agentKey: "copilot",
        version: "1.0.0",
        name: "GitHub Copilot CLI",
        description: "GitHub Copilot CLI through standard ACP",
        icon: { type: "asset", src: "assets/icon.svg" },
        heroImage: { type: "asset", src: "assets/hero-image.svg" },
        runtime: {
          kind: "standard-acp",
          install: {
            runner: "npm",
            args: [
              "install",
              "--prefix",
              "${installRoot}",
              "@github/copilot@1.0.71"
            ]
          },
          launch: {
            executable: "${installRoot}/node_modules/.bin/copilot",
            args: ["--acp", "--stdio"]
          }
        },
        profiles: { discovery: "profiles/discovery.json" },
        localizationInfo: {
          defaultLocale: "en",
          defaultFile: "locales/en.json"
        }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(packageDir, "profiles", "discovery.json"),
    '{"schemaVersion":"tutti.agent.discovery.v1","candidates":[]}\n'
  );
  const passiveSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>\n';
  await writeFile(path.join(packageDir, "assets", "icon.svg"), passiveSvg);
  await writeFile(path.join(packageDir, "assets", "hero-image.svg"), passiveSvg);
  await writeFile(
    path.join(packageDir, "locales", "en.json"),
    '{"agent.name":"GitHub Copilot CLI","agent.description":"Copilot over ACP"}\n'
  );
  return packageDir;
}
