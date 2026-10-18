use super::{Logger, Record};
use serde_json::{Map, Value};
use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
    span::{Attributes, Id, Record as SpanRecord},
};
use tracing_subscriber::{Layer, layer::Context, registry::LookupSpan};

pub(crate) struct LogLayer(pub Logger);
#[derive(Clone, Default)]
pub(super) struct Fields(pub(super) Map<String, Value>);
impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0
            .insert(field.name().into(), Value::String(format!("{value:?}")));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0
            .insert(field.name().into(), Value::String(value.into()));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.0.insert(field.name().into(), value.into());
    }
}
impl<S> Layer<S> for LogLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn register_callsite(
        &self,
        metadata: &'static tracing::Metadata<'static>,
    ) -> tracing::subscriber::Interest {
        if metadata.target().starts_with("butler") {
            tracing::subscriber::Interest::sometimes()
        } else if *metadata.level() == tracing::Level::TRACE && self.0.enabled("deps", "TRACE") {
            tracing::subscriber::Interest::always()
        } else {
            tracing::subscriber::Interest::never()
        }
    }
    fn max_level_hint(&self) -> Option<tracing::metadata::LevelFilter> {
        use tracing::metadata::LevelFilter;
        let snapshot = self.0.snapshot();
        let config = &snapshot.effective;
        let maximum = config
            .category_levels
            .values()
            .map(|level| super::record::severity(level))
            .chain(std::iter::once(config.level.threshold()))
            .max()
            .unwrap_or(0);
        Some(match maximum {
            5 => LevelFilter::TRACE,
            4 => LevelFilter::DEBUG,
            3 => LevelFilter::INFO,
            2 => LevelFilter::WARN,
            1 => LevelFilter::ERROR,
            _ => LevelFilter::OFF,
        })
    }
    fn enabled(&self, metadata: &tracing::Metadata<'_>, _ctx: Context<'_, S>) -> bool {
        // Event categories are fields, unavailable here; use the most permissive
        // configured category before visiting fields, then filter the actual category.
        if !metadata.target().starts_with("butler") {
            return *metadata.level() == tracing::Level::TRACE && self.0.enabled("deps", "TRACE");
        }
        if metadata.is_span() {
            return true;
        }
        let snapshot = self.0.snapshot();
        let config = &snapshot.effective;
        config.enabled(metadata.target(), metadata.level().as_str())
            || config.category_levels.values().any(|l| {
                super::record::severity(metadata.level().as_str()) <= super::record::severity(l)
            })
    }
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(id) {
            let mut fields = Fields::default();
            attrs.record(&mut fields);
            let span_id = fields.0.get("span_id").cloned().unwrap_or_else(|| {
                Value::String(uuid::Uuid::new_v4().simple().to_string()[..16].into())
            });
            let parent_id = fields.0.get("parent_span_id").cloned();
            if let Some(parent) = span.parent()
                && let Some(inherited) = parent.extensions().get::<Fields>()
            {
                let own = std::mem::take(&mut fields.0);
                fields.0 = inherited.0.clone();
                fields.0.extend(own);
                fields.0.insert(
                    "parent_span_id".into(),
                    parent_id
                        .or_else(|| fields.0.get("span_id").cloned())
                        .unwrap_or(Value::Null),
                );
            }
            fields
                .0
                .entry("trace_id")
                .or_insert_with(|| Value::String(uuid::Uuid::new_v4().simple().to_string()));
            fields.0.insert("span_id".into(), span_id);
            let lifetime = super::trace::Lifetime::new(span.metadata(), &fields.0);
            lifetime.start(&self.0);
            let mut ext = span.extensions_mut();
            ext.insert(lifetime);
            ext.insert(fields);
        }
    }
    fn on_record(&self, id: &Id, values: &SpanRecord<'_>, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(id) {
            let mut ext = span.extensions_mut();
            if let Some(fields) = ext.get_mut::<Fields>() {
                values.record(fields);
            }
        }
    }
    fn on_close(&self, id: Id, ctx: Context<'_, S>) {
        if let Some(span) = ctx.span(&id) {
            let ext = span.extensions();
            if let (Some(lifetime), Some(fields)) =
                (ext.get::<super::trace::Lifetime>(), ext.get::<Fields>())
            {
                lifetime.finish(&self.0, &fields.0);
            }
        }
    }
    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        if *event.metadata().level() == tracing::Level::ERROR
            && let Some(span) = ctx.event_span(event)
            && let Some(fields) = span.extensions_mut().get_mut::<Fields>()
        {
            let mut failure = Fields::default();
            event.record(&mut failure);
            failure
                .0
                .retain(|name, _| matches!(name.as_str(), "error" | "message" | "code" | "reason"));
            fields.0.insert("failure".into(), Value::Object(failure.0));
            fields
                .0
                .insert("status".into(), Value::String("error".into()));
        }
        let mut category = Category::default();
        event.record(&mut category);
        let category = if event.metadata().target().starts_with("butler") {
            category
                .0
                .unwrap_or_else(|| event.metadata().target().into())
        } else {
            "deps".into()
        };
        let level = event.metadata().level().as_str();
        if !self.0.enabled(&category, level) {
            return;
        }
        let mut fields = Fields::default();
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root() {
                if let Some(parent) = span.extensions().get::<Fields>() {
                    fields.0.extend(parent.0.clone());
                }
            }
        }
        event.record(&mut fields);
        fields.0.remove("category");
        let name = take(&mut fields.0, "event").unwrap_or_else(|| "diagnostic".into());
        let msg = take(&mut fields.0, "message").unwrap_or_default();
        let mut row = Record::new(level, &category, &name, &msg);
        row.trace_id = take(&mut fields.0, "trace_id");
        row.span_id = take(&mut fields.0, "span_id");
        row.parent_span_id = take(&mut fields.0, "parent_span_id");
        row.chat_id = take(&mut fields.0, "chat_id");
        row.turn_id = take(&mut fields.0, "turn_id");
        row.duration_ms = fields.0.remove("duration_ms").and_then(|v| v.as_f64());
        // JSON payloads retain structural redaction without changing plain content strings.
        row.content = fields
            .0
            .remove("content_json")
            .map(|value| match value {
                Value::String(raw) => serde_json::from_str(&raw).unwrap_or(Value::String(raw)),
                value => value,
            })
            .or_else(|| fields.0.remove("content"));
        row.error = fields.0.remove("error");
        row.attrs = Value::Object(fields.0);
        let _ = self.0.record(row);
    }
}
fn take(fields: &mut Map<String, Value>, key: &str) -> Option<String> {
    fields
        .remove(key)
        .and_then(|v| v.as_str().map(str::to_owned))
}

#[derive(Default)]
struct Category(Option<String>);
impl Visit for Category {
    fn record_debug(&mut self, _field: &Field, _value: &dyn std::fmt::Debug) {}
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "category" {
            self.0 = Some(value.into());
        }
    }
}

/// Copy the current span hierarchy while it is still on the sending task.
pub(crate) fn current_ids(row: &mut Record) {
    use tracing_subscriber::registry::Registry;
    tracing::Span::current().with_subscriber(|(id, dispatch)| {
        let Some(registry) = dispatch.downcast_ref::<Registry>() else {
            return;
        };
        let Some(span) = registry.span(id) else {
            return;
        };
        let mut fields = serde_json::Map::new();
        for span in span.scope().from_root() {
            if let Some(parent) = span.extensions().get::<Fields>() {
                fields.extend(parent.0.clone());
            }
        }
        row.trace_id = take(&mut fields, "trace_id");
        row.turn_id = take(&mut fields, "turn_id");
        row.chat_id = take(&mut fields, "chat_id");
        row.span_id = take(&mut fields, "span_id");
        row.parent_span_id = take(&mut fields, "parent_span_id");
    });
}
