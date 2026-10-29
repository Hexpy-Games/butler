use super::{Mail, Result, Value, imap, json, message, text};
use mail_send::{SmtpClientBuilder, mail_builder::MessageBuilder, smtp::message::Message};
impl Mail {
    pub(super) async fn draft(
        &self,
        c: &mut imap::Connection,
        id: &message::Id,
        body: &str,
    ) -> Result<Value> {
        let fetch = imap::fetch(c, id.uid, true).await?;
        let parsed = message::parse(fetch.body().ok_or("mail_body_missing")?)?;
        let to = parsed
            .reply_to()
            .or_else(|| parsed.from())
            .and_then(|a| a.iter().next())
            .and_then(|a| a.address.as_deref())
            .ok_or("mail_reply_address_missing")?;
        let bytes = self.compose(
            to,
            "",
            &format!("Re: {}", parsed.subject().unwrap_or_default()),
            body,
            parsed.message_id(),
        )?;
        let destinations = imap::destinations(c).await?;
        let drafts = imap::role(&destinations, "drafts")?;
        imap::destination(&destinations, &drafts)?;
        c.append(&drafts, Some("(\\Draft)"), None, bytes)
            .await
            .map_err(|_| "mail_draft_failed")?;
        Ok(json!({"ok":true,"mailbox":drafts}))
    }
    fn compose(
        &self,
        to: &str,
        cc: &str,
        subject: &str,
        body: &str,
        reply: Option<&str>,
    ) -> Result<Vec<u8>> {
        if [to, cc, subject, self.config.address.as_str()]
            .iter()
            .any(|s| s.contains(['\r', '\n', '\0']))
        {
            return Err("mail_header_invalid");
        }
        let recipients = recipients(to)?;
        let mut builder = MessageBuilder::new()
            .from(self.config.address.as_str())
            .to(recipients)
            .subject(subject)
            .text_body(body);
        if !cc.is_empty() {
            builder = builder.cc(recipients_list(cc)?);
        }
        if let Some(reply) = reply {
            builder = builder.in_reply_to(reply);
        }
        builder.write_to_vec().map_err(|_| "mail_compose_failed")
    }
    pub(super) async fn send(&self, args: &Value) -> Result<Value> {
        let to = text(args, "to")?;
        let cc = args["cc"].as_str().unwrap_or_default();
        let mut reply = None;
        if let Some(event) = args["in_reply_to_event_id"].as_str() {
            let id = message::Id::parse(event)?;
            let mut c = imap::connect(&self.config).await?;
            imap::select(&mut c, &id).await?;
            let fetch = imap::fetch(&mut c, id.uid, false).await?;
            reply = message::parse(fetch.header().ok_or("mail_headers_missing")?)?
                .message_id()
                .map(str::to_owned);
            let _ = c.logout().await;
        }
        let bytes = self.compose(
            to,
            cc,
            text(args, "subject")?,
            text(args, "body")?,
            reply.as_deref(),
        )?;
        let mut envelope = Message::empty()
            .from(self.config.address.as_str())
            .body(bytes);
        for recipient in recipients_list(to)?.into_iter().chain(recipients_list(cc)?) {
            envelope = envelope.to(recipient);
        }
        let endpoint = &self.config.smtp;
        // Platform certificate verifier construction may read OS roots.
        let host = endpoint.host.clone();
        let port = endpoint.port;
        let builder = tokio::task::spawn_blocking(move || SmtpClientBuilder::new(host, port))
            .await
            .map_err(|_| "mail_smtp_failed")?
            .map_err(|_| "mail_smtp_failed")?
            .credentials((
                self.config.username.clone(),
                self.config.smtp_password.clone(),
            ))
            .implicit_tls(endpoint.security == "tls");
        if endpoint.security == "plain" {
            let mut client = builder
                .connect_plain()
                .await
                .map_err(|_| "mail_smtp_failed")?;
            client
                .send(envelope)
                .await
                .map_err(|_| "mail_send_failed")?;
            let _ = client.quit().await;
        } else {
            let mut client = builder.connect().await.map_err(|_| "mail_smtp_failed")?;
            client
                .send(envelope)
                .await
                .map_err(|_| "mail_send_failed")?;
            let _ = client.quit().await;
        }
        Ok(json!({"ok":true}))
    }
    pub(super) async fn unsubscribe(
        &self,
        c: &mut imap::Connection,
        id: &message::Id,
        target: &str,
    ) -> Result<Value> {
        let fetch = imap::fetch(c, id.uid, false).await?;
        let parsed = message::parse(fetch.header().ok_or("mail_headers_missing")?)?;
        let links = parsed
            .header_raw("List-Unsubscribe")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().trim_matches(['<', '>']).to_owned())
            .collect::<Vec<_>>();
        let one_click = parsed
            .header_raw("List-Unsubscribe-Post")
            .is_some_and(|s| s.trim().eq_ignore_ascii_case("List-Unsubscribe=One-Click"));
        if !links.iter().any(|link| link == target)
            || !(target.starts_with("mailto:") || one_click && target.starts_with("https://"))
        {
            return Err("mail_unsubscribe_target_mismatch");
        }
        if target.starts_with("https://") {
            let client =
                butler_log::http::external(butler_log::http::Purpose::new("mail.unsubscribe"))
                    .redirect(butler_log::http::RedirectPolicy::none())
                    .build()
                    .map_err(|_| "mail_unsubscribe_failed")?;
            let response = client
                .post(target)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body("List-Unsubscribe=One-Click");
            let response = butler_log::http::send(
                response,
                butler_log::http::Purpose::new("mail.unsubscribe"),
                butler_log::http::Phase::current().sensitive(),
            )
            .await
            .map_err(|_| "mail_unsubscribe_failed")?;
            if !response.status().is_success() {
                return Err("mail_unsubscribe_failed");
            }
            return Ok(json!({"ok":true}));
        }
        Ok(json!({"links":[target]}))
    }
}
fn recipients(value: &str) -> Result<Vec<&str>> {
    recipients_list(value)
}
fn recipients_list(value: &str) -> Result<Vec<&str>> {
    let items = value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if items.iter().any(|s| {
        !s.contains('@')
            || s.chars()
                .any(|c| c.is_control() || c.is_whitespace() || "<>".contains(c))
    }) {
        return Err("mail_address_invalid");
    }
    Ok(items)
}

pub(super) fn unsubscribe_target(args: &Value) -> Result<&str> {
    match (args.get("url"), args.get("mailto")) {
        (Some(Value::String(url)), None) if url.starts_with("https://") => Ok(url),
        (None, Some(Value::String(mailto))) if mailto.starts_with("mailto:") => Ok(mailto),
        _ => Err("mail_unsubscribe_target_mismatch"),
    }
}
