use super::{FakeButlerCloud, failure, pending, timestamp};
use axum::{
    Json,
    extract::ws::{CloseFrame, Message},
    http::{Method, StatusCode, header::RETRY_AFTER},
    response::{IntoResponse, Response},
};
use chrono::{Days, SecondsFormat, Utc};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::{MutexGuard, PoisonError},
};
use tokio::sync::mpsc::UnboundedSender;

mod ops;
use ops::{StoredEntity, decide};

#[derive(Default)]
pub(super) struct Canon {
    pub(super) spaces: HashMap<String, Space>,
    memberships: HashMap<String, Vec<String>>,
    invite_spaces: HashMap<String, String>,
    latest_invites: HashMap<String, String>,
    held: HashSet<String>,
}

#[derive(Default)]
pub(super) struct Space {
    info: Value,
    members: Vec<Value>,
    invites: Vec<(String, Value)>,
    entities: HashMap<String, StoredEntity>,
    log: VecDeque<Value>,
    accepted: HashMap<String, Value>,
    head: u64,
    frozen: HashMap<String, u64>,
    pub(super) sockets: Vec<(String, UnboundedSender<Message>)>,
}

impl FakeButlerCloud {
    pub fn invite_token(&self, email: &str) -> Option<String> {
        self.canon().latest_invites.get(email).cloned()
    }

    pub fn pause_delivery(&self, email: &str, pause: bool) {
        for space in self.canon().spaces.values_mut() {
            if pause {
                space.frozen.insert(email.to_owned(), space.head);
            } else {
                space.frozen.remove(email);
                space.sockets.retain(|(recipient, socket)| {
                    if recipient != email {
                        return !socket.is_closed();
                    }
                    let _ = socket.send(Message::Close(Some(CloseFrame {
                        code: 1001,
                        reason: "going away".into(),
                    })));
                    false
                });
            }
        }
    }

    pub fn prune_ops(&self) {
        for space in self.canon().spaces.values_mut() {
            space.log.clear();
            space.accepted.clear();
        }
    }

    pub fn hold_ops(&self, email: &str, hold: bool) {
        let mut canon = self.canon();
        if hold {
            canon.held.insert(email.to_owned());
        } else {
            canon.held.remove(email);
        }
    }

    pub fn ops(&self, space: &str) -> Vec<Value> {
        self.canon().spaces[space].log.iter().cloned().collect()
    }

    pub fn inject_op(&self, space: &str, mut record: Value) {
        if let Some(space) = self.canon().spaces.get_mut(space) {
            record["seq"] = json!(space.head + 1);
            space.append(record.clone());
            space.deliver(&[record]);
        }
    }

    fn canon(&self) -> MutexGuard<'_, Canon> {
        self.state
            .canon
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

impl Canon {
    pub(super) fn route(
        &mut self,
        method: Method,
        path: &str,
        query: Option<&str>,
        account: &Value,
        device: &Value,
        body: &[u8],
    ) -> Response {
        let account_id = account["id"].as_str().unwrap_or_default();
        let email = account["email"].as_str().unwrap_or_default();
        let input = || serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
        match (&method, path) {
            (&Method::POST, "spaces") => return self.create_space(account_id, email, &input()),
            (&Method::GET, "spaces") => {
                let spaces: Vec<_> = self
                    .memberships
                    .get(account_id)
                    .into_iter()
                    .flatten()
                    .map(|id| self.spaces[id].view(account_id))
                    .collect();
                return Json(json!({"spaces": spaces})).into_response();
            }
            (&Method::POST, "invites/accept") => {
                return self.accept_invite(account_id, email, &input());
            }
            _ => {}
        }
        let Some((id, resource)) = path
            .strip_prefix("spaces/")
            .and_then(|path| path.split_once('/'))
        else {
            return failure(StatusCode::NOT_FOUND, "not_found");
        };
        let Some(space) = self.spaces.get_mut(id) else {
            return failure(StatusCode::NOT_FOUND, "not_found");
        };
        let Some(role) = space.role(account_id).map(str::to_owned) else {
            return failure(StatusCode::NOT_FOUND, "not_found");
        };
        match (method, resource) {
            (Method::GET, "members") => {
                let now = timestamp();
                let invites: Vec<_> = space
                    .invites
                    .iter()
                    .filter(|(_, invite)| role == "owner" && pending(invite, &now))
                    .map(|(_, invite)| &invite["view"])
                    .collect();
                Json(json!({"members": space.members, "invites": invites})).into_response()
            }
            (Method::PATCH, path) if path.starts_with("members/") => {
                space.set_role(&role, &path["members/".len()..], &input())
            }
            (Method::POST, "invites") => {
                let n = self.invite_spaces.len();
                let token = format!("bci_fake{n}");
                let input = input();
                let email = input["email"]
                    .as_str()
                    .unwrap_or_default()
                    .trim()
                    .to_lowercase();
                let response = space.invite(&role, &input, &email, &token, n);
                if response.status() == StatusCode::CREATED {
                    self.invite_spaces.insert(token.clone(), id.to_owned());
                    self.latest_invites.insert(email, token);
                }
                response
            }
            (Method::POST, "ops") if self.held.contains(email) => (
                [(RETRY_AFTER, "1")],
                failure(StatusCode::SERVICE_UNAVAILABLE, "canon_capacity"),
            )
                .into_response(),
            (Method::POST, "ops") if role == "viewer" => {
                failure(StatusCode::FORBIDDEN, "canon_forbidden")
            }
            (Method::POST, "ops") => space.apply_ops(&account["id"], &device["id"], body),
            (Method::GET, "ops") => space.pull(email, query.unwrap_or_default()),
            (Method::GET, "snapshot") => {
                let entities: Vec<_> = space.entities.values().map(|row| &row.entity).collect();
                Json(json!({"head_seq": space.head, "entities": entities})).into_response()
            }
            _ => failure(StatusCode::NOT_FOUND, "not_found"),
        }
    }

    fn create_space(&mut self, owner: &str, email: &str, input: &Value) -> Response {
        let name = input["name"].as_str().unwrap_or_default().trim();
        if !(1..=100).contains(&name.encode_utf16().count()) {
            return failure(StatusCode::BAD_REQUEST, "invalid_request");
        }
        let id = format!("cs_{:026}", self.spaces.len() + 1);
        let created_at = timestamp();
        let info = json!({"id": id, "name": name, "owner_account_id": owner, "created_at": created_at, "role": "owner"});
        let member =
            json!({"account_id": owner, "email": email, "role": "owner", "added_at": created_at});
        self.spaces.insert(
            id.clone(),
            Space {
                info: info.clone(),
                members: vec![member],
                ..Space::default()
            },
        );
        self.memberships
            .entry(owner.to_owned())
            .or_default()
            .push(id);
        (StatusCode::CREATED, Json(json!({"space": info}))).into_response()
    }

    fn accept_invite(&mut self, account: &str, email: &str, input: &Value) -> Response {
        let token = input["token"].as_str().unwrap_or_default();
        let now = timestamp();
        let Some(id) = self.invite_spaces.get(token) else {
            return failure(StatusCode::NOT_FOUND, "invite_invalid");
        };
        let Some(space) = self.spaces.get_mut(id) else {
            return failure(StatusCode::NOT_FOUND, "invite_invalid");
        };
        let Some((_, invite)) = space
            .invites
            .iter_mut()
            .find(|(candidate, invite)| candidate == token && pending(invite, &now))
        else {
            return failure(StatusCode::NOT_FOUND, "invite_invalid");
        };
        if invite["view"]["email"] != email {
            return failure(StatusCode::FORBIDDEN, "invite_email_mismatch");
        }
        let role = invite["view"]["role"].clone();
        invite["active"] = json!(false);
        if space.role(account).is_none() {
            space.members.push(
                json!({"account_id": account, "email": email, "role": role, "added_at": now}),
            );
            self.memberships
                .entry(account.to_owned())
                .or_default()
                .push(id.clone());
        }
        Json(json!({"space": space.view(account)})).into_response()
    }
}

impl Space {
    pub(super) fn role(&self, account: &str) -> Option<&str> {
        self.members
            .iter()
            .find(|member| member["account_id"] == account)?["role"]
            .as_str()
    }

    fn view(&self, account: &str) -> Value {
        let mut view = self.info.clone();
        view["role"] = json!(self.role(account));
        view
    }

    fn invite(
        &mut self,
        role: &str,
        input: &Value,
        email: &str,
        token: &str,
        n: usize,
    ) -> Response {
        if role != "owner" {
            return failure(StatusCode::FORBIDDEN, "canon_forbidden");
        }
        let role = input["role"].as_str().unwrap_or_default();
        if email.is_empty()
            || !matches!(role, "editor" | "viewer")
            || self.members.iter().any(|member| member["email"] == email)
        {
            return failure(StatusCode::BAD_REQUEST, "invalid_request");
        }
        for (_, invite) in &mut self.invites {
            if invite["view"]["email"] == email {
                invite["active"] = json!(false);
            }
        }
        let expires = (Utc::now() + Days::new(7)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let view = json!({"id": format!("ci_{n:026}"), "email": email, "role": role, "expires_at": expires});
        self.invites
            .push((token.to_owned(), json!({"view": view, "active": true})));
        (StatusCode::CREATED, Json(json!({"invite": view}))).into_response()
    }

    fn set_role(&mut self, role: &str, account: &str, input: &Value) -> Response {
        if role != "owner" {
            return failure(StatusCode::FORBIDDEN, "canon_forbidden");
        }
        let role = input["role"].as_str().unwrap_or_default();
        if !matches!(role, "editor" | "viewer") || self.info["owner_account_id"] == account {
            return failure(StatusCode::BAD_REQUEST, "invalid_request");
        }
        let Some(member) = self
            .members
            .iter_mut()
            .find(|member| member["account_id"] == account)
        else {
            return failure(StatusCode::NOT_FOUND, "not_found");
        };
        member["role"] = json!(role);
        Json(json!({"member": {"account_id": account, "role": role}})).into_response()
    }

    fn apply_ops(&mut self, account: &Value, device: &Value, body: &[u8]) -> Response {
        let ops = match ops::validate(body) {
            Ok(ops) => ops,
            Err((status, code)) => return failure(status, code),
        };
        let now = Utc::now().timestamp_millis();
        let mut records = Vec::new();
        let mut results = Vec::new();
        for op in ops {
            if let Some(result) = self.accepted.get(&op.op_id) {
                results.push(result.clone());
                continue;
            }
            let Some((revision, fields)) = decide(&mut self.entities, &op) else {
                let current = self.entities.get(&op.entity_id).map(|row| &row.entity);
                results.push(json!({"op_id": op.op_id, "status": "rejected", "current": current}));
                continue;
            };
            let record = json!({"seq": self.head + 1, "op_id": op.op_id, "entity_id": op.entity_id,
                "kind": op.kind, "action": op.action, "revision": revision, "fields": fields,
                "account_id": account, "device_id": device, "created_at": now});
            results.push(self.append(record.clone()));
            records.push(record);
        }
        if !records.is_empty() {
            self.deliver(&records);
        }
        Json(json!({"results": results})).into_response()
    }

    fn append(&mut self, record: Value) -> Value {
        self.head += 1;
        let id = record["op_id"].as_str().unwrap_or_default();
        let result = json!({"op_id": id, "status": "accepted", "seq": self.head, "revision": record["revision"]});
        self.accepted.insert(id.to_owned(), result.clone());
        self.log.push_back(record);
        result
    }

    fn pull(&self, email: &str, query: &str) -> Response {
        let query: BTreeMap<_, _> = url::form_urlencoded::parse(query.as_bytes()).collect();
        let after = query
            .get("after")
            .map_or(Ok(0), |after| after.parse::<u64>());
        let limit = query
            .get("limit")
            .map_or(Ok(500), |limit| limit.parse::<usize>());
        let (Ok(after), Ok(limit @ 1..=1000)) = (after, limit) else {
            return failure(StatusCode::BAD_REQUEST, "invalid_request");
        };
        let frozen = self.frozen.get(email).copied();
        let head = frozen.unwrap_or(self.head);
        let oldest = self.log.front().and_then(|op| op["seq"].as_u64());
        if frozen.is_none() && after < head && oldest.is_none_or(|seq| seq > after + 1) {
            return Json(json!({"resync": true, "head_seq": head})).into_response();
        }
        let start = self
            .log
            .partition_point(|op| op["seq"].as_u64().unwrap_or_default() <= after);
        let mut ops: Vec<_> = self
            .log
            .range(start..)
            .take_while(|op| op["seq"].as_u64().unwrap_or_default() <= head)
            .take(limit + 1)
            .collect();
        let more = frozen.is_none() && ops.len() > limit;
        ops.truncate(limit);
        Json(json!({"ops": ops, "head_seq": head, "more": more})).into_response()
    }

    fn deliver(&mut self, records: &[Value]) {
        let frame = Message::Text(json!({"type": "ops", "ops": records}).to_string().into());
        self.sockets.retain(|(email, socket)| {
            if self.frozen.contains_key(email) {
                !socket.is_closed()
            } else {
                socket.send(frame.clone()).is_ok()
            }
        });
    }
}
