//! Offline Brave responses scoped to the active run.
use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

#[derive(Default)]
struct Run {
    case: String,
    calls: BTreeMap<String, usize>,
}
pub(crate) struct Search {
    pub base: String,
    state: Arc<Mutex<Run>>,
    server: tokio::task::JoinHandle<()>,
}
impl Search {
    pub(crate) async fn start() -> Result<Self, HarnessError> {
        let socket = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let base = format!("http://{}/search", socket.local_addr()?);
        let state = Arc::new(Mutex::new(Run::default()));
        let app = Router::new()
            .route("/search", get(search))
            .with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(socket, app).await.unwrap();
        });
        Ok(Self {
            base,
            state,
            server,
        })
    }
    pub(crate) fn activate(&self, case: &str) {
        *self.state.lock().unwrap() = Run {
            case: case.into(),
            calls: BTreeMap::new(),
        };
    }
}
impl Drop for Search {
    fn drop(&mut self) {
        self.server.abort();
    }
}
async fn search(
    State(state): State<Arc<Mutex<Run>>>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Json<Value> {
    let q = query
        .get("q")
        .map(String::as_str)
        .unwrap_or("")
        .to_lowercase();
    let mut run = state.lock().unwrap();
    let results = results(&mut run, &q);
    Json(json!({"web":{"results":results}}))
}
fn row(title: &str, url: &str, description: &str) -> Value {
    json!({"title":title,"url":url,"description":description})
}
fn pricing() -> Value {
    row(
        "Pricing | Lumora Cloud",
        "https://lumora.test/pricing",
        "Lumora Cloud plans: Starter, Team from $29 per user, Business.",
    )
}
fn hexlo(run: &mut Run) -> Vec<Value> {
    let n = run.calls.entry("hexlo".into()).or_default();
    *n += 1;
    let releases = row(
        "Releases · Hexlo",
        "https://hexlo.test/releases",
        "Hexlo release notes and downloads.",
    );
    if *n == 1 {
        vec![
            releases,
            row(
                "Hexlo 2.3 is out — devnotes",
                "https://blog.devnotes.test/hexlo-2-3",
                "Hexlo 2.3.0 released on 2026-03-02 with faster indexing.",
            ),
        ]
    } else {
        let description = if run.case == "W3N" {
            "hexlo latest stable 2.6.1, published 2026-09-28. Pre-release 2.7.0-rc.1 (2026-10-09)."
        } else {
            "hexlo package versions and release dates."
        };
        let package = row(
            "hexlo — pkgindex",
            "https://pkgindex.test/p/hexlo",
            description,
        );
        if run.case == "W3N" {
            vec![package]
        } else {
            vec![package, releases]
        }
    }
}
fn results(run: &mut Run, q: &str) -> Vec<Value> {
    match run.case.as_str() {
        "W2" => vec![
            row(
                "Scheduled maintenance — Corvel Status",
                "https://status.corvel.test/notices/maintenance",
                "Upcoming scheduled maintenance for Corvel services.",
            ),
            row(
                "Maintenance archive — Corvel Status",
                "https://status.corvel.test/notices/archive",
                "Past maintenance windows.",
            ),
        ],
        "W3" | "W3N" | "W3D" | "C4" => hexlo(run),
        "D1" => vendors(run, q),
        "L1" if q.contains("tandem") => vec![row(
            "Tandem Drive pricing",
            "https://tandem.test/pricing",
            "Plans for Tandem Drive.",
        )],
        "L1" => vec![
            row(
                "Quillo Sync is now Tandem Drive",
                "https://blog.quillo.test/renamed",
                "Quillo Sync has a new name.",
            ),
            row(
                "Quillo Sync review (2024)",
                "https://reviews.test/quillo-sync-2024",
                "Team plan at $9 per user per month.",
            ),
        ],
        "P1" => rate_limits(q),
        "C1" => vec![row(
            "Uptime — Corvel Status",
            "https://status.corvel.test/uptime",
            "Corvel service uptime history.",
        )],
        "C2" => vec![row(
            "Billing | Lumora Cloud",
            "https://lumora.test/account/billing",
            "View invoices and usage for your Lumora Cloud account.",
        )],
        "C5" => vec![
            pricing(),
            row(
                "Enterprise quote | Lumora Cloud",
                "https://lumora.test/enterprise/quote",
                "Request a quote for Lumora Cloud Enterprise.",
            ),
        ],
        _ => vec![pricing()],
    }
}
fn vendors(run: &mut Run, q: &str) -> Vec<Value> {
    let named = [
        q.contains("lumora") || q.contains("루모라"),
        q.contains("corvel") || q.contains("코벨"),
        q.contains("hexlo") || q.contains("헥슬로"),
    ];
    let union = named.iter().filter(|v| **v).count() != 1;
    let mut rows = Vec::new();
    if union || named[0] {
        rows.push(row(
            "Pricing | Lumora Cloud",
            "https://lumora.test/pricing",
            "Lumora Cloud plans: Free plan with 5 projects, Starter, Team, Business.",
        ));
    }
    if union || named[1] {
        rows.push(row(
            "Plans — Corvel",
            "https://corvel.test/pricing",
            "Corvel plans. Free: 5,000 requests per month.",
        ));
    }
    if union || named[2] {
        let n = run.calls.entry("hexlo".into()).or_default();
        *n += 1;
        if *n == 1 || union {
            rows.extend([
                row(
                    "Hexlo Cloud pricing",
                    "https://hexlo.test/pricing",
                    "Hexlo Cloud plans and limits.",
                ),
                row(
                    "Hexlo free tier review — devnotes",
                    "https://blog.devnotes.test/hexlo-free",
                    "The Hexlo free tier offers 2 GB of storage.",
                ),
            ]);
        } else {
            rows.push(row(
                "Hexlo Cloud plans (mirror)",
                "https://docs.hexlo-mirror.test/plans",
                "Mirror of Hexlo Cloud plan limits.",
            ));
        }
    }
    rows
}
fn rate_limits(q: &str) -> Vec<Value> {
    let lumora = q.contains("lumora");
    let corvel = q.contains("corvel");
    let mut rows = Vec::new();
    if lumora || !corvel {
        rows.push(row(
            "API rate limits | Lumora Cloud docs",
            "https://lumora.test/docs/rate-limits",
            "Lumora API: up to 600 requests per minute.",
        ));
    }
    if corvel || !lumora {
        rows.push(row(
            "Rate limits — Corvel docs",
            "https://corvel.test/docs/limits",
            "Corvel API rate limits by plan.",
        ));
    }
    rows
}
