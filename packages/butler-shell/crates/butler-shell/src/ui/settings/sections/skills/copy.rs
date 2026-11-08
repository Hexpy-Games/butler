//! The Skills copy. Each field names its `packages/butler-i18n` key.
use butler_ds::ui::context::Lang;

pub(super) struct SkillsCopy {
    /// settings.pageSections.coreSkills
    pub(super) core_skills: &'static str,
    /// settings.pageSections.userSkills
    pub(super) user_skills: &'static str,
    /// settings.pageSections.projectSkills
    pub(super) project_skills: &'static str,
    /// interfaceDetails.noSkills
    pub(super) no_skills: &'static str,
    /// settings.memory.noProjects
    pub(super) no_projects: &'static str,
    /// settings.actions.importSkill
    pub(super) import_skill: &'static str,
    /// settings.actions.createSkillWithChat
    pub(super) create_with_chat: &'static str,
    /// settings.skillErrors.import
    pub(super) import_failed: &'static str,
    /// firstRun.product
    pub(super) product: &'static str,
    /// interfaceTemplates.skillTitle
    pub(super) skill_title: fn(&str) -> String,
}

static KO: SkillsCopy = SkillsCopy {
    core_skills: "기본 스킬",
    user_skills: "내 스킬",
    project_skills: "프로젝트 스킬",
    no_skills: "등록된 스킬이 없습니다.",
    no_projects: "프로젝트 없음",
    import_skill: "가져오기",
    create_with_chat: "대화해서 만들기",
    import_failed: "가져오지 못했습니다.",
    product: "버틀러",
    skill_title: |name| format!("{name}과 어떤 스킬을 만들어볼까요?"),
};

static EN: SkillsCopy = SkillsCopy {
    core_skills: "Built-in skills",
    user_skills: "Your skills",
    project_skills: "Project skills",
    no_skills: "No skills registered.",
    no_projects: "No projects",
    import_skill: "Import",
    create_with_chat: "Create with chat",
    import_failed: "Couldn't import it.",
    product: "Butler",
    skill_title: |name| format!("What skill shall we build with {name}?"),
};

pub(super) fn words(lang: Lang) -> &'static SkillsCopy {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}
