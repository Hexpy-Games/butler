//! One DOM traversal measures structure; a second emits every evidence block once.
use dom_query::{Document, NodeId, NodeRef};
use std::collections::{HashMap, HashSet};

use super::compact;

#[derive(Default, Clone, Copy)]
struct Stats {
    chars: usize,
    linked: usize,
    words: usize,
    unlinked_words: usize,
    elements: usize,
    block: bool,
}

pub(super) struct Block {
    pub html: String,
    pub text: String,
    pub chrome: bool,
    pub main: bool,
}

pub(super) fn blocks(html: &str) -> Vec<Block> {
    let doc = Document::from(html);
    // HTML5 parsing handles raw-text elements and comments before serialization,
    // including malformed markup, table descendants and embedded '<' characters.
    sanitize(doc.root());
    let mut stats = HashMap::new();
    measure(doc.root(), false, &mut stats);
    let main = densest(doc.root(), &stats, false).map(|(_, id)| id);
    let mut output = Vec::new();
    emit(doc.root(), &stats, false, false, main, &mut output);
    let mut seen = HashSet::new();
    output.retain(|block| !block.text.is_empty() && seen.insert(block.text.clone()));
    output
}

fn sanitize(node: NodeRef<'_>) {
    if node.is_comment()
        || matches!(
            node.node_name().as_deref(),
            Some("script" | "style" | "noscript" | "svg")
        )
    {
        node.remove_from_parent();
        return;
    }
    if node.node_name().as_deref() == Some("iframe") {
        // Iframe fallback is raw text in HTML5. Parse its markup before treating
        // it as chrome, so embedded style/script text cannot bypass sanitation.
        let fallback = node.text();
        node.rename("aside");
        node.set_html(fallback);
    }
    let fragment = node.element_ref().and_then(|e| e.template_contents);
    if let Some(fragment) = fragment {
        // HTML5 template contents live in a detached fragment. Make them an
        // ordinary chrome subtree so they are measured and sanitized too.
        node.rename("aside");
        for child in NodeRef::new(fragment, node.tree)
            .children_it(false)
            .collect::<Vec<_>>()
        {
            node.append_child(&child.id);
        }
    }
    for child in node.children_it(false).collect::<Vec<_>>() {
        sanitize(child);
    }
}

fn measure(node: NodeRef<'_>, link: bool, all: &mut HashMap<NodeId, Stats>) -> Stats {
    let name = node.node_name().unwrap_or_default();
    let link = link || name.as_ref() == "a";
    let mut result = Stats {
        elements: usize::from(node.is_element()),
        ..Stats::default()
    };
    if node.is_text() {
        let text = node.text();
        result.chars = text.chars().count();
        result.words = text.split_whitespace().count();
        if link {
            result.linked = result.chars;
        } else {
            result.unlinked_words = result.words;
        }
    }
    for child in node.children_it(false) {
        let stats = measure(child, link, all);
        result.chars += stats.chars;
        result.linked += stats.linked;
        result.words += stats.words;
        result.unlinked_words += stats.unlinked_words;
        result.elements += stats.elements;
        result.block |=
            stats.block || is_block(&child.node_name().unwrap_or_default()) || chrome(child, stats);
    }
    all.insert(node.id, result);
    result
}

fn chrome(node: NodeRef<'_>, stats: Stats) -> bool {
    let name = node.node_name().unwrap_or_default();
    let page_edge = matches!(name.as_ref(), "header" | "footer")
        && !node.ancestors(None).iter().any(|n| {
            matches!(
                n.node_name().as_deref(),
                Some("article" | "main" | "section")
            )
        });
    let role = node.attr("role").unwrap_or_default();
    let style = node.attr("style").unwrap_or_default().to_ascii_lowercase();
    let hidden_style = style.split(';').any(|rule| {
        rule.split_once(':').is_some_and(|(key, value)| {
            key.trim() == "display" && value.trim().split('!').next().unwrap_or("").trim() == "none"
        })
    });
    // The conventional 50% link-density cutoff with <10 non-link words and
    // <20 text characters per element identifies navigation, not prose citations.
    let link_dense = is_block(&name)
        && stats.chars > 0
        && stats.linked * 2 >= stats.chars
        && stats.unlinked_words < 10
        && stats.chars < stats.elements.max(1) * 20;
    page_edge
        || matches!(
            name.as_ref(),
            "head"
                | "nav"
                | "aside"
                | "form"
                | "dialog"
                | "iframe"
                | "template"
                | "input"
                | "button"
                | "select"
                | "textarea"
        )
        || role.split_whitespace().any(|r| {
            matches!(
                r,
                "navigation"
                    | "banner"
                    | "contentinfo"
                    | "complementary"
                    | "search"
                    | "menu"
                    | "menubar"
            )
        })
        || node.attr("hidden").is_some()
        || node
            .attr("aria-hidden")
            .is_some_and(|v| v.eq_ignore_ascii_case("true"))
        || hidden_style
        || link_dense
}

fn densest(
    node: NodeRef<'_>,
    all: &HashMap<NodeId, Stats>,
    inherited: bool,
) -> Option<(f64, NodeId)> {
    let stats = all[&node.id];
    let chrome = inherited || chrome(node, stats);
    if chrome {
        return None;
    }
    let name = node.node_name().unwrap_or_default();
    let mut best = if node.is_element() && !matches!(name.as_ref(), "html" | "body") {
        Some((
            (stats.chars - stats.linked) as f64 / (stats.elements.max(1) as f64).sqrt(),
            node.id,
        ))
    } else {
        None
    };
    for child in node.children_it(false) {
        if let Some(candidate) = densest(child, all, chrome)
            && best.is_none_or(|best| candidate.0 > best.0)
        {
            best = Some(candidate);
        }
    }
    best
}

fn emit(
    node: NodeRef<'_>,
    all: &HashMap<NodeId, Stats>,
    inherited: bool,
    main: bool,
    region: Option<NodeId>,
    output: &mut Vec<Block>,
) {
    let stats = all[&node.id];
    let chrome = inherited || chrome(node, stats);
    let main = main || region == Some(node.id);
    let name = node.node_name().unwrap_or_default();
    if !stats.block || matches!(name.as_ref(), "table" | "pre") {
        if node.is_element() || node.is_text() {
            output.push(Block {
                html: node.html().to_string(),
                text: compact(&node.text()),
                chrome,
                main,
            });
        }
        return;
    }
    let mut inline = String::new();
    let mut text = String::new();
    for child in node.children_it(false) {
        let child_stats = all[&child.id];
        if is_block(&child.node_name().unwrap_or_default())
            || child_stats.block
            || (!chrome && self::chrome(child, child_stats))
        {
            flush(&mut inline, &mut text, chrome, main, output);
            emit(child, all, chrome, main, region, output);
        } else if !child.is_comment() {
            inline.push_str(&child.html());
            text.push_str(&child.text());
        }
    }
    flush(&mut inline, &mut text, chrome, main, output);
}

fn flush(html: &mut String, text: &mut String, chrome: bool, main: bool, output: &mut Vec<Block>) {
    if !text.trim().is_empty() {
        output.push(Block {
            html: std::mem::take(html),
            text: compact(text),
            chrome,
            main,
        });
    }
    html.clear();
    text.clear();
}

pub(super) fn is_block(name: &str) -> bool {
    super::is_block(name)
        || matches!(
            name,
            "nav" | "aside" | "form" | "dialog" | "iframe" | "template" | "dl" | "dt" | "dd"
        )
}
