//! The App executor's page scripts, composed the same way for headless tabs.
//!
//! The modules under `packages/butler-app/client/electron/browser/page/` are
//! the single source: perception, the walker, reading text, refs, point hits
//! and focus. Their functions run in Butler's isolated world with the
//! perception helpers installed as globals, exactly as `snapshot.mjs` does.
use serde_json::Value;
use std::sync::LazyLock;

const PERCEPTION: &str =
    include_str!("../../../../../../../butler-app/client/electron/browser/page/perception.mjs");
const WALK: &str =
    include_str!("../../../../../../../butler-app/client/electron/browser/page/walk.mjs");
const TEXT: &str =
    include_str!("../../../../../../../butler-app/client/electron/browser/page/text.mjs");
const REFS: &str =
    include_str!("../../../../../../../butler-app/client/electron/browser/page/refs.mjs");
const POINT: &str =
    include_str!("../../../../../../../butler-app/client/electron/browser/page/point.mjs");
const FOCUS: &str =
    include_str!("../../../../../../../butler-app/client/electron/browser/page/focus.mjs");

pub(crate) struct Scripts {
    implementation: String,
    helpers: Vec<String>,
    resolve_ref: String,
    select_value: String,
    point_hit: String,
    focus_target: String,
}

/// An ES module as plain declarations: imports dropped, `export` removed.
fn declarations(module: &str) -> String {
    module
        .lines()
        .filter(|line| !line.starts_with("import "))
        .map(|line| line.strip_prefix("export ").unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One top-level function's source, from `function name(` to its closing brace.
fn function(module: &str, name: &str) -> Option<String> {
    let body = declarations(module);
    let start = body.find(&format!("function {name}("))?;
    let end = body[start..].find("\n}")? + start + 2;
    Some(body[start..end].to_owned())
}

static SCRIPTS: LazyLock<Option<Scripts>> = LazyLock::new(|| {
    let helpers = PERCEPTION
        .lines()
        .filter_map(|line| line.strip_prefix("export function "))
        .filter_map(|rest| rest.split('(').next())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if helpers.is_empty() {
        return None;
    }
    Some(Scripts {
        implementation: [PERCEPTION, WALK, TEXT, REFS]
            .iter()
            .map(|module| declarations(module))
            .collect::<Vec<_>>()
            .join("\n"),
        helpers,
        resolve_ref: function(REFS, "resolveRef")?,
        select_value: function(REFS, "selectValue")?,
        point_hit: function(POINT, "pointHit")?,
        focus_target: function(FOCUS, "focusTarget")?,
    })
});

pub(crate) fn scripts() -> Option<&'static Scripts> {
    SCRIPTS.as_ref()
}

impl Scripts {
    /// `perceptionSource(options)`: installs the helpers once per source
    /// change and returns the snapshot of this frame.
    pub(crate) fn perception(&self, options: &Value) -> String {
        let source = Value::String(self.implementation.clone()).to_string();
        format!(
            "(() => {{
    const source = {source};
    if (globalThis.__butlerPerceptionImplementation?.source !== source) {{
      {implementation}
      Object.assign(globalThis, {{ {helpers} }});
      for (const index of globalThis.__butlerPerceptionImplementation?.indexes?.values() ?? []) index.observer.disconnect();
      globalThis.__butlerPerceptionImplementation = {{ source, snapshot, indexes: new Map(), targetIds: new WeakMap(), nextTargetId: 0 }};
    }}
    return globalThis.__butlerPerceptionImplementation.snapshot({options});
  }})()",
            implementation = self.implementation,
            helpers = self.helpers.join(", "),
        )
    }
    pub(crate) fn resolve(&self, input: &Value) -> String {
        format!("({})({input})", self.resolve_ref)
    }
    pub(crate) fn select(&self, input: &Value) -> String {
        format!("({})({input})", self.select_value)
    }
    pub(crate) fn point(&self, input: &Value) -> String {
        format!("({})({input})", self.point_hit)
    }
    pub(crate) fn focus(&self, input: &Value) -> String {
        format!("({})({input})", self.focus_target)
    }
}
