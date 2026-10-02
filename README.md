<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/mark-dark.png">
    <img src="assets/readme/mark-light.png" alt="Butler logo" width="120" height="120">
  </picture>
</p>

<h1 align="center">Butler</h1>

<p align="center">
  <strong>At your service, on your machine.</strong>
</p>

<p align="center">
  A personal AI agent that asks before it acts.<br>
  For macOS (Apple silicon) and Linux, with hosted or local models.
</p>

0.1.0 is in preview. The current build is [`0.1.0-preview.5`](https://github.com/Hexpy-Games/butler/releases/tag/v0.1.0-preview.5).

<p align="center">
  <a href="https://github.com/Hexpy-Games/butler/releases/tag/v0.1.0-preview.5"><strong>Download</strong></a>
  &nbsp;·&nbsp;
  <a href="https://butler.hexpy.games/en/help/"><strong>Manual</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Hexpy-Games/butler/releases">Releases</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/hero-demo-dark.svg">
    <img src="assets/readme/hero-demo-light.svg" alt="Butler handing a task to the background, answering another question meanwhile, then delivering the summary" width="100%">
  </picture>
</p>

## How Butler works

Use Butler through the App, on desktop or in a browser.

- **Keep talking while it works.** Give Butler a long job and move on to something else. The result lands in the same conversation when it's done.
- **You talk to Butler, nobody else.** It farms the pieces out to background workers and checks their work before giving you one answer.
- **It checks the bag against the list.** Send someone shopping and the careful ones compare the bag to your list before coming home. Butler does that with your request and its own result.
- **Memory that carries over.** Ask Butler to remember information and recall it later, including on a fresh install. Search vectors and the hot cache update in the background. Personal information analysis is a separate opt-in under Settings → Personalization.
- **Work gets written down.** Butler keeps a record of what it planned and what it finished, so it can pick up where it stopped. In a project, a new conversation starts from that record.
- **It lives on your computer.** Butler stores everything on your machine. Data leaves only when it goes to the model you chose or to a tool that reaches the internet, like web search or a server you connected.

## Features

- **Permissions.** Choose *Ask first*, *Read only* or *Full access*. Set a default in **Settings → Models**, change it for one conversation, and give each schedule its own. [Conversations](https://butler.hexpy.games/en/help/basics/conversation/)
- **Schedules.** Butler sends a prompt to a conversation at a fixed interval, or daily, on weekdays or weekly at a set time. [Schedules](https://butler.hexpy.games/en/help/scheduled-tasks/)
- **MCP servers.** Connect MCP servers for extra tools. [MCP servers](https://butler.hexpy.games/en/help/extensions/mcp-servers/)
- **Skills.** A skill is a `SKILL.md` file that tells Butler how to handle one kind of request.
- **Model providers.** Use OpenAI, Anthropic, Google and other hosted providers, or an OpenAI-compatible server such as Ollama, LM Studio or llama.cpp. Backup models take over on eligible provider failures when you enable them. [Cloud models](https://butler.hexpy.games/en/help/models/cloud/), [Custom models](https://butler.hexpy.games/en/help/models/custom/), [Backup models](https://butler.hexpy.games/en/help/models/backup/)
- **Projects.** A project gives its conversations a shared folder and a dashboard. [Projects](https://butler.hexpy.games/en/help/projects/)
- **Remote access.** Open the App from another computer on a trusted network with an 8-digit one-time pairing code. It is off by default. [Remote access](https://butler.hexpy.games/en/help/advanced/remote-access/)
- **API key management.** Manage saved API keys in **Settings → Models**. [Settings](https://butler.hexpy.games/en/help/settings/)
- **Usage.** Ask Butler for conversation and background memory costs separately. Runtime estimates group them by work; unavailable prices remain unavailable. [Usage](https://butler.hexpy.games/en/help/settings/#usage)
- **CLI.** Run the Agent as a background service without the desktop App. `butler --help` lists the commands; `butler config set user.responseLanguage en` sets the reply language. [Agent CLI](https://butler.hexpy.games/en/help/advanced/agent-cli/)

## Install

Download Butler from the [0.1.0 preview.5 release](https://github.com/Hexpy-Games/butler/releases/tag/v0.1.0-preview.5).

| Platform | Download |
| --- | --- |
| macOS (Apple silicon) | [DMG](https://github.com/Hexpy-Games/butler/releases/download/v0.1.0-preview.5/butler-app-0.1.0-preview.5-darwin-arm64.dmg) |
| Linux (x64) | [DEB](https://github.com/Hexpy-Games/butler/releases/download/v0.1.0-preview.5/butler-app-0.1.0-preview.5-linux-x64.deb) |
| Linux (arm64) | [DEB](https://github.com/Hexpy-Games/butler/releases/download/v0.1.0-preview.5/butler-app-0.1.0-preview.5-linux-arm64.deb) |
| Arch Linux (x64) | [Package](https://github.com/Hexpy-Games/butler/releases/download/v0.1.0-preview.5/butler-app-0.1.0-preview.5-archlinux-x64.pkg.tar.zst) |
| Windows | Coming in a later preview |

Each file has a `.sha256` checksum, and `butler-0.1.0-preview.5-SHA256SUMS` lists them all.

Settings → Updates installs the new App and bundled Agent, then relaunches with the same data directory.
**Receive preview versions** defaults to OFF. Turn it on to receive the newest stable or preview release.
After installing `0.1.0-preview.5`, later previews arrive through Settings → Updates when **Receive preview versions** is on. `butler --version` shows the exact version.
The CLI shares this preference: `butler config set update.previews true` (or `false`); `butler status` shows it.
Release builds identify with their full tag, such as `0.1.0-preview.5`; development builds use `0.1.0-dev`.

On first launch, choose the interface language on the welcome screen, accept the safety notice and connect an AI. Choose Butler's reply language at the end of the AI connection step; you can change it later in **Settings → Personalization**. See [Install](https://butler.hexpy.games/en/help/getting-started/install/) and [First run](https://butler.hexpy.games/en/help/getting-started/first-run/).

macOS preview builds are signed but not notarized, so Gatekeeper shows a prompt on first open. Right-click **Butler → Open**, or choose **System Settings → Privacy & Security → Open Anyway** after trying to open it.

### Headless Agent

On Apple silicon macOS or Linux x64 / arm64 with glibc:

```sh
curl -fsSL https://github.com/Hexpy-Games/butler/releases/download/v0.1.0-preview.5/install.sh | sh -s -- --version 0.1.0-preview.5
# Or, with Node.js:
npx @hexpygames/butler install
```

Use `butler open` to open the App in your browser. For another computer on a trusted network, enable access and generate a pairing code in **Settings → Security**, or use `butler remote enable` and `butler remote pair` on the host. Open the displayed address on the other computer and enter the 8-digit one-time pairing code. Remote access is off by default. [Remote access](https://butler.hexpy.games/en/help/advanced/remote-access/)

## Where your data lives

The data folder is `~/.butler` by default. Saved API keys go to the system credential store on Developer ID-signed macOS builds, and otherwise to an owner-only file in that folder. Use a local model to keep inference on your machine too.

## Documentation

The Butler manual covers setup, conversations, projects, schedules, models, MCP, settings and troubleshooting. Read it in [English](https://butler.hexpy.games/en/help/) or [Korean](https://butler.hexpy.games/help/).

## Status

Butler is pre-1.0, so expect breaking changes between releases. It edits files and runs commands, so run it on a machine you control.

## Contributing

To build Butler from source, run the checks or work on the Rust agent, see [CONTRIBUTING.md](CONTRIBUTING.md). Report bugs in [Issues](https://github.com/Hexpy-Games/butler/issues).

## License

[MIT](LICENSE)
