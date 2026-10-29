use super::{Mail, Result, imap, intake, json};
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt, model::*, service::RequestContext};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct Server {
    mail: Option<Arc<Mail>>,
    stop: CancellationToken,
    auth_failed: CancellationToken,
    intake: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}
pub(super) async fn serve(mail: Option<Arc<Mail>>) -> Result<()> {
    let stop = CancellationToken::new();
    let auth_failed = CancellationToken::new();
    let intake = Arc::new(Mutex::new(None));
    let server = Server {
        mail: mail.clone(),
        stop: stop.clone(),
        auth_failed: auth_failed.clone(),
        intake: intake.clone(),
    };
    let running = server
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|_| "mail_mcp_failed")?;
    let result = tokio::select! {
        result = running.waiting() => result.map(|_| ()).map_err(|_| "mail_mcp_failed"),
        () = auth_failed.cancelled() => {
            let code = match &mail {
                Some(mail) => mail.terminal.lock().await.unwrap_or("mail_auth_failed"),
                None => "mail_auth_failed",
            };
            Err(code)
        },
    };
    stop.cancel();
    if let Some(task) = intake.lock().await.take() {
        let _ = task.await;
    }
    result
}
fn error(code: &'static str) -> ErrorData {
    ErrorData::internal_error(code, None)
}
impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        let mut config = ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_resources_subscribe()
                .build(),
        )
        .with_server_info(Implementation::new("butler-mail-connector", "1.0.0"));
        config.protocol_version = ProtocolVersion::V_2025_06_18;
        config
    }
    fn list_resources(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = std::result::Result<ListResourcesResult, ErrorData>> + Send
    {
        std::future::ready(Ok(ListResourcesResult {
            resources: vec![
                Resource::new("connector://events", "Mail events"),
                Resource::new("connector://destinations", "Mailboxes"),
            ],
            ..Default::default()
        }))
    }
    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ReadResourceResponse, ErrorData> {
        let mail = self
            .mail
            .as_ref()
            .ok_or_else(|| error("mail_account_required"))?;
        let value = match request.uri.as_str() {
            "connector://events" => mail.state.lock().await.batch(),
            "connector://destinations" => mail
                .bounded(async {
                    let (mut connection, _) = mail.connect(Some(&self.auth_failed)).await?;
                    let destinations = imap::destinations(&mut connection).await?;
                    let _ = connection.logout().await;
                    Ok(json!({"destinations":destinations}))
                })
                .await
                .map_err(error)?,
            uri if uri.starts_with("connector://events?after=") => {
                let cursor = uri
                    .strip_prefix("connector://events?after=")
                    .ok_or_else(|| error("mail_cursor_invalid"))?;
                mail.state
                    .lock()
                    .await
                    .acknowledge(&mail.config.data, cursor)
                    .await
                    .map_err(error)?;
                json!({"ok":true})
            }
            _ => return Err(error("mail_resource_unknown")),
        };
        Ok(
            ReadResourceResult::new(vec![ResourceContents::text(value.to_string(), request.uri)])
                .into(),
        )
    }
    #[allow(deprecated, reason = "PC0 uses resource subscriptions")]
    async fn subscribe(
        &self,
        request: SubscribeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<(), ErrorData> {
        if request.uri != "connector://events" {
            return Err(error("mail_resource_unknown"));
        }
        let mail = self
            .mail
            .as_ref()
            .ok_or_else(|| error("mail_account_required"))?;
        let mut task = self.intake.lock().await;
        if task.is_none() {
            *task = Some(tokio::spawn(intake::run(
                mail.clone(),
                context.peer,
                self.stop.clone(),
                self.auth_failed.clone(),
            )));
        }
        Ok(())
    }
    fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = std::result::Result<ListToolsResult, ErrorData>> + Send
    {
        std::future::ready(tools().map(|tools| ListToolsResult {
            tools,
            ..Default::default()
        }))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let mail = self
            .mail
            .as_ref()
            .ok_or_else(|| error("mail_account_required"))?;
        let args = serde_json::Value::Object(request.arguments.unwrap_or_default());
        let result =
            tokio::time::timeout(mail.config.timeout, mail.action(&request.name, args)).await;
        let result = match result {
            Ok(Ok(value)) => CallToolResult::success(vec![ContentBlock::text(value.to_string())]),
            Ok(Err(code)) => CallToolResult::error(vec![ContentBlock::text(code)]),
            Err(_) => CallToolResult::error(vec![ContentBlock::text("mail_operation_timeout")]),
        };
        Ok(result.into())
    }
}
fn tools() -> std::result::Result<Vec<Tool>, ErrorData> {
    let specs = [
        (
            "thread",
            "Read headers, text and attachment metadata",
            vec!["event_id"],
            vec![],
        ),
        (
            "move",
            "File mail into an existing mailbox",
            vec!["event_id", "destination"],
            vec![],
        ),
        (
            "label",
            "Apply a mailbox label or keyword",
            vec!["event_id", "label"],
            vec![],
        ),
        ("archive", "Archive mail", vec!["event_id"], vec![]),
        ("mark_read", "Mark mail read", vec!["event_id"], vec![]),
        (
            "search",
            "Search INBOX using IMAP search criteria",
            vec!["query", "limit"],
            vec![],
        ),
        (
            "draft_reply",
            "Save a reply in Drafts",
            vec!["event_id", "body"],
            vec![],
        ),
        (
            "send",
            "Send mail via SMTP",
            vec!["to", "subject", "body"],
            vec!["cc", "in_reply_to_event_id"],
        ),
        (
            "unsubscribe",
            "Submit the exact one-click HTTPS URL or return the exact mailto link",
            vec!["event_id"],
            vec!["url", "mailto"],
        ),
    ];
    specs
        .into_iter()
        .map(|(name, description, required, optional)| {
            tool(name, description, &required, &optional)
        })
        .collect()
}
fn tool(
    name: &str,
    description: &str,
    required: &[&str],
    optional: &[&str],
) -> std::result::Result<Tool, ErrorData> {
    let mut properties = serde_json::Map::new();
    for key in required
        .iter()
        .chain(optional.iter())
        .copied()
        .chain(std::iter::once("account"))
    {
        properties.insert(
            key.into(),
            if key == "limit" {
                json!({"type":"integer","minimum":1,"maximum":1000})
            } else {
                json!({"type":"string"})
            },
        );
    }
    let mut schema = json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    if name == "unsubscribe" {
        schema["oneOf"] = json!([{"required":["url"]},{"required":["mailto"]}]);
    }
    serde_json::from_value(json!({"name":name,"description":description,"inputSchema":schema,"annotations":{"readOnlyHint":matches!(name,"thread"|"search"),"destructiveHint":false}})).map_err(|_| error("mail_schema_failed"))
}
