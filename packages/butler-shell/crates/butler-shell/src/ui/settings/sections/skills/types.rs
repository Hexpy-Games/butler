//! `SkillSettingsView` (app/types.ts): what `/skills` carries.
use serde::Deserialize;

#[derive(Clone, Deserialize)]
pub(super) struct Skill {
    pub(super) name: String,
    #[serde(default)]
    pub(super) description: String,
    pub(super) source: String,
    #[serde(default)]
    pub(super) project_id: Option<String>,
    pub(super) file_path: String,
    #[serde(default)]
    pub(super) user_invocable: bool,
}

#[derive(Clone, Deserialize)]
pub(super) struct SkillProject {
    pub(super) id: String,
    pub(super) display_name: String,
    #[serde(default)]
    pub(super) skills: Vec<Skill>,
}

#[derive(Clone, Deserialize)]
pub(super) struct SkillSettings {
    #[serde(default)]
    pub(super) core: Vec<Skill>,
    #[serde(default)]
    pub(super) user: Vec<Skill>,
    #[serde(default)]
    pub(super) projects: Vec<SkillProject>,
}
