//! Selection through the native shell's public pointer and clipboard harness.
use super::live_turns::ready_workspace;
use super::*;

/// SHELL-APP-05 — Text selection stays inside one message: chrome never selects, paragraphs
/// copy together, and a drag beyond the user bubble clamps to that message's text.
/// Assistant selection includes the labels and values of facts, metrics, checklist and progress,
/// the answer-block title and footer meta.
/// Composer focus clears selection; context-menu and footer Copy include the full answer-block markdown.
#[tokio::test]
async fn shell_app_05_text_selection_stays_in_one_message() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-05")?;
    let behavior = ChatBehavior {
        script: vec![
            json!({"role":"assistant","content":null,"tool_calls":[{
                "id":"facts","type":"function","function":{
                    "name":"answer_blocks","arguments":json!({"v":1,"blocks":[
                        {"type":"facts","title":"Facts","items":[
                            {"label":"Alpha","value":"1"},{"label":"Beta","value":"2"}]},
                        {"type":"metrics","items":[
                            {"label":"Speed","value":"12","unit":"ms","delta":"+3%"},
                            {"label":"Size","value":"4"}]},
                        {"type":"checklist","items":[
                            {"text":"Done item","done":true},{"text":"Open item","done":false}]},
                        {"type":"progress","items":[
                            {"label":"Build","value":3,"max":10,"unit":"steps"},
                            {"label":"Test","value":50}]}
                    ]}).to_string()
                }
            }]}),
            json!({"role":"assistant","content":"Alpha first paragraph.\n\nBeta second paragraph."}),
        ],
        refuse_stream: true,
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["completion".into(), "tools".into()]),
            ..Default::default()
        },
        ..Default::default()
    };
    let _model = ready_workspace(&sandbox, behavior).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind": "chat", "title": "Selection"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{id}"),
            &format!("open {id}"),
        ])
        .await?;
    let sent = gw
        .post(
            "/messages",
            json!({"chat_id": id, "text": "Hello", "client_message_id": "shell-app-05"}),
        )
        .await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    shell.run(&["answer Alpha first paragraph."]).await?;
    let response = gw.get(&format!("/session-view?session_id={id}")).await?;
    assert_eq!(response.status, 200, "{}", response.text);
    let view = response.data();
    let messages = view["messages"].as_array().expect("messages");
    let user = messages.iter().find(|m| m["role"] == "user").expect("user")["id"]
        .as_str()
        .expect("user id");
    let assistant = messages
        .iter()
        .find(|m| m["role"] == "assistant")
        .expect("assistant")["id"]
        .as_str()
        .expect("assistant id");
    shell
        .run(&[
            "size 800 1400",
            &format!("drag sidebar-row-{id} 60 0"),
            "key secondary-c",
            "expect-clipboard null",
            &format!("drag-from message-{assistant}-body 0 0 1 1"),
            "key secondary-c",
            "expect-clipboard-prefix \"Alpha first paragraph.\\n\\nBeta second paragraph.\\n\\n\"",
            "expect-clipboard-contains \"Facts\\nAlpha\\n1\\n\\nBeta\\n2\\n\\n12 ms\\nSpeed\\n+3%\\n4\\nSize\\nDone item\\nOpen item\\nBuild\\n3 / 10 steps\\nTest\\n50 / 100\\n\"",
            &format!("drag-from message-{user}-body 0 0 0.5 4"),
            "key secondary-c",
            "expect-clipboard \"Hello\"",
            "click composer",
            &format!("click-at message-{assistant}-body 0.1 0.05 right"),
            &format!("wait-anchor message-menu-{assistant}-item-0-0"),
            &format!("click message-menu-{assistant}-item-0-0"),
            "expect-clipboard \"Alpha first paragraph.\\n\\nBeta second paragraph.\\n\\n### Facts\\n\\n- Alpha: 1\\n- Beta: 2\\n\\n- Speed: 12 ms (\\\\+3%)\\n- Size: 4\\n\\n- [x] Done item\\n- [ ] Open item\\n\\nBuild: 3 / 10 steps\\nTest: 50 / 100\"",
            &format!("click copy-{assistant}"),
            "expect-clipboard \"Alpha first paragraph.\\n\\nBeta second paragraph.\\n\\n### Facts\\n\\n- Alpha: 1\\n- Beta: 2\\n\\n- Speed: 12 ms (\\\\+3%)\\n- Size: 4\\n\\n- [x] Done item\\n- [ ] Open item\\n\\nBuild: 3 / 10 steps\\nTest: 50 / 100\"",
            "app-quit",
        ])
        .await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}

/// The bands (top, height) of pixel rows that differ between two shots within `cols`, and the
/// columns they span.
fn changed(
    before: &std::path::Path,
    after: &std::path::Path,
    cols: std::ops::Range<u32>,
) -> (Vec<(u32, u32)>, std::ops::Range<u32>) {
    let (a, b) = (
        image::open(before).expect("shot").to_rgba8(),
        image::open(after).expect("shot").to_rgba8(),
    );
    assert_eq!(a.dimensions(), b.dimensions());
    let cols = cols.start..cols.end.min(a.width());
    let mut bands: Vec<(u32, u32)> = Vec::new();
    let mut span = cols.end..cols.start;
    for y in 0..a.height() {
        let xs: Vec<u32> = cols
            .clone()
            .filter(|&x| a.get_pixel(x, y) != b.get_pixel(x, y))
            .collect();
        let (Some(&first), Some(&last)) = (xs.first(), xs.last()) else {
            continue;
        };
        span = span.start.min(first)..span.end.max(last + 1);
        match bands.last_mut() {
            Some((top, height)) if *top + *height == y => *height += 1,
            _ => bands.push((y, 1)),
        }
    }
    (bands, span)
}

/// SHELL-APP-11 — Selecting message text fills every wrapped line of a paragraph and of table
/// cells, not only each text's last line; a press that starts inside a table cell or an answer
/// block still starts a selection; a left press outside the message (sidebar, empty chat area)
/// clears the selection.
#[tokio::test]
async fn shell_app_11_selection_fills_wrapped_lines_and_clears_outside() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    butler_e2e::skip_unless!(nonempty(SHOTS).is_some(), format!("{SHOTS} is not set"));
    let _serial = SERIAL.lock().await;
    let mut sandbox = Sandbox::new("SHELL-APP-11")?;
    let paragraph = "보고서에는 이 흐름에 더해 악성코드가 실제로 할 수 있었던 일(원격 조종, 브라우저 비밀번호·쿠키 탈취, 가상자산 지갑 28종 수집, 흔적 삭제)과 구조적 원인 분석, 출처 16건이 함께 들어 있습니다. 사건을 키운 핵심은 공격 자체보다 37일간 아무도 몰랐고, 공지는 약 10시간 늦게 나왔다는 점입니다.";
    let (head, cell) = (
        "| 사건 | 결과 |\n|---|---|",
        "하루 만에 종료되었고 핵심 보상이 누락되어 추가 보상 공지가 나옴",
    );
    let row = "| 협동 작전 버그가 발견되어 하루 만에 종료된 이벤트와 그 뒤의 공지 |";
    let markdown =
        format!("{paragraph}\n\n{head}\n{row} {cell} |\n\n### 정리\n\n마지막 문단입니다.");
    let timeline = json!({"v":1,"blocks":[{"type":"timeline","title":"무슨 일이 있었나","items":[{
        "when":"2026-09-27","title":"CDN 배포 파일 변조",
        "text":"런처 자바스크립트 4개에 외부 스크립트 호출 코드가 삽입됐다는 사실이 뒤늦게 확인됐습니다."}]}]});
    let behavior = ChatBehavior {
        script: vec![
            json!({"role":"assistant","content":null,"tool_calls":[{
                "id":"timeline","type":"function","function":{
                    "name":"answer_blocks","arguments":timeline.to_string()}}]}),
            json!({"role":"assistant","content":markdown}),
        ],
        refuse_stream: true,
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["completion".into(), "tools".into()]),
            ..Default::default()
        },
        ..Default::default()
    };
    let _model = ready_workspace(&sandbox, behavior).await?;
    let mut shell = Shell::start(&sandbox, &[]).await?;
    shell
        .run(&["agent running", "wait-anchor composer"])
        .await?;
    let gw = gateway(&shell.launch);
    let created = gw
        .post("/sessions", json!({"kind": "chat", "title": "Selection"}))
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let id = created.data()["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();
    shell
        .run(&[
            &format!("wait-anchor sidebar-row-{id}"),
            &format!("open {id}"),
        ])
        .await?;
    let sent = gw
        .post(
            "/messages",
            json!({"chat_id": id, "text": "Hello", "client_message_id": "shell-app-11"}),
        )
        .await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    shell.run(&["answer 보고서에는"]).await?;
    let response = gw.get(&format!("/session-view?session_id={id}")).await?;
    assert_eq!(response.status, 200, "{}", response.text);
    let view = response.data();
    let messages = view["messages"].as_array().expect("messages");
    let assistant = messages
        .iter()
        .find(|m| m["role"] == "assistant")
        .expect("assistant")["id"]
        .as_str()
        .expect("assistant id");
    let user = messages.iter().find(|m| m["role"] == "user").expect("user")["id"]
        .as_str()
        .expect("user id");
    // Pointer places are fractions (x0 y0 x1 y1) of the assistant message body, read from the shot.
    let drag = |f: &str| format!("drag-from message-{assistant}-body {f}");
    let shots = sandbox.root.join("shell");
    let shot = |name: &str| shots.join(format!("{name}.png"));
    // Selection fill present in a shot, as bands of rows differing from the unselected one.
    let filled = |name: &str| changed(&shot("before"), &shot(name), 0..u32::MAX);
    // No fill left where `selected` had it (the sidebar's own hover state is outside its columns).
    let cleared = |name: &str, selected: &(Vec<(u32, u32)>, std::ops::Range<u32>)| {
        let (rows, _) = changed(&shot("before"), &shot(name), selected.1.clone());
        !rows.iter().any(|r| {
            selected
                .0
                .iter()
                .any(|b| r.0 < b.0 + b.1 && b.0 < r.0 + r.1)
        })
    };
    shell.run(&["size 1000 900", "shot before"]).await?;
    // D1: the press starts in the last body cell (first line) and ends on the heading "정리".
    // The context-menu Copy then copies that selection, though its press clears the selection.
    shell
        .run(&[
            &drag("0.522 0.316 0.027 0.473"),
            &format!("click-at message-{assistant}-body 0.5 0.1 right"),
            &format!("wait-anchor message-menu-{assistant}-item-0-0"),
            &format!("click message-menu-{assistant}-item-0-0"),
            &format!("expect-clipboard-prefix {}", json!(cell)),
        ])
        .await?;
    // D2: the press starts on the blank marker column left of the timeline item, ends on its text.
    shell.run(&[&format!("click sidebar-row-{id}")]).await?;
    shell
        .run(&[
            &drag("0.005 0.765 0.93 0.804"),
            "key secondary-c",
            "expect-clipboard-contains \"CDN 배포 파일 변조\"",
        ])
        .await?;
    // A: all wrapped lines are filled: paragraph, header row, body row, heading, last paragraph.
    shell.run(&[&format!("click sidebar-row-{id}")]).await?;
    let copied = format!(
        "{paragraph}\n\n사건\t결과\n협동 작전 버그가 발견되어 하루 만에 종료된 이벤트와 그 뒤의 공지\t{cell}\n정리\n마지막 문단입니다."
    );
    shell
        .run(&[
            &drag("0 0 0.3 0.547"),
            "shot selected",
            "key secondary-c",
            &format!("expect-clipboard-prefix {}", json!(copied)),
        ])
        .await?;
    let selected = filled("selected");
    let bands = selected.0.clone();
    let heights: Vec<u32> = bands.iter().map(|b| b.1).collect();
    assert_eq!(
        heights.len(),
        5,
        "paragraph, header, body row, heading, last: {bands:?}"
    );
    assert!(
        heights[0] >= 2 * heights[1],
        "paragraph wrapped lines unfilled: {bands:?}"
    );
    assert!(
        2 * heights[2] >= 3 * heights[1],
        "cell wrapped lines unfilled: {bands:?}"
    );
    // B: a press on the sidebar, and one on the empty chat area, clear it.
    shell
        .run(&[&format!("click sidebar-row-{id}"), "shot sidebar-press"])
        .await?;
    assert!(
        cleared("sidebar-press", &selected),
        "sidebar press left the selection"
    );
    shell
        .run(&[
            &drag("0 0 0.3 0.547"),
            &format!("click-at message-{user}-body -2 0.5"),
            "shot empty-press",
        ])
        .await?;
    assert!(
        cleared("empty-press", &selected),
        "empty chat-area press left the selection"
    );
    shell.run(&["app-quit"]).await?;
    shell.finish().await?;
    sandbox.mark_success();
    Ok(())
}
