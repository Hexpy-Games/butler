use super::{Value, summary};
use std::fmt::Write;

fn number(row: &Value, key: &str, decimals: usize) -> String {
    row[key]
        .as_f64()
        .map(|n| format!("{n:.decimals$}"))
        .unwrap_or_else(|| "—".into())
}
pub(crate) fn markdown(rows: &[Value]) -> String {
    let mut text = "| Task | Status | Shape | Facts | Calls | Input | Cached | Uncached | Output | Avg tools | Unreadable | USD | Cold USD |\n|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n".to_owned();
    for row in rows {
        let facts = if row["facts_total"].is_number() {
            format!("{}/{}", row["facts_found"], row["facts_total"])
        } else {
            "—".into()
        };
        let id = row["id"].as_str().unwrap().replace('|', "\\|");
        write!(
            text,
            "| {id} | {} | {} | {facts} |",
            row["status"].as_str().unwrap_or("complete"),
            row["shape"].as_str().unwrap_or("—")
        )
        .unwrap();
        for key in [
            "calls",
            "input",
            "cached",
            "uncached",
            "output",
            "average_tools_tokens",
            "unreadable_pages",
            "usd",
            "usd_cold",
        ] {
            write!(
                text,
                " {} |",
                number(row, key, if key.starts_with("usd") { 6 } else { 0 })
            )
            .unwrap();
        }
        text.push('\n');
    }
    let summary = summary(rows);
    writeln!(text,"\nMedian USD: {}. Blind median USD: {}. Per-set median USD: {}. All facts kept: {}. Completed: {}. Incomplete: {}. Priced rows: {}.\n\nIncomplete visible rows show facts received by Butler and cost so far. Blind incomplete rows expose only set/index and status; their costs are omitted from medians.\n\nToken estimates: o200k over serialized instructions, tools, input and reply items. Cached tokens are the common token prefix with the previous request in that lane. Prices are estimates from the static catalog, including per-request prompt tiers.",
        summary["median_usd"],summary["median_blind_usd"],summary["median_usd_per_set"],
        if summary["all_facts_kept"] == true {"yes"} else {"no"},summary["completed_tasks"],summary["incomplete_tasks"],summary["priced_tasks"]).unwrap();
    text
}
