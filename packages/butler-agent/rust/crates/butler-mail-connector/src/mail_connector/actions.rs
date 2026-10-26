use super::{Mail, Result, Value, imap, json, message, text};
use futures_util::TryStreamExt;
impl Mail {
    pub(super) async fn action(&self, name: &str, args: Value) -> Result<Value> {
        if name == "send" {
            return self.send(&args).await;
        }
        let (mut connection, _) = self.connect(None).await?;
        let result = self.imap_action(&mut connection, name, &args).await;
        let _ = connection.logout().await;
        result
    }
    async fn imap_action(
        &self,
        c: &mut imap::Connection,
        name: &str,
        args: &Value,
    ) -> Result<Value> {
        if name == "search" {
            return self.search(c, args).await;
        }
        let id = message::Id::parse(text(args, "event_id")?)?;
        if matches!(name, "move" | "archive") {
            imap::source(&imap::destinations(c).await?, &id.mailbox)?;
        }
        imap::select(c, &id).await?;
        match name {
            "thread" => {
                let fetch = imap::fetch(c, id.uid, true).await?;
                message::context(fetch.body().ok_or("mail_body_missing")?)
            }
            "move" => self.move_mail(c, &id, text(args, "destination")?).await,
            "archive" => self.archive(c, &id).await,
            "label" => self.label(c, id.uid, text(args, "label")?).await,
            "mark_read" => {
                c.uid_store(id.uid.to_string(), "+FLAGS.SILENT (\\Seen)")
                    .await
                    .map_err(|_| "mail_store_failed")?
                    .try_collect::<Vec<_>>()
                    .await
                    .map_err(|_| "mail_store_failed")?;
                Ok(json!({"ok":true}))
            }
            "draft_reply" => self.draft(c, &id, text(args, "body")?).await,
            "unsubscribe" => {
                self.unsubscribe(c, &id, super::outward::unsubscribe_target(args)?)
                    .await
            }
            _ => Err("mail_tool_unknown"),
        }
    }
    async fn archive(&self, c: &mut imap::Connection, id: &message::Id) -> Result<Value> {
        let destinations = imap::destinations(c).await?;
        let caps = c
            .capabilities()
            .await
            .map_err(|_| "mail_capability_failed")?;
        if caps.has_str("X-GM-EXT-1") {
            // Gmail archive changes label membership, not the destination mailbox.
            self.remember(c, id).await?;
            c.run_command_and_check_ok(format!("UID STORE {} -X-GM-LABELS (\\Inbox)", id.uid))
                .await
                .map_err(|_| "mail_archive_failed")?;
            Ok(json!({"ok":true}))
        } else {
            self.move_mail(c, id, &imap::role(&destinations, "archive")?)
                .await
        }
    }
    async fn remember(&self, c: &mut imap::Connection, id: &message::Id) -> Result<()> {
        if id.mailbox.eq_ignore_ascii_case("INBOX") {
            let fetch = imap::fetch(c, id.uid, false).await?;
            let parsed = message::parse(fetch.header().ok_or("mail_headers_missing")?)?;
            if let Some(message_id) = parsed.message_id() {
                self.state
                    .lock()
                    .await
                    .remember(&self.config.data, message::normalize(message_id))
                    .await?;
            }
        }
        Ok(())
    }
    async fn move_mail(
        &self,
        c: &mut imap::Connection,
        id: &message::Id,
        destination: &str,
    ) -> Result<Value> {
        let destinations = imap::destinations(c).await?;
        imap::destination(&destinations, destination)?;
        if id.mailbox == destination {
            return Ok(json!({"ok":true}));
        }
        let caps = c
            .capabilities()
            .await
            .map_err(|_| "mail_capability_failed")?;
        if !caps.has_str("MOVE") && !caps.has_str("UIDPLUS") {
            return Err("mail_safe_move_unavailable");
        }
        // Durable intent precedes mutation so a fast user return cannot race the record.
        self.remember(c, id).await?;
        let uid = id.uid.to_string();
        if caps.has_str("MOVE") {
            c.uid_mv(&uid, destination)
                .await
                .map_err(|_| "mail_move_failed")?;
        } else {
            c.uid_copy(&uid, destination)
                .await
                .map_err(|_| "mail_copy_failed")?;
            // The sole deletion flag path completes exactly the UID that was copied.
            c.uid_store(&uid, "+FLAGS.SILENT (\\Deleted)")
                .await
                .map_err(|_| "mail_move_failed")?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|_| "mail_move_failed")?;
            c.uid_expunge(&uid)
                .await
                .map_err(|_| "mail_move_failed")?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|_| "mail_move_failed")?;
        }
        Ok(json!({"ok":true}))
    }
    async fn label(&self, c: &mut imap::Connection, uid: u32, label: &str) -> Result<Value> {
        let caps = c
            .capabilities()
            .await
            .map_err(|_| "mail_capability_failed")?;
        if caps.has_str("X-GM-EXT-1") {
            let destinations = imap::destinations(c).await?;
            imap::destination(&destinations, label)?;
            let quoted = quote(label)?;
            c.run_command_and_check_ok(format!("UID STORE {uid} +X-GM-LABELS ({quoted})"))
                .await
                .map_err(|_| "mail_label_failed")?;
        } else {
            // A keyword is an IMAP atom, never a system flag or protocol fragment.
            if label.is_empty()
                || label.starts_with('$')
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.$".contains(&b))
            {
                return Err("mail_label_invalid");
            }
            c.uid_store(uid.to_string(), format!("+FLAGS.SILENT ({label})"))
                .await
                .map_err(|_| "mail_label_failed")?
                .try_collect::<Vec<_>>()
                .await
                .map_err(|_| "mail_label_failed")?;
        }
        Ok(json!({"ok":true}))
    }
    async fn search(&self, c: &mut imap::Connection, args: &Value) -> Result<Value> {
        let query = text(args, "query")?;
        if query.contains(['\r', '\n', '\0']) {
            return Err("mail_query_invalid");
        }
        let limit = args["limit"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 1000)
            .ok_or("mail_limit_invalid")?;
        let inbox = c.examine("INBOX").await.map_err(|_| "mail_select_failed")?;
        let validity = inbox.uid_validity.ok_or("mail_uidvalidity_missing")?;
        let mut uids = c
            .uid_search(query)
            .await
            .map_err(|_| "mail_search_failed")?
            .into_iter()
            .collect::<Vec<_>>();
        uids.sort_unstable_by(|a, b| b.cmp(a));
        let total = uids.len();
        let mut events = Vec::new();
        for uid in uids
            .into_iter()
            .take(usize::try_from(limit).map_err(|_| "mail_limit_invalid")?)
        {
            let fetch = imap::fetch(c, uid, false).await?;
            events.push(message::event(
                &fetch,
                &message::Id {
                    mailbox: "INBOX".into(),
                    validity,
                    uid,
                },
                &self.config.address,
            )?);
        }
        Ok(json!({"events":events,"total":total}))
    }
}
pub(super) fn quote(value: &str) -> Result<String> {
    if value.contains(['\r', '\n', '\0']) {
        return Err("mail_argument_invalid");
    }
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}
