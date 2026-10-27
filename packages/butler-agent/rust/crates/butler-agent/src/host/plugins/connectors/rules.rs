use super::*;
impl Connectors {
    pub(in crate::host::plugins) async fn tool(
        &self,
        action: &str,
        input: Value,
        read_only: bool,
    ) -> Result<Value> {
        match action {
            "connector_rule_set" => self.set_rule(input, read_only).await,
            "connector_rule_list" => self.storage("rules", input).await,
            "connector_rule_remove" => self.storage("rule_remove", input).await,
            "connector_triage" => self.storage("triage", input).await,
            "connector_fetch" => {
                let event = self.storage("event", input).await?;
                let owner = self.owner()?;
                let account = owner
                    .state
                    .lock()
                    .registry
                    .accounts
                    .get(event["account"].as_str().unwrap_or_default())
                    .cloned()
                    .filter(|a| a.enabled)
                    .ok_or_else(|| error("connector_disconnected"))?;
                let definition = self.definition(&account.plugin, &account.connector)?;
                let result = self
                    .call(
                        &account,
                        &definition.context.tool,
                        json!({"event_id":event["id"]})
                            .as_object()
                            .cloned()
                            .unwrap_or_default(),
                    )
                    .await?;
                let data = serde_json::to_string(&result)
                    .map_err(|_| error("connector_content_invalid"))?
                    .replace('<', "\\u003c")
                    .replace('>', "\\u003e");
                Ok(json!({"content":format!("<connector-data>\n{data}\n</connector-data>")}))
            }
            _ => Err(error("connector_tool_unknown")),
        }
    }
    pub(super) async fn set_rule(&self, mut input: Value, read_only: bool) -> Result<Value> {
        let connector = input["connector"]
            .as_str()
            .ok_or_else(|| error("connector_rule_invalid"))?;
        let (plugin, id) = connector
            .split_once('/')
            .ok_or_else(|| error("connector_rule_invalid"))?;
        let definition = self.definition(plugin, id)?;
        let read_only = read_only || self.storage("access", json!({})).await?["read_only"] == true;
        validate_rule(&input)?;
        let relocating = input["actions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|action| {
                action["type"] == "organize"
                    && definition
                        .actions
                        .iter()
                        .any(|a| action["tool"] == a.tool && (a.destination || a.relocates))
            })
            .count();
        if relocating > 1 {
            return Err(error("connector_rule_invalid"));
        }
        for action in input["actions"].as_array().into_iter().flatten() {
            if action["type"] != "organize" {
                continue;
            }
            if read_only {
                return Err(error("connector_rule_read_only"));
            }
            let tool = action["tool"]
                .as_str()
                .ok_or_else(|| error("connector_rule_invalid"))?;
            if !definition
                .actions
                .iter()
                .any(|a| a.tool == tool && a.organize)
            {
                return Err(error("connector_rule_action_not_organize"));
            }
            let mut args = action["arguments"].as_object().cloned().unwrap_or_default();
            if let Some(account) = input["account"].as_str() {
                args.insert("account".into(), account.into());
            }
            let (server, name) = tool
                .split_once('/')
                .ok_or_else(|| error("connector_tool_invalid"))?;
            self.destination(&format!("{plugin}/{server}"), name, &args)
                .map_err(error)?;
        }
        if input["id"].is_null() {
            input["id"] = format!("rule-{}", uuid::Uuid::new_v4()).into();
        }
        self.storage("rule_set", input).await
    }
}
fn validate_rule(rule: &Value) -> Result<()> {
    let invalid = || error("connector_rule_invalid");
    for key in ["title", "reason"] {
        if rule[key].as_str().is_none_or(str::is_empty) {
            return Err(invalid());
        }
    }
    let conditions = rule["match"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(invalid)?;
    for c in conditions {
        let field = c["field"].as_str().ok_or_else(invalid)?;
        if !(matches!(
            field,
            "from.address" | "from.display" | "addressing" | "subject"
        ) || field
            .strip_prefix("attributes.")
            .is_some_and(|s| !s.is_empty()))
            || !matches!(c["op"].as_str(), Some("equals" | "contains" | "ends_with"))
            || c["value"].as_str().is_none_or(|v| v.trim().is_empty())
        {
            return Err(invalid());
        }
    }
    let actions = rule["actions"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(invalid)?;
    for a in actions {
        match a["type"].as_str() {
            Some("skip_model") => (),
            Some("tag") if a["tag"].as_str().is_some_and(|s| !s.is_empty()) => (),
            Some("organize")
                if a["tool"].as_str().is_some() && a["arguments"].as_object().is_some() => {}
            _ => return Err(invalid()),
        }
    }
    Ok(())
}
