use super::{Result, Value};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::Path};

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Cursor {
    pub validity: u32,
    pub last: u32,
}
#[derive(Default, Serialize, Deserialize)]
pub(super) struct State {
    pub cursor: Option<Cursor>,
    #[serde(skip)]
    pub moved: VecDeque<String>,
    #[serde(skip)]
    pub pending: Vec<(Value, Cursor)>,
}
impl State {
    pub(super) async fn load(path: &Path) -> Result<Self> {
        match tokio::fs::read(path.join("state.json")).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "mail_state_invalid"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("mail_state_failed"),
        }
    }
    pub(super) async fn save(&self, path: &Path) -> Result<()> {
        tokio::fs::create_dir_all(path)
            .await
            .map_err(|_| "mail_state_failed")?;
        let bytes = serde_json::to_vec(self).map_err(|_| "mail_state_failed")?;
        tokio::fs::write(path.join("state.tmp"), bytes)
            .await
            .map_err(|_| "mail_state_failed")?;
        tokio::fs::rename(path.join("state.tmp"), path.join("state.json"))
            .await
            .map_err(|_| "mail_state_failed")
    }
    pub(super) async fn moved(path: &Path) -> Result<VecDeque<String>> {
        match tokio::fs::read(path.join("moved.json")).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "mail_state_invalid"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(VecDeque::new()),
            Err(_) => Err("mail_state_failed"),
        }
    }
    pub(super) async fn remember(&mut self, path: &Path, key: String) -> Result<()> {
        self.moved = Self::moved(path).await?;
        if !self.moved.contains(&key) {
            self.moved.push_back(key);
        }
        while self.moved.len() > 4096 {
            self.moved.pop_front();
        }
        tokio::fs::create_dir_all(path)
            .await
            .map_err(|_| "mail_state_failed")?;
        let bytes = serde_json::to_vec(&self.moved).map_err(|_| "mail_state_failed")?;
        tokio::fs::write(path.join("moved.tmp"), bytes)
            .await
            .map_err(|_| "mail_state_failed")?;
        tokio::fs::rename(path.join("moved.tmp"), path.join("moved.json"))
            .await
            .map_err(|_| "mail_state_failed")
    }
    pub(super) async fn drain(&mut self, path: &Path) -> Result<Vec<Value>> {
        if let Some((_, cursor)) = self.pending.last() {
            self.cursor = Some(cursor.clone());
            self.save(path).await?;
        }
        Ok(std::mem::take(&mut self.pending)
            .into_iter()
            .map(|(event, _)| event)
            .collect())
    }
}
