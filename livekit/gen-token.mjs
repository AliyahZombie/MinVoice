#!/usr/bin/env node
// LiveKit Access Token 生成器(纯 node:crypto,零依赖)
//
//   node gen-token.mjs --room voice-1 --identity alice [选项]
//
// 选项:
//   --room <name>        房间名(默认 voice-1)
//   --identity <id>      参与者唯一 ID(默认随机)
//   --name <display>     显示名
//   --ttl <dur>          有效期,如 30m / 6h / 7d(默认 6h)
//   --admin              生成服务端管理令牌(可调用 RoomService 等 API)
//   --can-publish false  禁止推流
//   --can-subscribe false 禁止订阅
//   --json               输出 JSON(含 url/key/token)
//
// 密钥来源:环境变量 LIVEKIT_API_KEY/LIVEKIT_API_SECRET,
//          否则读取同目录 credentials.env。

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  try {
    const txt = readFileSync(join(HERE, "credentials.env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    /* 没有就靠环境变量 */
  }
}
loadEnvFile();

const argv = process.argv.slice(2);
const opt = { room: "voice-1", ttl: "6h", admin: false, json: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === "--room") opt.room = next();
  else if (a === "--identity") opt.identity = next();
  else if (a === "--name") opt.name = next();
  else if (a === "--ttl") opt.ttl = next();
  else if (a === "--admin") opt.admin = true;
  else if (a === "--can-publish") opt.canPublish = next() !== "false";
  else if (a === "--can-subscribe") opt.canSubscribe = next() !== "false";
  else if (a === "--json") opt.json = true;
  else if (a === "-h" || a === "--help") {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 21).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(0);
  } else {
    console.error(`未知参数: ${a}(用 --help 看用法)`);
    process.exit(2);
  }
}

const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
if (!apiKey || !apiSecret) {
  console.error("缺少 LIVEKIT_API_KEY / LIVEKIT_API_SECRET(先跑 ./fetch-secrets.sh 生成 credentials.env)");
  process.exit(1);
}

function parseDuration(s) {
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`无法解析时长: ${s}(用 30m / 6h / 7d 这种写法)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

const now = Math.floor(Date.now() / 1000);
const identity = opt.identity || `user-${randomBytes(4).toString("hex")}`;

const payload = {
  exp: now + parseDuration(opt.ttl),
  iss: apiKey,
  nbf: now - 10,
  sub: identity,
  jti: identity,
};
if (opt.name) payload.name = opt.name;

if (opt.admin) {
  // 服务端令牌:覆盖 RoomService 的全部管理动作
  payload.video = {
    roomCreate: true,
    roomList: true,
    roomAdmin: true,
    roomRecord: true,
  };
  if (opt.room && opt.room !== "voice-1") payload.video.room = opt.room;
} else {
  payload.video = {
    room: opt.room,
    roomJoin: true,
    canPublish: opt.canPublish !== false,
    canSubscribe: opt.canSubscribe !== false,
    canPublishData: true,
  };
}
payload.kind = "standard";

const b64 = (buf) => Buffer.from(buf).toString("base64url");
const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const body = b64(JSON.stringify(payload));
const sig = createHmac("sha256", apiSecret).update(`${header}.${body}`).digest("base64url");
const token = `${header}.${body}.${sig}`;

if (opt.json) {
  console.log(JSON.stringify({ url: process.env.LIVEKIT_URL, apiKey, room: opt.room, identity, token }, null, 2));
} else {
  console.log(token);
}
