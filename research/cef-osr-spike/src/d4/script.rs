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
    Key(u16, u64),
    ClickField,
    Second,
    Main,
    WebClick,
    WebRead,
    Tabs,
    Stream,
    Cef,
    Restore,
    RememberFieldA,
}
struct Step {
    id: &'static str,
    actions: Vec<Action>,
    checks: Vec<(&'static str, Value)>,
    ax: bool,
    shot: bool,
    wait_ms: u64,
    sample_ms: &'static [u64],
}
fn step(
    id: &'static str,
    shot: bool,
    ax: bool,
    sample_ms: &'static [u64],
    actions: Vec<Action>,
    checks: Vec<(&'static str, Value)>,
) -> Step {
    Step {
        id,
        actions,
        checks,
        ax,
        shot,
        wait_ms: 250,
        sample_ms,
    }
}
#[rustfmt::skip]
fn steps() -> Vec<Step> {
    use self::Action::*;
    let enter = Key(36, 0);
    let delete = Key(51, 0);
    // Keep the action/check table in rows so it can be compared directly with the specification.
    vec![
        step("S0", false, false, &[], vec![Focus("field_a"), Source(KOREAN)], vec![("/isActive", json!(true)), ("/key_window", json!("main"))]),
        step("K1a", true, false, &[], vec![Type("gksrmf")], vec![("/field_a/text", json!("한글")), ("/field_a/marked_text", json!("글"))]),
        step("K1b", false, false, &[], vec![Type(" ")], vec![("/field_a/text", json!("한글 ")), ("/field_a/marked_text", Value::Null)]),
        step("K2", false, false, &[], vec![Clear(0), Type("dkssud"), enter.clone()], vec![("/field_a/text", json!("안녕")), ("/field_a/marked_text", Value::Null), ("/submit_count_a", json!(1))]),
        step("K3", false, false, &[], vec![Clear(0), Type("rk.rk,rk?")], vec![("/field_a/text", json!("가.가,가?"))]),
        step("K4a", false, false, &[], vec![Clear(0), Type("gks")], vec![("/field_a/marked_text", json!("한"))]),
        step("K4b", true, false, &[], vec![delete.clone()], vec![("/field_a/marked_text", json!("하"))]),
        step("K4c", false, false, &[], vec![delete.clone()], vec![("/field_a/marked_text", json!("ㅎ"))]),
        step("K4d", false, false, &[], vec![delete], vec![("/field_a/text", json!("")), ("/field_a/marked_text", Value::Null)]),
        step("K4e", false, false, &[], vec![Type("rk ")], vec![("/field_a/text", json!("가 "))]),
        step("K5", false, false, &[], vec![Clear(0), Type("dkssudgktpdy ekfrdl rkqtdms dhkd Tkd ")], vec![("/field_a/text", json!("안녕하세요 닭이 값은 왕 쌍 "))]),
        step("K6", false, false, &[], vec![Clear(0), Source(ABC), Type("abc "), Source(KOREAN), Type("gks"), Source(ABC), Type("def")], vec![("/field_a/text", json!("abc 한def"))]),
        step("K7a", false, false, &[], vec![Clear(0), Clear(1), Focus("field_a"), Source(KOREAN), Type("gk")], vec![("/field_a/marked_text", json!("하"))]),
        step("K7b", true, false, &[], vec![ClickField], vec![("/field_a/text", json!("하")), ("/field_a/marked_text", Value::Null)]),
        step("K7c", true, false, &[], vec![Type("s")], vec![("/field_b/text", json!("ㄴ")), ("/field_b/marked_text", json!("ㄴ")), ("/field_a/text", json!("하"))]),
        step("K7d", false, false, &[], vec![Clear(0), Clear(1), Focus("field_a"), Type("gk"), Key(48, 0)], vec![("/field_a/text", json!("하")), ("/field_a/marked_text", Value::Null), ("/focused", json!("field_b"))]),
        step("K8a", false, false, &[], vec![Clear(0), Focus("field_a"), Type("gk"), Second, Type("s")], vec![("/field_c/text", json!("ㄴ"))]),
        step("K8b", true, false, &[], vec![Main, Focus("field_a")], vec![("/field_a/text", json!("하")), ("/field_a/marked_text", Value::Null)]),
        step("K9a", true, false, &[], vec![Clear(0), Type("gks"), Key(36, 1 << 19)], vec![("/candidate_near_caret", json!(true))]),
        step("K9b", false, false, &[], vec![enter.clone()], vec![("/single_hanja", json!(true)), ("/field_a/marked_text", Value::Null)]),
        step("K10a", true, false, &[], vec![Focus("composer"), Clear(2), Type("dkssud"), Key(36, 1 << 17), Type("gktpdy ")], vec![("/composer/text", json!("안녕\n하세요 "))]),
        step("K10b", false, false, &[], vec![Clear(2), Type("rkskek"), enter.clone()], vec![("/last_row", json!("가나다")), ("/composer/text", json!(""))]),
        step("K12a", true, false, &[], vec![Clear(0), Clear(1), Focus("field_a"), Source(KOREAN), Type("gks"), Key(36, 1 << 19)], vec![("/field_a/marked_text", json!("韓"))]),
        step("K12b", true, false, &[], vec![ClickField, RememberFieldA], vec![("/field_a/marked_text", Value::Null), ("/field_a_hanja_or_hangul", json!(true)), ("/field_b/text", json!(""))]),
        step("K12c", false, false, &[], vec![Type("rk")], vec![("/field_b/text", json!("가")), ("/field_a_unchanged", json!(true))]),
        step("K13a", false, false, &[], vec![Clear(0), Clear(1), Focus("field_a"), Source(KOREAN), Type("gks"), Key(36, 1 << 19)], vec![("/field_a/marked_text", json!("韓"))]),
        step("K13b", false, false, &[], vec![Key(48, 0), RememberFieldA], vec![("/field_a/marked_text", Value::Null), ("/focused", json!("field_b"))]),
        step("K13c", false, false, &[], vec![Type("rk")], vec![("/field_b/text", json!("가")), ("/field_a_unchanged", json!(true))]),
        step("K11a", true, false, &[], vec![WebClick, Type("gksrm")], vec![]),
        step("K11b", true, false, &[], vec![Type("f "), WebRead], vec![("/web_in", json!("한글 "))]),
        step("A1", false, true, &[], vec![Source(ABC)], vec![("/ax_checks/send_button", json!(true)), ("/ax_checks/settings_disabled", json!(true)), ("/ax_checks/title_field", json!(true)), ("/ax_checks/composer_area", json!(true)), ("/ax_checks/list_rows_match", json!(true))]),
        step("A2", false, false, &[], vec![Focus("field_a"), Tabs], vec![("/tab_sequence", json!(["field_a", "field_b", "composer", "보내기", "첨부", "더보기", "열기", "page"].into_iter().cycle().take(10) .collect::<Vec<_>>()))]),
        step("A3a", true, true, &[], vec![Focus("더보기"), enter.clone()], vec![("/menu", json!(true)), ("/ax_checks/menu_items", json!(3)), ("/ax_checks/menu", json!(true)), ("/ax_focused_node/title", json!("복사"))]),
        step("A3b", false, false, &[], vec![Key(125, 0)], vec![("/ax_focused_node/title", json!("편집"))]),
        step("A3c", false, false, &[], vec![Key(53, 0)], vec![("/menu", json!(false)), ("/ax_focused_node/title", json!("더보기"))]),
        step("A4a", true, true, &[], vec![Focus("열기"), enter], vec![("/dialog", json!(true)), ("/ax_checks/dialog", json!(true)), ("/ax_focused_node/title", json!("확인"))]),
        step("A4b", false, false, &[], vec![Key(48, 0), Key(48, 0)], vec![("/ax_focused_node/title", json!("확인"))]),
        step("A4c", false, false, &[], vec![Key(53, 0)], vec![("/dialog", json!(false)), ("/ax_focused_node/title", json!("열기"))]),
        step("A5", true, true, &[300, 1500, 2600], vec![Stream], vec![("/stream_samples_match", json!(true))]),
        step("A6", false, false, &[], vec![Cef], vec![]),
        step("END", false, false, &[], vec![Restore], vec![]),
    ]
}
struct Runner {
    main: WindowHandle<Scene>,
    rt: Runtime,
    out: PathBuf,
    second: Option<WindowHandle<Auxiliary>>,
    extra: Value,
    original: inject::InputSource,
    saved_field_a: Value,
    baseline: Value,
}
pub async fn run(
    main: WindowHandle<Scene>,
    rt: Runtime,
    out: PathBuf,
    baseline: Value,
    cx: &mut AsyncApp,
) -> Result<(), String> {
    let mut runner = Runner {
        main,
        rt,
        out,
        second: None,
        extra: json!({}),
        original: inject::InputSource::remember(),
        saved_field_a: Value::Null,
        baseline,
    };
    let mut results =
        std::fs::File::create(runner.out.join("results.jsonl")).map_err(|e| e.to_string())?;
    for step in steps() {
        runner.extra = json!({});
        inject::take_first_key_chars();
        for action in &step.actions {
            runner.action(action, step.sample_ms, cx).await?;
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
    async fn action(
        &mut self,
        action: &Action,
        times: &[u64],
        cx: &mut AsyncApp,
    ) -> Result<(), String> {
        match action {
            Action::RememberFieldA => {
                self.saved_field_a = self
                    .main
                    .update(cx, |s, w, cx| {
                        scene::field_snapshot(&s.fields[0], w, cx)["text"].clone()
                    })
                    .map_err(|e| e.to_string())?;
            }
            Action::Focus(id) => {
                self.main
                    .update(cx, |s, w, cx| s.focus(id, w, cx))
                    .map_err(|e| e.to_string())?;
            }
            Action::Source(id) => {
                self.extra["input_source_after"] = json!(inject::select_input_source(id)?)
            }
            Action::Clear(index) => {
                self.main
                    .update(cx, |s, _, cx| s.clear(*index, cx))
                    .map_err(|e| e.to_string())?;
            }
            Action::Type(text) => {
                inject::type_keys(text, cx).await;
            }
            Action::Key(code, mods) => inject::key(*code, *mods),
            Action::ClickField => self.click_field(cx)?,
            Action::Second => self.open_second(cx)?,
            Action::Main => inject::make_key("main"),
            Action::WebClick => self.web_click(cx).await?,
            Action::WebRead => {
                self.extra["web_in"] = self.eval("document.getElementById('web_in').value").await;
            }
            Action::Tabs => self.tabs(cx).await?,
            Action::Stream => self.stream(times, cx).await?,
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
        let node = ax::dump_ax(inject::window("main"))["ax_focused_node"].clone();
        let mut ids = vec![
            self.main
                .update(cx, |s, w, cx| s.focused(w, cx))
                .map_err(|e| e.to_string())?,
        ];
        let mut focused = vec![node];
        for _ in 0..9 {
            inject::key(48, 0);
            wait(cx, 250).await;
            let node = ax::dump_ax(inject::window("main"))["ax_focused_node"].clone();
            ids.push(
                self.main
                    .update(cx, |s, w, cx| s.focused(w, cx))
                    .map_err(|e| e.to_string())?,
            );
            focused.push(node);
        }
        self.extra["tab_sequence"] = json!(ids);
        self.extra["tab_ax_focused"] = json!(focused);
        Ok(())
    }
    async fn stream(&mut self, times: &[u64], cx: &mut AsyncApp) -> Result<(), String> {
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
        let mut paused = Duration::ZERO;
        for (i, c) in text.iter().enumerate() {
            let deadline = Duration::from_millis((i as u64 + 1) * 100);
            cx.background_executor()
                .timer((deadline + paused).saturating_sub(started.elapsed()))
                .await;
            self.main
                .update(cx, |s, _, cx| {
                    s.stream.push(*c);
                    cx.notify();
                })
                .map_err(|e| e.to_string())?;
            // Pause stream updates while AccessKit publishes the current model text.
            if times.contains(&((i as u64 + 1) * 100)) {
                let pause_started = Instant::now();
                wait(cx, 200).await;
                let model = self
                    .main
                    .update(cx, |s, _, _| s.stream.clone())
                    .map_err(|e| e.to_string())?;
                let tree = ax::dump_ax(inject::window("main"));
                let mut nodes = Vec::new();
                ax::nodes(&tree, &mut nodes);
                let node = nodes
                    .iter()
                    .find(|n| name(n) == "응답")
                    .copied()
                    .cloned()
                    .unwrap_or(Value::Null);
                let value = node["value"]
                    .as_str()
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| node["title"].as_str().unwrap_or_default());
                let matches = value == model;
                samples.push(
                    json!({"at_ms":started.elapsed().as_millis(),"model":model,"ax":node,"pass":matches}),
                );
                paused += pause_started.elapsed();
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
        result["ime_windows"] = ax::ime_windows(&self.baseline);
        result["field_a_hanja_or_hangul"] = json!(matches!(
            result["field_a"]["text"].as_str(),
            Some("韓" | "한")
        ));
        result["field_a_unchanged"] = json!(result["field_a"]["text"] == self.saved_field_a);
        result["saved_field_a"] = self.saved_field_a.clone();
        result["ax_focused"] = ax::focused();
        result["ax_focused_node"] = ax::dump_ax(inject::window("main"))["ax_focused_node"].clone();
        result["input_source"] = json!(inject::input_source());
        result["first_key_chars"] = json!(inject::take_first_key_chars());
        result["bounds_for_range_screen"] = inject::caret_rect();
        result["candidate_offset"] = candidate_offset(&result);
        result["candidate_near_caret"] = json!(
            result["candidate_offset"]["dx"]
                .as_f64()
                .is_some_and(|dx| dx.abs() <= 300.)
                && result["candidate_offset"]["dy"]
                    .as_f64()
                    .is_some_and(|dy| (-400. ..=80.).contains(&dy))
        );
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
        result["ax_checks"] = ax_checks(result["list_rows"].as_array().unwrap().len());
        result
            .as_object_mut()
            .unwrap()
            .extend(self.extra.as_object().unwrap().clone());
        Ok(result)
    }
    async fn shot(&self, id: &str, cx: &mut AsyncApp) -> Result<bool, String> {
        let ready = self.out.join(format!("shot-{id}.ready"));
        std::fs::write(ready, inject::shot_info(&self.baseline).to_string())
            .map_err(|e| e.to_string())?;
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
fn candidate_offset(snapshot: &Value) -> Value {
    let rect = &snapshot["bounds_for_range_screen"];
    let Some(candidate) = snapshot["ime_windows"].as_array().and_then(|w| w.first()) else {
        return Value::Null;
    };
    let coordinate = |value: &Value, key: &str| value[key].as_f64();
    let bounds = &candidate["bounds"];
    match (
        coordinate(bounds, "x"),
        coordinate(bounds, "y"),
        coordinate(rect, "x"),
        coordinate(rect, "y"),
        coordinate(rect, "height"),
    ) {
        (Some(x), Some(y), Some(rx), Some(ry), Some(height)) => json!({"dx":x-rx,"dy":y-ry-height}),
        _ => Value::Null,
    }
}
fn name(node: &Value) -> &str {
    node["title"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| node["label"].as_str().unwrap_or_default())
}
fn ax_checks(model_rows: usize) -> Value {
    let tree = ax::dump_ax(inject::window("main"));
    let mut nodes = Vec::new();
    ax::nodes(&tree, &mut nodes);
    let has = |role: &str, label: &str| nodes.iter().any(|n| n["role"] == role && name(n) == label);
    let list_rows = nodes
        .iter()
        .find(|n| n["role"] == "AXList")
        .map(|n| n["child_count"].clone())
        .unwrap_or(Value::Null);
    let dialog = nodes
        .iter()
        .find(|n| name(n) == "확인 대화상자")
        .copied()
        .cloned()
        .unwrap_or(Value::Null);
    json!({"send_button":has("AXButton","보내기"),"settings_disabled":nodes.iter().any(|n|name(n)=="설정" && n["enabled"]==false),
        "title_field":has("AXTextField","제목"),"composer_area":has("AXTextArea","메시지 입력"),"list_rows_match":list_rows==json!(model_rows),
        "web_content":nodes.iter().any(|n|matches!(name(n), "웹 제목" | "웹 버튼")),
        "menu":nodes.iter().any(|n|n["role"]=="AXMenu"),"menu_items":nodes.iter().filter(|n|n["role"]=="AXMenuItem").count(),
        "dialog":!dialog.is_null(),"dialog_node":dialog})
}
