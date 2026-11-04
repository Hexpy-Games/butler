use super::{
    ax, inject,
    scene::{self, Auxiliary, Scene},
};
use crate::state::Runtime;
use gpui::{prelude::*, *};
use gpui_ce_elements::editable_text::{EditableTextState, StringStorage};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::PathBuf,
    time::{Duration, Instant},
};
const KOREAN: &str = "com.apple.inputmethod.Korean.2SetKorean";
const ABC: &str = "com.apple.keylayout.ABC";
#[derive(Clone)]
enum Action {
    Focus(&'static str),
    Source(&'static str),
    Clear(usize),
    Type(&'static str),
    Key(u16, &'static str, u64),
    ClickField,
    Second,
    Main,
    WebClick,
    WebRead,
    Tabs,
    Stream,
    Cef,
    Restore,
}
struct Step {
    id: &'static str,
    actions: Vec<Action>,
    checks: Vec<(&'static str, Value)>,
    ax: bool,
    shot: bool,
    wait_ms: u64,
}
fn step(id: &'static str, actions: Vec<Action>, checks: Vec<(&'static str, Value)>) -> Step {
    Step {
        id,
        actions,
        checks,
        ax: false,
        shot: false,
        wait_ms: 250,
    }
}
fn steps() -> Vec<Step> {
    use self::Action::*;
    let enter = Key(36, "\r", 0);
    let delete = Key(51, "\u{7f}", 0);
    // Keep the action/check table in rows so it can be compared directly with the specification.
    #[rustfmt::skip]
    let mut steps = vec![
        step("S0", vec![Focus("field_a"), Source(KOREAN)], vec![("/isActive", json!(true)), ("/key_window", json!("main"))]),
        step("K1a", vec![Type("gksrmf")], vec![("/field_a/text", json!("한글")), ("/field_a/marked_text", json!("글"))]),
        step("K1b", vec![Type(" ")], vec![("/field_a/text", json!("한글 ")), ("/field_a/marked_text", Value::Null)]),
        step("K2", vec![Clear(0), Type("dkssud"), enter.clone()], vec![("/field_a/text", json!("안녕")), ("/field_a/marked_text", Value::Null), ("/submit_count_a", json!(1))]),
        step("K3", vec![Clear(0), Type("rk.rk,rk?")], vec![("/field_a/text", json!("가.가,가?"))]),
        step("K4a", vec![Clear(0), Type("gks")], vec![("/field_a/marked_text", json!("한"))]),
        step("K4b", vec![delete.clone()], vec![("/field_a/marked_text", json!("하"))]),
        step("K4c", vec![delete.clone()], vec![("/field_a/marked_text", json!("ㅎ"))]),
        step("K4d", vec![delete], vec![("/field_a/text", json!("")), ("/field_a/marked_text", Value::Null)]),
        step("K4e", vec![Type("rk ")], vec![("/field_a/text", json!("가 "))]),
        step("K5", vec![Clear(0), Type("dkssudgktpdy ekfrdl rkqtdms dhkd Tkd ")], vec![("/field_a/text", json!("안녕하세요 닭이 값은 왕 쌍 "))]),
        step("K6", vec![Clear(0), Source(ABC), Type("abc "), Source(KOREAN), Type("gks"), Source(ABC), Type("def")], vec![("/field_a/text", json!("abc 한def"))]),
        step("K7a", vec![Clear(0), Clear(1), Focus("field_a"), Source(KOREAN), Type("gk")], vec![("/field_a/marked_text", json!("하"))]),
        step("K7b", vec![ClickField], vec![("/field_a/text", json!("하")), ("/field_a/marked_text", Value::Null)]),
        step("K7c", vec![Type("s")], vec![("/field_b/text", json!("ㄴ")), ("/field_b/marked_text", json!("ㄴ")), ("/field_a/text", json!("하"))]),
        step("K7d", vec![Clear(0), Clear(1), Focus("field_a"), Type("gk"), Key(48, "\t", 0)], vec![("/field_a/text", json!("하")), ("/field_a/marked_text", Value::Null), ("/focused", json!("field_b"))]),
        step("K8a", vec![Clear(0), Focus("field_a"), Type("gk"), Second, Type("s")], vec![("/field_c/text", json!("ㄴ"))]),
        step("K8b", vec![Main, Focus("field_a")], vec![("/field_a/text", json!("하")), ("/field_a/marked_text", Value::Null)]),
        step("K9a", vec![Clear(0), Type("gks"), Key(36, "\r", 1 << 19)], vec![("/foreign_window_appeared", json!(true))]),
        step("K9b", vec![enter.clone()], vec![("/single_hanja", json!(true)), ("/field_a/marked_text", Value::Null)]),
        step("K10a", vec![Focus("composer"), Clear(2), Type("dkssud"), Key(36, "\r", 1 << 17), Type("gktpdy ")], vec![("/composer/text", json!("안녕\n하세요 "))]),
        step("K10b", vec![Clear(2), Type("rkskek"), enter.clone()], vec![("/last_row", json!("가나다")), ("/composer/text", json!(""))]),
        step("K11a", vec![WebClick, Type("gksrm")], vec![]),
        step("K11b", vec![Type("f "), WebRead], vec![("/web_in", json!("한글 "))]),
        step("A1", vec![Source(ABC)], vec![("/ax_checks/send_button", json!(true)), ("/ax_checks/settings_disabled", json!(true)), ("/ax_checks/title_field", json!(true)), ("/ax_checks/composer_area", json!(true)), ("/ax_checks/list_rows", json!(3))]),
        step("A2", vec![Focus("field_a"), Tabs], vec![("/tab_sequence", json!(scene::ORDER .into_iter() .cycle() .take(10) .collect::<Vec<_>>()))]),
        step("A3a", vec![Focus("더보기"), enter.clone()], vec![("/menu", json!(true)), ("/ax_checks/menu_items", json!(3)), ("/ax_checks/menu", json!(true)), ("/focused", json!("복사"))]),
        step("A3b", vec![Key(125, "\u{f701}", 0)], vec![("/focused", json!("편집"))]),
        step("A3c", vec![Key(53, "\u{1b}", 0)], vec![("/menu", json!(false)), ("/focused", json!("더보기"))]),
        step("A4a", vec![Focus("열기"), enter], vec![("/dialog", json!(true)), ("/ax_checks/dialog", json!(true)), ("/focused", json!("확인"))]),
        step("A4b", vec![Key(48, "\t", 0), Key(48, "\t", 0)], vec![("/focused", json!("확인"))]),
        step("A4c", vec![Key(53, "\u{1b}", 0)], vec![("/dialog", json!(false)), ("/focused", json!("열기"))]),
        step("A5", vec![Stream], vec![("/stream_samples_match", json!(true))]),
        step("A6", vec![Cef], vec![]),
        step("END", vec![Restore], vec![]),
    ];
    for s in &mut steps {
        s.shot = ["K1a", "K7b", "K9a", "K11a", "A4a"].contains(&s.id);
        s.ax = ["A1", "A3a", "A4a", "A5"].contains(&s.id);
    }
    steps
}
struct Runner {
    main: WindowHandle<Scene>,
    rt: Runtime,
    out: PathBuf,
    second: Option<WindowHandle<Auxiliary>>,
    extra: Value,
    original: inject::InputSource,
    previous_foreign: Value,
}
pub async fn run(
    main: WindowHandle<Scene>,
    rt: Runtime,
    out: PathBuf,
    cx: &mut AsyncApp,
) -> Result<(), String> {
    let mut runner = Runner {
        main,
        rt,
        out,
        second: None,
        extra: json!({}),
        original: inject::InputSource::remember(),
        previous_foreign: ax::foreign_windows(),
    };
    let mut results =
        std::fs::File::create(runner.out.join("results.jsonl")).map_err(|e| e.to_string())?;
    for step in steps() {
        runner.extra = json!({});
        for action in &step.actions {
            runner.action(action, cx).await?;
            wait(cx, step.wait_ms).await;
        }
        let mut snapshot = runner.snapshot(cx)?;
        if step.ax {
            let tree = ax::dump_ax(inject::window("main"));
            std::fs::write(
                runner.out.join(format!("ax-{}.json", step.id)),
                serde_json::to_vec_pretty(&tree).unwrap(),
            )
            .map_err(|e| e.to_string())?;
        }
        if step.shot {
            snapshot["shot_missing"] = json!(!runner.shot(step.id, cx).await?);
        }
        snapshot["step"] = json!(step.id);
        snapshot["checks"] = json!(step.checks.iter().map(|(name,expected)| {
            let actual = snapshot.pointer(name).cloned().unwrap_or(Value::Null);
            json!({"name":name,"expected":expected,"actual":actual,"pass":actual==*expected})
        }).collect::<Vec<_>>());
        writeln!(results, "{snapshot}").map_err(|e| e.to_string())?;
        results.flush().map_err(|e| e.to_string())?;
        runner.previous_foreign = snapshot["foreign_windows"].clone();
    }
    runner.original.restore();
    Ok(())
}
async fn wait(cx: &AsyncApp, ms: u64) {
    cx.background_executor()
        .timer(Duration::from_millis(ms))
        .await;
}
impl Runner {
    async fn action(&mut self, action: &Action, cx: &mut AsyncApp) -> Result<(), String> {
        match action {
            Action::Focus(id) => {
                self.main
                    .update(cx, |s, w, cx| s.focus(id, w, cx))
                    .map_err(|e| e.to_string())?;
            }
            Action::Source(id) => inject::select_input_source(id)?,
            Action::Clear(index) => {
                self.main
                    .update(cx, |s, _, cx| s.clear(*index, cx))
                    .map_err(|e| e.to_string())?;
            }
            Action::Type(text) => {
                inject::type_keys(text, cx).await;
            }
            Action::Key(code, chars, mods) => inject::key(*code, chars, chars, *mods),
            Action::ClickField => self.click_field(cx)?,
            Action::Second => self.open_second(cx)?,
            Action::Main => inject::make_key("main"),
            Action::WebClick => self.web_click(cx).await?,
            Action::WebRead => {
                self.extra["web_in"] = self.eval("document.getElementById('web_in').value").await;
            }
            Action::Tabs => self.tabs(cx).await?,
            Action::Stream => self.stream(cx).await?,
            Action::Cef => self.extra["cef_accessibility"] = ax::cef_snapshot(),
            Action::Restore => {
                if !self.original.restore() {
                    return Err("input source restoration failed".into());
                }
            }
        }
        Ok(())
    }
    fn open_second(&mut self, cx: &mut AsyncApp) -> Result<(), String> {
        let window = cx
            .update(|cx| {
                cx.open_window(
                    super::options("보조 창", 1200., 40., 400., 200.),
                    |w, cx| {
                        w.set_a11y_forced(true);
                        let field =
                            cx.new(|cx| EditableTextState::new(StringStorage::default(), cx));
                        w.focus(&field.read(cx).focus_handle(cx), cx);
                        cx.new(|_| Auxiliary(field))
                    },
                )
            })
            .map_err(|e| e.to_string())?;
        self.second = Some(window);
        inject::make_key("보조 창");
        Ok(())
    }
    fn click_field(&self, cx: &mut AsyncApp) -> Result<(), String> {
        let bounds = self
            .main
            .update(cx, |s, _, _| *s.field_b_bounds.borrow())
            .map_err(|e| e.to_string())?;
        let center = bounds.center();
        inject::click_content(
            inject::window("main"),
            inject::Point {
                x: f64::from(f32::from(center.x)),
                y: f64::from(f32::from(center.y)),
            },
        );
        Ok(())
    }
    async fn eval(&self, expression: &str) -> Value {
        if let Some(host) = self.rt.host() {
            self.rt.cdp.eval(&host, expression, false).await
        } else {
            Value::Null
        }
    }
    async fn web_click(&self, cx: &mut AsyncApp) -> Result<(), String> {
        let rect = self.eval("(()=>{let r=document.getElementById('web_in').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()").await;
        let b = self.rt.shared.borrow().bounds;
        let window = inject::window("main");
        let x = f64::from(f32::from(b.origin.x))
            + rect["x"].as_f64().ok_or("web_in rect unavailable")?
            + rect["width"].as_f64().unwrap_or(0.) / 2.;
        let y = f64::from(f32::from(b.origin.y))
            + rect["y"].as_f64().unwrap_or(0.)
            + rect["height"].as_f64().unwrap_or(0.) / 2.;
        let _ = cx;
        inject::click_content(window, inject::Point { x, y });
        Ok(())
    }
    async fn tabs(&mut self, cx: &mut AsyncApp) -> Result<(), String> {
        let mut ids = vec![json!("field_a")];
        let mut focused = vec![ax::focused()];
        for _ in 0..9 {
            inject::key(48, "\t", "\t", 0);
            wait(cx, 250).await;
            ids.push(json!(
                self.main
                    .update(cx, |s, w, cx| s.focused(w, cx))
                    .map_err(|e| e.to_string())?
            ));
            focused.push(ax::focused());
        }
        self.extra["tab_sequence"] = json!(ids);
        self.extra["tab_ax_focused"] = json!(focused);
        Ok(())
    }
    async fn stream(&mut self, cx: &mut AsyncApp) -> Result<(), String> {
        let text: Vec<char> = "안녕하세요. 버틀러가 답변을 작성하고 있습니다."
            .chars()
            .collect();
        let mut samples = Vec::new();
        self.main
            .update(cx, |s, _, cx| {
                s.stream.clear();
                cx.notify();
            })
            .map_err(|e| e.to_string())?;
        let started = Instant::now();
        for (i, c) in text.iter().enumerate() {
            let deadline = Duration::from_millis((i as u64 + 1) * 100);
            cx.background_executor()
                .timer(deadline.saturating_sub(started.elapsed()))
                .await;
            self.main
                .update(cx, |s, _, cx| {
                    s.stream.push(*c);
                    cx.notify();
                })
                .map_err(|e| e.to_string())?;
            // Let AccessKit publish this frame before sampling its native projection.
            if i == 2 || i == 14 || i == text.len() - 1 {
                cx.background_executor()
                    .timer(Duration::from_millis(1))
                    .await;
                let model = self
                    .main
                    .update(cx, |s, _, _| s.stream.clone())
                    .map_err(|e| e.to_string())?;
                let tree = ax::dump_ax(inject::window("main"));
                let mut nodes = Vec::new();
                ax::nodes(&tree, &mut nodes);
                let node = nodes
                    .iter()
                    .find(|n| n["label"] == "응답")
                    .copied()
                    .cloned()
                    .unwrap_or(Value::Null);
                let matches = ["value", "label", "title"]
                    .iter()
                    .any(|key| node[*key] == model);
                samples.push(json!({"at_ms":started.elapsed().as_millis(),"model":model,"ax":node,"pass":matches}));
            }
        }
        self.extra["stream_samples_match"] = json!(samples.iter().all(|s| s["pass"] == true));
        self.extra["stream_samples"] = json!(samples);
        Ok(())
    }
    fn snapshot(&self, cx: &mut AsyncApp) -> Result<Value, String> {
        let mut result = self.main.update(cx,|s,w,cx| {
            json!({"field_a":scene::field_snapshot(&s.fields[0],w,cx),"field_b":scene::field_snapshot(&s.fields[1],w,cx),
                "composer":scene::field_snapshot(&s.fields[2],w,cx),"focused":s.focused(w,cx),"submit_count_a":s.submit_count_a,
                "list_rows":s.rows,"last_row":s.rows.last(),"stream":s.stream,"menu":s.menu,"dialog":s.dialog})
        }).map_err(|e|e.to_string())?;
        result["field_c"] = if let Some(second) = self.second {
            second
                .update(cx, |s, w, cx| scene::field_snapshot(&s.0, w, cx))
                .map_err(|e| e.to_string())?
        } else {
            Value::Null
        };
        let foreign = ax::foreign_windows();
        result["foreign_window_appeared"] = json!(
            foreign.as_array().unwrap().iter().any(|w| !self
                .previous_foreign
                .as_array()
                .unwrap()
                .contains(w))
        );
        result["foreign_windows"] = foreign;
        result["ax_focused"] = ax::focused();
        result["bounds_for_range_screen"] = inject::caret_rect();
        result["single_hanja"] = json!(
            result["field_a"]["text"]
                .as_str()
                .is_some_and(|s| s.chars().count() == 1
                    && s.chars().all(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)))
        );
        result
            .as_object_mut()
            .unwrap()
            .extend(inject::status().as_object().unwrap().clone());
        result["ax_checks"] = ax_checks();
        result
            .as_object_mut()
            .unwrap()
            .extend(self.extra.as_object().unwrap().clone());
        Ok(result)
    }
    async fn shot(&self, id: &str, cx: &mut AsyncApp) -> Result<bool, String> {
        let ready = self.out.join(format!("shot-{id}.ready"));
        std::fs::write(ready, inject::shot_info().to_string()).map_err(|e| e.to_string())?;
        let done = self.out.join(format!("shot-{id}.done"));
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            if done.exists() {
                return Ok(true);
            }
            wait(cx, 50).await;
        }
        Ok(false)
    }
}
fn ax_checks() -> Value {
    let tree = ax::dump_ax(inject::window("main"));
    let mut nodes = Vec::new();
    ax::nodes(&tree, &mut nodes);
    let has = |role: &str, label: &str| {
        nodes
            .iter()
            .any(|n| n["role"] == role && n["label"] == label)
    };
    let list_rows = nodes
        .iter()
        .find(|n| n["role"] == "AXList")
        .map(|n| n["child_count"].clone())
        .unwrap_or(Value::Null);
    let dialog = nodes
        .iter()
        .find(|n| n["label"] == "확인 대화상자")
        .copied()
        .cloned()
        .unwrap_or(Value::Null);
    json!({"send_button":has("AXButton","보내기"),"settings_disabled":nodes.iter().any(|n|n["label"]=="설정" && n["enabled"]==false),
        "title_field":has("AXTextField","제목"),"composer_area":has("AXTextArea","메시지 입력"),"list_rows":list_rows,
        "web_content":nodes.iter().any(|n|n.to_string().contains("웹 제목") || n.to_string().contains("웹 버튼")),
        "menu":nodes.iter().any(|n|n["role"]=="AXMenu"),"menu_items":nodes.iter().filter(|n|n["role"]=="AXMenuItem").count(),
        "dialog":!dialog.is_null(),"dialog_node":dialog})
}
