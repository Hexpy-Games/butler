//! The inputs of an AdaptiveShell that are not tokens.
use super::frame::CHAT_WIDTH_DEFAULT;

/// The window the shell lives in: its size decides drawer or docked (media queries in CSS).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShellWindow {
    pub width: f32,
    pub height: f32,
    /// The window is fullscreen: macOS draws no traffic lights then.
    pub fullscreen: bool,
}

impl ShellWindow {
    pub fn new(width: f32, height: f32) -> Self {
        Self {
            width,
            height,
            fullscreen: false,
        }
    }
}

/// `platform` of the shell: the chrome that Electron draws or leaves to the app.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ShellPlatform {
    #[default]
    Browser,
    Darwin,
    Linux,
    Win32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandleSide {
    Left,
    Right,
}

/// The browser pane beside the chat (`splitOpen`, `paneOpen`, `chatWidth`, `contextKey`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SplitConfig {
    pub open: bool,
    pub chat_width: f32,
    /// What the split shows (a conversation id): when it changes the pane opens or closes at once.
    pub context_key: u64,
}

impl SplitConfig {
    pub fn new(open: bool) -> Self {
        Self {
            open,
            chat_width: CHAT_WIDTH_DEFAULT,
            context_key: 0,
        }
    }

    pub fn chat_width(mut self, width: f32) -> Self {
        self.chat_width = width;
        self
    }

    pub fn context_key(mut self, key: u64) -> Self {
        self.context_key = key;
        self
    }
}
