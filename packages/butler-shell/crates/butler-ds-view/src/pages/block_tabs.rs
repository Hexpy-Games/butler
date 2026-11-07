//! BlockTabs.showcase.tsx: tabs of blocks.
use butler_ds::ui::blocks::block_tabs::{BlockTab, BlockTabs};
use butler_ds::ui::blocks::key_value_row::KeyValueRow;
use butler_ds::ui::layout::{Space, Stack};
use gpui::{AnyElement, App, IntoElement as _, ParentElement as _, Window};

use super::Story;
use crate::copy::Lang;

pub(super) fn stories() -> Vec<Story> {
    vec![Story {
        name: "Tabs of blocks",
        render: cities,
    }]
}

fn cities(lang: Lang, _: &mut Window, _: &mut App) -> AnyElement {
    let (cities, temp, rain, name) = lang.pick(
        (
            ["Seoul", "Busan", "Jeju"],
            "Temperature",
            "Rain",
            "Weather by city",
        ),
        (["서울", "부산", "제주"], "기온", "강수 확률", "도시별 날씨"),
    );
    let values = [("18°", "10%"), ("21°", "0%"), ("23°", "40%")];
    let mut tabs = BlockTabs::new("block-tabs", name);
    for (label, (degrees, chance)) in cities.into_iter().zip(values) {
        tabs = tabs.tab(BlockTab::new(
            label,
            Stack::new()
                .gap(Space::Xs)
                .child(KeyValueRow::new(temp, degrees))
                .child(KeyValueRow::new(rain, chance)),
        ));
    }
    tabs.into_any_element()
}
