mod parse;

use std::{collections::HashSet, time::Instant};

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
pub(super) use parse::{is_duckduckgo_challenge, parse_results};

impl WebSession {
    pub(crate) async fn web_search(
        &self,
        args: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, WebAccessError> {
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .map(crate::public_text::trim_js_whitespace)
            .unwrap_or_default();
        if query.encode_utf16().count() < 2 {
            return Err(WebAccessError::new(
                "invalid_arguments",
                "web_search requires a query with at least 2 characters.",
            ));
        }
        let allowed = string_array(args.get("allowed_domains"));
        let blocked = string_array(args.get("blocked_domains"));
        if !allowed.is_empty() && !blocked.is_empty() {
            return Err(WebAccessError::new(
                "invalid_arguments",
                "web_search cannot use allowed_domains and blocked_domains together.",
            ));
        }
        let requested_max_results = optional_number(args.get("max_results"), 1, 10);
        let max_results = requested_max_results.unwrap_or(5);
        let coverage_limit = requested_max_results.unwrap_or(10);
        let recency_days = optional_number(args.get("recency_days"), 1, usize::MAX);
        let input = SearchInput {
            query: query.to_owned(),
            allowed_domains: allowed,
            blocked_domains: blocked,
            max_results,
            requested_max_results,
            recency_days: recency_days.map(|days| days as u64),
        };
        let provider = providers::configured(&self.access).await?;
        let gate = self.lock_planning().await;
        let first_search = !self.first_search_consumed();
        let plan_result = if first_search {
            match planning::create_plan(
                &self.access,
                &input,
                &self.original_request(),
                cancellation,
            )
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    self.access
                        .metrics()
                        .record(provider.id(), query, Some(error.code));
                    return Err(error);
                }
            }
        } else {
            PlanningResult {
                plan: None,
                used_planner: false,
                attempts: 0,
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
                    .record(provider.id(), query, Some(error.code));
                return Err(error);
            }
        };
        self.access
            .metrics()
            .record(&searched.provider, query, None);
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
        let result_values = results
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
            .collect::<Vec<_>>();
        let search_plan = plan_result
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
            });
        let mut result = json!({
            "ok":true,
            "query":query,
            "results":result_values,
            "duration_ms":searched.duration_ms,
            "provider":searched.provider,
            "usage":{"search_requests":searched.search_requests},
            "search_plan":search_plan,
            "public_web_evidence_items":evidence::search_items(&results, &observed_at),
            "evidence_capability_receipts":[evidence::search_capability_receipt(&results, &observed_at)],
            "evidence_receipts":[evidence::tool_receipt(evidence::ToolReceiptInput {
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
        Ok(result)
    }
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
    let mut outputs = Vec::new();
    let mut failures = Vec::new();
    for (batch_index, batch) in planned_inputs.chunks(batch_size).enumerate() {
        if cancellation.is_cancelled() {
            return Err(WebAccessError::cancelled());
        }
        let settled = futures_util::future::join_all(
            batch
                .iter()
                .map(|search| provider.search(&session.access, search, cancellation)),
        )
        .await;
        if cancellation.is_cancelled() {
            return Err(WebAccessError::cancelled());
        }
        for (offset, result) in settled.into_iter().enumerate() {
            match result {
                Ok(output) => outputs.push(output),
                Err(error) => {
                    let index = batch_index * batch_size + offset;
                    failures.push(json!({
                        "query":planned_inputs[index].query,
                        "error":bounded_error(&error.message, 500),
                    }));
                }
            }
        }
    }
    if outputs.is_empty() {
        return Err(WebAccessError::new(
            "web_search_planned_all_failed",
            format!(
                "All {} planned web searches failed via {}.",
                planned_inputs.len(),
                provider.id(),
            ),
        ));
    }
    let results = interleave_results(&outputs, final_limit);
    let mut providers = Vec::<String>::new();
    for output in &outputs {
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
        results,
        provider_overview: None,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
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
            planned_inputs.len(),
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
    crate::json::Utf16Slice::new(&compact, 0, max)
        .utf8_lossy()
        .into_owned()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(crate::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn optional_number(value: Option<&Value>, min: usize, max: usize) -> Option<usize> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .map(|number| number.trunc().clamp(min as f64, max as f64) as usize)
}
