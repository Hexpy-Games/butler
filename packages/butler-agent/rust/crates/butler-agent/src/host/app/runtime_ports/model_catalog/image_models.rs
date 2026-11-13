use std::sync::Arc;

use butler_gateway::gateway::GatewayApplicationError;
use serde_json::Value;

use super::AppModelCatalog;

impl AppModelCatalog {
    pub(super) async fn image_model(
        &self,
        value: Option<Value>,
    ) -> Result<Value, GatewayApplicationError> {
        self.validate_model_files()?;
        self.validated_root()?;
        match value {
            Some(value) => self
                .configuration
                .set_image_model(value)
                .await
                .map_err(image_model_error),
            None => self
                .configuration
                .image_model_settings()
                .await
                .map_err(image_model_error),
        }
    }
    pub(super) async fn add_custom_image_model(
        &self,
        value: Value,
    ) -> Result<Value, GatewayApplicationError> {
        self.validate_model_files()?;
        self.validated_root()?;
        self.configuration
            .add_custom_image_model(value)
            .await
            .map_err(image_model_error)
    }

    pub(super) async fn delete_custom_image_model(
        &self,
        id: String,
    ) -> Result<Value, GatewayApplicationError> {
        self.validate_model_files()?;
        self.validated_root()?;
        self.configuration
            .delete_custom_image_model(id)
            .await
            .map_err(image_model_error)
    }
}

fn image_model_error(error: butler_models::models::ImageModelError) -> GatewayApplicationError {
    let status = if error.code == "image_model_store_failed" {
        500
    } else {
        400
    };
    GatewayApplicationError::Public {
        status,
        code: error.code.into(),
        message: "Image model setting could not be applied.".into(),
        source: Some(Arc::new(error)),
    }
}
