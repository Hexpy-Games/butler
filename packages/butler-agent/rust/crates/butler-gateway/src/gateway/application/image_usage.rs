//! Image-only usage with historical costs and indexed time-range aggregation.
use super::{AppApplication, AppStorageError, GatewayApplicationError, app_error};
use butler_models::models::{ImageOutputPricing, ModelCatalog};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageUsageOperation {
    Generate,
    Edit,
}
#[derive(Deserialize, Serialize)]
pub struct ImageUsageRecord {
    pub ts: String,
    pub model_ref: String,
    pub provider_id: String,
    pub op: ImageUsageOperation,
    pub images: u32,
    pub input_text_tokens: Option<u64>,
    pub input_image_tokens: Option<u64>,
    pub output_image_tokens: Option<u64>,
    pub quality: Option<String>,
}
pub enum AppImageUsageCommand {
    Record(ImageUsageRecord),
    Stats { days: u32 },
}

pub(super) fn create(db: &Connection) -> Result<(), AppStorageError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS app_image_usage(
      id INTEGER PRIMARY KEY,ts TEXT NOT NULL,model_ref TEXT NOT NULL,provider_id TEXT NOT NULL,
      op TEXT NOT NULL CHECK(op IN ('generate','edit')),images INTEGER NOT NULL,auth TEXT NOT NULL CHECK(auth='api_key'),
      input_text_tokens INTEGER,input_image_tokens INTEGER,output_image_tokens INTEGER,quality TEXT,cost_usd REAL);
      CREATE INDEX IF NOT EXISTS app_image_usage_ts ON app_image_usage(ts);")
        .map_err(AppStorageError::sqlite)
}
impl AppApplication {
    pub async fn record_image_usage(
        &self,
        mut row: ImageUsageRecord,
    ) -> Result<(), GatewayApplicationError> {
        row.ts = chrono::DateTime::parse_from_rfc3339(&row.ts)
            .map_err(|_| {
                GatewayApplicationError::public(400, "image_usage_time_invalid", "Invalid time.")
            })?
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let models = image_models()?;
        let pricing = models
            .iter()
            .find(|m| m.model_ref == row.model_ref && m.provider_id == row.provider_id)
            .and_then(|m| m.image_output.as_ref())
            .map(|c| c.pricing.clone());
        self.storage
            .execute(move |db| record(db, &row, pricing.as_ref()))
            .await
            .map_err(app_error)
    }
    pub(super) async fn image_usage_owned(
        &self,
        command: AppImageUsageCommand,
    ) -> Result<Value, GatewayApplicationError> {
        match command {
            AppImageUsageCommand::Record(row) => {
                self.record_image_usage(row).await?;
                Ok(json!({"ok":true}))
            }
            AppImageUsageCommand::Stats { days } => {
                if !matches!(days, 7 | 30) {
                    return Err(GatewayApplicationError::public(
                        400,
                        "image_usage_days_invalid",
                        "Invalid range.",
                    ));
                }
                let models = image_models()?;
                let since = (chrono::Utc::now() - chrono::Duration::days(i64::from(days)))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                self.storage
                    .read(move |db| stats(db, days, &since, models))
                    .await
                    .map_err(app_error)
            }
        }
    }
}
fn image_models()
-> Result<&'static [butler_models::models::ModelProviderMetadata], GatewayApplicationError> {
    static MODELS: std::sync::LazyLock<
        Result<
            Vec<butler_models::models::ModelProviderMetadata>,
            butler_models::models::ModelCatalogError,
        >,
    > = std::sync::LazyLock::new(|| {
        ModelCatalog::new().map(|catalog| catalog.image_output_models())
    });
    MODELS
        .as_ref()
        .map(Vec::as_slice)
        .map_err(|_| GatewayApplicationError::internal())
}
fn record(
    db: &Connection,
    row: &ImageUsageRecord,
    pricing: Option<&ImageOutputPricing>,
) -> Result<(), AppStorageError> {
    let cost = pricing.and_then(|p| {
        p.estimated_cost(
            row.input_text_tokens,
            row.input_image_tokens,
            row.output_image_tokens,
            row.quality.as_deref(),
            row.images,
        )
    });
    let op = match row.op {
        ImageUsageOperation::Generate => "generate",
        ImageUsageOperation::Edit => "edit",
    };
    db.execute("INSERT INTO app_image_usage(ts,model_ref,provider_id,op,images,auth,input_text_tokens,input_image_tokens,output_image_tokens,quality,cost_usd) VALUES(?1,?2,?3,?4,?5,'api_key',?6,?7,?8,?9,?10)",
        params![row.ts,row.model_ref,row.provider_id,op,row.images,row.input_text_tokens,row.input_image_tokens,row.output_image_tokens,row.quality,cost]).map_err(AppStorageError::sqlite)?;
    Ok(())
}
fn stats(
    db: &Connection,
    days: u32,
    since: &str,
    models: &[butler_models::models::ModelProviderMetadata],
) -> Result<Value, AppStorageError> {
    let mut query = db.prepare_cached("SELECT model_ref,provider_id,
      SUM(CASE WHEN op='generate' THEN images ELSE 0 END),SUM(CASE WHEN op='edit' THEN images ELSE 0 END),
      CASE WHEN COUNT(cost_usd)=COUNT(*) THEN SUM(cost_usd) ELSE NULL END
      FROM app_image_usage INDEXED BY app_image_usage_ts WHERE ts>=?1 GROUP BY model_ref,provider_id
      ORDER BY SUM(images) DESC,model_ref").map_err(AppStorageError::sqlite)?;
    let mut generated = 0u64;
    let mut edited = 0u64;
    let mut total = Some(0.0);
    let rows = query
        .query_map([since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, u64>(2)?,
                r.get::<_, u64>(3)?,
                r.get::<_, Option<f64>>(4)?,
            ))
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let rows = rows.into_iter().map(|(model_ref,provider_id,g,e,cost)| {
        generated += g; edited += e; total = total.zip(cost).map(|(a,b)|a+b);
        let name = models.iter().find(|m|m.model_ref==model_ref).map_or(model_ref.as_str(),|m|m.display_name.as_str());
        json!({"model_ref":model_ref,"provider_id":provider_id,"display_name":name,"generated":g,"edited":e,"estimated_usd":cost})
    }).collect::<Vec<_>>();
    Ok(
        json!({"days":days,"models":rows,"total":{"generated":generated,"edited":edited,"estimated_usd":total}}),
    )
}

pub(super) fn execute(
    this: AppApplication,
    command: AppImageUsageCommand,
) -> super::ApplicationFuture<Value> {
    Box::pin(async move { this.image_usage_owned(command).await })
}
