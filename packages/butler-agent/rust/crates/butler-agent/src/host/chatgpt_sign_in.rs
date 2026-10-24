//! One sign-in attempt, shared by the App flow table and the CLI.
use super::oauth_callback::{self, Callback, CallbackPages, CallbackSpec, respond};
use butler_models::models::{
    ModelConfiguration,
    chatgpt::{self, SignInAttempt, SignInKind, SignInOutcome},
};
use std::sync::Arc;
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

pub(crate) const SPEC: CallbackSpec = CallbackSpec {
    path: "/auth/callback",
    port_env: "BUTLER_CHATGPT_OAUTH_PORT",
    pages: CallbackPages {
        success: "Signed in to ChatGPT. You can close this tab and return to Butler.",
        declined: "Sign-in was declined. You can close this tab.",
        failed: "Sign-in failed. Return to Butler to try again.",
        cancelled: "This sign-in was cancelled in Butler.",
        not_pending: "This is not the pending sign-in.",
    },
};
pub(crate) struct Attempt {
    listener: TcpListener,
    secrets: SignInAttempt,
    pub redirect_uri: String,
    pub auth_url: String,
}
impl Attempt {
    pub(crate) async fn start(
        configuration: &ModelConfiguration,
        kind: SignInKind,
    ) -> Result<Self, String> {
        let secrets = configuration
            .chatgpt_prepare(kind)
            .await
            .map_err(flow_error)?;
        let (port, host) = configuration.chatgpt_callback_environment();
        let bound = if port.is_none() && host.is_none() {
            oauth_callback::bind(SPEC).await
        } else {
            oauth_callback::bind_with_environment(SPEC, port, host).await
        };
        let (listener, redirect_uri) = bound.map_err(|error| match error {
            oauth_callback::CallbackBindError::PortInvalid => {
                "oauth_callback_port_invalid".to_owned()
            }
            oauth_callback::CallbackBindError::PortUnavailable => {
                "oauth_callback_port_unavailable".to_owned()
            }
        })?;
        let auth_url = chatgpt::authorize::url(&secrets, &redirect_uri)
            .map_err(str::to_owned)?
            .to_string();
        Ok(Self {
            listener,
            secrets,
            redirect_uri,
            auth_url,
        })
    }
    pub(crate) async fn run(
        self,
        configuration: Arc<ModelConfiguration>,
        stop: CancellationToken,
        completing: impl FnOnce() -> bool,
    ) -> Result<SignInOutcome, String> {
        let exchanged = tokio::select! {
            result = self.exchange(&configuration) => result,
            () = tokio::time::sleep(std::time::Duration::from_mins(5)) => Err("oauth_timeout".into()),
            () = stop.cancelled() => return Err("oauth_cancelled".into()),
        };
        let (registration, mut stream) = exchanged?;
        if !completing() {
            respond(&mut stream, 409, SPEC.pages.cancelled).await;
            return Err("oauth_cancelled".into());
        }
        let outcome = configuration.chatgpt_save(registration).await;
        match outcome {
            Ok(outcome) => {
                let configuration = configuration.clone();
                tokio::spawn(async move {
                    let _ = configuration.chatgpt_models().await;
                });
                respond(&mut stream, 200, SPEC.pages.success).await;
                Ok(outcome)
            }
            Err(code) => {
                respond(&mut stream, 500, SPEC.pages.failed).await;
                Err(flow_error(code))
            }
        }
    }
    async fn exchange(
        &self,
        configuration: &ModelConfiguration,
    ) -> Result<(serde_json::Value, TcpStream), String> {
        let (code, params, mut stream) = self.wait_for_code().await?;
        match configuration
            .chatgpt_exchange(&self.secrets, &params, &code, &self.redirect_uri)
            .await
        {
            Ok(registration) => Ok((registration, stream)),
            Err(code) => {
                respond(&mut stream, 500, SPEC.pages.failed).await;
                Err(flow_error(code))
            }
        }
    }
    async fn wait_for_code(
        &self,
    ) -> Result<
        (
            String,
            std::collections::BTreeMap<String, String>,
            TcpStream,
        ),
        String,
    > {
        let mut reads = JoinSet::new();
        loop {
            tokio::select! {
                accepted = self.listener.accept() => {
                    let (stream, _) = accepted.map_err(|_| "oauth_callback_unavailable".to_owned())?;
                    if reads.len() < 16 { reads.spawn(read_one(stream, self.redirect_uri.clone(), self.secrets.state.clone())); }
                }
                Some(read) = reads.join_next() => match read {
                    Ok((Callback::Code { code, params }, stream)) => return Ok((code, params, stream)),
                    Ok((Callback::Denied { .. }, _)) => return Err("oauth_denied".into()),
                    _ => {},
                },
            }
        }
    }
}
async fn read_one(mut stream: TcpStream, redirect: String, state: String) -> (Callback, TcpStream) {
    let callback = oauth_callback::read_callback(&mut stream, &redirect, SPEC, &state).await;
    (callback, stream)
}

fn flow_error(code: &str) -> String {
    match code {
        "chatgpt_host_unreadable" => "oauth_host_unreadable",
        "chatgpt_store_unreadable" | "chatgpt_auth_dir_invalid" => "oauth_profile_write_failed",
        code => code,
    }
    .to_owned()
}
