#!/usr/bin/env node
// E2E 测试页服务:静态托管 + 回收页面里的测试结果
//
//   node server.mjs [port]
//
// 页面每 2 秒把 window.__state POST 到 /result?role=xxx,
// 这里落到 results/<role>.json 并打印到 stdout,供无头 Chrome 场景做断言。

import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8099);
const RESULTS = join(HERE, "results");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

await mkdir(RESULTS, { recursive: true });

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/result") {
    const role = url.searchParams.get("role") || "unknown";
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body);
      await mkdir(RESULTS, { recursive: true });   // 目录被清理掉也能自愈
      await writeFile(join(RESULTS, `${role}.json`), JSON.stringify(parsed, null, 2));
      const media = parsed.media || {};
      const parts = [];
      if (media.receiverStats) {
        const r = media.receiverStats;
        parts.push(`收到 ${r.bytesReceived}B/${r.packetsReceived}pkts,解码 ${r.framesDecoded} 帧,丢 ${r.packetsLost}`);
      }
      if (media.senderStats) {
        const s = media.senderStats;
        parts.push(`发出 ${s.outboundBytes}B/${s.outboundPackets}pkts,编码 ${s.framesEncoded} 帧`);
      }
      for (const [k, v] of Object.entries(media)) {
        if (v && v.selectedPair) parts.push(`${k}: ${v.selectedPair.protocol}/${v.selectedPair.localType} ice=${v.pc?.ice} dtls=${v.pc?.dtls}`);
      }
      console.log(`[${role}] phase=${parsed.phase}${parsed.dataReceived ? " data=" + parsed.dataReceived.text : ""} ${parts.join(" | ")}${parsed.error ? " ERROR=" + parsed.error : ""}`);
    } catch (e) {
      console.log(`[${role}] 结果解析失败: ${e.message}`);
    }
    res.writeHead(204).end();
    return;
  }

  // 静态文件
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const path = join(HERE, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!path.startsWith(HERE)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(path);
    res.writeHead(200, { "Content-Type": MIME[path.slice(path.lastIndexOf("."))] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`E2E 测试页: http://127.0.0.1:${PORT}/index.html`));
