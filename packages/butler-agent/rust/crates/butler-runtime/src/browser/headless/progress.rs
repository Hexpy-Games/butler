//! What the last batch did to the page, stated plainly so the model can change
//! approach (the App executor's `progress.mjs`): fields it cleared, a batch
//! that repeats an earlier one with the same outcome, no effect at all, or new
//! options right after typing. Notes carry refs and ids, never page text.
use super::js::{js_string, round};
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};

const HISTORY: usize = 12;
const GRID: f64 = 8.0;
const REMEMBERED: usize = 50;

struct Entry {
    obs: String,
    fingerprint: String,
    thumb: Option<Vec<u8>>,
    values: IndexMap<String, (Value, Value)>,
    refs: Vec<String>,
    field_refs: HashSet<String>,
    targets: HashMap<String, String>,
}

struct Step {
    action: String,
    reference: Option<String>,
    point: bool,
    identity: String,
    completed: bool,
}

struct Batch {
    from: String,
    steps: Vec<Step>,
}

#[derive(Default)]
pub(crate) struct Progress {
    history: VecDeque<Entry>,
    last_batch: Option<Batch>,
    no_progress: IndexMap<String, (String, String)>,
    refused: IndexMap<String, Value>,
}

/// The observation a progress note compares.
pub(crate) struct Current<'a> {
    pub obs: &'a str,
    pub url: &'a str,
    pub nodes: &'a [Value],
    pub fields: &'a [Value],
    pub thumb: Option<Vec<u8>>,
}

fn field_key(field: &Value) -> String {
    format!(
        "{}:{}",
        js_string(&field["position"]),
        js_string(&field["name"])
    )
}

fn entry(current: Current<'_>) -> Entry {
    let actionable: Vec<&Value> = current
        .nodes
        .iter()
        .filter(|n| n["actionable"] == true)
        .collect();
    let mut labels: Vec<String> = actionable
        .iter()
        .map(|n| format!("{} {}", js_string(&n["role"]), js_string(&n["name"])))
        .collect();
    labels.sort();
    let mut parts = vec![current.url.to_owned()];
    parts.extend(
        current
            .fields
            .iter()
            .map(|f| format!("{}={}", field_key(f), js_string(&f["value"]))),
    );
    parts.extend(labels);
    Entry {
        obs: current.obs.to_owned(),
        fingerprint: parts.join("\n"),
        thumb: current.thumb,
        values: current
            .fields
            .iter()
            .map(|f| (field_key(f), (f["ref"].clone(), f["value"].clone())))
            .collect(),
        refs: actionable.iter().map(|n| js_string(&n["ref"])).collect(),
        field_refs: current
            .fields
            .iter()
            .map(|f| js_string(&f["ref"]))
            .collect(),
        targets: current
            .nodes
            .iter()
            .map(|n| {
                (
                    js_string(&n["ref"]),
                    format!("{} {}", js_string(&n["role"]), js_string(&n["name"])),
                )
            })
            .collect(),
    }
}

fn grid(point: &Value) -> String {
    point.as_array().map_or_else(String::new, |values| {
        values
            .iter()
            .map(|v| js_string(&json!(round(v.as_f64().unwrap_or(f64::NAN) / GRID))))
            .collect::<Vec<_>>()
            .join(",")
    })
}

/// The element a step reaches (role and name, whatever ref or point named
/// it), its value, and its points on a coarse grid.
fn identity(step: &Value, hit: &Value) -> String {
    let path = step["path"].as_array().map_or_else(String::new, |p| {
        p.iter().map(grid).collect::<Vec<_>>().join(";")
    });
    [
        js_string(&step["action"]),
        format!("{} {}", js_string(&hit["role"]), js_string(&hit["name"])),
        js_string(&step["value"]),
        grid(&step["point"]),
        grid(&step["target_point"]),
        path,
    ]
    .join("|")
}

fn bounded<V>(map: &mut IndexMap<String, V>, key: String, value: V) {
    map.insert(key, value);
    if map.len() > REMEMBERED {
        map.shift_remove_index(0);
    }
}

impl Progress {
    /// Records the batch so the next observation can compare against its start.
    pub(crate) fn record_batch(&mut self, args: &Value, results: &[Value]) {
        let steps = args["steps"].as_array().map_or(&[][..], Vec::as_slice);
        self.last_batch = Some(Batch {
            from: js_string(&args["observation"]),
            steps: steps
                .iter()
                .enumerate()
                .map(|(i, step)| {
                    let result = results.get(i).unwrap_or(&Value::Null);
                    Step {
                        action: js_string(&step["action"]),
                        reference: step["ref"].as_str().map(str::to_owned),
                        point: !step["point"].is_null(),
                        identity: identity(step, &result["hit"]),
                        completed: result["status"] == "completed",
                    }
                })
                .collect(),
        });
    }

    /// Refuses, before anything is dispatched, a batch that starts with steps
    /// that already ran from this same page state and made no progress.
    pub(crate) fn repeat_refusal(&self, args: &Value, prepared: &[Value]) -> Option<Value> {
        let state = self.history.back()?;
        if args["observation"] != state.obs.as_str() || self.no_progress.is_empty() {
            return None;
        }
        let steps = args["steps"].as_array()?;
        let identities: Vec<String> = steps
            .iter()
            .enumerate()
            .map(|(i, step)| {
                identity(
                    step,
                    &prepared.get(i).map_or(Value::Null, |p| p["hit"].clone()),
                )
            })
            .collect();
        for length in 1..=identities.len() {
            let key = std::iter::once(state.fingerprint.clone())
                .chain(identities[..length].iter().cloned())
                .collect::<Vec<_>>()
                .join("\n");
            let Some((obs, what)) = self.no_progress.get(&key) else {
                continue;
            };
            let scope = if length == identities.len() {
                "This same batch".to_owned()
            } else {
                format!(
                    "The first {length} step{} of this batch",
                    if length == 1 { "" } else { "s" }
                )
            };
            return Some(
                json!({"status":"refused","reason":"repeated_no_progress","previous_result":obs,"step_index":0,
                "recovery":format!("{scope} already ran from this same page state and {what} (see {obs}). Nothing was run again. Use a different control or approach; re-observe if the page should have changed. No steps were dispatched.")}),
            );
        }
        None
    }

    fn refusal_key(&self, args: &Value) -> Option<String> {
        let state = self.history.back()?;
        (args["observation"] == state.obs.as_str())
            .then(|| format!("{}\n{}", state.fingerprint, args["steps"]))
    }

    /// Records a refusal so an unchanged resend from the same state is answered at once.
    pub(crate) fn remember_refusal(&mut self, args: &Value, refusal: Value) -> Value {
        if refusal["status"] == "refused"
            && let Some(key) = self.refusal_key(args)
        {
            let seen = json!({"reason":refusal["reason"],"step_index":refusal["step_index"],"hit":refusal["hit"],"rejected_point":refusal["rejected_point"]});
            bounded(&mut self.refused, key, seen);
        }
        refusal
    }

    /// Refuses an unchanged resend of a batch refused from this same page state.
    pub(crate) fn resent_refusal(&self, args: &Value) -> Option<Value> {
        let last = self.refused.get(&self.refusal_key(args)?)?;
        let step = last["step_index"].as_u64().unwrap_or(0);
        let hit = if last["hit"]["role"].is_string() {
            let at = if last["rejected_point"].is_null() {
                String::new()
            } else {
                format!(" at [{}]", js_string(&last["rejected_point"]))
            };
            format!(
                " it hit {} \"{}\"{at}",
                js_string(&last["hit"]["role"]),
                js_string(&last["hit"]["name"])
            )
        } else {
            " see that result".to_owned()
        };
        Some(
            json!({"status":"refused","reason":"repeated_refusal","previous_reason":last["reason"],"step_index":step,"hit":last["hit"],
            "recovery":format!("This exact batch was already refused from this same page state ({} at step {step};{hit}). Sending it unchanged gives the same result. Pick a different point or target: move the point off what it hit (for a drag on a canvas, onto empty canvas shown in the screenshot), use the hit's ref if that is the intended control, or dismiss what covers the target first. No steps were dispatched.", js_string(&last["reason"]))}),
        )
    }

    /// Compares a fresh observation with the one the last batch started from.
    pub(crate) fn note(&mut self, current: Current<'_>) -> Option<Value> {
        let next = entry(current);
        let batch = self.last_batch.take();
        self.history.push_back(next);
        if self.history.len() > HISTORY {
            self.history.pop_front();
        }
        let length = self.history.len();
        let batch = batch?;
        let previous = self.history.get(length.checked_sub(2)?)?;
        if batch.from != previous.obs || !batch.steps.iter().any(|s| s.completed) {
            return None;
        }
        let notes = self.outcomes(&batch);
        let since = self.history.get(length - 2)?.obs.clone();
        (!notes.is_empty()).then(|| json!({"since":since,"notes":notes}))
    }

    fn outcomes(&mut self, batch: &Batch) -> Vec<String> {
        let length = self.history.len();
        let (Some(previous), Some(entry)) =
            (self.history.get(length - 2), self.history.get(length - 1))
        else {
            return Vec::new();
        };
        let mut notes = Vec::new();
        let mut remembered = Vec::new();
        let lost = cleared(previous, entry, batch);
        if !lost.is_empty() {
            let earlier = self
                .history
                .iter()
                .take(length.saturating_sub(2))
                .rev()
                .find(|old| old.fingerprint == entry.fingerprint);
            let back = earlier.map_or_else(String::new, |old| {
                format!("; the page is back to its state at {}", old.obs)
            });
            notes.push(format!("The last batch cleared field {}, which had a value before{back}. Unless clearing was intended, this undid progress; use a different control instead.", lost.join(", ")));
            remembered.push(format!("cleared field {}", lost.join(", ")));
        }
        if entry.fingerprint == previous.fingerprint
            && same_pixels(previous.thumb.as_deref(), entry.thumb.as_deref())
            && dom_only(previous, batch)
        {
            notes.push("The last batch changed nothing visible: no URL, field, control or pixel changed. Try a different control or approach instead of repeating it.".to_owned());
            remembered.push("changed nothing visible".to_owned());
        }
        if let Some(options) = suggestions(previous, entry, batch) {
            notes.push(options);
        }
        if batch.steps.iter().all(|s| s.completed) {
            let key = std::iter::once(previous.fingerprint.clone())
                .chain(batch.steps.iter().map(|s| s.identity.clone()))
                .collect::<Vec<_>>()
                .join("\n");
            let obs = entry.obs.clone();
            for what in remembered {
                bounded(&mut self.no_progress, key.clone(), (obs.clone(), what));
            }
        }
        notes
    }
}

fn cleared(previous: &Entry, entry: &Entry, batch: &Batch) -> Vec<String> {
    let filled: HashSet<&str> = batch
        .steps
        .iter()
        .filter(|s| s.completed && matches!(s.action.as_str(), "fill" | "type"))
        .filter_map(|s| s.reference.as_deref())
        .collect();
    previous
        .values
        .iter()
        .filter(|(key, (reference, value))| {
            truthy(value)
                && entry.values.get(*key).is_some_and(|(_, now)| now == "")
                && !filled.contains(js_string(reference).as_str())
        })
        .map(|(key, (before, _))| {
            let now = entry
                .values
                .get(key)
                .map_or(Value::Null, |(r, _)| r.clone());
            let reference = if now.is_null() { before } else { &now };
            format!(
                "{} [{}]",
                key.split(':').next().unwrap_or(""),
                js_string(reference)
            )
        })
        .collect()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::String(s) => !s.is_empty(),
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}

/// Only DOM-visible inputs can be judged by the DOM; pixels on a canvas cannot.
fn dom_only(previous: &Entry, batch: &Batch) -> bool {
    batch.steps.iter().all(|s| {
        s.reference.as_ref().is_some_and(|r| {
            !previous
                .targets
                .get(r)
                .is_some_and(|t| t.starts_with("canvas "))
        }) && !s.point
            && matches!(s.action.as_str(), "click" | "fill" | "select")
    })
}

/// Pixels decide when both observations carry a thumbnail.
fn same_pixels(before: Option<&[u8]>, after: Option<&[u8]>) -> bool {
    let (Some(before), Some(after)) = (before, after) else {
        return true;
    };
    if before.len() != after.len() {
        return true;
    }
    let mut changed = 0;
    for (a, b) in before
        .as_chunks::<4>()
        .0
        .iter()
        .zip(after.as_chunks::<4>().0)
    {
        let delta: i32 = (0..3)
            .map(|i| (i32::from(a[i]) - i32::from(b[i])).abs())
            .sum();
        if delta > 60 {
            changed += 1;
            if changed >= 3 {
                return false;
            }
        }
    }
    true
}

fn suggestions(previous: &Entry, entry: &Entry, batch: &Batch) -> Option<String> {
    let last = batch.steps.iter().rev().find(|s| s.completed)?;
    if !matches!(last.action.as_str(), "fill" | "type") {
        return None;
    }
    let known: HashSet<&String> = previous.refs.iter().collect();
    let appeared: Vec<&String> = entry
        .refs
        .iter()
        .filter(|r| !known.contains(r) && !entry.field_refs.contains(*r))
        .collect();
    if appeared.len() < 2 {
        return None;
    }
    let field = last
        .reference
        .as_ref()
        .map_or_else(String::new, |r| format!(" into [{r}]"));
    let shown: Vec<&str> = appeared.iter().take(12).map(|r| r.as_str()).collect();
    let more = if appeared.len() > 12 { ", …" } else { "" };
    Some(format!(
        "{} new clickable options appeared right after typing{field}: {}{more}. Typed text alone may not commit a choice; select the option that matches, then check the field.",
        appeared.len(),
        shown.join(", ")
    ))
}
