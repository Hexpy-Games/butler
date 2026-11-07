//! Wire types for the P2 wave-2 `palette` unit (mirror TS, `/// TS: path:line`).
use crate::ui::source::wire::CommandPaletteResult;
use serde::Deserialize;

/// The `GET /command-palette` body (`CommandPalette.tsx` `api<{ results: CommandPaletteResult[] }>`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct CommandPaletteResponse {
    #[serde(default)]
    pub(crate) results: Vec<CommandPaletteResult>,
}
