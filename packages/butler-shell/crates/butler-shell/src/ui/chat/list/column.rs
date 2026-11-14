//! Electron `MessageList`: the measured transcript column.
use butler_ds::ui::blocks::scope;
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Styled as _, div, px, relative};

/// `CONTENT_MAX` of the DS message column, for a column the shell has not measured yet.
const COLUMN_MAX: f32 = 760.;
/// `COLUMN_SHARE` of the same column.
const COLUMN_SHARE: f32 = 0.86;

/// The message column a row flows in: the measured column, or its share before that.
pub(super) fn in_column(row: AnyElement, cx: &App) -> AnyElement {
    let vars = scope::conversation(cx).unwrap_or_default();
    let column = div().flex().flex_col().flex_none().min_w_0();
    let column = if vars.column_width > 0. {
        column.w(px(vars.column_width)).ml(px(vars.column_left))
    } else {
        column
            .w(relative(COLUMN_SHARE))
            .max_w(px(COLUMN_MAX))
            .mx_auto()
    };
    div().w_full().child(column.child(row)).into_any_element()
}
