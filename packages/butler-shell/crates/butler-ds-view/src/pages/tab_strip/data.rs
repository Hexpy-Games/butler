//! The TabStrip showcase data (TabStrip.demo.tsx): copy, groups and labels in English and Korean.
use butler_ds::ui::blocks::tab_strip::{
    Favicon, Group, GroupKind, GroupState, Tab, TabState, TabStripLabels,
};

use crate::copy::Lang;

pub(crate) fn labels(lang: Lang) -> TabStripLabels {
    lang.pick(
        TabStripLabels::default(),
        TabStripLabels {
            my_tabs: "내 탭".into(),
            new_tab: "새 탭".into(),
            close_tab: "탭 닫기".into(),
            untitled: "제목 없음".into(),
            working: "버틀러 작업 중".into(),
            waiting: "승인 대기".into(),
            crashed: "페이지 종료됨".into(),
            new_tab_in: |group| format!("{group}에 새 탭"),
            more_tabs: |count| format!("+{count}"),
        },
    )
}

const DOCS: Favicon = Favicon::Letter {
    rgb: 0x003b_6fd8,
    letter: 'D',
};
const MAIL: Favicon = Favicon::Letter {
    rgb: 0x00d9_473b,
    letter: 'M',
};
const SHOP: Favicon = Favicon::Letter {
    rgb: 0x001f_8f5f,
    letter: 'S',
};
const MAP: Favicon = Favicon::Letter {
    rgb: 0x008a_5cf6,
    letter: 'K',
};

struct Copy {
    mine: [&'static str; 3],
    shoes: &'static str,
    trip: &'static str,
    shop: [&'static str; 4],
    sync: &'static str,
    sync_tab: &'static str,
    trip_tabs: [&'static str; 5],
}

fn copy(lang: Lang) -> Copy {
    lang.pick(
        Copy {
            mine: ["Butler design system", "Inbox — Mail", "Q3 report.pdf"],
            shoes: "Running shoes under $150",
            trip: "Book a Busan trip",
            shop: ["Search results — Shop", "Checkout", "Size guide", "Reviews"],
            sync: "Order sync",
            sync_tab: "Seller console",
            trip_tabs: [
                "Hotel booking",
                "Train timetable",
                "Beach weather",
                "Seafood market",
                "Car rental",
            ],
        },
        Copy {
            mine: [
                "버틀러 디자인 시스템",
                "받은편지함 — 메일",
                "3분기 보고서.pdf",
            ],
            shoes: "15만 원 이하 러닝화",
            trip: "부산 여행 예약",
            shop: ["검색 결과 — 쇼핑", "결제", "사이즈 가이드", "구매 후기"],
            sync: "주문 동기화",
            sync_tab: "판매자 콘솔",
            trip_tabs: [
                "호텔 예약",
                "KTX 시간표",
                "해운대 날씨",
                "자갈치 시장",
                "렌터카",
            ],
        },
    )
}

pub(super) fn shoes(lang: Lang, size: usize) -> Group {
    let c = copy(lang);
    let tabs = c.shop.iter().take(size).enumerate().map(|(i, title)| {
        let tab = Tab::new(format!("s{}", i + 1), *title).favicon(SHOP);
        if i == 0 {
            tab.state(TabState::Working)
        } else {
            tab
        }
    });
    Group::new("shoes", GroupKind::Conversation)
        .label(c.shoes)
        .state(GroupState::Working)
        .tabs(tabs)
}

/// A folded group of five tabs: its title previews three favicons and "+2".
pub(super) fn trip(lang: Lang) -> Group {
    let c = copy(lang);
    let icons = [MAP, Favicon::Broken, DOCS, MAIL, SHOP];
    let tabs = c
        .trip_tabs
        .iter()
        .zip(icons)
        .enumerate()
        .map(|(i, (title, icon))| Tab::new(format!("t{}", i + 1), *title).favicon(icon));
    Group::new("trip", GroupKind::Conversation)
        .label(c.trip)
        .state(GroupState::Waiting)
        .collapsed(true)
        .tabs(tabs)
}

pub(super) fn demo_groups(lang: Lang) -> Vec<Group> {
    let c = copy(lang);
    let mine = Group::new("mine", GroupKind::Mine)
        .tab(Tab::new("m1", c.mine[0]).favicon(DOCS))
        .tab(Tab::new("m2", c.mine[1]).favicon(MAIL))
        .tab(Tab::new("m3", c.mine[2]).state(TabState::Loading));
    vec![mine, shoes(lang, 2), trip(lang)]
}

pub(super) fn crashed_groups(lang: Lang) -> Vec<Group> {
    let c = copy(lang);
    let mut groups = demo_groups(lang);
    groups.push(
        Group::new("sync", GroupKind::Conversation)
            .label(c.sync)
            .state(GroupState::Crashed)
            .tab(Tab::new("x1", c.sync_tab).state(TabState::Crashed)),
    );
    groups
}

/// My tabs beside one conversation group of `size` tabs.
pub(super) fn paired(lang: Lang, size: usize) -> Vec<Group> {
    let mut mine = demo_groups(lang).remove(0);
    mine.truncate_tabs(2);
    vec![mine, shoes(lang, size)]
}

/// Many tabs, to show shrink-to-fit and the sideways scroll with edge fades.
pub(super) fn crowded(lang: Lang) -> Vec<Group> {
    let c = copy(lang);
    let titles: Vec<&str> = c
        .mine
        .iter()
        .chain(&c.shop)
        .chain(&c.trip_tabs)
        .chain([&c.sync_tab])
        .copied()
        .collect();
    let icons = [DOCS, MAIL, SHOP, MAP];
    let tabs: Vec<Tab> = (0..14)
        .map(|i| Tab::new(format!("n{i}"), titles[i % titles.len()]).favicon(icons[i % 4].clone()))
        .collect();
    let (first, rest) = tabs.split_at(9);
    vec![
        Group::new("mine", GroupKind::Mine).tabs(first.iter().cloned()),
        Group::new("shoes", GroupKind::Conversation)
            .label(c.shoes)
            .state(GroupState::Working)
            .tabs(rest.iter().cloned()),
    ]
}
