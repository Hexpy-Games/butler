mod html;
mod markdown;

use std::collections::HashMap;

use butler_ds::ui::context::Lang;

use super::api::Doc;
use super::read_view::{self, Segment};
use crate::ui::chat::answers::spec_markdown;
use html::Out;

const CSS: &str = include_str!("document.css");

pub(super) fn document(
    doc: &Doc,
    id: &str,
    images: &HashMap<String, String>,
    lang: Lang,
) -> String {
    let lang = match lang {
        Lang::Ko => "ko",
        Lang::En => "en",
    };
    let mut out = Out::default();
    out.raw("<!doctype html>");
    out.open("html", &[("lang", lang)]);
    out.raw(concat!(
        "<head><meta http-equiv=\"Content-Security-Policy\" content=\"",
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
        "\"><meta charset=\"utf-8\"><style>"
    ));
    out.raw(CSS);
    out.raw("</style></head>");
    out.open("body", &[("class", "theme-light")]);
    out.raw("<h1 class=\"Typo__typo Typo__h1\" data-trim=\"\">");
    out.text(&doc.title);
    out.close("h1");
    out.open("div", &[("data-document-read-only", id)]);
    out.raw(concat!(
        "<div class=\"Stack__stack Stack__align-column Stack__gap-md ",
        "Stack__justify-start Stack__cross-stretch\">"
    ));
    for part in read_view::split(&doc.body) {
        match part {
            Segment::Markdown(text) => {
                for range in markdown::nodes(text) {
                    markdown::content(&mut out, &text[range], images);
                }
            }
            Segment::Blocks { json, fence } => {
                if let Some(spec) = read_view::parse(json) {
                    let text = spec_markdown(&spec, &|id, _| images.get(id).cloned());
                    markdown::content(&mut out, &text, images);
                } else {
                    markdown::content(&mut out, fence, images);
                }
            }
        }
    }
    out.raw("</div></div></body></html>");
    out.0
}
