//! ComposerQuestionPanel.showcase.tsx (+ fixtures.ts): one to four questions in place of the
//! composer input, in every state, and in the conversation. A finished panel hands its answers to
//! the QuestionAnswerCard, as the React demo does.
use butler_ds::ui::blocks::composer_card::{ComposerCard, Toolbar, textarea};
use butler_ds::ui::blocks::composer_panel::Placement;
use butler_ds::ui::blocks::composer_question_panel::{
    Answer, ComposerQuestionPanel, Labels, PanelState, Question, QuestionKind, QuestionOption,
};
use butler_ds::ui::blocks::question_answer_card as card;
use butler_ds::ui::button::{Button, Size, Variant};
use butler_ds::ui::layout::{Space, Stack};
use butler_ds::ui::typo::Typo;
use gpui::{AnyElement, App, Entity, IntoElement as _, ParentElement as _, SharedString, Window};

use super::{Story, sub};
use crate::copy::Lang;

/// `koLabels`, and the English defaults.
fn labels(lang: Lang) -> Labels {
    let s = |text: &'static str| SharedString::new_static(text);
    match lang {
        Lang::En => Labels::default(),
        Lang::Ko => Labels {
            review: s("확인"),
            send: s("보내기"),
            next: s("다음"),
            back: s("이전"),
            skip: s("건너뛰기"),
            skipped: s("건너뜀"),
            later: s("나중에"),
            pending: s("답변 대기"),
            other: s("직접 입력…"),
            recommended: s("추천"),
            working: s("작업 중"),
            select: s("선택"),
        },
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
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

/// `questionFixtures(ko)[kind]`.
fn fixtures(lang: Lang, kind: Kind) -> Vec<Question> {
    let single = {
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
    };
    let multi = {
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
    };
    let text = {
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
    };
    let with = |q: &Question,
                id: &'static str,
                header_text: (&'static str, &'static str),
                opts: Vec<QuestionOption>| {
        let mut next = q.clone();
        next.id = id.into();
        next.header = header_text.0.into();
        next.text = header_text.1.into();
        next.options = opts;
        next
    };
    let schedule = vec![
        with(
            &single,
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
            &multi,
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
    ];
    let onboarding = {
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
                &single,
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
                &single,
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
    };
    match kind {
        Kind::Single => vec![single],
        Kind::Multi => vec![multi],
        Kind::Text => vec![text],
        Kind::Schedule => schedule,
        Kind::Onboarding => onboarding,
        Kind::Four => schedule.into_iter().chain([text]).collect(),
    }
}

/// The QuestionAnswerCard's view of the panel's questions and answers.
fn card_question(question: &Question) -> card::Question {
    card::Question {
        id: question.id.clone(),
        header: question.header.clone(),
        kind: match question.kind {
            QuestionKind::Single => card::QuestionKind::Single,
            QuestionKind::Multi => card::QuestionKind::Multi,
            QuestionKind::Text => card::QuestionKind::Text,
        },
        options: question
            .options
            .iter()
            .map(|option| option.label.clone())
            .collect(),
    }
}

fn card_answer(answer: &Answer) -> card::Answer {
    card::Answer {
        id: answer.id.clone(),
        selected: answer.selected.clone(),
        text: answer.text.clone().into(),
        other: answer.other.clone().into(),
        skipped: answer.skipped,
    }
}

/// What the demo's owner holds besides the panel's own form state.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Answered,
    Skipped,
    Message,
}

struct Demo {
    key: &'static str,
    kind: Kind,
    initial: PanelState,
    step: usize,
}

pub(super) fn stories() -> Vec<Story> {
    vec![
        Story {
            name: "Single choice · recommended focus · Other",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-single", Kind::Single, PanelState::Open, 0),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Multiple choice · scroll fades",
            render: |l, w, c| run(l, demo("cq-multi", Kind::Multi, PanelState::Open, 0), w, c),
        },
        Story {
            name: "Short text",
            render: |l, w, c| run(l, demo("cq-text", Kind::Text, PanelState::Open, 0), w, c),
        },
        Story {
            name: "Three questions · Tabs · review",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-three", Kind::Schedule, PanelState::Open, 1),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Onboarding · new chat first turn",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-onboarding", Kind::Onboarding, PanelState::Open, 0),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Four questions · partial answers",
            render: |l, w, c| run(l, demo("cq-four", Kind::Four, PanelState::Open, 0), w, c),
        },
        Story {
            name: "Keyboard · focus panel to start",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-keyboard", Kind::Single, PanelState::Open, 0),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Review",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-review", Kind::Onboarding, PanelState::Open, 3),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Submitting",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-submitting", Kind::Onboarding, PanelState::Submitting, 3),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Error · retry",
            render: |l, w, c| run(l, demo("cq-error", Kind::Text, PanelState::Error, 0), w, c),
        },
        Story {
            name: "Collapsed · answer by message",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-collapsed", Kind::Single, PanelState::Collapsed, 0),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "Working · disabled",
            render: |l, w, c| {
                run(
                    l,
                    demo("cq-working", Kind::Single, PanelState::Working, 0),
                    w,
                    c,
                )
            },
        },
        Story {
            name: "In conversation · single choice",
            render: |l, w, c| conversation(l, "cq-conv-single", Kind::Single, w, c),
        },
        Story {
            name: "In conversation · three questions",
            render: |l, w, c| conversation(l, "cq-conv-three", Kind::Schedule, w, c),
        },
    ]
}

/// `defaultAnswers` for a review, a retry or a given step past the questions.
fn filled(lang: Lang, questions: &[Question]) -> Vec<Answer> {
    questions
        .iter()
        .map(|q| {
            let text = q.kind == QuestionKind::Text;
            Answer {
                id: q.id.clone(),
                selected: if text { Vec::new() } else { vec![0] },
                text: if text {
                    lang.pick("Alex", "민수").to_owned()
                } else {
                    String::new()
                },
                other: String::new(),
                skipped: false,
            }
        })
        .collect()
}

fn reset(label: &'static str, id: SharedString, on: impl Fn(&mut App) + 'static) -> AnyElement {
    Button::new(id)
        .size(Size::Sm)
        .variant(Variant::Borderless)
        .text(label)
        .on_click(move |_, _, cx| on(cx))
        .into_any_element()
}

fn demo(key: &'static str, kind: Kind, initial: PanelState, step: usize) -> Demo {
    Demo {
        key,
        kind,
        initial,
        step,
    }
}

fn run(lang: Lang, demo: Demo, window: &mut Window, cx: &mut App) -> AnyElement {
    let questions = fixtures(lang, demo.kind);
    let key = demo.key;
    let state: Entity<PanelState> =
        window.use_keyed_state(sub(key, "state"), cx, move |_, _| demo.initial);
    let result: Entity<Option<(Outcome, Vec<Answer>)>> =
        window.use_keyed_state(sub(key, "result"), cx, |_, _| None);
    let message: Entity<String> =
        window.use_keyed_state(sub(key, "message"), cx, |_, _| String::new());
    let draft: Entity<Option<(Vec<Answer>, usize)>> =
        window.use_keyed_state(sub(key, "draft"), cx, |_, _| None);
    let revision: Entity<usize> = window.use_keyed_state(sub(key, "revision"), cx, |_, _| 0);
    let body = lang.pick(
        if demo.kind == Kind::Onboarding {
            "Hello, I’m Butler. Let’s start with three questions."
        } else {
            "Ready. Choose a few details."
        },
        if demo.kind == Kind::Onboarding {
            "안녕하세요, 버틀러예요. 세 가지만 여쭤볼게요."
        } else {
            "준비됐어요. 몇 가지만 정해 주세요."
        },
    );
    let mut stack = Stack::new().gap(Space::Md).child(Typo::body(body));
    if let Some((outcome, answers)) = result.read(cx).clone() {
        let cards: Vec<card::Question> = questions.iter().map(card_question).collect();
        let given: Vec<card::Answer> = answers.iter().map(card_answer).collect();
        let variant = match outcome {
            Outcome::Answered => card::Variant::Answered,
            Outcome::Skipped => card::Variant::Skipped,
            Outcome::Message => card::Variant::Message,
        };
        let labels = lang.pick(
            card::Labels {
                answered: "Answered".into(),
                skipped: "Skipped".into(),
                message: "Answered by message".into(),
            },
            card::Labels {
                answered: "답변 완료".into(),
                skipped: "건너뜀".into(),
                message: "메시지로 답함".into(),
            },
        );
        let text = message.read(cx).clone();
        let answer_card = card::QuestionAnswerCard::new(sub(key, "card"), cards)
            .answers(given)
            .variant(variant)
            .labels(labels)
            .message(text);
        let (result, state, draft, revision, initial) = (
            result.clone(),
            state.clone(),
            draft.clone(),
            revision.clone(),
            demo.initial,
        );
        return stack
            .child(answer_card)
            .child(reset(
                lang.pick("Reset", "다시"),
                SharedString::from(format!("{key}-reset")),
                move |cx| {
                    result.update(cx, |value, cx| {
                        *value = None;
                        cx.notify();
                    });
                    state.update(cx, |value, cx| {
                        *value = initial;
                        cx.notify();
                    });
                    draft.update(cx, |value, _| *value = None);
                    revision.update(cx, |value, cx| {
                        *value += 1;
                        cx.notify();
                    });
                },
            ))
            .into_any_element();
    }
    let current = *state.read(cx);
    let revision_now = *revision.read(cx);
    let panel_id: SharedString = format!("{key}-panel-{revision_now}").into();
    let defaults = match draft.read(cx).clone() {
        Some((answers, _)) => answers,
        None if demo.initial == PanelState::Error || demo.step == questions.len() => {
            filled(lang, &questions)
        }
        None => Vec::new(),
    };
    let step = draft.read(cx).as_ref().map_or(demo.step, |(_, step)| *step);
    let (set_done, set_skip, set_collapse, set_expand, set_draft) = (
        result.clone(),
        result.clone(),
        state.clone(),
        state.clone(),
        draft.clone(),
    );
    let skip_questions = questions.clone();
    let mut panel = ComposerQuestionPanel::new(
        panel_id.clone(),
        questions.clone(),
        move |answers, _, cx| {
            let answers = answers.to_vec();
            set_done.update(cx, |value, cx| {
                *value = Some((Outcome::Answered, answers));
                cx.notify();
            });
        },
    )
    .labels(labels(lang))
    .state(if current == PanelState::Collapsed {
        PanelState::Collapsed
    } else {
        current
    })
    .default_answers(defaults)
    .default_step(step)
    .error(lang.pick(
        "Could not send. Try again.",
        "보내지 못했습니다. 다시 시도하세요.",
    ))
    .on_skip(move |_, cx| {
        let answers = skip_questions
            .iter()
            .map(|q| Answer::empty(q.id.clone()))
            .collect();
        set_skip.update(cx, |value, cx| {
            *value = Some((Outcome::Skipped, answers));
            cx.notify();
        });
    })
    .on_collapse(move |_, cx| {
        set_collapse.update(cx, |value, cx| {
            *value = PanelState::Collapsed;
            cx.notify();
        })
    })
    .on_expand(move |_, cx| {
        set_expand.update(cx, |value, cx| {
            *value = PanelState::Open;
            cx.notify();
        })
    })
    .on_draft_change(move |answers, step, cx| {
        set_draft.update(cx, |value, _| *value = Some((answers.to_vec(), step)));
    });
    panel = panel.placement(Placement::Composer);
    if current == PanelState::Collapsed {
        let text = message.read(cx).clone();
        let (set_text, send_result) = (message.clone(), result.clone());
        let replied_questions = questions;
        let mut send = Button::new(sub(key, "send"))
            .size(Size::Sm)
            .text(lang.pick("Send", "보내기"))
            .on_click(move |_, _, cx| {
                let answers = replied_questions
                    .iter()
                    .map(|q| Answer::empty(q.id.clone()))
                    .collect();
                send_result.update(cx, |value, cx| {
                    *value = Some((Outcome::Message, answers));
                    cx.notify();
                });
            });
        if text.trim().is_empty() {
            send = send.disabled();
        }
        let composer = ComposerCard::new(sub(key, "card"))
            .child(
                textarea(sub(key, "message"))
                    .placeholder(lang.pick("Write a message", "메시지 작성"))
                    .on_change(move |value, _, cx| {
                        let value = value.to_owned();
                        set_text.update(cx, |text, cx| {
                            *text = value;
                            cx.notify();
                        });
                    }),
            )
            .child(Toolbar::new().child(send));
        stack = stack.child(panel).child(composer);
    } else {
        stack = stack.child(ComposerCard::new(sub(key, "card")).child(panel));
    }
    stack.into_any_element()
}

/// `placement="conversation"`: the question where Butler asked it, with a reset once answered.
fn conversation(
    lang: Lang,
    key: &'static str,
    kind: Kind,
    window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let questions = fixtures(lang, kind);
    let state: Entity<PanelState> =
        window.use_keyed_state(sub(key, "state"), cx, |_, _| PanelState::Open);
    let result: Entity<Option<Vec<Answer>>> =
        window.use_keyed_state(sub(key, "result"), cx, |_, _| None);
    let revision: Entity<usize> = window.use_keyed_state(sub(key, "revision"), cx, |_, _| 0);
    let text = lang.pick(
        "Search results now sort by last modified.",
        "검색 결과를 최근 수정순으로 바꿨습니다.",
    );
    let mut stack = Stack::new().gap(Space::Md).child(Typo::body(text));
    if let Some(answers) = result.read(cx).clone() {
        let cards: Vec<card::Question> = questions.iter().map(card_question).collect();
        let given: Vec<card::Answer> = answers.iter().map(card_answer).collect();
        let labels = lang.pick(
            card::Labels {
                answered: "Answered".into(),
                skipped: "Skipped".into(),
                message: "Answered by message".into(),
            },
            card::Labels {
                answered: "답변 완료".into(),
                skipped: "건너뜀".into(),
                message: "메시지로 답함".into(),
            },
        );
        let (result, state, revision) = (result.clone(), state.clone(), revision.clone());
        return stack
            .child(
                card::QuestionAnswerCard::new(sub(key, "card"), cards)
                    .answers(given)
                    .variant(card::Variant::Answered)
                    .labels(labels),
            )
            .child(reset(
                lang.pick("Reset", "다시"),
                SharedString::from(format!("{key}-reset")),
                move |cx| {
                    result.update(cx, |value, cx| {
                        *value = None;
                        cx.notify();
                    });
                    state.update(cx, |value, cx| {
                        *value = PanelState::Open;
                        cx.notify();
                    });
                    revision.update(cx, |value, cx| {
                        *value += 1;
                        cx.notify();
                    });
                },
            ))
            .into_any_element();
    }
    let panel_id: SharedString = format!("{key}-panel-{}", *revision.read(cx)).into();
    let (set_done, set_skip, set_collapse, set_expand) =
        (result.clone(), result, state.clone(), state.clone());
    let skip_questions = questions.clone();
    let panel = ComposerQuestionPanel::new(panel_id, questions, move |answers, _, cx| {
        let answers = answers.to_vec();
        set_done.update(cx, |value, cx| {
            *value = Some(answers);
            cx.notify();
        });
    })
    .placement(Placement::Conversation)
    .labels(labels(lang))
    .state(*state.read(cx))
    .on_skip(move |_, cx| {
        let answers = skip_questions
            .iter()
            .map(|q| Answer::empty(q.id.clone()))
            .collect();
        set_skip.update(cx, |value, cx| {
            *value = Some(answers);
            cx.notify();
        });
    })
    .on_collapse(move |_, cx| {
        set_collapse.update(cx, |value, cx| {
            *value = PanelState::Collapsed;
            cx.notify();
        })
    })
    .on_expand(move |_, cx| {
        set_expand.update(cx, |value, cx| {
            *value = PanelState::Open;
            cx.notify();
        })
    });
    stack = stack.child(panel);
    stack.into_any_element()
}
