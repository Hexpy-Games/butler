//! Other AI agents' setup files in the signed-in account, for a one-way import.
//!
//! Only named instruction and configuration files are ever opened: never
//! credential files, sessions, history or memory folders. Folders come from
//! [`crate::account_dirs`], so a redirected `HOME` does not hide them.
//! Nothing here writes to, renames or deletes a source file.

use crate::account_dirs::AccountDirs;
use std::io;
use std::path::{Path, PathBuf};

/// Names a fixture home whose default layout replaces the account folders.
/// Honored only in test-support builds.
pub const HOME_FIXTURE: &str = "BUTLER_AGENT_IMPORT_HOME";

/// A supported source agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Agent {
    /// OpenAI Codex CLI and app.
    Codex,
    /// Anthropic Claude Code.
    ClaudeCode,
    /// OpenCode.
    OpenCode,
    /// Nous Research Hermes Agent.
    Hermes,
}

impl Agent {
    /// Every supported agent, in display order.
    pub const ALL: [Agent; 4] = [
        Agent::Codex,
        Agent::ClaudeCode,
        Agent::OpenCode,
        Agent::Hermes,
    ];

    /// Stable identifier used by requests and receipts.
    pub fn key(self) -> &'static str {
        match self {
            Agent::Codex => "codex",
            Agent::ClaudeCode => "claude-code",
            Agent::OpenCode => "opencode",
            Agent::Hermes => "hermes",
        }
    }

    /// Product name.
    pub fn name(self) -> &'static str {
        match self {
            Agent::Codex => "Codex",
            Agent::ClaudeCode => "Claude Code",
            Agent::OpenCode => "OpenCode",
            Agent::Hermes => "Hermes",
        }
    }
}

/// How a configuration file is written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigFormat {
    /// Codex `config.toml`.
    Toml,
    /// Claude Code `.claude.json` in the home folder.
    Json,
    /// OpenCode `opencode.json[c]`.
    Jsonc,
    /// Hermes `config.yaml`.
    Yaml,
}

/// One existing source file and how it is shown to the user.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceFile {
    /// Absolute path; stays in the native process.
    pub path: PathBuf,
    /// Home-relative label such as `~/.codex/AGENTS.md`.
    pub label: String,
}

/// A detected agent and the files Butler may read from it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentSetup {
    /// Which agent.
    pub agent: Agent,
    /// Global instruction file, when present.
    pub instructions: Option<SourceFile>,
    /// Configuration files holding MCP servers, in precedence order (last wins).
    pub configs: Vec<(SourceFile, ConfigFormat)>,
}

/// Agents installed for the signed-in account.
pub fn detect() -> Vec<AgentSetup> {
    #[cfg(feature = "test-support")]
    if let Some(fixture) = std::env::var_os(HOME_FIXTURE).filter(|v| !v.is_empty()) {
        return detect_in(&AccountDirs::under(Path::new(&fixture)));
    }
    crate::account_dirs::account_dirs()
        .map(|dirs| detect_in(&dirs))
        .unwrap_or_default()
}

/// Agents found in the given account folders.
pub fn detect_in(dirs: &AccountDirs) -> Vec<AgentSetup> {
    Agent::ALL
        .into_iter()
        .filter_map(|agent| setup(agent, &dirs.home))
        .collect()
}

/// Reads a source file of at most `max` bytes; `Ok(None)` when it is absent.
pub fn read_source(path: &Path, max: u64) -> io::Result<Option<Vec<u8>>> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > max {
        return Err(io::Error::new(
            io::ErrorKind::FileTooLarge,
            "source too large",
        ));
    }
    std::fs::read(path).map(Some)
}

/// Instruction candidates (first existing wins) and configuration files.
type Files = (
    &'static [&'static str],
    &'static [(&'static str, ConfigFormat)],
);

fn files(agent: Agent) -> Files {
    // OpenCode uses .config on every system (xdg-basedir defaults).
    match agent {
        // An override file replaces AGENTS.md for Codex.
        Agent::Codex => (
            &[".codex/AGENTS.override.md", ".codex/AGENTS.md"],
            &[(".codex/config.toml", ConfigFormat::Toml)],
        ),
        Agent::ClaudeCode => (
            &[".claude/CLAUDE.md"],
            &[(".claude.json", ConfigFormat::Json)],
        ),
        Agent::OpenCode => (
            &[".config/opencode/AGENTS.md"],
            &[
                (".config/opencode/config.json", ConfigFormat::Jsonc),
                (".config/opencode/opencode.json", ConfigFormat::Jsonc),
                (".config/opencode/opencode.jsonc", ConfigFormat::Jsonc),
            ],
        ),
        Agent::Hermes => (
            &[".hermes/SOUL.md"],
            &[(".hermes/config.yaml", ConfigFormat::Yaml)],
        ),
    }
}

/// An agent counts as found when one of its files exists; an empty folder
/// has nothing to import.
fn setup(agent: Agent, home: &Path) -> Option<AgentSetup> {
    let file = |relative: &str| {
        let path = home.join(relative);
        path.is_file().then(|| SourceFile {
            path,
            label: format!("~/{relative}"),
        })
    };
    let (instructions, configs) = files(agent);
    let setup = AgentSetup {
        agent,
        instructions: instructions.iter().find_map(|relative| file(relative)),
        configs: configs
            .iter()
            .filter_map(|(relative, format)| file(relative).map(|source| (source, *format)))
            .collect(),
    };
    (setup.instructions.is_some() || !setup.configs.is_empty()).then_some(setup)
}
