//! `/setup/canon-online` actions. Each request reads the signed-in identity
//! once and passes its token to every cloud call it makes.
use super::*;
use butler_canon::store::Context;
use reqwest::Method;

use crate::host::app::canon::error as storage_error;
use crate::host::app::runtime_ports::{CloudIdentity, signed_out};

fn public(status: u16, code: &str, message: &str) -> GatewayApplicationError {
    GatewayApplicationError::Public {
        status,
        code: code.into(),
        message: message.into(),
        source: None,
    }
}
fn not_linked() -> GatewayApplicationError {
    public(
        404,
        "canon_online_not_linked",
        "This project is not online.",
    )
}
fn already_linked() -> GatewayApplicationError {
    public(
        409,
        "canon_online_linked",
        "This project is already online.",
    )
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
/// Accepts `expected` or 404 (already gone on the server).
fn gone_ok(result: Result<Value, GatewayApplicationError>) -> Result<(), GatewayApplicationError> {
    match result {
        Ok(_) | Err(GatewayApplicationError::Public { status: 404, .. }) => Ok(()),
        Err(error) => Err(error),
    }
}

pub(super) async fn handle(
    online: &CanonOnline,
    request: CanonOnlineRequest,
) -> Result<Value, GatewayApplicationError> {
    if let CanonOnlineRequest::Status = request {
        let links = online
            .storage
            .canon_read(sync::links)
            .await
            .map_err(storage_error)?;
        let links: Vec<Value> = links.iter().map(|link| online.view(link)).collect();
        return Ok(json!({"links": links}));
    }
    let id = online.account.identity().await?.ok_or_else(signed_out)?;
    let account = &online.account;
    match request {
        CanonOnlineRequest::Spaces => {
            let mut value = account
                .canon(&id.token, Method::GET, "/spaces", None, 200)
                .await?;
            let links = online
                .storage
                .canon_read(sync::links)
                .await
                .map_err(storage_error)?;
            for space in value["spaces"].as_array_mut().into_iter().flatten() {
                let link = links.iter().find(|link| link["space_id"] == space["id"]);
                space["project_id"] = link.map_or(Value::Null, |link| link["project_id"].clone());
            }
            Ok(value)
        }
        CanonOnlineRequest::Link { project_id, name } => link(online, &id, project_id, name).await,
        CanonOnlineRequest::Join { project_id, token } => {
            join(online, &id, project_id, token).await
        }
        CanonOnlineRequest::Unlink { project_id } => unlink(online, &id, project_id).await,
        CanonOnlineRequest::Leave { project_id } => {
            let space = linked(online, &project_id).await?;
            let member = format!("{}/members/{}", path(&space), encode(&id.account_id));
            gone_ok(
                account
                    .canon(&id.token, Method::DELETE, &member, None, 204)
                    .await,
            )?;
            forget(online, project_id).await?;
            Ok(json!({"left": true}))
        }
        request => member_request(online, &id.token, request).await,
    }
}

/// Members, invites and roles: passthrough calls on a linked project's space.
async fn member_request(
    online: &CanonOnline,
    token: &str,
    request: CanonOnlineRequest,
) -> Result<Value, GatewayApplicationError> {
    let account = &online.account;
    match request {
        CanonOnlineRequest::Members { project_id } => {
            let space = path(&linked(online, &project_id).await?);
            account
                .canon(token, Method::GET, &format!("{space}/members"), None, 200)
                .await
        }
        CanonOnlineRequest::Invite {
            project_id,
            email,
            role,
        } => {
            let space = path(&linked(online, &project_id).await?);
            let body = json!({"email": email, "role": role});
            account
                .canon(
                    token,
                    Method::POST,
                    &format!("{space}/invites"),
                    Some(body),
                    201,
                )
                .await
        }
        CanonOnlineRequest::RevokeInvite {
            project_id,
            invite_id,
        } => {
            let space = path(&linked(online, &project_id).await?);
            let invite = format!("{space}/invites/{}", encode(&invite_id));
            account
                .canon(token, Method::DELETE, &invite, None, 204)
                .await?;
            Ok(json!({"revoked": true}))
        }
        CanonOnlineRequest::SetRole {
            project_id,
            account_id,
            role,
        } => {
            let space = path(&linked(online, &project_id).await?);
            let member = format!("{space}/members/{}", encode(&account_id));
            account
                .canon(
                    token,
                    Method::PATCH,
                    &member,
                    Some(json!({"role": role})),
                    200,
                )
                .await
        }
        CanonOnlineRequest::RemoveMember {
            project_id,
            account_id,
        } => {
            let space = path(&linked(online, &project_id).await?);
            let member = format!("{space}/members/{}", encode(&account_id));
            account
                .canon(token, Method::DELETE, &member, None, 204)
                .await?;
            Ok(json!({"removed": true}))
        }
        _ => Err(GatewayApplicationError::internal()),
    }
}

async fn link_row(
    online: &CanonOnline,
    project: &str,
) -> Result<Option<Value>, GatewayApplicationError> {
    let project = project.to_owned();
    online
        .storage
        .canon_read(move |db| sync::link_by_project(db, &project))
        .await
        .map_err(storage_error)
}
/// The space id of a linked project, else 404 `canon_online_not_linked`.
async fn linked(online: &CanonOnline, project: &str) -> Result<String, GatewayApplicationError> {
    link_row(online, project)
        .await?
        .and_then(|link| link["space_id"].as_str().map(str::to_owned))
        .ok_or_else(not_linked)
}
/// The link view of one project, with its pending count.
async fn view(online: &CanonOnline, project: &str) -> Result<Value, GatewayApplicationError> {
    let links = online
        .storage
        .canon_read(sync::links)
        .await
        .map_err(storage_error)?;
    let link = links
        .iter()
        .find(|link| link["project_id"] == project)
        .ok_or_else(not_linked)?;
    Ok(json!({"link": online.view(link)}))
}
async fn forget(online: &CanonOnline, project: String) -> Result<(), GatewayApplicationError> {
    online
        .storage
        .canon_write(move |tx| sync::unlink(tx, &project))
        .await
        .map_err(storage_error)?;
    online.poke();
    Ok(())
}

async fn link(
    online: &CanonOnline,
    id: &CloudIdentity,
    project: String,
    name: String,
) -> Result<Value, GatewayApplicationError> {
    if link_row(online, &project).await?.is_some() {
        return Err(already_linked());
    }
    let created = online
        .account
        .canon(
            &id.token,
            Method::POST,
            "/spaces",
            Some(json!({"name": name})),
            201,
        )
        .await?;
    let space = created["space"]["id"]
        .as_str()
        .ok_or_else(GatewayApplicationError::internal)?
        .to_owned();
    let ctx = Context {
        now: now(),
        actor: json!({"person": id.account_id, "via": "app"}),
    };
    let (target, space_id, account_id) = (project.clone(), space.clone(), id.account_id.clone());
    let linked = online
        .storage
        .canon_write(move |tx| sync::link(tx, &ctx, &target, &space_id, &account_id))
        .await;
    if let Err(error) = linked {
        let _ = online
            .account
            .canon(&id.token, Method::DELETE, &path(&space), None, 204)
            .await;
        return Err(storage_error(error));
    }
    online.poke();
    view(online, &project).await
}

async fn join(
    online: &CanonOnline,
    id: &CloudIdentity,
    project: String,
    invite: String,
) -> Result<Value, GatewayApplicationError> {
    let account = &online.account;
    let email = account.email(&id.token).await?;
    let target = project.clone();
    let used = online
        .storage
        .canon_read(move |db| {
            Ok(sync::link_by_project(db, &target)?.is_some() || sync::project_used(db, &target)?)
        })
        .await
        .map_err(storage_error)?;
    if used {
        return Err(public(
            409,
            "canon_online_project_not_empty",
            "Join into a new, empty project.",
        ));
    }
    let accepted = account
        .canon(
            &id.token,
            Method::POST,
            "/invites/accept",
            Some(json!({"token": invite})),
            200,
        )
        .await?;
    let space = accepted["space"].clone();
    let space_id = space["id"]
        .as_str()
        .ok_or_else(GatewayApplicationError::internal)?
        .to_owned();
    let lookup = space_id.clone();
    if online
        .storage
        .canon_read(move |db| sync::link_by_space(db, &lookup))
        .await
        .map_err(storage_error)?
        .is_some()
    {
        return Err(already_linked());
    }
    let snapshot = account
        .canon(
            &id.token,
            Method::GET,
            &format!("{}/snapshot", path(&space_id)),
            None,
            200,
        )
        .await?;
    let me = Context {
        now: now(),
        actor: json!({"person": email, "via": "sync", "account": id.account_id, "device": id.device_id}),
    };
    let (target, account_id) = (project.clone(), id.account_id.clone());
    let role = space["role"].as_str().unwrap_or("viewer").to_owned();
    let skipped = online
        .storage
        .canon_write(move |tx| {
            sync::join(tx, &me, &target, &space_id, &account_id, &role, &snapshot)
        })
        .await
        .map_err(storage_error)?;
    if !skipped.is_empty() {
        tracing::warn!(?skipped, "Canon online join skipped entities");
    }
    online.poke();
    view(online, &project).await
}

async fn unlink(
    online: &CanonOnline,
    id: &CloudIdentity,
    project: String,
) -> Result<Value, GatewayApplicationError> {
    let link = link_row(online, &project).await?.ok_or_else(not_linked)?;
    if link["state"] == "linked" && link["role"] == "owner" {
        if link["account_id"] != id.account_id.as_str() {
            return Err(public(
                409,
                "canon_online_account_mismatch",
                "Sign in with the account that shared this project.",
            ));
        }
        let space = link["space_id"].as_str().unwrap_or_default();
        gone_ok(
            online
                .account
                .canon(&id.token, Method::DELETE, &path(space), None, 204)
                .await,
        )?;
    }
    forget(online, project).await?;
    Ok(json!({"unlinked": true}))
}
