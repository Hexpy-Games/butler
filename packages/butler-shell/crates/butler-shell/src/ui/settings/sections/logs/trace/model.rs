//! The trace and its step tree (`traceApi.ts` `TraceView`, `traceModel.ts`).
use std::collections::{HashMap, HashSet};

use butler_ds::ui::blocks::disclosure_row::Attention;
use serde::Deserialize;
use serde_json::{Map, Value};

/// One span of GET /logs/trace; parents precede their children.
#[derive(Clone, Deserialize)]
pub(super) struct TraceSpan {
    pub(super) span_id: String,
    #[serde(default)]
    pub(super) parent_span_id: Option<String>,
    pub(super) name: String,
    #[serde(default)]
    pub(super) category: String,
    #[serde(default)]
    pub(super) start_offset_ms: f64,
    /// None while the span is still running.
    #[serde(default)]
    pub(super) duration_ms: Option<f64>,
    #[serde(default)]
    pub(super) status: String,
    /// The tone the agent's span record names (`trace.rs` `tone`).
    #[serde(default)]
    pub(super) tone: String,
    #[serde(default)]
    pub(super) title: String,
    #[serde(default)]
    pub(super) attrs: Option<Map<String, Value>>,
}

impl TraceSpan {
    /// The attribute `key` when it is a string.
    pub(super) fn text(&self, key: &str) -> Option<&str> {
        self.attrs.as_ref()?.get(key)?.as_str()
    }
}

#[derive(Deserialize)]
pub(super) struct TraceView {
    pub(super) trace_id: String,
    #[serde(default)]
    pub(super) started_at: Option<String>,
    #[serde(default)]
    pub(super) duration_ms: f64,
    #[serde(default)]
    pub(super) outcome: String,
    #[serde(default)]
    pub(super) model: Option<String>,
    #[serde(default)]
    pub(super) chat_id: Option<String>,
    #[serde(default)]
    pub(super) turn_id: Option<String>,
    #[serde(default)]
    pub(super) spans: Vec<TraceSpan>,
    #[serde(default)]
    pub(super) truncated: bool,
}

/// A span placed in the step tree, in display order (each parent before its subtree).
pub(super) struct Step {
    pub(super) span: TraceSpan,
    pub(super) depth: u32,
    pub(super) parent: Option<usize>,
    pub(super) children: Vec<usize>,
    pub(super) offset: f64,
    /// A running span reaches to the end of the trace.
    pub(super) duration: f64,
    pub(super) running: bool,
    /// The request record a received request (http.server) logged: shown in this step's
    /// details, not as a row.
    pub(super) exchange: Option<TraceSpan>,
}

/// The access record of a request the App sent the agent: part of its http.server span.
fn is_received_exchange(span: &TraceSpan) -> bool {
    span.name == "http.request" && span.category == "http.server"
}

/// `traceTotal`
pub(super) fn total(trace: &TraceView) -> f64 {
    trace
        .spans
        .iter()
        .map(|span| span.start_offset_ms + span.duration_ms.unwrap_or(0.))
        .fold(trace.duration_ms.max(0.), f64::max)
}

struct Builder<'a> {
    kids: HashMap<Option<&'a str>, Vec<&'a TraceSpan>>,
    total: f64,
    out: Vec<Step>,
}

impl<'a> Builder<'a> {
    fn place(&mut self, span: &'a TraceSpan, parent: Option<usize>) {
        let index = self.out.len();
        let offset = span.start_offset_ms.max(0.);
        let running = span.duration_ms.is_none();
        self.out.push(Step {
            span: span.clone(),
            depth: parent.map_or(0, |parent| self.out[parent].depth + 1),
            parent,
            children: Vec::new(),
            offset,
            duration: if running {
                (self.total - offset).max(0.)
            } else {
                span.duration_ms.unwrap_or(0.).max(0.)
            },
            running,
            exchange: None,
        });
        if let Some(parent) = parent {
            self.out[parent].children.push(index);
        }
        let children = self
            .kids
            .get(&Some(span.span_id.as_str()))
            .cloned()
            .unwrap_or_default();
        for child in children {
            let leaf = self
                .kids
                .get(&Some(child.span_id.as_str()))
                .is_none_or(Vec::is_empty);
            if is_received_exchange(child) && self.out[index].exchange.is_none() && leaf {
                self.out[index].exchange = Some(child.clone());
            } else {
                self.place(child, Some(index));
            }
        }
    }
}

/// `traceSteps`: roots by start, each followed by its children by start.
pub(super) fn steps(trace: &TraceView) -> Vec<Step> {
    let ids: HashSet<&str> = trace
        .spans
        .iter()
        .map(|span| span.span_id.as_str())
        .collect();
    let mut kids: HashMap<Option<&str>, Vec<&TraceSpan>> = HashMap::new();
    for span in &trace.spans {
        let parent = span
            .parent_span_id
            .as_deref()
            .filter(|parent| ids.contains(parent));
        kids.entry(parent).or_default().push(span);
    }
    for list in kids.values_mut() {
        list.sort_by(|a, b| a.start_offset_ms.total_cmp(&b.start_offset_ms));
    }
    let roots = kids.get(&None).cloned().unwrap_or_default();
    let mut builder = Builder {
        kids,
        total: total(trace),
        out: Vec::new(),
    };
    for root in roots {
        builder.place(root, None);
    }
    builder.out
}

/// `initialOpen`: each root, and down a single-child chain until the first row with several
/// children; then the first error (the innermost one) with every row above it.
pub(super) fn initial_open(steps: &[Step]) -> HashSet<usize> {
    let mut open = HashSet::new();
    for (root, _) in steps
        .iter()
        .enumerate()
        .filter(|(_, step)| step.parent.is_none())
    {
        let mut at = root;
        while let [first, rest @ ..] = steps[at].children.as_slice() {
            open.insert(at);
            if !rest.is_empty() {
                break;
            }
            at = *first;
        }
    }
    let mut at = first_error(steps);
    while let Some(index) = at {
        open.insert(index);
        at = steps[index].parent;
    }
    open
}

fn first_error(steps: &[Step]) -> Option<usize> {
    let failed = |step: &Step| step.span.status == "error";
    steps
        .iter()
        .position(|step| failed(step) && !step.children.iter().any(|child| failed(&steps[*child])))
}

/// `visibleSteps`: the steps whose every ancestor is open.
pub(super) fn visible(steps: &[Step], open: &HashSet<usize>) -> Vec<usize> {
    (0..steps.len())
        .filter(|index| {
            let mut parent = steps[*index].parent;
            while let Some(at) = parent {
                if !open.contains(&at) {
                    return false;
                }
                parent = steps[at].parent;
            }
            true
        })
        .collect()
}

/// `retryCount`
pub(super) fn retry_count(steps: &[Step]) -> usize {
    steps
        .iter()
        .filter(|step| step.span.name == "retry.wait")
        .count()
}

/// `stepAttention`
pub(super) fn attention(step: &Step) -> Option<Attention> {
    match step.span.status.as_str() {
        "error" => Some(Attention::Error),
        "wait" | "warn" => Some(Attention::Warning),
        _ => None,
    }
}

/// `isHttpStep`: its own request, or the received request it folded in.
pub(super) fn is_http(step: &Step) -> bool {
    step.span.name == "http.request" || step.exchange.is_some()
}

/// `httpSpan`: the span that carries the step's HTTP attributes.
pub(super) fn http_span(step: &Step) -> &TraceSpan {
    step.exchange.as_ref().unwrap_or(&step.span)
}
