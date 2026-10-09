/**
 * Daystream — Glitch Edition
 * ==========================
 * One file. Paste into Glitch. Done.
 *
 * Routes:
 *   /            → broadcaster (go live page)
 *   /watch/:id   → viewer (watch page)
 *   /streams     → API
 *   /ads         → Ad API
 *   /ws          → WebSocket signaling
 */

const http   = require("http");
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

// Glitch provides PORT automatically
const PORT     = process.env.PORT     || 3000;
const HOST     = "0.0.0.0";
const BASE_URL = process.env.BASE_URL || "https://your-project-name.glitch.me";

// ── Store ─────────────────────────────────────────────────────────────────────

const streams = new Map();
const viewers = new Map();

function uid(len = 10) {
  return crypto.randomBytes(len).toString("base64url").slice(0, len);
}

function broadcast(streamId, message) {
  for (const [, v] of viewers) {
    if (v.streamId === streamId && v.ws && v.ws.readyState === 1) {
      try { v.ws.send(JSON.stringify(message)); } catch (_) {}
    }
  }
}

// ── Read page and inject API URL ──────────────────────────────────────────────

function servePage(filePath, res) {
  try {
    let html = fs.readFileSync(filePath, "utf-8");
    // Replace placeholder API URL with the real one from .env
    html = html.replace(
      /const API = window\.DALA_API \|\| "[^"]*"/g,
      `const API = window.DALA_API || "${BASE_URL}"`
    );
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (e) {
    res.writeHead(500);
    res.end("Could not load page: " + e.message);
  }
}

function send(res, status, data) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":"Content-Type",
    "Content-Length":              Buffer.byteLength(body),
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", c => { d += c; });
    req.on("end",  () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url    = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(); return;
  }

  // ── Pages ────────────────────────────────────────────────────────────────────

  if (method === "GET" && url.pathname === "/") {
    servePage(path.join(__dirname, "broadcaster", "index.html"), res);
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/watch/")) {
    servePage(path.join(__dirname, "viewer", "index.html"), res);
    return;
  }

  // ── API ───────────────────────────────────────────────────────────────────────

  parseBody(req).then(data => {

    // POST /streams — create a new stream
    if (method === "POST" && url.pathname === "/streams") {
      const id              = uid();
      const shareUrl        = `${BASE_URL}/watch/${id}`;
      const broadcasterName = data.broadcasterName || "Someone";
      const stream = {
        id,
        title:            data.title || "Live",
        broadcasterId:    data.broadcasterId || uid(),
        broadcasterName,
        startedAt:        Date.now(),
        viewerCount:      0,
        peakViewers:      0,
        comments:         [],
        reactions:        { fire: 0, heart: 0, clap: 0, wow: 0 },
        status:           "waiting",
        shareUrl,
        whatsappUrl: `https://wa.me/?text=${encodeURIComponent(
          `🔴 ${broadcasterName} is LIVE on Daystream\n\nWatch now 👉 ${shareUrl}\n\n_Tap the link — opens right inside WhatsApp_`
        )}`,
      };
      streams.set(id, stream);
      send(res, 201, stream);
      return;
    }

    // GET /streams/:id
    if (method === "GET" && url.pathname.match(/^\/streams\/[\w-]+$/)) {
      const id     = url.pathname.split("/")[2];
      const stream = streams.get(id);
      if (!stream) { send(res, 404, { error: "stream not found" }); return; }
      send(res, 200, stream);
      return;
    }

    // PATCH /streams/:id/status
    if (method === "PATCH" && url.pathname.match(/^\/streams\/[\w-]+\/status$/)) {
      const id     = url.pathname.split("/")[2];
      const stream = streams.get(id);
      if (!stream) { send(res, 404, { error: "not found" }); return; }
      stream.status = data.status;
      if (data.status === "live")  broadcast(id, { type: "stream_live" });
      if (data.status === "ended") broadcast(id, { type: "stream_ended" });
      send(res, 200, stream);
      return;
    }

    // GET /ads
    if (method === "GET" && url.pathname === "/ads") {
      send(res, 200, {
        id: uid(6), type: "preroll", duration: 15, skipAfter: 5,
        videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
        clickUrl: `${BASE_URL}/advertise`,
        brand: "Daystream Ads", cta: "Learn More",
      });
      return;
    }

    send(res, 404, { error: "not found" });

  });
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

server.on("upgrade", (req, socket) => {
  const url      = new URL(req.url, `http://${req.headers.host}`);
  const streamId = url.searchParams.get("streamId");
  const role     = url.searchParams.get("role");
  const vid      = uid();

  // Handshake
  const accept = crypto.createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const ws = makeWs(socket);

  if (role === "viewer" && streamId) {
    viewers.set(vid, { streamId, ws });
    const stream = streams.get(streamId);
    if (stream) {
      stream.viewerCount++;
      stream.peakViewers = Math.max(stream.peakViewers, stream.viewerCount);
      broadcast(streamId, { type: "viewer_count", count: stream.viewerCount });
      ws.send(JSON.stringify({ type: "init", stream }));
    }
  }

  ws.on("message", raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const sid    = msg.streamId || streamId;
    const stream = streams.get(sid);
    if (!stream) return;

    if (msg.type === "offer")    { stream.sdpOffer = msg.sdp; broadcast(sid, { type: "offer", sdp: msg.sdp }); }
    if (msg.type === "answer")   { ws.send(JSON.stringify({ type: "answer", sdp: msg.sdp })); }
    if (msg.type === "ice")      { broadcast(sid, { type: "ice", candidate: msg.candidate }); }
    if (msg.type === "reaction") {
      if (msg.emoji in stream.reactions) stream.reactions[msg.emoji]++;
      broadcast(sid, { type: "reaction", emoji: msg.emoji, totals: stream.reactions });
    }
    if (msg.type === "comment") {
      const entry = { id: uid(6), author: msg.author, text: msg.text, ts: Date.now() };
      stream.comments.push(entry);
      if (stream.comments.length > 200) stream.comments.shift();
      broadcast(sid, { type: "comment", comment: entry });
    }
  });

  ws.on("close", () => {
    if (role === "viewer") {
      viewers.delete(vid);
      const stream = streams.get(streamId);
      if (stream && stream.viewerCount > 0) {
        stream.viewerCount--;
        broadcast(streamId, { type: "viewer_count", count: stream.viewerCount });
      }
    }
  });
});

// ── Minimal WebSocket frame codec ─────────────────────────────────────────────

function makeWs(socket) {
  const handlers = {};
  let buf = Buffer.alloc(0);

  socket.on("data", chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const op   = buf[0] & 0x0f;
      const mask = (buf[1] & 0x80) !== 0;
      let plen   = buf[1] & 0x7f;
      let off    = 2;
      if (plen === 126) { if (buf.length < 4) break; plen = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + (mask ? 4 : 0) + plen) break;
      const key = mask ? buf.slice(off, off + 4) : null;
      if (mask) off += 4;
      const payload = buf.slice(off, off + plen);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
      buf = buf.slice(off + plen);
      if (op === 8) { (handlers.close || []).forEach(h => h()); socket.end(); return; }
      if (op === 1) (handlers.message || []).forEach(h => h(payload.toString()));
    }
  });

  socket.on("end",   () => (handlers.close || []).forEach(h => h()));
  socket.on("error", () => (handlers.close || []).forEach(h => h()));

  return {
    readyState: 1,
    send(data) {
      const p = Buffer.from(String(data));
      const h = Buffer.alloc(p.length < 126 ? 2 : 4);
      h[0] = 0x81;
      if (p.length < 126) h[1] = p.length;
      else { h[1] = 126; h.writeUInt16BE(p.length, 2); }
      try { socket.write(Buffer.concat([h, p])); } catch (_) {}
    },
    on(ev, fn) { handlers[ev] = handlers[ev] || []; handlers[ev].push(fn); },
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, () => {
  console.log(`Daystream running on port ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
});
