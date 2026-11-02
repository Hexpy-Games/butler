//! Attribute-free cells; only structural table attributes survive complex tables.
use dom_query::{Document, NodeRef};

pub(super) fn render(html: &str) -> String {
    let doc = Document::from(html);
    doc.select("script,style,noscript,svg").remove();
    let Some(table) = doc.select("table").nodes().first().copied() else {
        return String::new();
    };
    let complex = doc.select("table table,[colspan],[rowspan]").length() > 0;
    if complex {
        return minimal(table);
    }
    let rows: Vec<Vec<String>> = doc
        .select("tr")
        .nodes()
        .iter()
        .map(|row| {
            row.children_it(false)
                .filter(|n| matches!(n.node_name().as_deref(), Some("td" | "th")))
                .map(|n| escape(&super::compact(&n.formatted_text())).replace('|', "\\|"))
                .collect()
        })
        .filter(|cells: &Vec<_>| !cells.is_empty())
        .collect();
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let caption = super::compact(&doc.select("caption").text());
    let mut output = if caption.is_empty() {
        String::new()
    } else {
        format!("{caption}\n\n")
    };
    for (index, mut cells) in rows.into_iter().enumerate() {
        cells.resize(width, String::new());
        output.push_str(&format!("| {} |\n", cells.join(" | ")));
        if index == 0 {
            output.push_str(&format!("| {} |\n", vec!["---"; width].join(" | ")));
        }
    }
    output.trim_end().into()
}

fn minimal(node: NodeRef<'_>) -> String {
    if node.is_text() {
        return escape(&node.text());
    }
    if !node.is_element() {
        return String::new();
    }
    let name = node.node_name().unwrap_or_default();
    let children = node.children_it(false).map(minimal).collect::<String>();
    if !matches!(
        name.as_ref(),
        "table" | "thead" | "tbody" | "tfoot" | "tr" | "td" | "th" | "caption" | "colgroup" | "col"
    ) {
        return if super::structure::is_block(&name) {
            format!("\n{children}\n")
        } else {
            children
        };
    }
    let mut attributes = String::new();
    for key in ["colspan", "rowspan", "scope", "headers"] {
        if let Some(value) = node.attr(key) {
            attributes.push_str(&format!(" {key}=\"{}\"", escape(&value)));
        }
    }
    let boundary = if name.as_ref() == "tr" { "\n" } else { "" };
    format!("<{name}{attributes}>{children}</{name}>{boundary}")
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
