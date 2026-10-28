//! Canon MCP tools; strict inputs and explicit response models.
mod args;
mod client;
use super::server::McpServer;
use butler_canon::store::{CanonActivity, CanonEpic, CanonPage, CanonSpecBody};
use client::{Client, Error, component};
use rmcp::{
    RoleServer,
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    service::RequestContext,
    tool, tool_router,
};
use serde_json::{Value, json};

fn result<T: serde::Serialize>(value: Result<T, Error>) -> CallToolResult {
    match value {
        Ok(v) => CallToolResult::success(vec![ContentBlock::text(json!(v).to_string())]),
        Err(e) => CallToolResult::error(vec![ContentBlock::text(json!({"error":e}).to_string())]),
    }
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Error> {
    serde_json::from_value(value)
        .map_err(|_| Error::new("permission", "캐논 응답을 확인해 주세요."))
}
fn required(value: Option<String>) -> Result<String, Error> {
    value
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::new("invalid_arguments", "ID를 지정해 주세요."))
}
#[tool_router(router=canon_router,vis="pub(super)")]
impl McpServer {
    #[tool(
        name = "canon_list",
        description = "List canon plans and epics. Follow cursor for further pages."
    )]
    async fn canon_list(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<args::List>,
    ) -> CallToolResult {
        result(
            async {
                let client = Client::local(self, &context).await?;
                let query = list_query(args);
                decode::<CanonPage>(client.get(&format!("/canon/list?{}", query)).await?)
            }
            .await,
        )
    }
    #[tool(
        name = "canon_get_epic",
        description = "Read a canon epic, its shared specs and recent activity."
    )]
    async fn canon_get_epic(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<args::Epic>,
    ) -> CallToolResult {
        result(
            async {
                if args.issue_number.is_some() {
                    return Err(Error::new("not_linked", "연결된 이슈가 없습니다."));
                }
                if args.project.is_some() && args.epic_id.is_none() {
                    return Err(Error::new("invalid_arguments", "epic_id를 지정해 주세요."));
                }
                let client = Client::local(self, &context).await?;
                decode::<CanonEpic>(
                    client
                        .get(&format!(
                            "/canon/epics/{}",
                            component(&required(args.epic_id)?)
                        ))
                        .await?,
                )
            }
            .await,
        )
    }
    #[tool(
        name = "canon_get_spec",
        description = "Read a shared canon spec body, criteria and revision."
    )]
    async fn canon_get_spec(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<args::Spec>,
    ) -> CallToolResult {
        result(
            async {
                let client = Client::local(self, &context).await?;
                let id = match (args.spec_id, args.epic_id) {
                    (Some(id), None) => id,
                    (None, Some(epic)) => {
                        let epic: CanonEpic = decode(
                            client
                                .get(&format!("/canon/epics/{}", component(&epic)))
                                .await?,
                        )?;
                        epic.specs
                            .first()
                            .map(|s| s.id.clone())
                            .ok_or_else(|| Error::new("not_linked", "연결된 스펙이 없습니다."))?
                    }
                    _ => {
                        return Err(Error::new(
                            "invalid_arguments",
                            "spec_id 또는 epic_id를 지정해 주세요.",
                        ));
                    }
                };
                decode::<CanonSpecBody>(
                    client
                        .get(&format!("/canon/specs/{}", component(&id)))
                        .await?,
                )
            }
            .await,
        )
    }
    #[tool(
        name = "canon_update_epic_status",
        description = "Change a canon epic status using its current revision."
    )]
    async fn canon_update_epic_status(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<args::Update>,
    ) -> CallToolResult {
        result(async {
            let client=Client::local(self,&context).await?;
            decode::<CanonEpic>(client.request(reqwest::Method::PATCH,&format!("/canon/epics/{}",component(&args.epic_id)),
                Some(json!({"expected_revision":args.expected_revision,"status":args.status}))).await?)
        }.await)
    }
    #[tool(
        name = "canon_comment_epic",
        description = "Add a comment to a canon epic."
    )]
    async fn canon_comment_epic(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<args::Comment>,
    ) -> CallToolResult {
        #[derive(serde::Serialize, serde::Deserialize)]
        struct Comment {
            id: String,
            activity: Vec<CanonActivity>,
        }
        result(
            async {
                let client = Client::local(self, &context).await?;
                decode::<Comment>(
                    client
                        .request(
                            reqwest::Method::POST,
                            &format!("/canon/epics/{}/comments", component(&args.epic_id)),
                            Some(json!({"body":args.body})),
                        )
                        .await?,
                )
            }
            .await,
        )
    }
    #[tool(
        name = "canon_create_epic",
        description = "Create a canon epic in a project backlog."
    )]
    async fn canon_create_epic(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<args::Create>,
    ) -> CallToolResult {
        result(async {
            if !(1..=256).contains(&args.title.chars().count()) {return Err(Error::new("invalid_arguments","제목은 1~256자로 입력해 주세요."));}
            let client=Client::local(self,&context).await?;
            decode::<CanonEpic>(client.request(reqwest::Method::POST,&format!("/projects/{}/canon/epics",component(&args.project)),
                Some(json!({"title":args.title,"description":args.description.unwrap_or_default(),"assignee":args.assign_to_me.unwrap_or(false).then_some(butler_gateway::gateway::APP_PERSON_ID)}))).await?)
        }.await)
    }
    #[tool(
        name = "canon_propose_spec_change",
        description = "Open a spec change proposal for approval in Butler."
    )]
    async fn canon_propose_spec_change(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<args::Propose>,
    ) -> CallToolResult {
        #[derive(serde::Serialize, serde::Deserialize)]
        struct Proposal {
            id: String,
            spec_id: String,
            summary: String,
            base_revision: i64,
            state: String,
        }
        result(async {
            let client=Client::local(self,&context).await?;
            decode::<Proposal>(client.request(reqwest::Method::POST,&format!("/canon/specs/{}/proposals",component(&args.spec_id)),
                Some(json!({"base_revision":args.base_revision,"body":args.body,"summary":args.summary}))).await?)
        }.await)
    }
}

fn list_query(args: args::List) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in json!(args).as_object().into_iter().flatten() {
        if !value.is_null() {
            query.append_pair(
                key,
                &value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string()),
            );
        }
    }
    query.finish()
}
