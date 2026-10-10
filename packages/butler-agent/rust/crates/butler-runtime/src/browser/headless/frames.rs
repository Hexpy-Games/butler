//! Frames of a tab and Butler's isolated world in each (the App executor's
//! `frame-worlds.mjs`). Out-of-process frames are their own CDP targets; a
//! frame's world is created once per document and reused, so refs stay stable.
use super::{js::round, page::Page, state::Frame};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const WORLD: &str = "butler-browser";

impl Page {
    /// Butler's isolated world in `frame` of `session`, created on first use.
    pub(crate) async fn world(&self, session: &str, frame: &str) -> Result<i64, String> {
        let key = (session.to_owned(), frame.to_owned());
        if let Some(id) = self
            .shared
            .with_tab(&self.tab, |t| t.contexts.get(&key).copied())
            .flatten()
        {
            return Ok(id);
        }
        let created = self
            .send_to(
                session,
                "Page.createIsolatedWorld",
                json!({"frameId":frame,"worldName":WORLD}),
            )
            .await?;
        let id = created["executionContextId"]
            .as_i64()
            .ok_or("frame_unavailable")?;
        self.shared
            .with_tab(&self.tab, |t| t.contexts.insert(key, id));
        Ok(id)
    }

    /// Every frame, main first, each with its world; closed shadow roots are
    /// exposed inside the world only.
    pub(crate) async fn frame_worlds(&self) -> Result<Vec<Frame>, String> {
        let root = self.send("Page.getFrameTree", json!({})).await?["frameTree"].take();
        let remote = self
            .shared
            .with_tab(&self.tab, |t| t.frames.clone())
            .unwrap_or_default();
        let mut frames = Vec::new();
        let mut snapshots = HashMap::new();
        let mut stack = vec![(root, None, self.session.clone())];
        let mut visited = HashSet::new();
        while let Some((tree, parent, inherited)) = stack.pop() {
            let id = tree["frame"]["id"].as_str().unwrap_or("").to_owned();
            let session = remote.get(&id).cloned().unwrap_or(inherited);
            let index = self
                .visit(&tree, parent, &session, &mut frames, &mut snapshots)
                .await?;
            visited.insert(id);
            for child in tree["childFrames"].as_array().into_iter().flatten().rev() {
                stack.push((child.clone(), Some(index), session.clone()));
            }
        }
        let mut extra = Vec::new();
        for (id, session) in &remote {
            if !visited.contains(id) {
                extra.push((
                    self.send_to(session, "Page.getFrameTree", json!({}))
                        .await?["frameTree"]
                        .take(),
                    session.clone(),
                ));
            }
        }
        while !extra.is_empty() {
            let before = extra.len();
            let mut index = 0;
            while index < extra.len() {
                let parent_id = extra[index].0["frame"]["parentId"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                if let Some(parent) = frames.iter().position(|f: &Frame| f.id == parent_id) {
                    let (tree, session) = extra.remove(index);
                    let mut stack = vec![(tree, Some(parent), session)];
                    while let Some((tree, parent, session)) = stack.pop() {
                        let at = self
                            .visit(&tree, parent, &session, &mut frames, &mut snapshots)
                            .await?;
                        for child in tree["childFrames"].as_array().into_iter().flatten().rev() {
                            let child_id = child["frame"]["id"].as_str().unwrap_or("");
                            let child_session = remote
                                .get(child_id)
                                .cloned()
                                .unwrap_or_else(|| session.clone());
                            stack.push((child.clone(), Some(at), child_session));
                        }
                    }
                } else {
                    index += 1;
                }
            }
            if extra.len() == before {
                return Err("frame_unavailable".into());
            }
        }
        Ok(frames)
    }

    async fn visit(
        &self,
        tree: &Value,
        parent: Option<usize>,
        session: &str,
        frames: &mut Vec<Frame>,
        snapshots: &mut HashMap<String, Value>,
    ) -> Result<usize, String> {
        let id = tree["frame"]["id"].as_str().unwrap_or("").to_owned();
        let raw = tree["frame"]["url"].as_str().unwrap_or("");
        let url = if matches!(raw, "about:blank" | "about:srcdoc") {
            parent
                .and_then(|p| frames.get(p))
                .map_or_else(|| raw.to_owned(), |p| p.url.clone())
        } else {
            raw.to_owned()
        };
        let context = self.world(session, &id).await?;
        if !snapshots.contains_key(session) {
            let snapshot = self
                .send_to(
                    session,
                    "DOMSnapshot.captureSnapshot",
                    json!({"computedStyles":[]}),
                )
                .await?;
            snapshots.insert(session.to_owned(), snapshot);
        }
        let main = parent.is_none()
            || frames
                .get(parent.unwrap_or(0))
                .is_some_and(|p| p.session != session);
        let roots = closed_roots(snapshots.get(session), &id);
        self.expose_roots(session, context, &id, main, roots)
            .await?;
        frames.push(Frame {
            id,
            url,
            parent,
            session: session.to_owned(),
            context,
        });
        Ok(frames.len() - 1)
    }

    async fn expose_roots(
        &self,
        session: &str,
        context: i64,
        frame: &str,
        main: bool,
        any: bool,
    ) -> Result<(), String> {
        self.evaluate_in(session, context, "globalThis.__butlerClosedRoots = []")
            .await?;
        if !any {
            return Ok(());
        }
        let tree = self
            .send_to(
                session,
                "DOM.getDocument",
                json!({"depth":-1,"pierce":true}),
            )
            .await?["root"]
            .take();
        let mut roots = Vec::new();
        if let Some(document) = find_document(&tree, frame, main) {
            collect_closed(document, &mut roots);
        }
        for backend in roots {
            let resolved = self
                .send_to(
                    session,
                    "DOM.resolveNode",
                    json!({"backendNodeId":backend,"executionContextId":context}),
                )
                .await?;
            if let Some(object) = resolved["object"]["objectId"].as_str() {
                self.send_to(session, "Runtime.callFunctionOn", json!({"objectId":object,
                    "functionDeclaration":"function(){ globalThis.__butlerClosedRoots.push(this); }"}))
                    .await?;
                let _ = self
                    .send_to(session, "Runtime.releaseObject", json!({"objectId":object}))
                    .await;
            }
        }
        Ok(())
    }

    /// Evaluates `code` in `frame`'s world; any page exception is `frame_unavailable`.
    pub(crate) async fn evaluate(&self, frame: &Frame, code: &str) -> Result<Value, String> {
        self.evaluate_in(&frame.session, frame.context, code).await
    }

    pub(crate) async fn evaluate_in(
        &self,
        session: &str,
        context: i64,
        code: &str,
    ) -> Result<Value, String> {
        let mut result = self
            .send_to(session, "Runtime.evaluate", json!({"expression":code,"contextId":context,"returnByValue":true,"awaitPromise":true}))
            .await?;
        if result.get("exceptionDetails").is_some() {
            return Err("frame_unavailable".into());
        }
        Ok(result["result"]["value"].take())
    }

    /// A frame-local point in the main viewport's coordinates.
    pub(crate) async fn frame_point(
        &self,
        frames: &[Frame],
        index: usize,
        point: (f64, f64),
    ) -> Result<(f64, f64), String> {
        let mut current = index;
        let mut local = point;
        loop {
            let frame = frames.get(current).ok_or("frame_unavailable")?;
            let Some(parent) = frame.parent else {
                return Ok(local);
            };
            let parent_frame = frames.get(parent).ok_or("frame_unavailable")?;
            let owner = self
                .send_to(
                    &parent_frame.session,
                    "DOM.getFrameOwner",
                    json!({"frameId":frame.id}),
                )
                .await?;
            let model = self
                .send_to(
                    &parent_frame.session,
                    "DOM.getBoxModel",
                    json!({"backendNodeId":owner["backendNodeId"]}),
                )
                .await?;
            let content = &model["model"]["content"];
            local = (
                local.0 + content[0].as_f64().unwrap_or(0.0),
                local.1 + content[1].as_f64().unwrap_or(0.0),
            );
            // A box is relative to its target's root viewport: continue from that root.
            let mut root = parent;
            while let Some(above) = frames[root].parent
                && frames[above].session == frames[root].session
            {
                root = above;
            }
            if frames[root].parent.is_none() {
                return Ok(local);
            }
            current = root;
        }
    }

    /// Hit-tests inside every renderer target and its embedding iframe. A frame
    /// whose owner has no layout box (a hidden iframe) contains no point.
    pub(crate) async fn hit_frame(
        &self,
        frames: &[Frame],
        index: usize,
        local: (f64, f64),
    ) -> Result<Option<(f64, f64)>, String> {
        match self.hit_frame_checked(frames, index, local).await {
            Ok(point) => Ok(point),
            Err(error)
                if error.contains("box model")
                    || error.contains("frame_unavailable")
                    || error.contains("No node") =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    async fn hit_frame_checked(
        &self,
        frames: &[Frame],
        index: usize,
        local: (f64, f64),
    ) -> Result<Option<(f64, f64)>, String> {
        let point = self.frame_point(frames, index, local).await?;
        let target = frames.get(index).ok_or("frame_unavailable")?;
        let mut current = Some(index);
        let mut owner: Option<Value> = None;
        while let Some(at) = current {
            let mut root = at;
            while let Some(parent) = frames[root].parent
                && frames[parent].session == frames[root].session
            {
                root = parent;
            }
            let origin = self.frame_point(frames, root, (0.0, 0.0)).await?;
            let hit = self
                .send_to(&frames[root].session, "DOM.getNodeForLocation", json!({"x":round(point.0 - origin.0),"y":round(point.1 - origin.1),"includeUserAgentShadowDOM":true}))
                .await?;
            let matched = match &owner {
                Some(owner) => hit["backendNodeId"] == owner["backendNodeId"],
                None => hit["frameId"] == target.id.as_str(),
            };
            if !matched {
                return Ok(None);
            }
            let Some(parent) = frames[root].parent else {
                break;
            };
            owner = Some(
                self.send_to(
                    &frames[parent].session,
                    "DOM.getFrameOwner",
                    json!({"frameId":frames[root].id}),
                )
                .await?,
            );
            current = Some(parent);
        }
        Ok(Some(point))
    }
}

/// Whether the flat snapshot of `frame` reports a closed shadow root.
fn closed_roots(snapshot: Option<&Value>, frame: &str) -> bool {
    let Some(snapshot) = snapshot else {
        return false;
    };
    let strings = snapshot["strings"].as_array();
    let text = |index: &Value| {
        index
            .as_u64()
            .and_then(|i| strings.and_then(|s| s.get(usize::try_from(i).ok()?)))
    };
    snapshot["documents"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|document| {
            text(&document["frameId"]).and_then(Value::as_str) == Some(frame)
                && document["nodes"]["shadowRootType"]["value"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|value| text(value).and_then(Value::as_str) == Some("closed"))
        })
}

fn find_document<'a>(node: &'a Value, frame: &str, main: bool) -> Option<&'a Value> {
    if node["nodeName"] == "#document" && (node["frameId"] == frame || main) {
        return Some(node);
    }
    let children = node["children"].as_array().into_iter().flatten();
    for child in children.chain(node.get("contentDocument")) {
        if let Some(found) = find_document(child, frame, false) {
            return Some(found);
        }
    }
    None
}

fn collect_closed(node: &Value, roots: &mut Vec<Value>) {
    if node["shadowRootType"] == "closed" {
        roots.push(node["backendNodeId"].clone());
    }
    let children = node["children"].as_array().into_iter().flatten();
    for child in children.chain(node["shadowRoots"].as_array().into_iter().flatten()) {
        collect_closed(child, roots);
    }
}
