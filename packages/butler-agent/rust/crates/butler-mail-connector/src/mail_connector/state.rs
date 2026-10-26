use super::{Result, Value};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::Path};

#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Cursor {
    pub validity: u32,
    pub last: u32,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct State {
    pub cursor: Option<Cursor>,
    #[serde(skip)]
    pub moved: VecDeque<String>,
    #[serde(default)]
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
    pub(super) fn batch(&self) -> Value {
        let cursor = self.pending.last().map(|(_, c)| c).or(self.cursor.as_ref());
        let cursor = cursor.map_or_else(|| "0-0".into(), |c| format!("{}-{}", c.validity, c.last));
        serde_json::json!({"cursor":cursor,"events":self.pending.iter().map(|(v,_)|v).collect::<Vec<_>>()})
    }
    pub(super) async fn acknowledge(&mut self, path: &Path, cursor: &str) -> Result<()> {
        let (validity, last) = cursor.split_once('-').ok_or("mail_cursor_invalid")?;
        let validity = validity.parse::<u32>().map_err(|_| "mail_cursor_invalid")?;
        let last = last.parse::<u32>().map_err(|_| "mail_cursor_invalid")?;
        if validity == 0 && last == 0 {
            return Ok(());
        }
        if self
            .cursor
            .as_ref()
            .is_some_and(|c| c.validity == validity && last <= c.last)
        {
            return Ok(());
        }
        let through = self
            .pending
            .iter()
            .position(|(_, c)| c.validity == validity && c.last == last)
            .ok_or("mail_cursor_invalid")?;
        let mut saved = self.clone();
        saved.cursor = Some(Cursor { validity, last });
        saved.pending.drain(..=through);
        saved.save(path).await?;
        *self = saved;
        Ok(())
    }
}
