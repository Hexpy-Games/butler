use super::*;
impl Connectors {
    pub(super) async fn ingest(
        &self,
        account: &Account,
        definition: &Connector,
        event: Value,
    ) -> Result<()> {
        let connector = format!("{}/{}", account.plugin, account.connector);
        let event = butler_core::plugins::validate_connector_event(event, &connector, &account.id)?;
        if !event["signal"].is_null() {
            self.storage("signal", event).await?;
            return Ok(());
        }
        let inserted = self.storage("insert", event.clone()).await?;
        if inserted["fresh"] != true {
            return Ok(());
        }
        let event_id = inserted["event_id"]
            .as_str()
            .ok_or_else(|| error("connector_store_invalid"))?;
        let rules = self
            .storage("rules", json!({"connector":connector,"account":account.id}))
            .await?;
        let read_only = self.storage("access", json!({})).await?["read_only"] == true;
        let mut matched = Vec::new();
        let mut actions = Vec::new();
        let mut skip = false;
        let mut skip_rules = Vec::new();
        let mut tags = Vec::new();
        for rule in rules["rules"].as_array().into_iter().flatten() {
            let Some(conditions) = rule["match"].as_array() else {
                continue;
            };
            if !butler_core::plugins::connector_matches(&event, conditions) {
                continue;
            }
            matched.push(rule["id"].clone());
            for action in rule["actions"].as_array().into_iter().flatten() {
                match action["type"].as_str() {
                    Some("skip_model") => {
                        skip = true;
                        skip_rules.push(rule["id"].clone());
                    }
                    Some("tag") => tags.push(action["tag"].clone()),
                    Some("organize") => {
                        let result = if read_only {
                            json!({"ok":false,"code":"connector_read_only"})
                        } else {
                            self.organize(
                                account,
                                definition,
                                event["id"]
                                    .as_str()
                                    .ok_or_else(|| error("connector_event_invalid"))?,
                                action,
                            )
                            .await
                            .unwrap_or_else(|e| json!({"ok":false,"code":e.code}))
                        };
                        actions.push(json!({"rule_id":rule["id"],"action":action,"result":result}));
                    }
                    _ => (),
                }
            }
        }
        self.storage("ready",json!({"event_id":event_id,"matched_rules":matched,"actions":actions,"skip_model":skip,"tags":tags,"skip_rules":skip_rules})).await?;
        Ok(())
    }
    async fn organize(
        &self,
        account: &Account,
        definition: &Connector,
        event_id: &str,
        action: &Value,
    ) -> Result<Value> {
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
        args.insert("event_id".into(), event_id.into());
        args.insert("account".into(), account.id.clone().into());
        let (server, name) = tool
            .split_once('/')
            .ok_or_else(|| error("connector_tool_invalid"))?;
        self.destination(&format!("{}/{server}", account.plugin), name, &args)
            .map_err(error)?;
        self.call(account, tool, args).await
    }
}
