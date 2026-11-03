use cef::*;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};
type Pending = Rc<RefCell<HashMap<i32, async_channel::Sender<Value>>>>;
#[derive(Clone)]
pub struct Cdp {
    cx: gpui::AsyncApp,
    next: Rc<Cell<i32>>,
    pending: Pending,
    pub world: Rc<Cell<i64>>,
}
cef::wrap_dev_tools_message_observer! {
    pub struct Observer { pending:Pending }
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self,_b:Option<&mut Browser>,id:i32,success:i32,result:Option<&[u8]>) {
            crate::log("cdp_result",json!({"id":id,"success":success,"bytes":result.map(<[u8]>::len)}));
            let value=result.and_then(|v|serde_json::from_slice(v).ok()).unwrap_or(Value::Null);
            if success==0{crate::log("cdp_error",value.clone());}
            if let Some(tx)=self.pending.borrow_mut().remove(&id) {
                let _=tx.try_send(json!({"ok":success!=0,"value":value}));
            }
        }
    }
}
impl Cdp {
    pub fn new(cx: &gpui::App) -> Self {
        Self {
            cx: cx.to_async(),
            next: Rc::default(),
            pending: Rc::default(),
            world: Rc::default(),
        }
    }

    pub fn observer(&self) -> DevToolsMessageObserver {
        Observer::new(self.pending.clone())
    }
    pub async fn call(&self, host: &BrowserHost, method: &str, params: Value) -> Value {
        let id = self.next.get() + 1;
        self.next.set(id);
        let (tx, rx) = async_channel::bounded(1);
        self.pending.borrow_mut().insert(id, tx);
        crate::log("cdp_call", json!({"id":id,"method":method}));
        let request =
            serde_json::to_vec(&json!({"id":id,"method":method,"params":params})).unwrap();
        if host.send_dev_tools_message(Some(&request)) == 0 {
            self.pending.borrow_mut().remove(&id);
            return json!({"ok":false,"error":"send rejected"});
        }
        let pending = self.pending.clone();
        let method = method.to_string();
        self.cx
            .spawn(async move |cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(3))
                    .await;
                if let Some(tx) = pending.borrow_mut().remove(&id) {
                    let _ = tx
                        .try_send(json!({"ok":false,"error":"3s CDP hang cutoff","method":method}));
                    crate::log("cdp_timeout", json!({"id":id,"method":method}));
                }
            })
            .detach();
        rx.recv().await.unwrap_or(Value::Null)
    }
    pub async fn eval(&self, host: &BrowserHost, expression: &str, isolated: bool) -> Value {
        let mut params = json!({"expression":expression,"returnByValue":true,"awaitPromise":true,"userGesture":true});
        if isolated {
            params["contextId"] = json!(self.world.get());
        }
        let result = self.call(host, "Runtime.evaluate", params).await;
        if !result["value"]["exceptionDetails"].is_null() {
            crate::log("js_exception", result.clone());
        }
        result["value"]["result"]["value"].clone()
    }
    pub async fn init_world(&self, host: &BrowserHost) -> bool {
        let frame = self.call(host, "Page.getFrameTree", json!({})).await;
        let id = &frame["value"]["frameTree"]["frame"]["id"];
        let world = self
            .call(
                host,
                "Page.createIsolatedWorld",
                json!({"frameId":id,"worldName":"butler-spike","grantUniveralAccess":false}),
            )
            .await;
        self.world
            .set(world["value"]["executionContextId"].as_i64().unwrap_or(0));
        crate::log(
            "isolated_world",
            json!({"frame":id,"world":self.world.get(),"ok":world["ok"]}),
        );
        self.world.get() != 0
    }
    pub async fn pick(&self, host: &BrowserHost, x: f32, y: f32) -> Value {
        let script =
            include_str!("pick-page.mjs").replace("export function pickPage", "function pickPage");
        let ladder = self
            .eval(
                host,
                &format!(
                    "{script}\npickPage({})",
                    json!({"op":"ladder","x":x,"y":y,"token":"spike"})
                ),
                true,
            )
            .await;
        let index = ladder["index"].as_u64().unwrap_or(0) as usize;
        let id = &ladder["levels"][index]["id"];
        self.eval(
            host,
            &format!(
                "{script}\npickPage({})",
                json!({"op":"capture","id":id,"token":"spike"})
            ),
            true,
        )
        .await
    }
}
