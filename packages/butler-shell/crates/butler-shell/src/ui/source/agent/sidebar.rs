//! Sidebar transport uses only the shared ShellClient API.
use super::{Agent, convert};
use crate::ui::source::{
    Fetch,
    sidebar::{Mutation, ProjectCommand, SessionCommand, SpaceCommand},
    wire,
};

impl Agent {
    pub(super) fn sidebar_navigation(&self) -> Fetch<wire::NavigationView> {
        let client = self.client.clone();
        self.fetch(async move { convert::decode(&client.list_navigation().await?) })
    }
    pub(super) fn sidebar_work_status(&self) -> Fetch<wire::WorkStatusView> {
        let client = self.client.clone();
        self.fetch(async move { convert::decode(&client.get_work_status().await?) })
    }
    pub(super) fn sidebar_mutate(&self, command: Mutation) -> Fetch<wire::SidebarMutationResult> {
        let client = self.client.clone();
        self.fetch(async move {
            let reply = ReplyKind::of(&command);
            let result = match command {
                Mutation::Space(command, body) => match command {
                    SpaceCommand::Create => client.create_space_groups(&body).await,
                    SpaceCommand::Move => client.create_space_moves(&body).await,
                    SpaceCommand::Group => client.create_space_group_sessions(&body).await,
                    SpaceCommand::Undo => client.create_space_undo(&body).await,
                    SpaceCommand::Pin => client.create_space_pins(&body).await,
                    SpaceCommand::Rename(id) => client.update_space_group(&id, &body).await,
                    SpaceCommand::Dissolve(id) => client.delete_space_group(&id, &body).await,
                    SpaceCommand::Relocate => client.create_space_relocations(&body).await,
                },
                Mutation::Session(id, action) => match action {
                    SessionCommand::Rename(title) => {
                        client
                            .update_session(&id, &serde_json::json!({"title":title}))
                            .await
                    }
                    SessionCommand::Archive => client.archive_session(&id).await,
                    SessionCommand::Delete => client.delete_session_permanent(&id).await,
                    SessionCommand::Read => client.mark_session_read(&id).await,
                },
                Mutation::Project(id, action) => match action {
                    ProjectCommand::Rename(title) => {
                        client
                            .update_project(&id, &serde_json::json!({"display_name":title}))
                            .await
                    }
                    ProjectCommand::Archive => client.archive_project(&id).await,
                    ProjectCommand::Delete => client.delete_project(&id, Some(true)).await,
                },
                Mutation::CreateProject(body) => client.create_project(&body).await,
                Mutation::CanonOrder(project, body) => {
                    client.order_canon_sidebar(&project, &body).await
                }
                Mutation::CanonEdit(id, body) => client.edit_canon_epic(&id, &body).await,
                Mutation::CanonCreate(project, body) => {
                    client.create_canon_epic(&project, &body).await
                }
                Mutation::CanonPlanEdit(id, body) => client.edit_canon_plan(&id, &body).await,
                Mutation::CanonConversation(id) => {
                    client
                        .link_canon_conversation(&id, &serde_json::json!({}))
                        .await
                }
                Mutation::ResumeSubtask(id, parent) => {
                    client
                        .resume_steward(&id, &serde_json::json!({"parent_session_id":parent}))
                        .await
                }
                Mutation::ClearGeneral(body) => client.clear_general(&body).await,
            }?;
            reply.decode(&result)
        })
    }
}

enum ReplyKind {
    Empty,
    Space,
    Project,
    Conversation,
    Epic,
}
impl ReplyKind {
    fn of(command: &Mutation) -> Self {
        match command {
            Mutation::Space(_, _) => Self::Space,
            Mutation::CreateProject(_) => Self::Project,
            Mutation::CanonConversation(_) => Self::Conversation,
            Mutation::CanonCreate(_, _) => Self::Epic,
            _ => Self::Empty,
        }
    }
    fn decode(
        self,
        value: &serde_json::Value,
    ) -> Result<wire::SidebarMutationResult, butler_shell_client::Error> {
        if matches!(self, Self::Empty) {
            return Ok(wire::SidebarMutationResult::default());
        }
        let result: wire::SidebarMutationResult = convert::decode(value)?;
        let valid = match self {
            Self::Space => result.space.is_some(),
            Self::Project => result.project.is_some(),
            Self::Conversation => result.session_id.is_some(),
            Self::Epic => result.id.is_some(),
            Self::Empty => true,
        };
        if valid {
            Ok(result)
        } else {
            Err(butler_shell_client::Error::Protocol)
        }
    }
}
