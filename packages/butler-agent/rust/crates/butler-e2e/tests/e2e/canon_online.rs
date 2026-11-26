//! Canon online: two signed-in devices sync one project through the stub cloud.
#![allow(clippy::unwrap_used, clippy::panic, reason = "test assertions")]

use std::time::{Duration, Instant};

use butler_e2e::e2e::{
    HarnessError, fake_butler_cloud::FakeButlerCloud, scenario::Scenario, scenario::Setup,
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};

const A: &str = "a@example.com";
const B: &str = "b@example.com";

struct Device {
    s: Scenario,
    app: AdminClient,
}

/// A Setup with the Butler account on, signed in as `email`.
async fn device(fake: &FakeButlerCloud, name: &str, email: &str) -> Result<Device, HarnessError> {
    let setup = Setup::new(name)?.env("BUTLER_CLOUD_API_URL", &fake.url);
    std::fs::create_dir_all(setup.sandbox.data.join("gateways"))?;
    std::fs::write(
        setup.sandbox.data.join("gateways/app.json"),
        json!({"config": {"butlerAccountEnabled": true}}).to_string(),
    )?;
    let s = setup.start().await?;
    let app = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    for body in [
        json!({"action": "start", "email": email}),
        json!({"action": "verify", "email": email, "code": "123456"}),
    ] {
        let reply = app
            .send(Method::POST, "/setup/butler-account", Some(body), &[])
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
    }
    Ok(Device { s, app })
}
impl Device {
    async fn call(&self, method: Method, path: &str, body: Value, status: u16) -> Value {
        let body = (method != Method::GET).then(|| body.to_string());
        let reply = self.s.gw.send(method, path, body).await.unwrap();
        assert_eq!(reply.status, status, "{path}: {}", reply.text);
        reply.body["data"].clone()
    }
    async fn online(&self, body: Value) -> Value {
        let reply = self
            .app
            .send(Method::POST, "/setup/canon-online", Some(body), &[])
            .await
            .unwrap();
        assert_eq!(reply.status, 200, "{}", reply.text);
        reply.body["data"].clone()
    }
    async fn link(&self, project: &str) -> Value {
        let reply = self
            .app
            .send(Method::GET, "/setup/canon-online", None, &[])
            .await
            .unwrap();
        let links = reply.body["data"]["links"].as_array().unwrap().clone();
        links
            .into_iter()
            .find(|link| link["project_id"] == project)
            .unwrap()
    }
    async fn project(&self, name: &str) -> String {
        let body = json!({"source": "scratch", "display_name": name});
        let data = self.call(Method::POST, "/projects", body, 201).await;
        data["project"]["id"].as_str().unwrap().to_owned()
    }
    async fn create(&self, project: &str, what: &str, body: Value) -> String {
        let path = format!("/projects/{project}/canon/{what}");
        let data = self.call(Method::POST, &path, body, 201).await;
        data["id"].as_str().unwrap().to_owned()
    }
    /// `GET /canon/epics/{id}`, or `None` when it is not here.
    async fn epic(&self, id: &str) -> Option<Value> {
        let reply = self.s.gw.get(&format!("/canon/epics/{id}")).await.unwrap();
        (reply.status == 200).then(|| reply.body["data"].clone())
    }
    async fn edit(&self, id: &str, mut body: Value) -> u16 {
        body["expected_revision"] = self.epic(id).await.unwrap()["revision"].clone();
        let path = format!("/canon/epics/{id}");
        let reply = self.s.gw.patch(&path, body).await.unwrap();
        reply.status
    }
    async fn idle(&self, project: &str) {
        eventually("no pending ops", move || async move {
            self.link(project).await["pending"] == 0
        })
        .await;
    }
}

/// Polls `check` every 100 ms for up to 20 s.
async fn eventually<F, Fut>(what: &str, check: F)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(20);
    while !check().await {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
fn has(activity: &Value, kind: &str, body: &str) -> bool {
    activity
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["kind"] == kind && row["body"] == body)
}

/// Field of an epic on a device, or Null when the epic is gone.
async fn field(device: &Device, id: &str, name: &str) -> Value {
    device
        .epic(id)
        .await
        .map_or(Value::Null, |epic| epic[name].clone())
}

#[tokio::test]
async fn canon_online_01_two_devices_converge() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeButlerCloud::start().await?;
    let a = device(&fake, "CANON-ONLINE-01-A", A).await?;
    let b = device(&fake, "CANON-ONLINE-01-B", B).await?;
    let ap = a.project("Team").await;
    let tag = a
        .create(&ap, "tags", json!({"name": "T", "color": "blue"}))
        .await;
    let plan = a.create(&ap, "plans", json!({"title": "P"})).await;
    let body = json!({"title": "t0", "plan_id": plan, "tags": [tag]});
    let epic = a.create(&ap, "epics", body).await;
    let path = format!("/canon/epics/{epic}/comments");
    a.call(Method::POST, &path, json!({"body": "hello"}), 200)
        .await;
    a.online(json!({"action": "link", "project_id": ap, "name": "Team"}))
        .await;
    let invite = json!({"action": "invite", "project_id": ap, "email": B, "role": "editor"});
    a.online(invite).await;
    let bp = b.project("Team").await;
    let token = fake.invite_token(B).unwrap();
    b.online(json!({"action": "join", "project_id": bp, "token": token}))
        .await;
    let (on_b, canon, ids) = (&b, format!("/projects/{bp}/canon"), (&*plan, &*tag, &*epic));
    let canon = canon.as_str();
    eventually("B has the project", move || async move {
        let view = on_b.call(Method::GET, canon, json!({}), 200).await;
        let e = on_b.epic(ids.2).await.unwrap_or_default();
        view["plans"][0]["id"] == ids.0
            && e["plan_id"] == ids.0
            && e["tags"][0]["id"] == ids.1
            && has(&e["activity"], "comment", "hello")
    })
    .await;
    concurrent_edits(&fake, &a, &b, (&ap, &bp), &epic).await;
    let e2 = delete_and_resync(&fake, &a, &b, (&ap, &bp), &epic).await;
    viewer_downgrade(&fake, &a, &b, (&ap, &bp), &e2).await;
    a.s.finish().await?;
    b.s.finish().await
}

/// Steps 5–6: different fields merge; a stale same-field edit is replaced
/// and recorded as a conflict.
async fn concurrent_edits(
    fake: &FakeButlerCloud,
    a: &Device,
    b: &Device,
    (ap, bp): (&str, &str),
    epic: &str,
) {
    a.idle(ap).await;
    b.idle(bp).await;
    fake.pause_delivery(A, true);
    assert_eq!(b.edit(epic, json!({"title": "tB"})).await, 200);
    b.idle(bp).await;
    assert_eq!(a.edit(epic, json!({"description": "dA"})).await, 200);
    a.idle(ap).await;
    fake.pause_delivery(A, false);
    for device in [a, b] {
        eventually("both fields merged", move || async move {
            field(device, epic, "title").await == "tB"
                && field(device, epic, "description").await == "dA"
        })
        .await;
    }
    a.idle(ap).await;
    b.idle(bp).await;
    fake.pause_delivery(A, true);
    assert_eq!(b.edit(epic, json!({"title": "tB2"})).await, 200);
    b.idle(bp).await;
    assert_eq!(a.edit(epic, json!({"title": "tA"})).await, 200);
    let conflict = &json!({"conflict": true, "fields": {"title": "tA"}});
    eventually("A takes the newer title", move || async move {
        let e = a.epic(epic).await.unwrap();
        e["title"] == "tB2"
            && a.link(ap).await["pending"] == 0
            && e["activity"].as_array().unwrap().iter().any(|row| {
                row["kind"] == "edited"
                    && row["body"]
                        .as_str()
                        .and_then(|b| serde_json::from_str(b).ok())
                        == Some(conflict.clone())
            })
    })
    .await;
    assert_eq!(field(b, epic, "title").await, "tB2");
    fake.pause_delivery(A, false);
}

/// Steps 7–8: a remote delete lands; a pruned log makes A resync.
async fn delete_and_resync(
    fake: &FakeButlerCloud,
    a: &Device,
    b: &Device,
    (_ap, bp): (&str, &str),
    epic: &str,
) -> String {
    let revision = b.epic(epic).await.unwrap()["revision"].clone();
    let body = json!({"expected_revision": revision}).to_string();
    let path = format!("/canon/epics/{epic}");
    let reply =
        b.s.gw
            .send(Method::DELETE, &path, Some(body))
            .await
            .unwrap();
    assert_eq!(reply.status, 200, "{}", reply.text);
    eventually("A drops the epic", move || async move {
        a.epic(epic).await.is_none()
    })
    .await;
    fake.pause_delivery(A, true);
    let e2 = b.create(bp, "epics", json!({"title": "E2"})).await;
    b.idle(bp).await;
    fake.prune_ops();
    fake.pause_delivery(A, false);
    let created = e2.as_str();
    eventually("A resyncs", move || async move {
        a.epic(created).await.is_some() && a.epic(epic).await.is_none()
    })
    .await;
    e2
}

/// Step 9: a 403 demotes B to viewer, drops its queue and resyncs it; a role change then reaches a connected B with no write from B.
async fn viewer_downgrade(
    fake: &FakeButlerCloud,
    a: &Device,
    b: &Device,
    (ap, bp): (&str, &str),
    e2: &str,
) {
    a.idle(ap).await;
    b.idle(bp).await;
    fake.hold_ops(B, true);
    assert_eq!(b.edit(e2, json!({"title": "tV"})).await, 200);
    let members = a
        .online(json!({"action": "members", "project_id": ap}))
        .await;
    let member = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == B);
    let account = member.unwrap()["account_id"].clone();
    let role =
        json!({"action": "set_role", "project_id": ap, "account_id": account, "role": "viewer"});
    a.online(role).await;
    fake.hold_ops(B, false);
    let title = &field(a, e2, "title").await;
    eventually("B is a viewer with A's title", move || async move {
        let link = b.link(bp).await;
        link["role"] == "viewer" && link["pending"] == 0 && field(b, e2, "title").await == *title
    })
    .await;
    assert_ne!(*title, "tV");
    let revision = b.epic(e2).await.unwrap()["revision"].clone();
    let body = json!({"expected_revision": revision, "title": "tW"});
    let reply =
        b.s.gw
            .patch(&format!("/canon/epics/{e2}"), body)
            .await
            .unwrap();
    assert_eq!(reply.status, 403, "{}", reply.text);
    assert_eq!(reply.error_code(), Some("permission"));
    let promote =
        json!({"action": "set_role", "project_id": ap, "account_id": account, "role": "editor"});
    a.online(promote).await;
    eventually("B is an editor without writing", move || async move {
        b.link(bp).await["role"] == "editor"
    })
    .await;
    let demote =
        json!({"action": "set_role", "project_id": ap, "account_id": account, "role": "viewer"});
    a.online(demote).await;
    eventually("B is a viewer without writing", move || async move {
        b.link(bp).await["role"] == "viewer"
    })
    .await;
}

#[tokio::test]
async fn canon_online_02_ops_stay_in_their_project() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let fake = FakeButlerCloud::start().await?;
    let a = device(&fake, "CANON-ONLINE-02-A", A).await?;
    let b = device(&fake, "CANON-ONLINE-02-B", B).await?;
    let (px, py) = (a.project("X").await, a.project("Y").await);
    let ex = a.create(&px, "epics", json!({"title": "x0"})).await;
    let ty = a
        .create(&py, "tags", json!({"name": "TY", "color": "red"}))
        .await;
    let ty2 = a
        .create(&py, "tags", json!({"name": "TY2", "color": "blue"}))
        .await;
    let ey = a
        .create(&py, "epics", json!({"title": "y0", "tags": [ty]}))
        .await;
    let path = format!("/canon/epics/{ey}/comments");
    a.call(Method::POST, &path, json!({"body": "keep"}), 200)
        .await;
    let (bx, by) = (b.project("X").await, b.project("Y").await);
    let mut spaces = Vec::new();
    for (project, name, joined) in [(&px, "SX", &bx), (&py, "SY", &by)] {
        let link = a
            .online(json!({"action": "link", "project_id": project, "name": name}))
            .await;
        spaces.push(link["link"]["space_id"].as_str().unwrap().to_owned());
        let invite =
            json!({"action": "invite", "project_id": project, "email": B, "role": "editor"});
        a.online(invite).await;
        let token = fake.invite_token(B).unwrap();
        b.online(json!({"action": "join", "project_id": joined, "token": token}))
            .await;
    }
    for (device, project) in [(&a, &px), (&a, &py), (&b, &bx), (&b, &by)] {
        device.idle(project).await;
    }
    let ops = fake.ops(&spaces[1]);
    let comment = ops.iter().find(|op| op["kind"] == "comment").unwrap()["entity_id"].clone();
    let members = a
        .online(json!({"action": "members", "project_id": px}))
        .await;
    let member = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["email"] == B);
    let account = member.unwrap()["account_id"].clone();
    for (n, entity, kind, action, fields) in [
        (1, comment, "comment", "delete", json!({})),
        (2, json!(ey), "epic", "set", json!({"title": "hijack"})),
        (
            3,
            json!(format!("et_{:026}", 1)),
            "epic_tag",
            "create",
            json!({"epic_id": ey, "tag_id": ty2}),
        ),
    ] {
        fake.inject_op(
            &spaces[0],
            json!({"op_id": format!("{n:026}"), "entity_id": entity,
            "kind": kind, "action": action, "revision": 9, "fields": fields,
            "account_id": account, "device_id": "dev_fake_1", "created_at": 0}),
        );
    }
    // X's own next op lands after the injected ones: A has processed them.
    assert_eq!(b.edit(&ex, json!({"title": "x1"})).await, 200);
    let (on_a, ex_id, ey_id) = (&a, ex.as_str(), ey.as_str());
    eventually("A shows x1", move || async move {
        field(on_a, ex_id, "title").await == "x1"
    })
    .await;
    let shown = a.epic(&ey).await.unwrap();
    assert_eq!(shown["title"], "y0");
    assert!(has(&shown["activity"], "comment", "keep"));
    let tags: Vec<_> = shown["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].clone())
        .collect();
    assert_eq!(tags, vec![json!(ty)]);
    assert_eq!(b.edit(&ey, json!({"title": "y1"})).await, 200);
    eventually("A shows y1", move || async move {
        field(on_a, ey_id, "title").await == "y1"
    })
    .await;
    a.s.finish().await?;
    b.s.finish().await
}
