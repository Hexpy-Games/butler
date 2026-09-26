use serde_json::json;
use std::{fs, path::Path};
use tz::TimeZone;

use super::super::providers::contracts::SearchInput;

const INSTRUCTIONS: &str = r"You are Butler's Smart Search Planning layer.
Plan web search queries before the actual search provider is called.
Use the original user request or current-turn context as the primary source for intent, scope, depth, risk, and decomposition when it is provided.
Use the model-selected web_search query as a retrieval seed, not as a replacement for the original request.
If the model-selected query collapses multiple user-named subjects or drops speed, depth, evidence, or risk signals, recover those signals from the original request.
Use the user's language for queries when that language is likely to reach the best sources.
Use the target source language or English when those are more likely to find authoritative sources.
If localized user-language sources and official/global source-language sources are both useful, create separate language/source lanes instead of mixing both languages into one provider query.
Do not combine localized entity names, user-language media terms, and international or English source anchors in the same query unless one is only a short alias that does not overload retrieval.
Prefer one query in the user's language or localized naming for local/user-language sources, and a separate query in the official, global, or source language for official or international sources.
Choose quick when the user asks for a fast, brief, lightweight, or high-level search.
Choose deep when the user asks for careful research, evidence, sources, comparison, risks, or completeness.
Choose verification when the answer depends on current factual status, primary-source confirmation, or could materially affect a consequential real-world decision.
Do not over-decompose. Split only when separate queries or source types are genuinely useful.
Each query should have one clear retrieval job and should be useful as-is in a normal web search engine.
Do not merely paraphrase the user request as a query; construct search-engine-native keyword queries.
For each query, use the fewest lexical anchors that can retrieve the target evidence.
Prefer exact entity names, product names, ticker symbols, source names, page names, or source-class anchors over vague intent words.
Avoid vague intent words such as important, evidence, official, recommendation, quick, or their equivalents unless those words are likely literal source terms.
Separate scan, official or primary-source, review, comparison, risk, reaction, and verification retrieval jobs instead of mixing them in one query.
For high-risk verification, keep each query narrow: one claim, entity, source surface, or safety question per query.
For high-risk verification, prefer primary-source, regulatory, official-label, standards, clinical-guidance, legal-text, disclosure, or incident-report source surfaces over broad SEO-style summaries.
For official, regulatory, legal, disclosure, label, or standards queries, target the issuing organization or stable host/page surface plus the entity, filing, label, or claim; do not rely only on generic source acronyms or third-party summaries.
For high-risk source choice, do not let the user's language or locale exclude stronger authoritative guidance in another source language.
When you intentionally target a named source, use a stable source/page/domain-style anchor if known and useful; otherwise avoid ambiguous source names that search engines may satisfy with unrelated blogs or mirrors.
Avoid dynamic map, internal search-result, or app-shell pages as evidence targets unless the user explicitly asks for that service; prefer indexable local guides, official pages, reviews, or directories that can be read.
Use dates only when they improve retrieval for news, events, releases, or time-bounded claims; avoid injecting a full current date into evergreen, official, review, or product-comparison queries.
If no concrete entity or source is known for an official query, do not invent a generic official-blog or official-announcement query; use authoritative scan or curation sources first.
Prefer broad curated or authoritative sources for quick scans, and include validation-oriented or official-source queries for deep or verification work.
For broad briefing requests, use the smallest useful decomposition and prefer source-seeking curated or authoritative overview queries over many narrow topic buckets.
When a query is meant to use curation, name an appropriate curated source, newswire, aggregator, official index, or publication in the query instead of using only generic topic words.
For local/domestic briefing scope, infer suitable overview sources from the user's locale and language; for international/global scope, infer suitable global overview sources.
For requests that combine multiple subjects with evidence/source signals, split by the subjects the user named, mark depth deep, make the plan parallelizable, and include validation-oriented queries.
For consequential decision-support questions, ignore speed shortcuts: choose verification, infer the evidence dimensions needed for that specific subject, separate those dimensions into focused queries, and avoid verdict-seeking query phrasing.
For consequential decision-support, include separate searches for current state, primary-source facts, and independent analysis or risk when those dimensions are relevant.
For rankings, candidates, or discovery tasks, include at least one source-discovery query for the official table, dataset, or curated source itself before queries that name likely answers.
If the request contains a date, period, version, release window, or other temporal constraint, preserve that exact constraint in the planned queries and prefer official or primary sources.
Avoid topic-soup queries that merely concatenate many section labels, avoid fragile search operators such as wildcard site: patterns, and avoid overloading one query with too many source names.
Return only one valid JSON object matching the requested schema.";

pub(super) fn instructions() -> &'static str {
    INSTRUCTIONS
}

pub(super) fn build(
    input: &SearchInput,
    original_request: &str,
    default_depth: &str,
    timezone: &str,
    attempt: usize,
    prior_error: Option<&str>,
) -> String {
    let current_date = current_date(timezone);
    let retry = if attempt > 1 {
        format!(
            "\nPrevious response was invalid: {}. Return corrected JSON only.",
            prior_error.unwrap_or("invalid JSON/schema")
        )
    } else {
        String::new()
    };
    let runtime = json!({
        "currentDate":current_date,
        "timeZone":timezone,
        "defaultDepth":default_depth,
        "plannedQueryExecution":"parallel",
        "allowedDomains":input.allowed_domains,
        "blockedDomains":input.blocked_domains,
        "recencyDays":input.recency_days,
        "maxResults":input.requested_max_results,
    });
    let mut prompt = String::from(
        "Plan web searches for the request below.\n\nOriginal user request or bounded current-turn context:\n",
    );
    prompt.push_str(&serde_json::to_string(original_request).unwrap_or_else(|_| "\"\"".into()));
    prompt.push_str("\n\nModel-selected web_search query:\n");
    prompt.push_str(&serde_json::to_string(&input.query).unwrap_or_else(|_| "\"\"".into()));
    prompt.push_str("\n\nUse the original user request/context for intent, scope, depth, and decomposition. Use the model-selected web_search query only as a retrieval seed or hint. If the seed query lost separate user-named subjects or omitted evidence/source/depth/risk/speed signals, restore those from the original request/context.\n\nRuntime context:\n");
    prompt.push_str(&serde_json::to_string_pretty(&runtime).unwrap_or_else(|_| "{}".into()));
    prompt.push_str(
        r#"

Return JSON with this exact shape:
{
  "depth": "quick" | "balanced" | "deep" | "verification",
  "originalRequest": string,
  "intent": string,
  "scope": "single_topic" | "multi_domain" | "comparison" | "verification" | "unknown",
  "decomposition": [
    {"id":string,"label":string,"reason":string,"priority":"low"|"normal"|"high"}
  ],
  "queries": [
    {"bucketId":string,"query":string,"purpose":"scan"|"curation"|"validation"|"official"|"reaction"|"comparison","priority":"low"|"normal"|"high","expectedSourceType":"official"|"news"|"curation"|"community"|"review"|"docs"}
  ],
  "verificationRequired": boolean,
  "notes": string[]
}

Constraints:
"#,
    );
    prompt.push_str(&constraints(input));
    prompt.push_str(&retry);
    prompt
}

fn constraints(input: &SearchInput) -> String {
    let mut lines = vec![format!(
        "- Generate at most {} query candidates, and avoid near-duplicates.",
        input.requested_max_results.unwrap_or(6).max(3)
    )];
    lines.extend([
        "- A simple single-topic request can have one bucket and one query.",
        "- Each query should have one clear retrieval job.",
        "- Do not paraphrase the user request as a query; write search-engine-native keyword queries.",
        "- For every query, choose minimal lexical anchors for the evidence target.",
        "- Include exact entity, product, ticker, organization, source, page, or source-class anchors when known.",
        "- Avoid vague intent words such as important, evidence, official, recommendation, quick, or their equivalents unless they are likely literal source terms.",
        "- Separate scan, official/primary-source, review, comparison, risk, reaction, and verification jobs into different queries.",
        "- For high-risk verification, keep each query narrow: one claim, entity, source surface, or safety question per query.",
        "- For high-risk verification, prefer primary-source, regulatory, official-label, standards, clinical-guidance, legal-text, disclosure, or incident-report source surfaces over broad SEO-style summaries.",
        "- For official, regulatory, legal, disclosure, label, or standards queries, target the issuing organization or stable host/page surface plus the entity, filing, label, or claim; do not rely only on generic source acronyms or third-party summaries.",
        "- For high-risk source choice, do not let the user's language or locale exclude stronger authoritative guidance in another source language.",
        "- When intentionally targeting a named source, use a stable source/page/domain-style anchor if known and useful; otherwise avoid ambiguous source names that search engines may satisfy with unrelated blogs or mirrors.",
        "- Avoid dynamic map, internal search-result, or app-shell pages as evidence targets unless the user explicitly asks for that service; prefer indexable local guides, official pages, reviews, or directories that can be read.",
        "- Use dates only when they improve retrieval; avoid full current dates for evergreen official pages, product reviews, or general comparisons.",
        "- If the plan lacks a concrete entity/source for an official query, do not invent generic official blog or official announcement queries. Use authoritative scan or curation queries first, then let later result reading identify official sources.",
        "- Do not keep multiple user-named subjects in the same provider query when they need separate source surfaces or validation paths.",
        "- If localized user-language sources and official/global source-language sources are both useful, split them into separate query lanes.",
        "- Do not combine localized entity names, user-language media terms, and international or English source anchors in one provider query unless one is only a short alias.",
        "- Prefer one query in the user's language or localized naming for local/user-language sources, and a separate query in the official, global, or source language for official or international sources.",
        "- Broad briefing requests should usually stay at quick or balanced depth with 2-4 curated or authoritative overview queries unless the user asks for deeper analysis.",
        "- Prefer source-seeking overview queries over topic-soup queries that concatenate many generic sections.",
        "- Curation-purpose queries should name a suitable source or source category inferred from the user's locale, language, and target scope; do not hardcode a fixed source list.",
        "- Requests that combine multiple named subjects with evidence/source wording should use deep depth, separate those subjects, and include validation-oriented queries.",
        "- Consequential decision-support requests must use verification depth even when the user asks for a quick answer.",
        "- For verification plans, infer the evidence dimensions that matter for the specific subject instead of relying on a fixed domain checklist, and avoid verdict-seeking query phrasing.",
        "- For consequential decision-support, keep current state, primary-source facts, and independent analysis or risk in separate queries when those dimensions are relevant.",
        "- Discovery tasks should not bake assumed answers into every query; include a query for the source table, dataset, official announcement, or curated source itself.",
        "- Preserve explicit temporal constraints exactly when present.",
        "- Avoid fragile or provider-specific search syntax, including wildcard site: operators.",
        "- If depth is deep or verification, set verificationRequired to true.",
        "- If allowedDomains are present, keep queries compatible with those domains.",
        "- If blockedDomains are present, do not target those domains.",
        "- Do not include markdown, code fences, or explanatory prose.",
    ].into_iter().map(str::to_owned));
    lines.join("\n")
}

fn current_date(timezone: &str) -> String {
    let epoch_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0_i64, |duration| {
            i64::try_from(duration.as_millis().min(i64::MAX as u128)).unwrap_or(i64::MAX)
        });
    let zone = zone(timezone).unwrap_or_else(TimeZone::utc);
    let seconds = epoch_ms.div_euclid(1_000);
    let offset = zone
        .find_local_time_type(seconds)
        .map(|value| value.ut_offset())
        .unwrap_or(0);
    let wall_ms = epoch_ms.saturating_add(i64::from(offset).saturating_mul(1_000));
    let (year, month, day) = crate::js_date::civil_from_days(wall_ms.div_euclid(86_400_000));
    format!("{year:04}-{month:02}-{day:02}")
}

fn zone(name: &str) -> Option<TimeZone> {
    if name.is_empty() || name.starts_with('/') || name.split('/').any(|part| part == "..") {
        return None;
    }
    ["/usr/share/zoneinfo", "/var/db/timezone/zoneinfo"]
        .iter()
        .find_map(|root| {
            let bytes = fs::read(Path::new(root).join(name)).ok()?;
            TimeZone::from_tz_data(&bytes).ok()
        })
}
