use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DialogKind {
    Alert,
    Confirm,
    Prompt,
    #[serde(rename = "beforeunload")]
    BeforeUnload,
    Auth,
    File,
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct PageDialog {
    pub(crate) id: u64,
    pub(crate) kind: DialogKind,
    pub(crate) message: String,
    pub(crate) default_prompt: String,
    pub(crate) origin: String,
    pub(crate) accept_types: Vec<String>,
    pub(crate) multiple: bool,
}
#[derive(Default, Clone)]
pub(crate) struct DialogAnswer {
    pub(crate) accept: bool,
    pub(crate) text: String,
    pub(crate) username: String,
    pub(crate) password: String,
    pub(crate) files: Vec<PathBuf>,
}
