//! Project-scoped skill settings assembled outside the gateway trait facade.
use super::*;
pub(super) fn read(this: AppApplication) -> ApplicationFuture<SkillSettingsView> {
    Box::pin(async move {
        let projects = this
            .list_projects(false)
            .await?
            .projects
            .into_iter()
            .map(|project| (project.id, project.display_name))
            .collect();
        this.dependencies
            .skills
            .settings(projects)
            .await
            .map_err(skill_error)
    })
}
