use super::*;
impl Connectors {
    pub(in crate::host::plugins) async fn admin(
        self: &Arc<Self>,
        action: &str,
        id: Option<String>,
        input: Value,
    ) -> Result<Value> {
        match action {
            "connector_stop" => {
                let live = std::mem::take(&mut *self.live.lock());
                for l in live.values() {
                    l.cancel.cancel();
                }
                for (_, l) in live {
                    let _ = l.task.await;
                }
                return Ok(json!({"ok":true}));
            }
            "connector_list" => return self.inventory(),
            "connector_rules" => return self.storage("rules", json!({})).await,
            "connector_rule_delete" => return self.storage("rule_remove", json!({"id":id})).await,
            "connector_rule_patch" => {
                let mut rule = self.storage("rule", json!({"id":id})).await?;
                let patch = input
                    .as_object()
                    .ok_or_else(|| error("connector_rule_invalid"))?;
                for key in ["match", "actions", "title"] {
                    if let Some(v) = patch.get(key) {
                        rule[key] = v.clone();
                    }
                }
                return self.set_rule(rule, false).await;
            }
            _ => (),
        }
        let owner = self.owner()?;
        let _permit = owner.writes.acquire_owned().await;
        let runtime = self.clone();
        let disconnect = action == "connector_disconnect";
        let action = action.to_owned();
        let mut changed =
            tokio::task::spawn_blocking(move || runtime.change_account(&action, id, &input))
                .await
                .map_err(|_| error("connector_task_failed"))??;
        // A handling update or retry restarts the account with its fresh snapshot.
        if let Some(id) = changed["account"].as_str() {
            let live = self.live.lock().remove(id);
            if let Some(live) = live {
                live.cancel.cancel();
                let _ = live.task.await;
            }
            self.states.lock().remove(id);
        }
        if disconnect {
            let runtime = self.clone();
            let account_id = changed["account"].as_str().unwrap_or_default().to_owned();
            let leftovers =
                tokio::task::spawn_blocking(move || runtime.cleanup_account(&account_id))
                    .await
                    .map_err(|_| error("connector_task_failed"))??;
            super::super::secret_cleanup::report(&mut changed, &leftovers);
        }
        self.reconcile().await;
        Ok(changed)
    }
    fn cleanup_account(&self, id: &str) -> Result<Vec<Value>> {
        let owner = self.owner()?;
        let account = owner
            .state
            .lock()
            .registry
            .accounts
            .get(id)
            .cloned()
            .ok_or_else(|| error("connector_account_not_found"))?;
        let keys = self.secret_keys(&account)?;
        Ok(super::super::secret_cleanup::system(&keys))
    }
    fn change_account(&self, action: &str, id: Option<String>, input: &Value) -> Result<Value> {
        let owner = self.owner()?;
        let _mutation = owner.mutation.lock();
        let mut state = owner.state.lock().clone();
        super::super::storage::revision(&state, input)?;
        let path = id.ok_or_else(|| error("connector_account_invalid"))?;
        let parts = path.split('/').collect::<Vec<_>>();
        if parts.len() < 2 {
            return Err(error("connector_account_invalid"));
        }
        let definition = self.definition(parts[0], parts[1])?;
        let account_id = if action == "connector_connect" {
            format!("acct-{}", uuid::Uuid::new_v4())
        } else {
            parts
                .get(2)
                .ok_or_else(|| error("connector_account_invalid"))?
                .to_string()
        };
        if action == "connector_connect" {
            let account = self.new_account(parts[0], parts[1], &account_id, &definition, input)?;
            state.registry.accounts.insert(account_id.clone(), account);
        } else {
            let account = state
                .registry
                .accounts
                .get_mut(&account_id)
                .filter(|a| a.plugin == parts[0] && a.connector == parts[1])
                .ok_or_else(|| error("connector_account_not_found"))?;
            match action {
                "connector_disconnect" => {
                    account.enabled = false;
                }
                "connector_retry" => {
                    account.enabled = true;
                }
                "connector_patch" => {
                    if let Some(value) = input.get("handling") {
                        account.handling = handling(Some(value))?;
                    }
                    if let Some(value) = input.get("enabled") {
                        account.enabled = value
                            .as_bool()
                            .ok_or_else(|| error("connector_account_invalid"))?;
                    }
                }
                _ => return Err(error("connector_action_invalid")),
            }
        }
        state.registry.revision += 1;
        owner.save(&state.registry)?;
        *owner.state.lock() = state.clone();
        Ok(json!({"account":account_id,"revision":state.registry.revision}))
    }
    fn new_account(
        &self,
        plugin: &str,
        connector: &str,
        account_id: &str,
        definition: &Connector,
        input: &Value,
    ) -> Result<Account> {
        let fields: BTreeMap<String, String> = serde_json::from_value(input["fields"].clone())
            .map_err(|_| error("connector_fields_invalid"))?;
        if fields
            .keys()
            .any(|k| !definition.account.fields.iter().any(|f| f.key == *k))
            || definition
                .account
                .fields
                .iter()
                .any(|f| !fields.contains_key(&f.key))
        {
            return Err(error("connector_fields_invalid"));
        }
        let handling = handling(input.get("handling"))?;
        let secrets = credentials::store()?;
        for field in &definition.account.secrets {
            let value = input["secrets"][&field.key]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| error("connector_secret_required"))?;
            butler_log::register_secret(value);
            secrets
                .set(
                    &credentials::key(plugin, connector, account_id, &field.key)?,
                    value,
                )
                .map_err(|_| error("connector_secret_store_unavailable"))?;
        }
        Ok(Account {
            id: account_id.into(),
            plugin: plugin.into(),
            connector: connector.into(),
            fields,
            handling,
            enabled: true,
        })
    }
    pub(super) async fn prepared(
        &self,
        account: &Account,
        server: &str,
    ) -> Result<butler_models::mcp_client::PreparedOverlay> {
        let owner = self.owner()?;
        let account = account.clone();
        let server = server.to_owned();
        tokio::task::spawn_blocking(move || owner.connectors.prepared_blocking(&account, &server))
            .await
            .map_err(|_| error("connector_task_failed"))?
    }
    pub(in crate::host::plugins) fn prepared_blocking(
        &self,
        account: &Account,
        server: &str,
    ) -> Result<butler_models::mcp_client::PreparedOverlay> {
        let owner = self.owner()?;
        let (mut config, lease) =
            owner.prepare_snapshot(&format!("{}/{server}", account.plugin))?;
        let definition = owner
            .connectors
            .definition(&account.plugin, &account.connector)?;
        let env = config["env"]
            .as_array_mut()
            .ok_or_else(|| error("connector_config_invalid"))?;
        env.push(json!({"key":"BUTLER_CONNECTOR_ACCOUNT","source":"literal","value":account.id}));
        env.push(json!({"key":"BUTLER_CONNECTOR_FIELDS","source":"literal","value":serde_json::to_string(&account.fields).map_err(|_|error("connector_fields_invalid"))?}));
        let secrets = credentials::store()?;
        for field in &definition.account.secrets {
            let secret = secrets
                .get(&credentials::key(
                    &account.plugin,
                    &account.connector,
                    &account.id,
                    &field.key,
                )?)
                .map_err(|_| error("connector_secret_store_unavailable"))?
                .ok_or_else(|| error("connector_secret_store_unavailable"))?;
            butler_log::register_secret(secret.expose());
            env.push(json!({"key":field.key,"source":"literal","value":secret.expose()}));
        }
        Ok(butler_models::mcp_client::PreparedOverlay {
            config,
            lease: Some(lease),
        })
    }
}
fn handling(value: Option<&Value>) -> Result<butler_core::plugins::ConnectorHandling> {
    let h: butler_core::plugins::ConnectorHandling = value
        .map(|v| serde_json::from_value(v.clone()))
        .transpose()
        .map_err(|_| error("connector_handling_invalid"))?
        .unwrap_or_default();
    if !matches!(h.mode.as_str(), "immediate" | "batch")
        || !h.interval_minutes.is_finite()
        || h.interval_minutes <= 0.0
        || h.interval_minutes > 525_600.0
    {
        return Err(error("connector_handling_invalid"));
    }
    Ok(h)
}
