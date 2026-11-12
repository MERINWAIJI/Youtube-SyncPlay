// YouTube SyncPlay room server.
//
// In-memory rooms over WebSocket. One connection is bound to at most one
// member of one room. The server is the single source of truth for the room
// timeline: every accepted playback change gets a sequence number and a
// server timestamp, and every room:state carries `playbackAgeMs` (a duration,
// never an instant) so clients can extrapolate the position without sharing a
// clock with the server.

import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const DEFAULTS = {
  port: 8787,
  host: "0.0.0.0",
  allowedOrigins: [],
  maxMembersPerRoom: 20,
  maxPayloadBytes: 8 * 1024,
  // A member whose socket drops keeps the seat this long, so a service-worker
  // restart or a network blip does not show up as leave + join.
  memberGraceMs: 20_000,
  // An empty room keeps its invite valid this long.
  emptyRoomTtlMs: 10 * 60_000,
  rateLimitBurst: 40,
  rateLimitWindowMs: 10_000,
  heartbeatMs: 30_000,
  log: true,
};

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 32);
}

function isPlaybackInput(p) {
  return (
    p &&
    typeof p === "object" &&
    typeof p.videoId === "string" &&
    VIDEO_ID_RE.test(p.videoId) &&
    Number.isFinite(p.currentTime) &&
    p.currentTime >= 0 &&
    p.currentTime < 1e7 &&
    (p.playState === "playing" || p.playState === "paused") &&
    Number.isFinite(p.playbackRate) &&
    p.playbackRate >= 0.0625 &&
    p.playbackRate <= 16
  );
}

export function startServer(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const rooms = new Map();
  const log = (...args) => {
    if (cfg.log) console.log(new Date().toISOString(), ...args);
  };

  // ---- origin policy -------------------------------------------------------
  // With ALLOWED_ORIGINS set, only those exact origins may connect. Without
  // it, any browser-extension origin is accepted and web pages are rejected,
  // so a random website cannot drive rooms from a visitor's browser.
  function originAllowed(origin) {
    if (cfg.allowedOrigins.length > 0) {
      return cfg.allowedOrigins.includes(origin || "");
    }
    if (!origin) return true; // non-browser client (tests, CLI)
    return /^(chrome-extension|moz-extension):\/\//.test(origin);
  }

  // ---- room helpers --------------------------------------------------------
  function newRoomCode() {
    for (;;) {
      const bytes = randomBytes(6);
      let code = "";
      for (const b of bytes) code += ROOM_CODE_ALPHABET[b % 32];
      if (!rooms.has(code)) return code;
    }
  }

  function createRoom() {
    const room = {
      code: newRoomCode(),
      joinToken: randomBytes(12).toString("base64url"),
      members: new Map(),
      sharedVideo: null,
      playback: null,
      seq: 0,
      emptyTimer: null,
    };
    rooms.set(room.code, room);
    return room;
  }

  function orderedMembers(room) {
    return [...room.members.values()].sort(
      (a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1),
    );
  }

  // Share ownership follows the original sharer while they hold a seat, and
  // otherwise falls to the longest-present member. Resolved on every send,
  // never rewritten in storage, so a sharer who reconnects gets it back.
  function resolveSharedVideo(room) {
    if (!room.sharedVideo) return null;
    const stored = room.members.get(room.sharedVideo.sharedByMemberId);
    const owner = stored || orderedMembers(room)[0] || null;
    return {
      videoId: room.sharedVideo.videoId,
      url: room.sharedVideo.url,
      title: room.sharedVideo.title,
      sharedByMemberId: owner ? owner.id : null,
      sharedByDisplayName: owner ? owner.name : null,
    };
  }

  function stateMessage(room) {
    const pb = room.playback;
    return {
      type: "room:state",
      payload: {
        roomCode: room.code,
        sharedVideo: resolveSharedVideo(room),
        playback: pb,
        members: orderedMembers(room).map((m) => ({ id: m.id, name: m.name })),
        // Recomputed at send time: how stale `playback` is right now.
        playbackAgeMs: pb ? Math.max(0, Date.now() - pb.serverTime) : 0,
      },
    };
  }

  function send(ws, message) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
  }

  function sendError(ws, code, message) {
    send(ws, { type: "error", payload: { code, message } });
  }

  function broadcast(room, message, exceptMemberId) {
    for (const m of room.members.values()) {
      if (m.id !== exceptMemberId) send(m.socket, message);
    }
  }

  function broadcastState(room) {
    for (const m of room.members.values()) send(m.socket, stateMessage(room));
  }

  function scheduleEmptyCheck(room) {
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
    if (room.members.size > 0) return;
    room.emptyTimer = setTimeout(() => {
      if (room.members.size === 0) {
        rooms.delete(room.code);
        log("room expired", room.code);
      }
    }, cfg.emptyRoomTtlMs);
    room.emptyTimer.unref?.();
  }

  function removeMember(room, member) {
    if (room.members.get(member.id) !== member) return;
    clearTimeout(member.graceTimer);
    room.members.delete(member.id);
    log("member left", room.code, member.name);
    broadcast(room, {
      type: "room:member-left",
      payload: { roomCode: room.code, member: { id: member.id, name: member.name } },
    });
    broadcastState(room);
    scheduleEmptyCheck(room);
  }

  function attach(ws, room, member) {
    ws.ctx.room = room;
    ws.ctx.member = member;
    member.socket = ws;
    clearTimeout(member.graceTimer);
    member.graceTimer = null;
    clearTimeout(room.emptyTimer);
    room.emptyTimer = null;
  }

  function detach(ws) {
    const { room, member } = ws.ctx;
    ws.ctx.room = null;
    ws.ctx.member = null;
    if (member && member.socket === ws) member.socket = null;
    return { room, member };
  }

  function addMember(ws, room, displayName) {
    const member = {
      id: randomUUID(),
      token: randomBytes(18).toString("base64url"),
      name: cleanName(displayName) || "Guest-" + randomBytes(2).toString("hex"),
      joinedAt: Date.now(),
      socket: null,
      graceTimer: null,
    };
    room.members.set(member.id, member);
    attach(ws, room, member);
    return member;
  }

  // ---- message handlers ----------------------------------------------------
  function leaveCurrent(ws) {
    const { room, member } = detach(ws);
    if (room && member) removeMember(room, member);
  }

  function onCreate(ws, payload) {
    leaveCurrent(ws);
    const room = createRoom();
    const member = addMember(ws, room, payload?.displayName);
    log("room created", room.code, "by", member.name);
    send(ws, {
      type: "room:created",
      payload: {
        roomCode: room.code,
        joinToken: room.joinToken,
        memberId: member.id,
        memberToken: member.token,
      },
    });
    send(ws, stateMessage(room));
  }

  function onJoin(ws, payload) {
    if (
      !payload ||
      typeof payload.roomCode !== "string" ||
      typeof payload.joinToken !== "string"
    ) {
      return sendError(ws, "invalid_message", "roomCode and joinToken required");
    }
    const room = rooms.get(payload.roomCode.toUpperCase());
    if (!room) return sendError(ws, "room_not_found", "Room not found");
    if (payload.joinToken !== room.joinToken) {
      return sendError(ws, "join_token_invalid", "Invalid join token");
    }

    // Reconnect: a still-valid memberToken takes its old seat back silently.
    let member = null;
    if (typeof payload.memberToken === "string") {
      member =
        [...room.members.values()].find((m) => m.token === payload.memberToken) ||
        null;
    }

    if (ws.ctx.member && ws.ctx.member !== member) leaveCurrent(ws);

    let rejoined = false;
    if (member) {
      rejoined = true;
      const old = member.socket;
      if (old && old !== ws) {
        old.ctx.room = null;
        old.ctx.member = null;
        old.close(4000, "replaced");
      }
      attach(ws, room, member);
      const name = cleanName(payload.displayName);
      if (name) member.name = name;
    } else {
      if (room.members.size >= cfg.maxMembersPerRoom) {
        return sendError(ws, "room_full", "Room is full");
      }
      member = addMember(ws, room, payload.displayName);
      log("member joined", room.code, member.name);
    }

    send(ws, {
      type: "room:joined",
      payload: {
        roomCode: room.code,
        joinToken: room.joinToken,
        memberId: member.id,
        memberToken: member.token,
      },
    });
    if (!rejoined) {
      broadcast(
        room,
        {
          type: "room:member-joined",
          payload: {
            roomCode: room.code,
            member: { id: member.id, name: member.name },
          },
        },
        member.id,
      );
    }
    broadcastState(room);
  }

  function requireMember(ws) {
    if (ws.ctx.room && ws.ctx.member) return true;
    sendError(ws, "not_in_room", "Join a room first");
    return false;
  }

  function stampPlayback(room, member, input) {
    room.seq += 1;
    return {
      videoId: input.videoId,
      currentTime: input.currentTime,
      playState: input.playState,
      playbackRate: input.playbackRate,
      actorId: member.id,
      actorName: member.name,
      seq: room.seq,
      serverTime: Date.now(),
    };
  }

  function onShare(ws, payload) {
    if (!requireMember(ws)) return;
    const { room, member } = ws.ctx;
    const video = payload?.video;
    if (
      !video ||
      typeof video.videoId !== "string" ||
      !VIDEO_ID_RE.test(video.videoId)
    ) {
      return sendError(ws, "invalid_message", "Invalid video");
    }
    const title =
      typeof video.title === "string" ? video.title.trim().slice(0, 200) : "";
    room.sharedVideo = {
      videoId: video.videoId,
      // Built server-side from the validated id, so clients never open a URL
      // another client made up.
      url: "https://www.youtube.com/watch?v=" + video.videoId,
      title: title || video.videoId,
      sharedByMemberId: member.id,
    };
    const pb =
      isPlaybackInput(payload.playback) &&
      payload.playback.videoId === video.videoId
        ? payload.playback
        : {
            videoId: video.videoId,
            currentTime: 0,
            playState: "paused",
            playbackRate: 1,
          };
    room.playback = stampPlayback(room, member, pb);
    log("video shared", room.code, video.videoId, "by", member.name);
    broadcastState(room);
  }

  function onPlayback(ws, payload) {
    if (!requireMember(ws)) return;
    const { room, member } = ws.ctx;
    const pb = payload?.playback;
    if (!isPlaybackInput(pb)) {
      return sendError(ws, "invalid_message", "Invalid playback state");
    }
    // A late update for a video the room already moved away from is dropped
    // quietly; it is a normal race, not a client error.
    if (!room.sharedVideo || room.sharedVideo.videoId !== pb.videoId) return;
    room.playback = stampPlayback(room, member, pb);
    broadcastState(room);
  }

  function onProfile(ws, payload) {
    if (!requireMember(ws)) return;
    const name = cleanName(payload?.displayName);
    if (!name) return sendError(ws, "invalid_message", "Invalid display name");
    ws.ctx.member.name = name;
    broadcastState(ws.ctx.room);
  }

  function handle(ws, msg) {
    switch (msg.type) {
      case "ping":
        return send(ws, { type: "pong", payload: { serverTime: Date.now() } });
      case "room:create":
        return onCreate(ws, msg.payload);
      case "room:join":
        return onJoin(ws, msg.payload);
      case "room:leave":
        return leaveCurrent(ws);
      case "video:share":
        return onShare(ws, msg.payload);
      case "playback:update":
        return onPlayback(ws, msg.payload);
      case "profile:update":
        return onProfile(ws, msg.payload);
      case "sync:request":
        if (requireMember(ws)) send(ws, stateMessage(ws.ctx.room));
        return;
      default:
        return sendError(ws, "invalid_message", "Unknown message type");
    }
  }

  // ---- transport -----------------------------------------------------------
  const http = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("YouTube SyncPlay server: connect with WebSocket.\n");
  });

  const wss = new WebSocketServer({
    server: http,
    maxPayload: cfg.maxPayloadBytes,
    verifyClient: (info, done) => {
      if (originAllowed(info.origin)) return done(true);
      log("origin rejected", info.origin);
      done(false, 403, "Origin not allowed");
    },
  });

  wss.on("connection", (ws) => {
    ws.ctx = {
      room: null,
      member: null,
      alive: true,
      tokens: cfg.rateLimitBurst,
      refilledAt: Date.now(),
    };

    ws.on("pong", () => {
      ws.ctx.alive = true;
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return sendError(ws, "invalid_message", "Text frames only");

      // Token bucket: refills continuously over the window.
      const now = Date.now();
      const c = ws.ctx;
      c.tokens = Math.min(
        cfg.rateLimitBurst,
        c.tokens +
          ((now - c.refilledAt) / cfg.rateLimitWindowMs) * cfg.rateLimitBurst,
      );
      c.refilledAt = now;
      if (c.tokens < 1) return sendError(ws, "rate_limited", "Too many messages");
      c.tokens -= 1;

      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return sendError(ws, "invalid_message", "Invalid JSON");
      }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
        return sendError(ws, "invalid_message", "Missing type");
      }
      try {
        handle(ws, msg);
      } catch (err) {
        log("handler error", err);
        sendError(ws, "internal_error", "Internal error");
      }
    });

    ws.on("close", () => {
      const { room, member } = detach(ws);
      if (!room || !member) return;
      member.graceTimer = setTimeout(() => {
        if (!member.socket) removeMember(room, member);
      }, cfg.memberGraceMs);
      member.graceTimer.unref?.();
    });

    ws.on("error", () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.ctx?.alive) {
        ws.terminate();
        continue;
      }
      ws.ctx.alive = false;
      ws.ping();
    }
  }, cfg.heartbeatMs);
  heartbeat.unref?.();

  const listening = new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(cfg.port, cfg.host, () => {
      const port = http.address().port;
      log(`YouTube SyncPlay server listening on ws://${cfg.host}:${port}`);
      resolve(port);
    });
  });

  return {
    listening,
    rooms,
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      for (const room of rooms.values()) {
        clearTimeout(room.emptyTimer);
        for (const m of room.members.values()) clearTimeout(m.graceTimer);
      }
      return new Promise((resolve) => wss.close(() => http.close(resolve)));
    },
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = startServer({
    port: Number(process.env.PORT) || DEFAULTS.port,
    host: process.env.HOST || DEFAULTS.host,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxMembersPerRoom:
      Number(process.env.MAX_MEMBERS_PER_ROOM) || DEFAULTS.maxMembersPerRoom,
  });
  server.listening.catch((err) => {
    console.error("Failed to start:", err.message);
    process.exit(1);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => server.close().then(() => process.exit(0)));
  }
}
