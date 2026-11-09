//! Sidebar commands, routed by the Agent to ShellClient (no UI HTTP).
use serde_json::Value;
#[derive(Clone)]
pub(crate) enum Mutation {
    Space(SpaceCommand, Value),
    Session(String, SessionCommand),
    Project(String, ProjectCommand),
    CreateProject(Value),
    CanonOrder(String, Value),
    CanonEdit(String, Value),
    ClearGeneral(Value),
    CanonConversation(String),
    CanonCreate(String, Value),
    CanonPlanEdit(String, Value),
    ResumeSubtask(String, String),
}
#[derive(Clone)]
pub(crate) enum SpaceCommand {
    Create,
    Move,
    Group,
    Undo,
    Pin,
    Rename(String),
    Dissolve(String),
    Relocate,
}
#[derive(Clone)]
pub(crate) enum SessionCommand {
    Rename(String),
    Archive,
    Delete,
    Read,
}
#[derive(Clone)]
pub(crate) enum ProjectCommand {
    Rename(String),
    Archive,
    Delete,
}

#[derive(Clone)]
pub(crate) enum DraftTarget {
    Project(String),
    Group { id: String, project: Option<String> },
}
impl DraftTarget {
    pub(crate) fn body(&self) -> Value {
        let mut body = serde_json::json!({"kind":"chat","workspace_mode":"local"});
        match self {
            Self::Project(id) => {
                body["kind"] = "project".into();
                body["project_id"] = id.clone().into();
            }
            Self::Group { id, project } => {
                body["group_id"] = id.clone().into();
                if let Some(project) = project {
                    body["kind"] = "project".into();
                    body["project_id"] = project.clone().into();
                }
            }
        }
        body
    }
}
