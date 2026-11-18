//! The question fixtures of the showcase (`fixtures.ts`).
use butler_ds::ui::blocks::composer_question_panel::{Question, QuestionKind, QuestionOption};

use crate::copy::Lang;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Single,
    Multi,
    Text,
    Schedule,
    Onboarding,
    Four,
}

fn options<const N: usize>(
    labels: [&'static str; N],
    describe: impl Fn(usize) -> Option<&'static str>,
    recommended: impl Fn(usize) -> bool,
) -> Vec<QuestionOption> {
    labels
        .iter()
        .enumerate()
        .map(|(index, label)| {
            let mut option = QuestionOption::new(*label);
            if let Some(text) = describe(index) {
                option = option.description(text);
            }
            if recommended(index) {
                option = option.recommended();
            }
            option
        })
        .collect()
}

fn question(
    id: &'static str,
    (header, text): (&'static str, &'static str),
    kind: QuestionKind,
    options: Vec<QuestionOption>,
) -> Question {
    Question {
        id: id.into(),
        header: header.into(),
        text: text.into(),
        kind,
        options,
        allow_other: kind != QuestionKind::Text,
        placeholder: None,
    }
}

/// One question of `base` with its id, header, text and options replaced.
fn with(
    base: &Question,
    id: &'static str,
    header_text: (&'static str, &'static str),
    opts: Vec<QuestionOption>,
) -> Question {
    let mut next = base.clone();
    next.id = id.into();
    next.header = header_text.0.into();
    next.text = header_text.1.into();
    next.options = opts;
    next
}

fn single_question(lang: Lang) -> Question {
    let mut q = question(
        "save",
        lang.pick(
            ("Save location", "Where should I save it?"),
            ("저장 위치", "어디에 저장할까요?"),
        ),
        QuestionKind::Single,
        vec![
            QuestionOption::new(lang.pick("Project folder", "프로젝트 폴더"))
                .description("Butler/Notes")
                .recommended(),
            QuestionOption::new(lang.pick("Desktop", "바탕화면")),
            QuestionOption::new(lang.pick("Ask each time", "매번 묻기"))
                .description(lang.pick("Confirm before saving", "저장할 때마다 확인")),
        ],
    );
    q.allow_other = true;
    q
}

fn multi_question(lang: Lang) -> Question {
    let names = lang.pick(
        [
            "Task complete",
            "Approval request",
            "Schedule results",
            "Errors",
            "Worker status",
            "Updates",
        ],
        [
            "작업 완료",
            "허용 요청",
            "예약 작업 결과",
            "오류",
            "워커 상태",
            "업데이트 소식",
        ],
    );
    let note = lang.pick("Notify when the status changes", "상태가 바뀌면 알림");
    question(
        "notifications",
        lang.pick(
            ("Notifications", "Which notifications do you want?"),
            ("알림", "어떤 알림을 받을까요?"),
        ),
        QuestionKind::Multi,
        options(names, |i| (i < 4).then_some(note), |i| i == 1),
    )
}

fn text_question(lang: Lang) -> Question {
    let mut q = question(
        "name",
        lang.pick(
            ("Project name", "Choose a name"),
            ("프로젝트 이름", "이름을 정해 주세요"),
        ),
        QuestionKind::Text,
        Vec::new(),
    );
    q.placeholder = Some(lang.pick("e.g. Quarterly report", "예: 분기 보고서").into());
    q
}

fn schedule_questions(lang: Lang, single: &Question, multi: &Question) -> Vec<Question> {
    vec![
        with(
            single,
            "frequency",
            lang.pick(
                ("Frequency", "When should it run?"),
                ("주기", "언제 실행할까요?"),
            ),
            options(
                lang.pick(
                    ["Daily at 8 am", "Weekdays at 8 am", "Mondays at 9 am"],
                    ["매일 아침 8시", "평일 아침 8시", "매주 월요일 9시"],
                ),
                |_| None,
                |i| i == 0,
            ),
        ),
        with(
            multi,
            "scope",
            lang.pick(
                ("Scope", "What should I summarize?"),
                ("범위", "무엇을 요약할까요?"),
            ),
            options(
                lang.pick(
                    ["Inbox", "Calendar", "Mentions"],
                    ["받은 메일", "캘린더", "메신저 멘션"],
                ),
                |_| None,
                |_| false,
            ),
        ),
        {
            let mut destination = single.clone();
            destination.id = "destination".into();
            destination.header = lang.pick("Destination", "받을 곳").into();
            destination.text = lang
                .pick("Where should I send it?", "어디로 보낼까요?")
                .into();
            destination
        },
    ]
}

fn onboarding_questions(lang: Lang, single: &Question, text: &Question) -> Vec<Question> {
    let mut name = text.clone();
    name.header = lang.pick("Name", "호칭").into();
    name.text = lang
        .pick("What should I call you?", "어떻게 불러 드릴까요?")
        .into();
    name.placeholder = Some(lang.pick("Name or nickname", "이름이나 별명").into());
    let detail = lang.pick("Documents, schedules and tasks", "문서·일정·작업");
    vec![
        name,
        with(
            single,
            "purpose",
            lang.pick(
                ("Purpose", "How will you use Butler?"),
                ("주 용도", "버틀러를 어디에 쓰실 건가요?"),
            ),
            options(
                lang.pick(
                    ["Work", "Development", "Personal"],
                    ["업무", "개발", "개인"],
                ),
                |_| Some(detail),
                |i| i == 0,
            ),
        ),
        with(
            single,
            "language",
            lang.pick(
                ("Language", "Which tone do you prefer?"),
                ("언어·말투", "어떤 말투가 편하세요?"),
            ),
            options(
                lang.pick(
                    ["Korean · polite", "Korean · casual", "English"],
                    ["한국어 · 존댓말", "한국어 · 반말", "English"],
                ),
                |_| None,
                |i| i == 0,
            ),
        ),
    ]
}

/// `questionFixtures(ko)[kind]`.
pub(super) fn fixtures(lang: Lang, kind: Kind) -> Vec<Question> {
    let single = single_question(lang);
    let multi = multi_question(lang);
    let text = text_question(lang);
    match kind {
        Kind::Single => vec![single],
        Kind::Multi => vec![multi],
        Kind::Text => vec![text],
        Kind::Schedule => schedule_questions(lang, &single, &multi),
        Kind::Onboarding => onboarding_questions(lang, &single, &text),
        Kind::Four => schedule_questions(lang, &single, &multi)
            .into_iter()
            .chain([text])
            .collect(),
    }
}
