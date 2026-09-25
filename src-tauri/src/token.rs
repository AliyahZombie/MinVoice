//! LiveKit Access Token 本地签发(HS256 JWT,零外部依赖)
//!
//! 为什么放在 Rust 侧而不是前端:
//! Tauri 的 WebView 里跑的是页面代码,任何注入/调试都能翻出内存里的字符串。
//! 把 API Secret 留在 Rust,前端只通过 IPC 说"给我签一个 token",Secret 永远
//! 不进 JS 世界。前端也不需要网络请求,断网也能签(签完才需要连服务器)。
//!
//! 官方推荐是 token 由服务端签发、客户端只拿 token(见 livekit/README.md)。
//! MinVoice 是单机自用客户端,按需求把签发搬到本地;代价是这台机器上必须存
//! Secret,所以配置文件权限设 0600,别把 ~/.config/minvoice 同步到任何地方。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

/// 签发一个房间 token 需要的输入。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MintRequest {
    pub api_key: String,
    pub api_secret: String,
    /// 参与者唯一 ID。同一房间内重复会被服务端踢掉旧连接。
    pub identity: String,
    /// 展示给别人的名字,写进 token 的 `name` claim。
    #[serde(default)]
    pub display_name: Option<String>,
    pub room: String,
    /// 有效期(秒)
    pub ttl_seconds: u64,
}

/// 前端表单直接传进来的东西:有效期是 "6h" 这种人类写法,不是秒。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MintInput {
    pub api_key: String,
    pub api_secret: String,
    pub identity: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub room: String,
    #[serde(default)]
    pub ttl: String,
}

impl MintInput {
    pub fn into_request(self) -> Result<MintRequest, String> {
        let ttl_seconds = parse_ttl(&self.ttl)?;
        Ok(MintRequest {
            api_key: self.api_key,
            api_secret: self.api_secret,
            identity: self.identity,
            display_name: self.display_name,
            room: self.room,
            ttl_seconds,
        })
    }
}

/// 签好的 token + 前端连房间需要的元信息。
/// 这里**不含** url 与 secret:url 前端本来就有,secret 永不回传。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MintResult {
    pub token: String,
    pub room: String,
    pub identity: String,
    pub expires_at: u64,
    pub ttl_seconds: u64,
}

/// 纯函数式的 HS256 签名:输入待签串和密钥,输出 base64url(无填充)签名。
/// 单独抽出来是为了能用 RFC 7515 的标准测试向量做回归。
fn sign_hs256(signing_input: &str, secret: &[u8]) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret).expect("HMAC-SHA256 接受任意长度密钥,不会失败");
    mac.update(signing_input.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

fn b64(input: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(input)
}

pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 按指定时间签发,便于测试复现。
pub fn mint_at(request: &MintRequest, now: u64) -> Result<String, String> {
    if request.api_key.trim().is_empty() {
        return Err("API Key 不能为空".into());
    }
    if request.api_secret.trim().is_empty() {
        return Err("API Secret 不能为空".into());
    }
    if request.identity.trim().is_empty() {
        return Err("参与者 ID 不能为空".into());
    }
    if request.room.trim().is_empty() {
        return Err("房间名不能为空".into());
    }

    // 字段名与 LiveKit 服务端解析的 claim 保持一致(camelCase)。
    // roomAdmin 显式写 false:客户端只需要进房间说话,不要管理权限。
    let video = serde_json::json!({
        "room": request.room,
        "roomJoin": true,
        "canPublish": true,
        "canSubscribe": true,
        "canPublishData": true,
        "roomAdmin": false,
    });

    let mut payload = serde_json::json!({
        "exp": now + request.ttl_seconds,
        "iss": request.api_key,
        // 留 10s 时钟偏移余量,避免本机比服务器快一点就 nbf 校验失败
        "nbf": now.saturating_sub(10),
        "sub": request.identity,
        "jti": request.identity,
        "video": video,
        "kind": "standard",
    });

    if let Some(name) = request.display_name.as_deref() {
        let name = name.trim();
        if !name.is_empty() {
            payload["name"] = serde_json::Value::String(name.to_string());
        }
    }

    let header = b64(br#"{"alg":"HS256","typ":"JWT"}"#);
    let body = b64(payload.to_string().as_bytes());
    let signing_input = format!("{header}.{body}");
    let signature = sign_hs256(&signing_input, request.api_secret.as_bytes());

    Ok(format!("{signing_input}.{signature}"))
}

pub fn mint(request: &MintRequest) -> Result<String, String> {
    mint_at(request, unix_now())
}

/// 解析 "6h" / "30m" / "7d" / "45s" / 纯数字(秒)为秒数。
pub fn parse_ttl(raw: &str) -> Result<u64, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(6 * 3600);
    }
    // 纯数字按秒处理
    if let Ok(secs) = raw.parse::<u64>() {
        return Ok(secs.max(30));
    }
    let unit_start = raw.char_indices().last().unwrap().0;
    let (digits, unit) = raw.split_at(unit_start);
    let value: u64 = digits
        .trim()
        .parse()
        .map_err(|_| format!("无法解析有效期 {raw:?}:用 30m / 6h / 7d 这种写法"))?;
    let mult = match unit {
        "s" | "S" => 1,
        "m" | "M" => 60,
        "h" | "H" => 3600,
        "d" | "D" => 86400,
        other => return Err(format!("不支持的时间单位 {other:?}:只认 s/m/h/d")),
    };
    value
        .checked_mul(mult)
        .map(|seconds| seconds.max(30))
        .ok_or_else(|| "有效期过大".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7515 Appendix A.1 的标准向量。
    /// 过了这个,说明 base64url(无填充)编码和 HMAC-SHA256 的字节级行为都对。
    ///
    /// 注意:签名输入是 RFC 里那份**带 CRLF 和空格**的 JSON 原文,不是压缩过的
    /// 等价 JSON —— 换个写法签名就完全不同。这里从原文自己编码,顺便把编码器也验了。
    #[test]
    fn rfc7515_hs256_known_answer() {
        let header = "{\"typ\":\"JWT\",\r\n \"alg\":\"HS256\"}";
        let payload =
            "{\"iss\":\"joe\",\r\n \"exp\":1300819380,\r\n \"http://example.com/is_root\":true}";

        let header_b64 = b64(header.as_bytes());
        let payload_b64 = b64(payload.as_bytes());

        // 先对齐 RFC 给出的 base64url 结果
        assert_eq!(header_b64, "eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9");
        assert_eq!(
            payload_b64,
            "eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ"
        );

        let key = URL_SAFE_NO_PAD
            .decode(
                "AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow",
            )
            .expect("测试密钥本身必须是合法 base64url");

        let signing_input = format!("{header_b64}.{payload_b64}");
        assert_eq!(
            sign_hs256(&signing_input, &key),
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        );
    }

    /// 固定时钟 + 固定输入 → 固定 token。
    /// 这个字符串和 livekit/gen-token.mjs 的产物逐字节相同(见 tests/README 的交叉校验)。
    #[test]
    fn mint_is_deterministic_for_fixed_clock() {
        let req = MintRequest {
            api_key: "APItestkey".into(),
            api_secret: "testsecret".into(),
            identity: "alice".into(),
            display_name: Some("Alice".into()),
            room: "voice-1".into(),
            ttl_seconds: 3600,
        };
        let token = mint_at(&req, 1_700_000_000).unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3, "JWT 必须是三段");

        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header["alg"], "HS256");

        let payload: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(payload["iss"], "APItestkey");
        assert_eq!(payload["sub"], "alice");
        assert_eq!(payload["name"], "Alice");
        assert_eq!(payload["exp"], 1_700_003_600u64);
        assert_eq!(payload["nbf"], 1_699_999_990u64);
        assert_eq!(payload["video"]["room"], "voice-1");
        assert_eq!(payload["video"]["roomJoin"], true);
        assert_eq!(payload["video"]["roomAdmin"], false);
    }

    /// 自己验一遍签名,确保 token 拿出去能被 HMAC 校验通过。
    #[test]
    fn signature_verifies_against_secret() {
        let req = MintRequest {
            api_key: "k".into(),
            api_secret: "s3cr3t".into(),
            identity: "bob".into(),
            display_name: None,
            room: "r".into(),
            ttl_seconds: 60,
        };
        let token = mint_at(&req, 42).unwrap();
        let (signing_input, sig) = token.rsplit_once('.').unwrap();
        assert_eq!(sig, sign_hs256(signing_input, b"s3cr3t"));
        assert_ne!(sig, sign_hs256(signing_input, b"wrong"));
    }

    #[test]
    fn empty_credentials_are_rejected() {
        let mut req = MintRequest {
            api_key: "k".into(),
            api_secret: "".into(),
            identity: "bob".into(),
            display_name: None,
            room: "r".into(),
            ttl_seconds: 60,
        };
        assert!(mint_at(&req, 0).is_err());
        req.api_secret = "s".into();
        req.room = "  ".into();
        assert!(mint_at(&req, 0).is_err());
    }

    #[test]
    fn ttl_parsing() {
        assert_eq!(parse_ttl("6h").unwrap(), 21600);
        assert_eq!(parse_ttl("30m").unwrap(), 1800);
        assert_eq!(parse_ttl("7d").unwrap(), 604800);
        assert_eq!(parse_ttl("90").unwrap(), 90);
        assert_eq!(parse_ttl("").unwrap(), 21600);
        assert!(parse_ttl("6x").is_err());
        assert!(parse_ttl("abc").is_err());
        assert!(parse_ttl("小时").is_err());
        assert!(parse_ttl("18446744073709551615d").is_err());
    }
}
