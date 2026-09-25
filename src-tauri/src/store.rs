//! 配置持久化。
//!
//! 存的是**明文 API Secret**,所以:
//!   * 文件权限固定 0600(Windows 上靠用户目录 ACL,不做额外处理)
//!   * 路径在 `~/.config/minvoice/settings.json`,不进仓库、不进安装包
//!   * 目录权限也收成 0700,避免同机其它用户读到

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// 前端表单里的全部内容。字段名走 camelCase,直接和 TS 侧对齐。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub url: String,
    pub api_key: String,
    pub api_secret: String,
    pub identity: String,
    pub display_name: String,
    pub room: String,
    pub ttl: String,
    /// 上次选中的麦克风 / 扬声器,空串表示"系统默认"
    pub mic_device_id: String,
    pub speaker_device_id: String,
    /// 音频处理开关
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain_control: bool,
    /// 启动后自动进入上次的房间(密钥齐全时才生效)
    pub auto_join: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            url: String::new(),
            api_key: String::new(),
            api_secret: String::new(),
            identity: random_identity(),
            display_name: String::new(),
            room: "voice-1".into(),
            ttl: "6h".into(),
            mic_device_id: String::new(),
            speaker_device_id: String::new(),
            echo_cancellation: true,
            noise_suppression: true,
            auto_gain_control: true,
            auto_join: false,
        }
    }
}

/// 生成一个默认参与者 ID。
/// 不用 rand crate:借用 HashMap 每次进程随机的种子 + 时间戳,足够避免撞名,
/// 而且不引依赖。真正的唯一性由用户在表单里改 identity 保证。
pub fn random_identity() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::time::{SystemTime, UNIX_EPOCH};

    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    format!("minvoice-{:08x}", (hasher.finish() & 0xffff_ffff) as u32)
}

pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

/// 读配置。文件不存在/损坏都退回默认值,不让 UI 卡在启动错误上。
pub fn load(config_dir: &Path) -> Settings {
    let path = settings_path(config_dir);
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

/// 写配置,并把权限收紧到 0600。
pub fn save(config_dir: &Path, settings: &Settings) -> Result<(), String> {
    fs::create_dir_all(config_dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    restrict_dir(config_dir);

    let path = settings_path(config_dir);
    let text = serde_json::to_string_pretty(settings).map_err(|e| format!("序列化失败: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    restrict_file(&path);
    Ok(())
}

#[cfg(unix)]
fn restrict_file(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    // Secret 在文件里是明文,权限必须是 0600
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path) {}

#[cfg(unix)]
fn restrict_dir(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn restrict_dir(_path: &Path) {}

/// 从 `livekit/credentials.env` 预填。
///
/// 只用于本机开发:那份文件是服务端密钥的本地副本,预填省得手输。
/// 发布版里这个路径根本不存在,读不到就静默跳过。
pub fn parse_env_file(text: &str) -> Settings {
    let mut s = Settings::default();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim().trim_matches('"').to_string();
        match key.trim() {
            // credentials.env 里 LIVEKIT_URL 和 LIVEKIT_WS_URL 是同一个值。
            // 前者是服务端 SDK 用的正式名字,优先;后者只在没见到前者时兜底。
            "LIVEKIT_URL" => s.url = value,
            "LIVEKIT_WS_URL" => {
                if s.url.is_empty() {
                    s.url = value;
                }
            }
            "LIVEKIT_API_KEY" => s.api_key = value,
            "LIVEKIT_API_SECRET" => s.api_secret = value,
            _ => {}
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_credentials_env() {
        let text = "\
# 注释行
LIVEKIT_URL=wss://livekit.example.com
LIVEKIT_API_KEY=APIfake00000000
LIVEKIT_API_SECRET=abcdef0123456789

LIVEKIT_WS_URL=wss://ignored-because-url-already-set
";
        let s = parse_env_file(text);
        assert_eq!(s.url, "wss://livekit.example.com");
        assert_eq!(s.api_key, "APIfake00000000");
        assert_eq!(s.api_secret, "abcdef0123456789");
        // 未在文件里出现的字段保持默认
        assert_eq!(s.room, "voice-1");

        // 只有 LIVEKIT_WS_URL 时应当兜底生效
        let fallback = parse_env_file("LIVEKIT_WS_URL=wss://ws-only.example\n");
        assert_eq!(fallback.url, "wss://ws-only.example");
    }

    #[test]
    fn random_identity_is_prefixed_and_unique_enough() {
        let a = random_identity();
        let b = random_identity();
        assert!(a.starts_with("minvoice-"));
        // 同一纳秒内两次调用理论上可能相同,但随机种子让概率极低
        assert_ne!(a, b);
    }

    #[test]
    fn round_trips_through_disk_with_0600() {
        let dir = std::env::temp_dir().join(format!("minvoice-test-{}", random_identity()));
        let mut s = Settings::default();
        s.api_secret = "top-secret".into();
        save(&dir, &s).unwrap();

        let back = load(&dir);
        assert_eq!(back.api_secret, "top-secret");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(settings_path(&dir))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "配置文件必须是 0600");
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_falls_back_to_defaults() {
        let dir = std::env::temp_dir().join("minvoice-does-not-exist-xyz");
        let s = load(&dir);
        assert_eq!(s.room, "voice-1");
        assert_eq!(s.ttl, "6h");
    }
}
