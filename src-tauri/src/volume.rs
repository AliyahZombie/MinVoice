//! Local listening preferences, scoped by server and participant identity.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

pub const DEFAULT_VOLUME: u16 = 100;

pub fn gain(percent: u16) -> Result<f64, String> {
    if percent > 200 {
        return Err("音量必须在 0–200% 之间".into());
    }
    Ok(f64::from(percent) / 100.0)
}

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Preferences {
    #[serde(default)]
    servers: BTreeMap<String, BTreeMap<String, u16>>,
}

impl Preferences {
    pub fn load(dir: &Path) -> Result<Self, String> {
        match fs::read(dir.join("participant-volumes.json")) {
            Ok(data) => {
                serde_json::from_slice(&data).map_err(|e| format!("读取本地音量设置失败: {e}"))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("读取本地音量设置失败: {e}")),
        }
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| format!("创建音量设置目录失败: {e}"))?;
        let data = serde_json::to_vec_pretty(self).map_err(|e| e.to_string())?;
        let path = dir.join("participant-volumes.json");
        let temp = dir.join("participant-volumes.json.tmp");
        fs::write(&temp, data).map_err(|e| format!("保存音量设置失败: {e}"))?;
        fs::rename(temp, path).map_err(|e| format!("保存音量设置失败: {e}"))
    }

    pub fn get(&self, server: &str, identity: &str) -> u16 {
        self.servers
            .get(server)
            .and_then(|users| users.get(identity))
            .copied()
            .filter(|value| gain(*value).is_ok())
            .unwrap_or(DEFAULT_VOLUME)
    }

    pub fn set(&mut self, server: &str, identity: &str, percent: u16) -> Result<(), String> {
        gain(percent)?;
        self.servers
            .entry(server.to_owned())
            .or_default()
            .insert(identity.to_owned(), percent);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_gain_and_keeps_other_people_and_servers_unchanged() {
        let mut prefs = Preferences::default();
        prefs.set("wss://a", "alice", 0).unwrap();
        prefs.set("wss://a", "bob", 200).unwrap();
        assert_eq!(prefs.get("wss://a", "alice"), 0);
        assert_eq!(prefs.get("wss://a", "bob"), 200);
        assert_eq!(prefs.get("wss://b", "alice"), 100);
        assert_eq!(prefs.get("wss://a", "unknown"), 100);
        assert!(prefs.set("wss://a", "alice", 201).is_err());
        assert_eq!(prefs.get("wss://a", "alice"), 0);
        assert_eq!(gain(0).unwrap(), 0.0);
        assert_eq!(gain(100).unwrap(), 1.0);
        assert_eq!(gain(200).unwrap(), 2.0);
    }

    #[test]
    fn persists_and_overwrites_preferences_without_credentials() {
        let dir = std::env::temp_dir().join(crate::store::random_identity());
        let mut prefs = Preferences::load(&dir).unwrap();
        prefs.set("wss://example.test", "alice", 65).unwrap();
        prefs.save(&dir).unwrap();
        assert_eq!(
            Preferences::load(&dir)
                .unwrap()
                .get("wss://example.test", "alice"),
            65
        );
        prefs.set("wss://example.test", "alice", 100).unwrap();
        prefs.save(&dir).unwrap();
        assert_eq!(
            Preferences::load(&dir)
                .unwrap()
                .get("wss://example.test", "alice"),
            100
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_saved_volume_falls_back_to_normal() {
        let prefs: Preferences =
            serde_json::from_str(r#"{"servers":{"server":{"alice":65535,"bob":50}}}"#).unwrap();
        assert_eq!(prefs.get("server", "alice"), 100);
        assert_eq!(prefs.get("server", "bob"), 50);
    }
}
