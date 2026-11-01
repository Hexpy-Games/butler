use super::*;
use rmcp::{RoleClient, model::*, service::RunningService, transport::async_rw::AsyncRwTransport};
use std::process::{ExitStatus, Stdio};
use tokio::process::{Child, Command};
pub(super) struct Direct {
    client: RunningService<RoleClient, ()>,
    child: Child,
    stderr: PathBuf,
}
impl Direct {
    pub(super) async fn open(
        s: &Scenario,
        fake: &FakeImap,
        id: &str,
        password: &str,
    ) -> Result<Self, HarnessError> {
        let stderr = s
            .sandbox
            .home
            .join(format!("connector-{}.stderr", uuid::Uuid::new_v4()));
        let mut command = Command::new(butler_e2e::e2e::binary::fixture_binary(
            "e2e-mail-connector",
        )?);
        command
            .env_clear()
            .envs(butler_e2e::e2e::binary::system_environment())
            .env("BUTLER_CONNECTOR_FIELDS", fields(fake).to_string())
            .env("BUTLER_CONNECTOR_ACCOUNT", id)
            .env(
                "BUTLER_PLUGIN_DATA",
                s.sandbox.data.join("plugins/data/mail"),
            )
            .env("IMAP_PASSWORD", password)
            .env("BUTLER_CONNECTOR_CALL_TIMEOUT_MS", "3000")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(fs::File::create(&stderr)?)
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let output = child.stdout.take().unwrap();
        let input = child.stdin.take().unwrap();
        let client = rmcp::service::serve_client(
            (),
            AsyncRwTransport::<RoleClient, _, _>::new_client(output, input),
        )
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
        Ok(Self {
            client,
            child,
            stderr,
        })
    }
    pub(super) async fn read(&self, uri: &str) -> Result<Value, HarnessError> {
        let result = self
            .client
            .peer()
            .read_resource(ReadResourceRequestParams::new(uri))
            .await
            .map_err(|e| HarnessError(e.to_string()))?;
        let result = serde_json::to_value(result)?;
        Ok(serde_json::from_str(
            result["contents"][0]["text"].as_str().unwrap(),
        )?)
    }
    #[allow(deprecated, reason = "connector event contract")]
    pub(super) async fn subscribe(&self) -> Result<(), HarnessError> {
        self.client
            .peer()
            .subscribe(SubscribeRequestParams::new("connector://events"))
            .await
            .map_err(|e| HarnessError(e.to_string()))
    }
    pub(super) async fn kill(mut self) -> Result<(), HarnessError> {
        self.child.kill().await?;
        self.child.wait().await?;
        fs::remove_file(self.stderr)?;
        Ok(())
    }
    pub(super) async fn call(&self, name: &str, args: Value) -> Result<Value, HarnessError> {
        let result = self
            .client
            .peer()
            .call_tool(
                CallToolRequestParams::new(name.to_owned())
                    .with_arguments(args.as_object().unwrap().clone()),
            )
            .await
            .map_err(|e| HarnessError(e.to_string()))?;
        Ok(serde_json::to_value(result)?)
    }
    pub(super) async fn tools(&self) -> Result<Vec<String>, HarnessError> {
        Ok(self
            .client
            .peer()
            .list_tools(None)
            .await
            .map_err(|e| HarnessError(e.to_string()))?
            .tools
            .into_iter()
            .map(|t| t.name.into_owned())
            .collect())
    }
    pub(super) async fn close(mut self, password: &str) -> Result<(), HarnessError> {
        let _ = self.client.close().await;
        tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .map_err(|_| HarnessError("connector failed to exit on EOF".into()))??;
        assert!(!fs::read_to_string(&self.stderr)?.contains(password));
        fs::remove_file(self.stderr)?;
        Ok(())
    }
    #[allow(deprecated, reason = "PC0 uses resource subscriptions")]
    pub(super) async fn subscribe_until_exit(
        mut self,
        password: &str,
    ) -> Result<(ExitStatus, String), HarnessError> {
        self.client
            .peer()
            .subscribe(SubscribeRequestParams::new("connector://events"))
            .await
            .map_err(|e| HarnessError(e.to_string()))?;
        let status = tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .map_err(|_| HarnessError("connector did not exit after rejected LOGIN".into()))??;
        let stderr = fs::read_to_string(&self.stderr)?;
        assert!(
            !stderr.contains(password),
            "password canary leaked to connector stderr"
        );
        fs::remove_file(self.stderr)?;
        Ok((status, stderr))
    }
}
