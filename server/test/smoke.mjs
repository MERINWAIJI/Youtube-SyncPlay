// End-to-end smoke test: two clients, one room, share + playback + reconnect.
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startServer } from "../src/server.js";

const server = startServer({ port: 0, host: "127.0.0.1", log: false, memberGraceMs: 150 });
const port = await server.listening;
const url = `ws://127.0.0.1:${port}`;

function client(headers) {
  const ws = new WebSocket(url, { headers });
  const queue = [];
  const waiters = [];
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    ws,
    open: new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    }),
    send: (type, payload) => ws.send(JSON.stringify({ type, payload })),
    next(pred, label = "message") {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout waiting for " + label)), 2000);
        waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
      });
    },
  };
}
const is = (type, extra = () => true) => (m) => m.type === type && extra(m.payload);

let passed = 0;
async function step(name, fn) {
  await fn();
  passed += 1;
  console.log("ok -", name);
}

try {
  const a = client();
  const b = client();
  await Promise.all([a.open, b.open]);
  let created, joined;

  await step("web page origins are rejected", async () => {
    const evil = client({ Origin: "https://evil.example" });
    await assert.rejects(evil.open);
  });

  await step("extension origins are accepted", async () => {
    const ext = client({ Origin: "chrome-extension://abcdefghijklmnop" });
    await ext.open;
    ext.ws.close();
  });

  await step("create room", async () => {
    a.send("room:create", { displayName: "Alice" });
    created = (await a.next(is("room:created"), "room:created")).payload;
    assert.match(created.roomCode, /^[A-Z2-9]{6}$/);
    const st = (await a.next(is("room:state"))).payload;
    assert.deepEqual(st.members.map((m) => m.name), ["Alice"]);
    assert.equal(st.sharedVideo, null);
  });

  await step("join rejects bad room and bad token", async () => {
    b.send("room:join", { roomCode: "NOPE00", joinToken: created.joinToken });
    assert.equal((await b.next(is("error"))).payload.code, "room_not_found");
    b.send("room:join", { roomCode: created.roomCode, joinToken: "wrongwrongwrong" });
    assert.equal((await b.next(is("error"))).payload.code, "join_token_invalid");
  });

  await step("join room (lowercase code accepted)", async () => {
    b.send("room:join", {
      roomCode: created.roomCode.toLowerCase(),
      joinToken: created.joinToken,
      displayName: "Bob",
    });
    joined = (await b.next(is("room:joined"))).payload;
    const ev = (await a.next(is("room:member-joined"))).payload;
    assert.equal(ev.member.name, "Bob");
    const st = (await b.next(is("room:state"))).payload;
    assert.deepEqual(st.members.map((m) => m.name), ["Alice", "Bob"]);
    await a.next(is("room:state"));
  });

  await step("share video reaches everyone with a server-built URL", async () => {
    a.send("video:share", {
      video: { videoId: "dQw4w9WgXcQ", title: "Test video", url: "https://evil.example" },
      playback: { videoId: "dQw4w9WgXcQ", currentTime: 12.5, playState: "playing", playbackRate: 1 },
    });
    const st = (await b.next(is("room:state", (p) => p.sharedVideo))).payload;
    assert.equal(st.sharedVideo.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(st.sharedVideo.sharedByMemberId, created.memberId);
    assert.equal(st.playback.currentTime, 12.5);
    assert.equal(st.playback.actorName, "Alice");
    assert.ok(st.playbackAgeMs >= 0 && st.playbackAgeMs < 1000);
    await a.next(is("room:state", (p) => p.sharedVideo));
  });

  await step("playback update is stamped and broadcast", async () => {
    b.send("playback:update", {
      playback: { videoId: "dQw4w9WgXcQ", currentTime: 40, playState: "paused", playbackRate: 1.5 },
    });
    const st = (await a.next(is("room:state", (p) => p.playback?.playState === "paused"))).payload;
    assert.equal(st.playback.actorId, joined.memberId);
    assert.equal(st.playback.playbackRate, 1.5);
    assert.equal(st.playback.seq, 2);
    await b.next(is("room:state", (p) => p.playback?.seq === 2));
  });

  await step("update for a non-shared video is dropped", async () => {
    b.send("playback:update", {
      playback: { videoId: "aaaaaaaaaaa", currentTime: 1, playState: "playing", playbackRate: 1 },
    });
    b.send("sync:request");
    const st = (await b.next(is("room:state"))).payload;
    assert.equal(st.playback.seq, 2);
  });

  await step("invalid playback is rejected", async () => {
    b.send("playback:update", { playback: { videoId: "dQw4w9WgXcQ", currentTime: -1 } });
    assert.equal((await b.next(is("error"))).payload.code, "invalid_message");
  });

  await step("reconnect with memberToken keeps the seat silently", async () => {
    b.ws.close();
    const b2 = client();
    await b2.open;
    b2.send("room:join", {
      roomCode: created.roomCode,
      joinToken: created.joinToken,
      memberToken: joined.memberToken,
    });
    const again = (await b2.next(is("room:joined"))).payload;
    assert.equal(again.memberId, joined.memberId);
    const st = (await a.next(is("room:state"))).payload;
    assert.equal(st.members.length, 2);
    await new Promise((r) => setTimeout(r, 300)); // past the grace period
    assert.equal(server.rooms.get(created.roomCode).members.size, 2);

    // Sharer drops for good: ownership falls to the remaining member.
    a.ws.close();
    const left = (await b2.next(is("room:member-left"), "member-left")).payload;
    assert.equal(left.member.name, "Alice");
    const after = (await b2.next(is("room:state", (p) => p.members.length === 1))).payload;
    assert.equal(after.sharedVideo.sharedByMemberId, joined.memberId);

    b2.send("room:leave");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.rooms.get(created.roomCode).members.size, 0);
    b2.ws.close();
  });

  console.log(`\n${passed} checks passed`);
} catch (err) {
  console.error("FAILED:", err);
  process.exitCode = 1;
} finally {
  await server.close();
}
