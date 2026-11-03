use crate::{log, state::SharedRef};
use cef::*;
use serde_json::json;
use std::time::Instant;
cef::wrap_browser_process_handler! {
    pub struct Pump { tx:async_channel::Sender<crate::pump::Message> }
    impl BrowserProcessHandler {
        fn on_schedule_message_pump_work(&self,delay_ms:i64) {
            static REQUESTS:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
            if REQUESTS.fetch_add(1,std::sync::atomic::Ordering::Relaxed)<5 {log("pump_request",json!({"delay_ms":delay_ms}));}
            let _=self.tx.try_send(crate::pump::Message::Schedule(Instant::now()+std::time::Duration::from_millis(delay_ms.max(0) as u64)));
        }
    }
}
cef::wrap_app! {
    pub struct CefApp { pump:BrowserProcessHandler }
    impl App {
        fn browser_process_handler(&self)->Option<BrowserProcessHandler>{Some(self.pump.clone())}
        fn on_before_command_line_processing(&self,_p:Option<&CefString>,cmd:Option<&mut CommandLine>){
            if let Some(cmd)=cmd {
                for name in ["use-mock-keychain","disable-crash-reporter","disable-breakpad","disable-component-update","disable-background-networking","no-first-run","disable-sync","autoplay-policy"] {
                    if name!="autoplay-policy" { cmd.append_switch(Some(&name.into())); }
                }
                cmd.append_switch_with_value(Some(&"password-store".into()),Some(&"basic".into()));
                cmd.append_switch_with_value(Some(&"autoplay-policy".into()),Some(&"no-user-gesture-required".into()));
                // Add to CEF's own disabled features; replacing the value would re-enable them.
                let disabled=CefString::from(&cmd.switch_value(Some(&"disable-features".into()))).to_string();
                let disabled=if disabled.is_empty(){"SpareRendererForSitePerProcess".to_string()}else{format!("{disabled},SpareRendererForSitePerProcess")};
                cmd.append_switch_with_value(Some(&"disable-features".into()),Some(&disabled.as_str().into()));
            }
        }
    }
}
cef::wrap_life_span_handler! {
    pub struct Life { shared:SharedRef, tx:async_channel::Sender<()> }
    impl LifeSpanHandler {
        fn on_after_created(&self,_b:Option<&mut Browser>){log("browser_created",json!(true));}
        fn on_before_close(&self,_b:Option<&mut Browser>){self.shared.borrow_mut().closed=true;let _=self.tx.try_send(());log("browser_closed",json!({"pumps":self.shared.borrow().pumps,"frames":self.shared.borrow().frames,"presentation":crate::presentation::snapshot()}));}
        fn on_before_popup(&self,_b:Option<&mut Browser>,_f:Option<&mut Frame>,_id:i32,url:Option<&CefString>,_name:Option<&CefString>,_disposition:WindowOpenDisposition,_gesture:i32,_features:Option<&PopupFeatures>,_info:Option<&mut WindowInfo>,_client:Option<&mut Option<Client>>,_settings:Option<&mut BrowserSettings>,_extra:Option<&mut Option<DictionaryValue>>,_access:Option<&mut i32>)->i32 {
            log("new_window_blocked",json!({"url":url.map(ToString::to_string)}));1
        }
    }
}
cef::wrap_render_handler! {
    pub struct Paint { shared:SharedRef, tx:async_channel::Sender<()> }
    impl RenderHandler {
        fn view_rect(&self,_b:Option<&mut Browser>,rect:Option<&mut Rect>){
            if let Some(r)=rect {let s=self.shared.borrow();r.width=f32::from(s.bounds.size.width).max(1.) as i32;r.height=f32::from(s.bounds.size.height).max(1.) as i32;}
        }
        fn screen_info(&self,_b:Option<&mut Browser>,info:Option<&mut ScreenInfo>)->i32 {
            if let Some(i)=info {i.device_scale_factor=self.shared.borrow().scale.max(1.);return 1;}0
        }
        fn on_paint(&self,_b:Option<&mut Browser>,kind:PaintElementType,_dirty:Option<&[Rect]>,buffer:*const u8,width:i32,height:i32){
            if width<=0 || height<=0{return;}
            let start=Instant::now();
            let frame={let mut s=self.shared.borrow_mut();let pool=if kind==PaintElementType::POPUP{&mut s.popup_pool}else{&mut s.view_pool};crate::unsafe_boundary::copy_paint(pool,buffer,width as usize,height as usize,width as usize*4)};
            if let Some(frame)=frame{
                accept(&self.shared,&self.tx,frame,kind,start,"software");
            }
        }
        fn on_accelerated_paint(&self,_b:Option<&mut Browser>,kind:PaintElementType,_dirty:Option<&[Rect]>,info:Option<&AcceleratedPaintInfo>){
            let start=Instant::now();
            let frame={let mut s=self.shared.borrow_mut();let s=&mut *s;let gpu=s.gpu.get_or_insert_with(crate::unsafe_boundary::GpuCopy::new);let pool=if kind==PaintElementType::POPUP{&mut s.popup_pool}else{&mut s.view_pool};info.and_then(|i|crate::unsafe_boundary::copy_accelerated(pool,gpu,i))};
            if let Some(frame)=frame{
                accept(&self.shared,&self.tx,frame,kind,start,"accelerated-gpu-copy");
            }
        }
        fn on_popup_show(&self,_b:Option<&mut Browser>,show:i32){self.shared.borrow_mut().popup_show=show!=0;log("popup_show",json!(show));let _=self.tx.try_send(());}
        fn on_popup_size(&self,_b:Option<&mut Browser>,rect:Option<&Rect>){if let Some(r)=rect{self.shared.borrow_mut().popup_rect=r.clone();log("popup_size",json!([r.x,r.y,r.width,r.height]));}}
        fn on_ime_composition_range_changed(&self,_b:Option<&mut Browser>,range:Option<&Range>,bounds:Option<&[Rect]>){
            self.shared.borrow_mut().ime_bounds=bounds.unwrap_or_default().to_vec();
            log("ime_bounds",json!({"range":range.map(|r|[r.from,r.to]),"bounds":bounds.map(|v|v.iter().map(|r|[r.x,r.y,r.width,r.height]).collect::<Vec<_>>())}));
        }
        fn on_text_selection_changed(&self,_b:Option<&mut Browser>,text:Option<&CefString>,range:Option<&Range>){
            let mut s=self.shared.borrow_mut();s.selected_text=text.map(ToString::to_string).unwrap_or_default();
            if let Some(r)=range{s.selection=r.from as usize..r.to as usize;}
        }
    }
}
fn accept(
    shared: &SharedRef,
    tx: &async_channel::Sender<()>,
    frame: core_video::pixel_buffer::CVPixelBuffer,
    kind: PaintElementType,
    start: Instant,
    path: &str,
) {
    let mut s = shared.borrow_mut();
    if kind == PaintElementType::POPUP {
        log("popup_frame", json!({"path":path}));
        s.popup = Some(frame);
    } else {
        if !s.first_paint {
            log(
                "first_paint",
                json!({"path":path,"width":frame.get_width(),"height":frame.get_height(),"format":frame.get_pixel_format()}),
            );
            s.first_paint = true;
        }
        if s.frame_waiter
            .as_ref()
            .is_some_and(|(w, h, _)| *w == frame.get_width() && *h == frame.get_height())
            && let Some((_, _, tx)) = s.frame_waiter.take()
        {
            let _ = tx.try_send(());
        }
        crate::presentation::received(&frame, s.frames + 1, path, s.input_at);
        s.frame = Some(frame);
        s.frames += 1;
        s.copies_ms.push(start.elapsed().as_secs_f64() * 1000.);
        if let Some(t) = s.input_at.take() {
            s.latencies_ms.push(t.elapsed().as_secs_f64() * 1000.);
        }
    }
    let _ = tx.try_send(());
}
cef::wrap_display_handler! {
    pub struct Display { shared:SharedRef, tx:async_channel::Sender<()> }
    impl DisplayHandler {
        fn on_cursor_change(&self,_b:Option<&mut Browser>,_cursor:*mut u8,kind:CursorType,_custom:Option<&CursorInfo>)->i32{
            self.shared.borrow_mut().cursor=if kind==CursorType::HAND{gpui::CursorStyle::PointingHand}else if kind==CursorType::IBEAM{gpui::CursorStyle::IBeam}else{gpui::CursorStyle::Arrow};
            let _=self.tx.try_send(());log("cursor",json!(format!("{kind:?}")));1
        }
    }
}
cef::wrap_client! {
    pub struct ClientBuilder { paint:RenderHandler, life:LifeSpanHandler, display:DisplayHandler, menu:ContextMenuHandler, dialog:DialogHandler, js:JsdialogHandler }
    impl Client {
        fn render_handler(&self)->Option<RenderHandler>{Some(self.paint.clone())}
        fn life_span_handler(&self)->Option<LifeSpanHandler>{Some(self.life.clone())}
        fn display_handler(&self)->Option<DisplayHandler>{Some(self.display.clone())}
        fn context_menu_handler(&self)->Option<ContextMenuHandler>{Some(self.menu.clone())}
        fn dialog_handler(&self)->Option<DialogHandler>{Some(self.dialog.clone())}
        fn jsdialog_handler(&self)->Option<JsdialogHandler>{Some(self.js.clone())}
    }
}
