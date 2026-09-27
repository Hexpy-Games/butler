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
  For macOS, Windows and Linux, with hosted or local models.
</p>

<p align="center">
  <a href="https://github.com/Hexpy-Games/butler/releases/latest"><strong>Download</strong></a>
  &nbsp;·&nbsp;
  <a href="https://hexpy-games.github.io/butler/docs/"><strong>Manual</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Hexpy-Games/butler/releases">Releases</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/hero-demo-dark.svg">
    <img src="assets/readme/hero-demo-light.svg" alt="Butler working on a task and asking before it acts" width="100%">
  </picture>
</p>

## What Butler does

- **Works on your computer, with permission.** Butler reads and edits files and runs commands. New conversations start in *Ask first*, so it asks before it changes a file or runs a command. You can switch a conversation to *Read only* or *Full access*. [Conversations](https://hexpy-games.github.io/butler/docs/basics/conversation/)
- **Projects.** A project gives its conversations a shared folder. Butler records plans and progress for the project, and the dashboard summarizes them. [Projects](https://hexpy-games.github.io/butler/docs/projects/)
- **Schedules.** Butler sends a prompt to a conversation at the interval you set. [Schedules](https://hexpy-games.github.io/butler/docs/scheduled-tasks/)
- **Memory and personalization.** Give Butler a name and a persona, and choose how much it learns about you. Learning is off by default. [Personalization](https://hexpy-games.github.io/butler/docs/personalization/)
- **Your choice of model.** Use OpenAI, Anthropic, Google and other hosted providers, or any OpenAI-compatible server such as Ollama, LM Studio or llama.cpp. Backup models take over when the current one stops responding. [Models](https://hexpy-games.github.io/butler/docs/models/cloud/)
- **CLI and MCP.** Run the agent without the app, give Butler tools from MCP servers, or connect other MCP clients to Butler with `butler mcp serve`. [MCP servers](https://hexpy-games.github.io/butler/docs/extensions/mcp-servers/), [Agent CLI](https://hexpy-games.github.io/butler/docs/advanced/agent-cli/)

## Install

Download Butler from the [latest release](https://github.com/Hexpy-Games/butler/releases/latest).

| Platform | Download |
| --- | --- |
| macOS | `.dmg` <!-- TODO(0.1.0): Apple Silicon only today; confirm Intel Mac support. --> |
| Windows | [Latest release](https://github.com/Hexpy-Games/butler/releases/latest) <!-- TODO(0.1.0): name the installer format. --> |
| Linux | [Latest release](https://github.com/Hexpy-Games/butler/releases/latest) <!-- TODO(0.1.0): name the package formats. --> |

On first launch, Butler walks you through language, a safety notice, agent setup and your first model. See [Install](https://hexpy-games.github.io/butler/docs/getting-started/install/) and [First run](https://hexpy-games.github.io/butler/docs/getting-started/first-run/).

<!-- TODO(0.1.0): drop the next line once the macOS app is notarized. -->
If macOS blocks the first launch, [Install](https://hexpy-games.github.io/butler/docs/getting-started/install/) shows how to open it.

## Where your data lives

Conversations, memory and settings stay in a local data folder, `~/.butler` by default. When you use a hosted model, that provider receives the prompt and context for each request. Use a local model to keep inference on your machine too.

## Documentation

The [Butler manual](https://hexpy-games.github.io/butler/docs/) covers setup, conversations, projects, schedules, models, MCP, settings and troubleshooting. It is in Korean for now.

<!-- TODO: link the English manual (https://hexpy-games.github.io/butler/en/docs/) when it ships. -->

## Status

Butler is pre-1.0, so expect breaking changes between releases. It edits files and runs commands, so run it on a machine you control.

## Contributing

To build Butler from source, run the checks or work on the Rust agent, see [CONTRIBUTING.md](CONTRIBUTING.md). Report bugs in [Issues](https://github.com/Hexpy-Games/butler/issues).

## License

[MIT](LICENSE)
