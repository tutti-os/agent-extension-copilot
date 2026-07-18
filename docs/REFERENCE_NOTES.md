# Source decisions and capability traceability

The authenticated 2026-07-17 probe is the source for successful `session/new`,
modes, config options, and command notifications. An independent credential-free
run on 2026-07-18 revalidated the exact npm package, `--version`, ACP
initialize/auth method, and the expected `Authentication required` session
error. Official GitHub documentation, the fixed official Copilot CLI source
snapshot, npm publication metadata, and real runtime probes take precedence
over every community reference.

## Capability traceability

| Declaration | Package value | Evidence and decision |
| --- | --- | --- |
| Runtime package | `@github/copilot@1.0.71` | npm registry returned exact version, `copilot` bin, and integrity; `--version` returned 1.0.71. |
| ACP launch | `--acp --stdio` | [Official ACP server reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) documents explicit stdio and recommends it for subprocess integration; the real launch negotiated ACP v1. |
| Image input | `true` | `initialize.agentCapabilities.promptCapabilities.image=true`. |
| Audio input | `false` | `initialize.agentCapabilities.promptCapabilities.audio=false`. |
| Embedded context | `true` | `initialize.agentCapabilities.promptCapabilities.embeddedContext=true`. |
| Resume/load | `true` | `initialize.agentCapabilities.loadSession=true`. |
| Interrupt | `false` | No interrupt capability was advertised; no prompt was sent to test cancellation. |
| Model selection | `false` | `session/new` contained no models field or model catalog. The composer source remains runtime-owned and contains no static models. |
| Permission/mode projection | experimental Autopilot → full-access; Agent and Plan unmapped | Exact ACP mode IDs came from `session/new`; only Autopilot's runtime description explicitly says it enables allow-all. `allow_all` is a separate permissions config option, so its current `off` value does not prove fixed semantics for Agent or Plan. Unknown mode semantics remain generic. |
| Slash commands | runtime snapshot only | A real `available_commands_update` was observed. No static table is packaged. The official reference says commands absent from that update—including interactive picker commands such as `/login`, `/resume`, and `/settings`—must not be treated as ACP commands. |
| Reasoning effort | no composer option | The official ACP reference says effort and tool-filter flags are fixed when the server launches and cannot be selected by `session/new`. |
| Tool mappings | empty | No paid prompt was sent and no tool-call payload/tool ID was observed. Unknown tools remain generic. |
| Authentication | prior terminal login or supported token | `initialize` advertised terminal auth `copilot login`. The [official install guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) documents subscription/policy requirements and supported token variables. ACP does not support the interactive `/login` picker. |

The complete sanitized probe summary is in
[`probes/copilot-1.0.71.json`](probes/copilot-1.0.71.json).

## Fixed implementation references

- [Copilot CLI at `fd24cea5cb11da4e630485ff2d9269318b8c2a4e`](https://github.com/github/copilot-cli/tree/fd24cea5cb11da4e630485ff2d9269318b8c2a4e): accepted as the official fixed source and changelog snapshot. The npm 1.0.71 distribution metadata and runtime behavior were verified independently rather than assuming identical build provenance.
- [Gemini extension at `8f8f2d9e794bc5a04f309cabe93aef4682ea2652`](https://github.com/tutti-os/agent-extension-gemini/tree/8f8f2d9e794bc5a04f309cabe93aef4682ea2652): adopted the declarative package, clean build, validator, deterministic ZIP, signing, and OIDC release structure. Provider-specific catalogs were not copied.
- [CodeBuddy extension at `697155d716ce1174b202b1e1f999c290b5023c75`](https://github.com/tutti-os/agent-extension-codebuddy/tree/697155d716ce1174b202b1e1f999c290b5023c75): adopted the same repository ownership and release boundaries. Runtime-specific permission aliases were rejected.
- [Agent Extension Skill at `4a053ce577bbf126ed614132bb176853855d7707`](https://github.com/tutti-os/tutti-agent-extension-skill/tree/4a053ce577bbf126ed614132bb176853855d7707): used its scaffold, package validator, ACP probe, release tools, workflow, and AWS template as the implementation baseline.

The template was tightened in this repository: package validation now rejects
undeclared files and unsafe install argv shapes; release tests cover symlinks,
executables, traversal, scripts/WASM/binaries, unpinned packages, and unsafe or
oversized assets; and the workflow uses conditional writes for `latest.json`
and `catalog.json` in addition to `versions.json`, then verifies the published
bytes and signature through the public CDN. Release Actions are pinned to
immutable commits, AWS credentials are acquired only after signing and public
key derivation, and mutable-index retries rebuild from freshly downloaded
state so an older backfill cannot incorrectly replace a newer active release.

The AWS template and workflow have received local static review only. A real
`aws cloudformation validate-template` call was not run because it requires AWS
credentials; no stack was deployed and no S3 or public CloudFront release bytes
were verified. Those are intentionally retained as pre-release validation
items, not treated as passing evidence.

## Community reference disposition

- [wechat-acp config at `8889461a92178788174b0dd53dbf0593162cbd0e`](https://github.com/formulahendry/wechat-acp/blob/8889461a92178788174b0dd53dbf0593162cbd0e/src/config.ts) was used only to discover a launch candidate. Its floating `npx @github/copilot` install and permissive server-wide `--yolo --enable-all-github-mcp-tools` flags were rejected in favor of the exact managed-install pin and the officially documented, probed `copilot --acp --stdio` launch.
- [wechat-acp agent manager at `8889461a92178788174b0dd53dbf0593162cbd0e`](https://github.com/formulahendry/wechat-acp/blob/8889461a92178788174b0dd53dbf0593162cbd0e/src/acp/agent-manager.ts) was used only to cross-check the stdio NDJSON subprocess → `initialize` → `session/new(cwd, mcpServers)` lifecycle. Its process management, shell/environment merging, client filesystem capabilities, and logging were not copied; those remain owned by Tutti's generic ACP host.
- [CopilotAdapter at `db2766a31ce0efc0d84c94728b07e0097f322ee5`](https://github.com/DWangSE/acp-client-prototype/blob/db2766a31ce0efc0d84c94728b07e0097f322ee5/src/driver-adapter/adapters/copilot-adapter.ts) was used only to cross-check candidate token environment names, which were then verified against GitHub's installation documentation. Its floating `npx -y @github/copilot --acp` download, implicit transport, and provider-specific adapter were rejected.
- [acpx registry at `a518ea909eb91296b0d05c76345f1c8403ba830b`](https://github.com/openclaw/acpx/blob/a518ea909eb91296b0d05c76345f1c8403ba830b/src/agent-registry.ts) supplied only a `copilot --acp --stdio` launch hint, independently confirmed by the official ACP reference and real probe. Its community registry/provider-name mapping is not launch authority and was not turned into a Tutti host branch.

No community code, static command table, model list, tool category, permission
heuristic, or provider-specific event parsing was copied. This keeps runtime
behavior traceable to official sources and the real 1.0.71 probe.

## Artwork decision

Redistribution rights for official Copilot identity artwork were not assumed.
The packaged icon and hero are original, neutral Tutti-maintained SVGs with no
remote references. They identify the integration in text without imitating an
official GitHub mark.
