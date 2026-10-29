use super::*;
use butler_models::mcp_client::ConnectorSession;
impl Connectors {
    pub(super) async fn ingest(
        &self,
        account: &Account,
        definition: &Connector,
        event: Value,
        session: &ConnectorSession,
    ) -> Result<()> {
        let connector = format!("{}/{}", account.plugin, account.connector);
        let event = butler_core::plugins::validate_connector_event(event, &connector, &account.id)?;
        // Signals have their own identity and must never consume an event with
        // the same source dedupe key, including one still awaiting delivery.
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
        let matched = rules["rules"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|rule| {
                rule["match"]
                    .as_array()
                    .is_some_and(|c| butler_core::plugins::connector_matches(&event, c))
            })
            .collect::<Vec<_>>();
        let mut actions = matched
            .iter()
            .flat_map(|rule| {
                rule["actions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|action| (rule["id"].clone(), action.clone()))
            })
            .collect::<Vec<_>>();
        actions.sort_by_key(|(_, action)| relocates(definition, action));
        let multiple = actions
            .iter()
            .filter(|(_, a)| relocates(definition, a))
            .count()
            > 1;
        let results = self
            .apply_actions(
                account,
                definition,
                &event,
                &actions,
                (read_only, multiple),
                session,
            )
            .await;
        let skip_rules = actions
            .iter()
            .filter(|(_, a)| a["type"] == "skip_model")
            .map(|(id, _)| id)
            .collect::<Vec<_>>();
        let tags = actions
            .iter()
            .filter(|(_, a)| a["type"] == "tag")
            .map(|(_, a)| &a["tag"])
            .collect::<Vec<_>>();
        self.storage("ready",json!({"event_id":event_id,"matched_rules":matched.iter().map(|r|&r["id"]).collect::<Vec<_>>(),"actions":results,"skip_model":!skip_rules.is_empty(),"tags":tags,"skip_rules":skip_rules})).await?;
        Ok(())
    }
    async fn apply_actions(
        &self,
        account: &Account,
        definition: &Connector,
        event: &Value,
        actions: &[(Value, Value)],
        (read_only, multiple): (bool, bool),
        session: &ConnectorSession,
    ) -> Vec<Value> {
        let mut results = Vec::new();
        for (rule, action) in actions.iter().filter(|(_, a)| a["type"] == "organize") {
            let result = if read_only {
                json!({"ok":false,"code":"connector_read_only"})
            } else if multiple && relocates(definition, action) {
                json!({"ok":false,"code":"connector_rule_invalid"})
            } else {
                self.organize(
                    account,
                    definition,
                    event["id"].as_str().unwrap_or_default(),
                    action,
                    session,
                )
                .await
                .unwrap_or_else(|e| json!({"ok":false,"code":e.code}))
            };
            results.push(json!({"rule_id":rule,"action":action,"result":result}));
        }
        results
    }
    async fn organize(
        &self,
        account: &Account,
        definition: &Connector,
        event_id: &str,
        action: &Value,
        session: &ConnectorSession,
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
        if server == definition.events.server {
            session.call(name, args).await.map_err(error)
        } else {
            self.call(account, tool, args).await
        }
    }
}
fn relocates(definition: &Connector, action: &Value) -> bool {
    action["type"] == "organize"
        && definition
            .actions
            .iter()
            .any(|a| action["tool"] == a.tool && (a.destination || a.relocates))
}
