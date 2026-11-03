use crate::{log, state::SharedRef};
use cef::*;
use serde_json::json;
cef::wrap_context_menu_handler! {
    pub struct Menu { shared:SharedRef, tx:async_channel::Sender<()> }
    impl ContextMenuHandler {
        fn run_context_menu(&self,_b:Option<&mut Browser>,_f:Option<&mut Frame>,params:Option<&mut ContextMenuParams>,model:Option<&mut MenuModel>,callback:Option<&mut RunContextMenuCallback>)->i32{
            if let (Some(p),Some(m),Some(c))=(params,model,callback){
                let items=(0..m.count()).filter_map(|i|{let id=m.command_id_at(i);(id>=0).then(||(id,CefString::from(&m.label_at(i)).to_string()))}).collect::<Vec<_>>();
                log("context_menu",json!({"x":p.xcoord(),"y":p.ycoord(),"items":items}));
                self.shared.borrow_mut().context=Some((p.xcoord(),p.ycoord(),items,c.clone()));let _=self.tx.try_send(());return 1;
            }0
        }
    }
}
cef::wrap_dialog_handler! {
    pub struct Dialog {}
    impl DialogHandler {
        fn on_file_dialog(&self,_b:Option<&mut Browser>,_mode:FileDialogMode,_title:Option<&CefString>,_default:Option<&CefString>,_filters:Option<&mut CefStringList>,_extensions:Option<&mut CefStringList>,_descriptions:Option<&mut CefStringList>,cb:Option<&mut FileDialogCallback>)->i32{
            if let Some(cb)=cb{cb.cancel();}log("file_dialog",json!({"handled":"cancelled; native chooser not implemented"}));1
        }
    }
}
cef::wrap_jsdialog_handler! {
    pub struct Js {}
    impl JsdialogHandler {
        fn on_jsdialog(&self,_b:Option<&mut Browser>,_origin:Option<&CefString>,kind:JsdialogType,message:Option<&CefString>,_prompt:Option<&CefString>,cb:Option<&mut JsdialogCallback>,_suppress:Option<&mut i32>)->i32{
            log("js_dialog",json!({"kind":format!("{kind:?}"),"message":message.map(ToString::to_string),"handled":"dismissed; dialog UI not implemented"}));
            if let Some(cb)=cb{cb.cont(0,None);}1
        }
    }
}
