# GitHub Copilot CLI Agent Extension for Tutti

This repository packages a declarative Tutti Agent Extension for the official
[GitHub Copilot CLI](https://github.com/github/copilot-cli) over standard
[Agent Client Protocol (ACP)](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).
It is not a Copilot CLI fork, does not bundle the Copilot runtime, and adds no
Copilot-specific runtime, provider enum, renderer, event parser, or persistence
path to Tutti.

## Identity and runtime contract

| Contract                  | Value                                                        |
| ------------------------- | ------------------------------------------------------------ |
| Repository                | `tutti-os/agent-extension-copilot`                           |
| Manifest agent key        | `copilot`                                                    |
| Host-derived Agent Target | `extension:copilot`                                          |
| Host-derived provider     | `acp:copilot`                                                |
| Extension version         | `1.0.0`                                                      |
| Runtime package           | `@github/copilot@1.0.71` (exact)                             |
| Executable                | `${installRoot}/node_modules/.bin/copilot`                   |
| ACP launch                | `copilot --acp --stdio`                                      |
| Compatible runtime        | `>=1.0.71 <2.0.0`                                            |
| Signing key ID            | `tutti-copilot-release-v1`                                   |
| CDN base                  | `https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases` |

Manifest v2 stores `agentKey`; the generic Tutti host derives the Target and
open ACP provider identities above after verifying the signed extension. Those
fields are intentionally not added as unsupported manifest properties.

Local discovery of a compatible `copilot` executable takes precedence. A
future user-confirmed managed install uses exactly
`npm install --prefix ${installRoot} @github/copilot@1.0.71`; launch is also
confined to `${installRoot}`. It does not modify a workspace `package.json`,
lockfile, `node_modules`, or global npm state.

## Prerequisites and authentication

GitHub's [installation documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)
requires Node.js 22 or newer and an active Copilot subscription. Organization
or enterprise policy can disable Copilot CLI even when a user has Copilot.

When Tutti reports that authentication is required, continuing setup opens the
managed Copilot runtime's advertised terminal-auth flow:

```sh
copilot login
```

Alternatively, use an officially supported token environment variable in this
precedence order: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, then `GITHUB_TOKEN`. The
ACP `initialize` response from 1.0.71 advertises `copilot-login` as terminal
authentication (`copilot login`). Tutti executes that flow in a Workspace
Terminal and polls ACP readiness until Copilot finishes account signup/login.
This is separate from the unsupported interactive `/login` picker inside an
ACP chat session.

## Verified ACP behavior

The sanitized evidence in
[`docs/probes/copilot-1.0.71.json`](docs/probes/copilot-1.0.71.json) contains two
non-prompt runs. The authenticated 2026-07-17 capture provides the successful
`session/new`, modes, configuration, and command-notification evidence below.
An independent credential-free run on 2026-07-18 revalidated the exact npm
package, `--version`, ACP initialize/auth method, and the expected
`Authentication required` failure at `session/new`:

- npm published `@github/copilot@1.0.71` with the `copilot` bin, and
  `copilot --version` returned `GitHub Copilot CLI 1.0.71.`
- `copilot --acp --stdio` negotiated ACP protocol version 1.
- `initialize` reported load-session, HTTP/SSE MCP, image and embedded-context
  prompt support, no audio support, session listing, and terminal auth.
- `session/new` succeeded in the authenticated probe and reported the exact
  Agent, Plan, and experimental Autopilot mode IDs plus the `allow_all`
  configuration option. No paid prompt was submitted.
- The session emitted `available_commands_update`. The extension treats every
  such update as the authoritative full command snapshot and does not ship a
  static slash-command table.
- The session did not report a model catalog, so `modelSelection` is declared
  false. The composer keeps the generic `acp-session-models` source so a future
  runtime-advertised catalog can be projected without a provider branch.

The tool profile is intentionally empty: no prompt was sent, so no runtime tool
IDs were observed. Unknown tool calls remain on Tutti's generic ACP renderer.
Interrupt support is also left disabled because it was not advertised by the
observed initialize response.

Per GitHub's ACP reference, `--available-tools`, `--excluded-tools`, and
`--effort`/`--reasoning-effort` are server-launch settings inherited by every
session. `session/new` cannot choose them. This extension therefore does not
present tools or reasoning effort as dynamically switchable session options.
Commands requiring an interactive picker or full-screen UI—including
`/login`, `/resume`, and `/settings`—must not be invented when they are absent
from `available_commands_update`.

Run the same non-prompt probe locally:

```sh
python3 scripts/probe_acp_runtime.py \
  --cwd /path/to/project \
  -- copilot --acp --stdio
```

The 2026-07-18 unauthenticated rerun completed `initialize` and then rejected
`session/new` with `Authentication required`. The probe reports that error as
JSON without printing environment values.

## Build and validation

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm package:tutti-agent
python3 scripts/validate_agent_extension.py build/tutti-agent/package
```

`pnpm check` builds a clean package, applies the repository validator, and runs
release tests. The validators reject symlinks, executable files, unsafe or
escaping paths, undeclared files, JS/WASM/runtime binaries, unpinned or extra
install packages, project/global install forms, and oversized or active remote
assets. `extension/` contains only referenced JSON, locales, passive local SVG
artwork, and its package instruction document.

## Release and infrastructure

The repository owns all release logic under `scripts/release/`. The manual
release workflow:

1. installs frozen dependencies and runs `pnpm check`;
2. builds and validates the clean declarative package;
3. creates a deterministic ZIP and signed `release.json`;
4. uploads immutable version objects with `If-None-Match: *`;
5. conditionally updates `versions.json`, `latest.json`, and `catalog.json`
   using observed ETags, retrying conflicts; and
6. invalidates only those three mutable CDN paths; then
7. downloads the public CDN metadata and ZIP and verifies identity, digest,
   size, freshness, and Ed25519 signature.

Configure these GitHub repository variables:

- `TUTTI_AGENT_RELEASES_AWS_REGION`
- `TUTTI_AGENT_RELEASES_AWS_ROLE_ARN`
- `TUTTI_AGENT_RELEASES_S3_BUCKET`
- `TUTTI_AGENT_RELEASES_CLOUDFRONT_DISTRIBUTION_ID` (optional)

Store the Ed25519 private key only in the
`TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY` repository secret. The workflow
uses GitHub OIDC; do not commit keys, AWS credentials, or tokens. For isolated
infrastructure, deploy
`infra/aws/agent-extension-release-infrastructure.yaml` with
`GitHubOwner=tutti-os` and `GitHubRepository=agent-extension-copilot`. Prefer
approved shared Tutti infrastructure when available. If the AWS account already
has GitHub's OIDC provider, keep `CreateGitHubOIDCProvider=false` and pass its
ARN as `ExistingGitHubOIDCProviderArn`; otherwise set
`CreateGitHubOIDCProvider=true`. Keep the workflow CDN base aligned with the
deployed distribution.

This repository does not publish 1.0.0, configure production credentials, or
register a trusted key/source in Tutti. Those are separate rollout actions.
The CloudFormation template has received only local static review: a real
`aws cloudformation validate-template` call was not run because it requires AWS
credentials. No stack was deployed, and no S3 or public CloudFront bytes were
validated. These remain explicit pre-release verification steps.

## Artwork and trademarks

`extension/assets/icon.svg` places the Copilot Octicon from GitHub's official
Primer Octicons repository in the colored shared identity used by the Provider
Rail, conversation headers, Message Center, and mentions. `mask-icon.svg` is
the transparent conversation-row mask glyph. `hero-image.jpg` is original,
Tutti-maintained record-sleeve artwork and does not reproduce the GitHub mark.
Both assets are local and remain below 256 KiB. “GitHub” and “Copilot” are
trademarks of GitHub, Inc.; their use here identifies the compatible official
runtime and does not imply endorsement.

## Reference decisions and limitations

Source-by-source implementation decisions and the capability traceability
matrix are recorded in [`docs/REFERENCE_NOTES.md`](docs/REFERENCE_NOTES.md).
ACP support is currently public preview. Runtime changes within the declared
major-version range may alter advertised modes, commands, auth, or capabilities;
session state remains authoritative.
