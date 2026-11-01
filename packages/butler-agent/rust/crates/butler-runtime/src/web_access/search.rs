mod parse;

use std::{collections::HashSet, time::Instant};

use futures_util::{FutureExt, StreamExt};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    evidence,
    planning::{self, PlanningResult, SearchPlan},
    providers::{
        self,
        contracts::{SearchInput, SearchOutput, SearchProvider},
    },
    service::{WebAccessError, WebSession},
};

pub(super) use super::providers::contracts::SearchResult;

const OPEN_RESULTS: &str = "When the Butler browser host is available, open useful results with browser_open {results:[ids]} and read them with browser_observe; otherwise read result URLs with web_read.";
use crate::web_access::WebAccessCode;
pub(super) use parse::{is_duckduckgo_challenge, parse_results};

impl WebSession {
    pub async fn web_search(
        &self,
        args: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, WebAccessError> {
        let total_started = Instant::now();
        let input = search_input(args)?;
        let query = input.query.as_str();
        let coverage_limit = input.requested_max_results.unwrap_or(10);
        let provider = providers::configured(&self.access).await?;
        let planning_started = Instant::now();
        let plan_result = self
            .plan_search(provider.id(), &input, cancellation)
            .await?;
        let planning_ms = planning_started.elapsed().as_millis();
        let search_started = Instant::now();
        if cancellation.is_cancelled() {
            return Err(WebAccessError::cancelled());
        }
        let searched = if let Some(plan) = plan_result.plan.as_ref() {
            execute_planned(self, provider.as_ref(), &input, plan, cancellation).await
        } else {
            provider.search(&self.access, &input, cancellation).await
        };
        let searched = match searched {
            Ok(output) => output,
            Err(error) => {
                self.access
                    .metrics()
                    .record(provider.id(), query, Some(error.code()));
                return Err(error);
            }
        };
        self.access
            .metrics()
            .record(&searched.provider, query, None);
        let search_ms = search_started.elapsed().as_millis();
        let mut result = project_search(
            query,
            coverage_limit,
            searched,
            &plan_result,
            total_started.elapsed().as_millis(),
            planning_ms,
            search_ms,
        );
        self.identify_results(&mut result);
        Ok(result)
    }

    /// Each result gets the id `browser_open` opens it by.
    fn identify_results(&self, result: &mut Value) {
        let Some(items) = result["results"].as_array_mut() else {
            return;
        };
        let pairs = items
            .iter()
            .map(|item| {
                let text = |key: &str| item[key].as_str().unwrap_or("").to_owned();
                (text("url"), text("title"))
            })
            .collect::<Vec<_>>();
        for (item, id) in items.iter_mut().zip(self.result_ids(&pairs)) {
            item["id"] = json!(id);
        }
        if !pairs.is_empty() {
            result["next"] = json!(OPEN_RESULTS);
        }
    }
    async fn plan_search(
        &self,
        provider: &str,
        input: &SearchInput,
        cancellation: &CancellationToken,
    ) -> Result<PlanningResult, WebAccessError> {
        let gate = self.lock_planning().await;
        let first_search = !self.first_search_consumed();
        let plan_result = if first_search {
            match planning::create_plan(
                &self.access,
                input,
                &self.original_request(),
                self.usage_attribution.as_ref(),
                cancellation,
            )
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    self.access
                        .metrics()
                        .record(provider, &input.query, Some(error.code()));
                    return Err(error);
                }
            }
        } else {
            PlanningResult {
                plan: None,
                used_planner: false,
                attempts: 0,
                measurements: Vec::new(),
                fallback_reason: Some(
                    "smart search planning already ran in this turn; direct follow-up search used"
                        .into(),
                ),
            }
        };
        if plan_result.used_planner || plan_result.plan.is_some() {
            self.mark_planner_ran();
        }
        drop(gate);
        Ok(plan_result)
    }
}

fn search_input(args: &Value) -> Result<SearchInput, WebAccessError> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .map(butler_core::public_text::trim_js_whitespace)
        .unwrap_or_default();
    if query.encode_utf16().count() < 2 {
        return Err(WebAccessError::new(
            WebAccessCode::InvalidArguments,
            "web_search requires a query with at least 2 characters.",
        ));
    }
    let allowed = string_array(args.get("allowed_domains"));
    let blocked = string_array(args.get("blocked_domains"));
    if !allowed.is_empty() && !blocked.is_empty() {
        return Err(WebAccessError::new(
            WebAccessCode::InvalidArguments,
            "web_search cannot use allowed_domains and blocked_domains together.",
        ));
    }
    let requested_max_results = optional_number(args.get("max_results"), 1, 10);
    let max_results = requested_max_results.unwrap_or(5);
    let recency_days = optional_number(args.get("recency_days"), 1, usize::MAX);
    Ok(SearchInput {
        query: query.to_owned(),
        allowed_domains: allowed,
        blocked_domains: blocked,
        max_results,
        requested_max_results,
        recency_days: recency_days.map(|days| days as u64),
    })
}

fn project_results(results: &[SearchResult]) -> Vec<Value> {
    results
        .iter()
        .map(|result| {
            let mut value = json!({
                "title":result.title,
                "url":result.url,
                "snippet":result.snippet,
                "source":result.source,
            });
            if let Some(published_at) = &result.published_at {
                value["published_at"] = json!(published_at);
            }
            value
        })
        .collect::<Vec<_>>()
}

fn project_plan(plan_result: &PlanningResult, query: &str) -> Value {
    plan_result
        .plan
        .as_ref()
        .map(planning::compact)
        .unwrap_or_else(|| {
            json!({
                "mode":"direct",
                "planner_used":plan_result.used_planner,
                "planner_attempts":plan_result.attempts,
                "fallback_reason":plan_result.fallback_reason,
                "original_query":query,
            })
        })
}

fn project_search(
    query: &str,
    coverage_limit: usize,
    searched: SearchOutput,
    plan_result: &PlanningResult,
    total_ms: u128,
    planning_ms: u128,
    search_ms: u128,
) -> Value {
    let results = searched.results;
    let observed_at = evidence::now_iso();
    let urls = results
        .iter()
        .map(|result| result.url.clone())
        .collect::<Vec<_>>();
    let stop_reason = if results.is_empty() {
        "no_source_candidates"
    } else if results.len() >= coverage_limit {
        "candidate_limit_reached"
    } else {
        "provider_results_exhausted"
    };
    let result_values = project_results(&results);
    let search_plan = project_plan(plan_result, query);
    let mut result = json!({
        "ok":true,
        "query":query,
        "results":result_values,
        "duration_ms":total_ms,
        "timings":{"planning_ms":planning_ms,"planner_calls":plan_result.measurements,
            "search_ms":search_ms,"requests":searched.timings},
        "provider":searched.provider,
        "usage":{"search_requests":searched.search_requests},
        "search_plan":search_plan,
        "public_web_evidence_items":evidence::search_items(&results, &observed_at),
        "evidence_capability_receipts":[evidence::search_capability_receipt(&results, &observed_at)],
        "evidence_receipts":[evidence::tool_receipt(&evidence::ToolReceiptInput {
            tool: "web_search",
            receipt_type: "coverage",
            summary: "Search returned public source candidates for the requested evidence.",
            verified: !results.is_empty(),
            covers: &["source_candidates"],
            satisfies: &[],
            urls: &urls,
            metrics: json!({"result_count":results.len(),"search_requests":searched.search_requests}),
        })],
        "citation_required":true,
        "coverage_budget":{
            "mode":"coverage_based",
            "result_count":results.len(),
            "stop_reason":stop_reason,
            "next_search_guidance":"Run another search only for a specific missing outcome field, category, source type, or verification gap.",
        },
        "source_urls":urls,
    });
    if let Some(overview) = searched.provider_overview {
        result["provider_overview"] = json!(overview);
    }
    if !searched.search_warnings.is_empty() {
        result["search_warnings"] = json!(searched.search_warnings);
    }
    if !searched.failed_queries.is_empty() {
        result["failed_queries"] = json!(searched.failed_queries);
    }
    result
}

async fn execute_planned(
    session: &WebSession,
    provider: &dyn SearchProvider,
    input: &SearchInput,
    plan: &SearchPlan,
    cancellation: &CancellationToken,
) -> Result<SearchOutput, WebAccessError> {
    let started = Instant::now();
    let final_limit = input.requested_max_results.unwrap_or(10).clamp(1, 10);
    let per_query_limit = final_limit.clamp(2, 5);
    let planned_inputs = plan
        .queries
        .iter()
        .map(|query| SearchInput {
            query: query.query.clone(),
            max_results: per_query_limit,
            requested_max_results: Some(per_query_limit),
            ..input.clone()
        })
        .collect::<Vec<_>>();
    let batch_size = provider
        .planned_concurrency()
        .unwrap_or(planned_inputs.len())
        .max(1)
        .min(planned_inputs.len());
    // Refill a freed slot immediately; a slow query must not hold the next batch.
    // Restore query order before ranking, independent of completion order.
    let requests = planned_inputs
        .iter()
        .enumerate()
        .map(|(index, search)| {
            async move {
                (
                    index,
                    provider.search(&session.access, search, cancellation).await,
                )
            }
            .boxed()
        })
        .collect::<Vec<_>>();
    let pending = futures_util::stream::iter(requests)
        .buffer_unordered(batch_size)
        .collect::<Vec<_>>();
    let mut settled = tokio::select! {
        biased;
        () = cancellation.cancelled() => return Err(WebAccessError::cancelled()),
        settled = pending => settled,
    };
    settled.sort_by_key(|(index, _)| *index);
    let mut outputs = Vec::new();
    let mut failures = Vec::new();
    for (index, result) in settled {
        match result {
            Ok(output) => outputs.push(output),
            Err(error) => failures.push(json!({
                "query":planned_inputs[index].query,
                "error":bounded_error(&error.message(), 500),
            })),
        }
    }
    merge_planned(
        provider.id(),
        &outputs,
        failures,
        planned_inputs.len(),
        final_limit,
        started.elapsed().as_millis(),
    )
}

fn merge_planned(
    provider: &str,
    outputs: &[SearchOutput],
    failures: Vec<Value>,
    query_count: usize,
    final_limit: usize,
    elapsed_ms: u128,
) -> Result<SearchOutput, WebAccessError> {
    if outputs.is_empty() {
        return Err(WebAccessError::new(
            WebAccessCode::WebSearchPlannedAllFailed,
            format!("All {query_count} planned web searches failed via {provider}."),
        ));
    }
    let ranking_started = Instant::now();
    let results = interleave_results(outputs, final_limit);
    let ranking_us = ranking_started.elapsed().as_micros();
    let mut providers = Vec::<String>::new();
    for output in outputs {
        if !providers.contains(&output.provider) {
            providers.push(output.provider.clone());
        }
    }
    let search_requests = outputs
        .iter()
        .map(|output| output.search_requests)
        .sum::<u64>()
        .saturating_add(failures.len() as u64);
    let mut output = SearchOutput {
        timings: outputs
            .iter()
            .enumerate()
            .map(|(index, output)| {
                json!({
                    "index":index,"duration_ms":output.duration_ms,"steps":output.timings,
                })
            })
            .chain(std::iter::once(json!({"ranking_us":ranking_us})))
            .collect(),
        results,
        provider_overview: None,
        duration_ms: u64::try_from(elapsed_ms.min(u128::from(u64::MAX))).unwrap_or(u64::MAX),
        provider: if providers.len() == 1 {
            providers.remove(0)
        } else {
            providers.join("+")
        },
        search_requests,
        search_warnings: Vec::new(),
        failed_queries: failures,
    };
    if !output.failed_queries.is_empty() {
        output.search_warnings.push(format!(
            "{} of {} planned web searches failed; successful results were preserved.",
            output.failed_queries.len(),
            query_count,
        ));
    }
    Ok(output)
}

fn interleave_results(outputs: &[SearchOutput], limit: usize) -> Vec<SearchResult> {
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    let max_rows = outputs
        .iter()
        .map(|output| output.results.len())
        .max()
        .unwrap_or(0);
    for row in 0..max_rows {
        for output in outputs {
            let Some(result) = output.results.get(row) else {
                continue;
            };
            if seen.insert(result.url.trim().to_owned()) {
                results.push(result.clone());
                if results.len() >= limit {
                    return results;
                }
            }
        }
    }
    results
}

fn bounded_error(value: &str, max: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    butler_core::json::Utf16Slice::new(&compact, 0, max)
        .utf8_lossy()
        .into_owned()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn optional_number(value: Option<&Value>, min: usize, max: usize) -> Option<usize> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .map(|number| {
            butler_core::json::saturating_usize(number.trunc().clamp(min as f64, max as f64))
        })
}
