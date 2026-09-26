use super::{EffectFuture, EffectIdentity};

pub(crate) trait EffectFaultHook: Send + Sync {
    fn reached<'a>(
        &'a self,
        point: &'static str,
        identity: &'a EffectIdentity,
    ) -> EffectFuture<'a, ()>;
}
pub(crate) struct NoEffectFault;
impl EffectFaultHook for NoEffectFault {
    fn reached<'a>(
        &'a self,
        _point: &'static str,
        _identity: &'a EffectIdentity,
    ) -> EffectFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}
