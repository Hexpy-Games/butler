//! TaskGraphCanvas.showcaseData.ts: the demo graphs the task graph showcases share. Copy is a
//! per-language pair. Model names are assembled from parts: showcase copy is not a model id,
//! and the source check keeps ids in the catalog.
use butler_ds::ui::blocks::task_graph_card::TaskGraphStatus as S;

use crate::copy::Lang;

/// A copy pair: English, then Korean.
#[derive(Clone, Copy)]
pub(crate) struct L {
    en: &'static str,
    ko: &'static str,
}

impl L {
    pub(crate) fn get(self, lang: Lang) -> &'static str {
        lang.pick(self.en, self.ko)
    }
}

const fn t(en: &'static str, ko: &'static str) -> L {
    L { en, ko }
}

/// One task of a demo graph (`DemoTask`).
pub(crate) struct DemoTask {
    pub(crate) id: &'static str,
    pub(crate) title: L,
    pub(crate) status: S,
    pub(crate) worker: Option<u8>,
    pub(crate) model: Option<&'static str>,
    /// Written "2m 05s"; stories read it through `demo::local_time`.
    pub(crate) time: Option<String>,
    pub(crate) step: Option<L>,
    pub(crate) reason: Option<L>,
}

/// A prerequisite edge: `(from, to)` task ids.
pub(crate) type Edge = (&'static str, &'static str);

/// A demo graph (`DemoGraph`).
pub(crate) struct DemoGraph {
    pub(crate) id: &'static str,
    pub(crate) title: L,
    pub(crate) tasks: Vec<DemoTask>,
    pub(crate) edges: Vec<Edge>,
}

impl DemoGraph {
    pub(crate) fn task(&self, id: &str) -> Option<&DemoTask> {
        self.tasks.iter().find(|task| task.id == id)
    }
}

/// The demo graphs by name (`GRAPHS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GraphId {
    One,
    Chain,
    ChainDone,
    Cancelled,
    Fanout,
    Failed,
    Skip,
    Long,
}

fn task(id: &'static str, title: L, status: S) -> DemoTask {
    DemoTask {
        id,
        title,
        status,
        worker: None,
        model: None,
        time: None,
        step: None,
        reason: None,
    }
}

impl DemoTask {
    fn by(mut self, worker: u8, model: &'static str, time: impl Into<String>) -> Self {
        self.worker = Some(worker);
        self.model = Some(model);
        self.time = Some(time.into());
        self
    }

    fn step(mut self, step: L) -> Self {
        self.step = Some(step);
        self
    }

    fn reason(mut self, reason: L) -> Self {
        self.reason = Some(reason);
        self
    }
}

fn luna() -> &'static str {
    concat!("GPT", "-6", " Luna")
}

fn sol() -> &'static str {
    concat!("GPT", "-6.1", " Sol")
}

fn fan(from: &'static str, to: &[&'static str]) -> Vec<Edge> {
    to.iter().map(|target| (from, *target)).collect()
}

fn chain(done: bool, cancelled: bool) -> Vec<DemoTask> {
    let move_files = t("Move and rename files", "파일 옮기고 이름 정리하기");
    let last = if cancelled {
        task("move", move_files, S::Cancelled)
    } else {
        let status = if done { S::Done } else { S::Running };
        let time = if done { "2m 41s" } else { "2m 05s" };
        task("move", move_files, status)
            .by(2, luna(), time)
            .step(t("Renaming documents", "문서 이름 고치는 중"))
    };
    let (rules_status, rules_time) = if cancelled {
        (S::Cancelled, "31s")
    } else {
        (S::Done, "1m 12s")
    };
    vec![
        task("scan", t("Scan the Downloads folder", "다운로드 폴더 훑어보기"), S::Done)
            .by(1, luna(), "48s"),
        task("rules", t("Decide how to sort", "정리 기준 정하기"), rules_status)
            .by(1, luna(), rules_time),
        last,
    ]
}

fn chain_edges() -> Vec<Edge> {
    vec![("scan", "rules"), ("rules", "move")]
}

fn research(failed: bool) -> Vec<DemoTask> {
    let step = t("Reading the pricing page", "요금제 페이지 읽는 중");
    let notion = t("Research Notion", "Notion 조사");
    let r2 = if failed {
        task("r2", notion, S::Failed)
            .by(3, luna(), "3m 31s")
            .reason(t("The pricing page did not open", "요금제 페이지를 열 수 없습니다"))
    } else {
        task("r2", notion, S::Running).by(3, luna(), "9m 01s").step(step)
    };
    let (r3_status, r3_time) = if failed { (S::Done, "2m 46s") } else { (S::Running, "9m 01s") };
    vec![
        task("brief", t("Set comparison criteria", "비교 기준 정리"), S::Done)
            .by(1, sol(), "1m 35s"),
        task("r1", t("Research Obsidian", "Obsidian 조사"), S::Done).by(2, luna(), "3m 04s"),
        r2,
        task("r3", t("Research Bear", "Bear 조사"), r3_status)
            .by(4, luna(), r3_time)
            .step(step),
        task(
            "compare",
            t("Build the comparison table", "세 앱 비교표 만들기"),
            if failed { S::Blocked } else { S::Pending },
        ),
        task("review", t("Review the result", "결과 검토"), S::Pending),
    ]
}

fn research_edges() -> Vec<Edge> {
    let mut edges = fan("brief", &["r1", "r2", "r3"]);
    for from in ["r1", "r2", "r3"] {
        edges.extend(fan(from, &["compare"]));
    }
    edges.extend(fan("compare", &["review"]));
    edges
}

fn skip() -> Vec<DemoTask> {
    vec![
        task("draft", t("Draft the notes", "초안 작성"), S::Done).by(1, sol(), "2m 10s"),
        task("links", t("Check every link", "링크 확인"), S::Running)
            .by(2, luna(), "1m 02s")
            .step(t("Opening links", "링크 여는 중")),
        task("shots", t("Retake screenshots", "스크린샷 다시 찍기"), S::Pending),
        task("publish", t("Publish", "게시"), S::Pending),
    ]
}

/// `LONG`: id, English, Korean, status.
const LONG: [(&str, &str, &str, S); 16] = [
    ("l1", "Confirm requirements", "요구사항 확인", S::Done),
    ("l2", "Study the search code", "현재 검색 코드 조사", S::Done),
    ("l3a", "Fix the ranking function", "정렬 함수 고치기", S::Done),
    ("l3b", "Rebuild the index", "색인 다시 만들기", S::Done),
    ("l3c", "Tidy the result labels", "화면 문구 정리", S::Done),
    ("l4", "Merge the changes", "변경 합치기", S::Done),
    ("l5a", "Check Korean search", "한국어 검색 확인", S::Done),
    ("l5b", "Check English search", "영어 검색 확인", S::Running),
    ("l5c", "Measure speed", "속도 측정", S::Running),
    ("l5d", "Check the screen", "화면 확인", S::Pending),
    ("l6", "Review results", "결과 검토", S::Pending),
    ("l7", "Apply review notes", "지적 사항 반영", S::Pending),
    ("l8a", "Update help", "도움말 갱신", S::Pending),
    ("l8b", "Write the changelog", "변경 기록 작성", S::Pending),
    ("l9", "Final check", "최종 확인", S::Pending),
    ("l10", "Report back", "결과 보고", S::Pending),
];

fn long_tasks() -> Vec<DemoTask> {
    LONG.iter()
        .enumerate()
        .map(|(index, &(id, en, ko, status))| {
            let base = task(id, t(en, ko), status);
            let worker = u8::try_from(index % 4 + 1).unwrap_or(1);
            let model = if index % 2 == 1 { sol() } else { luna() };
            match status {
                S::Pending => base,
                S::Running => base
                    .by(worker, model, "27m 01s")
                    .step(t("Reading code", "코드 읽는 중")),
                _ => base.by(worker, model, format!("{}m {}s", 1 + index % 3, 10 + index)),
            }
        })
        .collect()
}

fn long_edges() -> Vec<Edge> {
    let mut edges = fan("l1", &["l2"]);
    edges.extend(fan("l2", &["l3a", "l3b", "l3c"]));
    for from in ["l3a", "l3b", "l3c"] {
        edges.extend(fan(from, &["l4"]));
    }
    edges.extend(fan("l4", &["l5a", "l5b", "l5c", "l5d"]));
    for from in ["l5a", "l5b", "l5c", "l5d"] {
        edges.extend(fan(from, &["l6"]));
    }
    edges.extend(fan("l6", &["l7"]));
    edges.extend(fan("l7", &["l8a", "l8b"]));
    edges.extend(fan("l8a", &["l9"]));
    edges.extend(fan("l8b", &["l9"]));
    edges.extend(fan("l9", &["l10"]));
    edges
}

impl GraphId {
    pub(crate) fn build(self) -> DemoGraph {
        let (id, title, tasks, edges) = match self {
            Self::One => {
                let mut only = chain(false, false).remove(2);
                only.id = "one";
                only.worker = Some(1);
                ("one", t("Clean up meeting notes", "회의록 정리"), vec![only], Vec::new())
            }
            Self::Chain => (
                "chain",
                t("Tidy the Downloads folder", "다운로드 폴더 정리"),
                chain(false, false),
                chain_edges(),
            ),
            Self::ChainDone => (
                "chainDone",
                t("Tidy the Downloads folder", "다운로드 폴더 정리"),
                chain(true, false),
                chain_edges(),
            ),
            Self::Cancelled => (
                "cancelled",
                t("Sort the photo backup", "사진 백업 정리"),
                chain(false, true),
                chain_edges(),
            ),
            Self::Fanout => (
                "fanout",
                t("Compare three note apps", "노트 앱 세 개 비교"),
                research(false),
                research_edges(),
            ),
            Self::Failed => (
                "failed",
                t("Refresh the pricing table", "요금제 비교표 갱신"),
                research(true),
                research_edges(),
            ),
            Self::Skip => (
                "skip",
                t("Publish the release notes", "릴리스 노트 게시"),
                skip(),
                [
                    fan("draft", &["links", "publish"]),
                    fan("links", &["shots"]),
                    fan("shots", &["publish"]),
                ]
                .concat(),
            ),
            Self::Long => (
                "long",
                t("Improve search ranking", "검색 결과 정렬 개선"),
                long_tasks(),
                long_edges(),
            ),
        };
        DemoGraph {
            id,
            title,
            tasks,
            edges,
        }
    }
}
