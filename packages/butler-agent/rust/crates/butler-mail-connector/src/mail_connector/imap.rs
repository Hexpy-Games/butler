use super::{Config, Result, transport};
use async_imap::{Client, Session, types::Fetch};
use futures_util::TryStreamExt;
use serde_json::{Value, json};
pub(super) type Connection = Session<transport::Socket>;

pub(super) async fn connect(config: &Config) -> Result<Connection> {
    let socket = transport::connect(&config.imap).await?;
    let mut client = Client::new(socket);
    client
        .read_response()
        .await
        .map_err(|_| "mail_greeting_failed")?
        .ok_or("mail_greeting_failed")?;
    if config.imap.security == "starttls" {
        client
            .run_command_and_check_ok("STARTTLS", None)
            .await
            .map_err(|_| "mail_starttls_failed")?;
        client = Client::new(transport::tls(client.into_inner(), &config.imap.host).await?);
    }
    match client.login(&config.username, &config.password).await {
        Ok(connection) => Ok(connection),
        Err((async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_), _)) => {
            Err("mail_auth_failed")
        }
        Err(_) => Err("mail_login_failed"),
    }
}
pub(super) async fn destinations(connection: &mut Connection) -> Result<Vec<Value>> {
    let caps = connection
        .capabilities()
        .await
        .map_err(|_| "mail_capability_failed")?;
    let roles_known = caps.has_str("SPECIAL-USE");
    let pattern = if roles_known {
        "\"*\" RETURN (SPECIAL-USE)"
    } else {
        "\"*\""
    };
    let names: Vec<_> = connection
        .list(Some(""), Some(pattern))
        .await
        .map_err(|_| "mail_list_failed")?
        .try_collect()
        .await
        .map_err(|_| "mail_list_failed")?;
    // Some servers include RFC 6154 attributes in ordinary LIST responses
    // without advertising SPECIAL-USE. Only protocol attributes establish roles.
    let roles_known = roles_known
        || names.iter().any(|name| {
            name.attributes().iter().any(|attr| {
                use async_imap::types::NameAttribute;
                matches!(
                    attr,
                    NameAttribute::All
                        | NameAttribute::Archive
                        | NameAttribute::Drafts
                        | NameAttribute::Flagged
                        | NameAttribute::Junk
                        | NameAttribute::Sent
                        | NameAttribute::Trash
                )
            })
        });
    Ok(names
        .iter()
        .map(|name| {
            let mut roles = Vec::new();
            if name.name().eq_ignore_ascii_case("INBOX") {
                roles.push("inbox");
            }
            for attr in name.attributes() {
                use async_imap::types::NameAttribute;
                let role = match attr {
                    NameAttribute::Trash => Some("trash"),
                    NameAttribute::Junk => Some("junk"),
                    NameAttribute::Archive => Some("archive"),
                    NameAttribute::Sent => Some("sent"),
                    NameAttribute::Drafts => Some("drafts"),
                    NameAttribute::All => Some("all"),
                    NameAttribute::Flagged => Some("flagged"),
                    _ => None,
                };
                if let Some(role) = role {
                    roles.push(role);
                }
            }
            json!({"id":name.name(),"name":name.name(),"roles":roles,"roles_known":roles_known})
        })
        .collect())
}
pub(super) async fn fetch(connection: &mut Connection, uid: u32, full: bool) -> Result<Fetch> {
    let query = if full {
        "(UID INTERNALDATE BODY.PEEK[])"
    } else {
        "(UID INTERNALDATE BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.65536>)"
    };
    let mut stream = connection
        .uid_fetch(uid.to_string(), query)
        .await
        .map_err(|_| "mail_fetch_failed")?;
    let item = stream
        .try_next()
        .await
        .map_err(|_| "mail_fetch_failed")?
        .ok_or("mail_message_missing")?;
    while stream
        .try_next()
        .await
        .map_err(|_| "mail_fetch_failed")?
        .is_some()
    {}
    Ok(item)
}
pub(super) async fn select(connection: &mut Connection, id: &super::message::Id) -> Result<()> {
    let mailbox = connection
        .select(&id.mailbox)
        .await
        .map_err(|_| "mail_select_failed")?;
    if mailbox.uid_validity != Some(id.validity) {
        return Err("mail_event_expired");
    }
    fetch(connection, id.uid, false).await?;
    Ok(())
}
pub(super) fn destination<'a>(destinations: &'a [Value], id: &str) -> Result<&'a Value> {
    let found = destinations
        .iter()
        .find(|d| d["id"] == id)
        .ok_or("mail_destination_missing")?;
    if found["roles_known"] != true
        || found["roles"].as_array().is_none_or(|roles| {
            roles
                .iter()
                .any(|r| r == "trash" || r == "junk" || r == "all")
        })
    {
        return Err("mail_destination_refused");
    }
    Ok(found)
}
pub(super) fn role(destinations: &[Value], role: &str) -> Result<String> {
    destinations
        .iter()
        .find(|d| {
            d["roles"]
                .as_array()
                .is_some_and(|r| r.iter().any(|v| v == role))
        })
        .and_then(|d| d["id"].as_str())
        .map(str::to_owned)
        .ok_or("mail_destination_missing")
}

pub(super) fn source(destinations: &[Value], id: &str) -> Result<()> {
    let found = destinations
        .iter()
        .find(|d| d["id"] == id)
        .ok_or("mail_source_refused")?;
    if found["roles_known"] != true
        || found["roles"].as_array().is_none_or(|roles| {
            roles
                .iter()
                .any(|r| r == "all" || r == "trash" || r == "junk")
        })
    {
        return Err("mail_source_refused");
    }
    Ok(())
}

pub(super) async fn inbox(connection: &mut Connection) -> Result<async_imap::types::Mailbox> {
    let caps = connection
        .capabilities()
        .await
        .map_err(|_| "mail_capability_failed")?;
    if !caps.has_str("IDLE") {
        return Err("mail_idle_unsupported");
    }
    let inbox = connection
        .select("INBOX")
        .await
        .map_err(|error| match error {
            async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_) => {
                "mail_server_unsupported"
            }
            _ => "mail_select_failed",
        })?;
    if inbox.uid_validity.is_none() || inbox.uid_next.is_none() {
        return Err("mail_server_unsupported");
    }
    Ok(inbox)
}
