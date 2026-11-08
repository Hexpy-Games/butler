//! The Server copy. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct Words {
    /// settings.pageSections.connection
    pub(super) connection: &'static str,
    /// settings.pageSections.projects
    pub(super) projects: &'static str,
    /// settings.fields.serverUrl
    pub(super) server_url: &'static str,
    /// settings.fields.defaultProjectFolder
    pub(super) default_project_folder: &'static str,
    /// settings.actions.chooseFolder
    pub(super) choose_folder: &'static str,
    /// shell.notYet
    pub(super) not_yet: &'static str,
}

const KO: Words = Words {
    connection: "연결",
    projects: "프로젝트",
    server_url: "서버 URL",
    default_project_folder: "기본 프로젝트 폴더",
    choose_folder: "폴더 선택",
    not_yet: "준비 중",
};

const EN: Words = Words {
    connection: "Connection",
    projects: "Projects",
    server_url: "Server URL",
    default_project_folder: "Default project folder",
    choose_folder: "Choose folder",
    not_yet: "Coming soon",
};

pub(super) fn words(lang: Lang) -> &'static Words {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
