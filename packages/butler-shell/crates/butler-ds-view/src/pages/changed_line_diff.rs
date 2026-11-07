//! ChangedLineDiff.showcase.tsx: the diff standalone and inside a changed-file row.
use butler_ds::ui::Icon;
use butler_ds::ui::blocks::changed_line_diff::{ChangedLineDiff, DiffLine, LineType};
use butler_ds::ui::blocks::disclosure_row::{DisclosureRow, Surface};
use butler_ds::ui::context::Ds;
use butler_ds::ui::icon::{IconSize, icon};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use super::nav_parts::flag;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Standalone",
            render: standalone,
        },
        Story {
            name: "Inside a changed-file row",
            render: in_row,
        },
    ]
}

const PATH: &str = "src/libs/design-system/lib/motion.test.ts";

fn lines() -> Vec<DiffLine> {
    vec![
        DiffLine::new(LineType::Deleted, "const oldValue = true;").old_line(2),
        DiffLine::new(LineType::Added, "const newValue = true;").new_line(2),
        DiffLine::new(LineType::Added, "").new_line(98),
        DiffLine::new(
            LineType::Added,
            "  it(\"preserves the reusable prefix across different input lengths\", () => {",
        )
        .new_line(99),
        DiffLine::new(
            LineType::Added,
            "    const first = items().map((item) => item.section === \"runtime_policy\" ? { ...item, content: \"Current request\" } : item);",
        )
        .new_line(100),
        DiffLine::new(LineType::Added, "  });").new_line(101),
    ]
}

fn standalone(_: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    ChangedLineDiff::new("diff-standalone", lines()).into_any_element()
}

fn in_row(_: Lang, window: &mut Window, cx: &mut App) -> AnyElement {
    let (open, on_toggle) = flag("diff-row-open", true, window, cx);
    DisclosureRow::new("diff-row", PATH)
        .surface(Surface::Plain)
        .icon(icon(Icon::FileText, IconSize::Lg, Ds::get(cx)))
        .meta("+4 −1")
        .open(open)
        .on_toggle(on_toggle)
        .child(ChangedLineDiff::new("diff-in-row", lines()))
        .into_any_element()
}
