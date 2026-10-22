//! Explicit migration effects: retain domain writes, summarize notifications
//! and apply each counter delta once within the caller's transaction.
use super::*;
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Effects {
    pub counts: BTreeMap<(String, String, String), i64>,
    pub events: u64,
    pub changed: bool,
}
impl Transaction<'_> {
    pub(crate) fn migration<T>(&self, ctx: &Context, f: impl FnOnce() -> Result<T>) -> Result<T> {
        if self.effects.borrow().is_some() {
            return Err(Error::Invalid("nested migration effects"));
        }
        *self.effects.borrow_mut() = Some(Effects::default());
        let result = f();
        let effects = self
            .effects
            .borrow_mut()
            .take()
            .ok_or(Error::Invalid("migration effects"))?;
        let value = result?;
        for ((kind, scope, key), delta) in effects.counts {
            count(self, (&kind, &scope), &key, delta)?;
        }
        if effects.changed {
            self.execute("UPDATE wm_migration SET source_counts_json=json_set(source_counts_json,'$.changed',1) WHERE singleton=1 AND coalesce(json_extract(source_counts_json,'$.changed'),0)=0", [])?;
        }
        if effects.events > 0 {
            self.execute(
                sql::AUDIT,
                rusqlite::params![
                    "migration",
                    "cutover",
                    0,
                    ctx.actor.to_string(),
                    "batch",
                    ctx.now,
                    json!({"scope":"migration","operations":effects.events}).to_string()
                ],
            )?;
        }
        Ok(value)
    }
    pub(crate) fn migration_changed(&self) -> Result<()> {
        self.effects
            .borrow_mut()
            .as_mut()
            .ok_or(Error::Invalid("migration effects"))?
            .changed = true;
        Ok(())
    }
    pub(super) fn counts_pending(&self, scope: (&str, &str)) -> bool {
        self.effects.borrow().as_ref().is_some_and(|effects| {
            effects
                .counts
                .contains_key(&(scope.0.into(), scope.1.into(), "works".into()))
        })
    }
}
