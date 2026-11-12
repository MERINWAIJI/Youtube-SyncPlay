// Logic test for extension/content.js against a fake page: a stub <video>,
// stub `chrome` APIs and a stub DOM. It checks the sync rules, not YouTube's
// real player. Run: node extension-test/content-sync.test.mjs (or bun).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ext = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const SHARED = "dQw4w9WgXcQ";
const OTHER = "aaaaaaaaaaa";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fake page ---------------------------------------------------------------
class FakeVideo extends EventTarget {
  constructor() {
    super();
    this._t = 0;
    this._rate = 1;
    this.paused = false; // YouTube autoplays on load
    this.readyState = 4;
    this.duration = 1000;
    this.seeking = false;
    this.ended = false;
    this.player = { classes: new Set(["html5-video-player"]) };
  }
  fire(type) {
    queueMicrotask(() => this.dispatchEvent(new Event(type)));
  }
  get currentTime() {
    return this._t;
  }
  set currentTime(v) {
    this._t = v;
    this.fire("seeked");
  }
  get playbackRate() {
    return this._rate;
  }
  set playbackRate(v) {
    this._rate = v;
    this.fire("ratechange");
  }
  play() {
    if (this.paused) {
      this.paused = false;
      this.fire("play");
    }
    return Promise.resolve();
  }
  pause() {
    if (!this.paused) {
      this.paused = true;
      this.fire("pause");
    }
  }
  closest() {
    const classes = this.player.classes;
    return { classList: { contains: (c) => classes.has(c) }, querySelector: () => null };
  }
}

const toasts = [];
function fakeElement() {
  const el = {
    children: [],
    classList: { add() {}, remove() {} },
    set textContent(v) {
      if (el.className === "toast") toasts.push(v);
    },
    get childElementCount() {
      return el.children.length;
    },
    get firstElementChild() {
      return el.children[0];
    },
    attachShadow: () => fakeElement(),
    append: (...kids) => el.children.push(...kids),
    appendChild: (kid) => el.children.push(kid),
    remove() {},
  };
  el.host = el;
  return el;
}

const video = new FakeVideo();
const docListeners = {};
const sent = [];
let onBgMessage = null;
let helloSnapshot = null;

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.location = { href: "", pathname: "/watch" };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.document = {
  title: "Test video - YouTube",
  fullscreenElement: null,
  documentElement: fakeElement(),
  createElement: () => fakeElement(),
  querySelector: (sel) => (sel.includes("ytd-watch-flexy") ? null : video),
  addEventListener: (type, fn) => (docListeners[type] = fn),
};
globalThis.chrome = {
  i18n: { getMessage: (key, subs = []) => [key, ...subs].join("|") },
  runtime: {
    sendMessage: async (msg) => {
      sent.push(msg);
      return msg.type === "content:hello" ? helloSnapshot : { ok: true };
    },
    onMessage: { addListener: (fn) => (onBgMessage = fn) },
  },
};

function setPage(videoId) {
  location.href = videoId ? `https://www.youtube.com/watch?v=${videoId}` : "https://www.youtube.com/";
  location.pathname = videoId ? "/watch" : "/";
}

let seq = 0;
function snapshot({ playback, sharedBy = "other" } = {}) {
  seq += 1;
  return {
    conn: "connected",
    memberId: "me",
    autoShareNext: true,
    room: {
      roomCode: "ABC234",
      members: [],
      sharedVideo: {
        videoId: SHARED,
        url: `https://www.youtube.com/watch?v=${SHARED}`,
        title: "Shared",
        sharedByMemberId: sharedBy,
        sharedByDisplayName: "Bob",
      },
      playback: {
        videoId: SHARED,
        playbackRate: 1,
        actorId: "other",
        actorName: "Bob",
        seq,
        ...playback,
      },
      anchorAt: Date.now() - (playback.ageMs || 0),
    },
  };
}
const push = (snap) => onBgMessage({ type: "bg:state", snapshot: snap }, null, () => {});
const playbackSent = () => sent.filter((m) => m.type === "content:playback");
const near = (actual, expected, tol = 0.3) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ~${expected}, got ${actual}`);

let passed = 0;
async function step(name, fn) {
  await fn();
  passed += 1;
  console.log("ok -", name);
}

// ---- boot: page loads on the shared video while the room is mid-playback ------
setPage(SHARED);
helloSnapshot = snapshot({ playback: { currentTime: 100, playState: "playing", ageMs: 2000 } });
(0, eval)(readFileSync(join(ext, "shared.js"), "utf8"));
(0, eval)(readFileSync(join(ext, "content.js"), "utf8"));

try {
  await step("joining mid-playback seeks to the extrapolated position", async () => {
    await sleep(350);
    near(video.currentTime, 102);
    assert.equal(video.paused, false);
    assert.equal(playbackSent().length, 0, "applying room state must not echo back");
  });

  await step("local pause is broadcast once", async () => {
    video._t = 110;
    video.pause();
    await sleep(350);
    const out = playbackSent();
    assert.equal(out.length, 1);
    assert.equal(out[0].playback.playState, "paused");
    near(out[0].playback.currentTime, 110);
    assert.equal(out[0].playback.videoId, SHARED);
  });

  await step("own echo from the server changes nothing", async () => {
    push(snapshot({ playback: { currentTime: 110, playState: "paused", actorId: "me" } }));
    await sleep(350);
    assert.equal(video.paused, true);
    near(video.currentTime, 110);
    assert.equal(playbackSent().length, 1);
  });

  await step("remote seek + play + rate is applied without echo", async () => {
    toasts.length = 0;
    push(snapshot({ playback: { currentTime: 300, playState: "playing", playbackRate: 1.5 } }));
    await sleep(350);
    near(video.currentTime, 300, 1);
    assert.equal(video.paused, false);
    assert.equal(video.playbackRate, 1.5);
    assert.equal(playbackSent().length, 1);
    assert.ok(toasts.some((x) => x.startsWith("toastPlay|Bob")), "toast names the actor");
  });

  await step("local seek while playing is broadcast", async () => {
    video.currentTime = 500;
    await sleep(350);
    const out = playbackSent();
    assert.equal(out.length, 2);
    near(out[1].playback.currentTime, 500);
    assert.equal(out[1].playback.playState, "playing");
    assert.equal(out[1].playback.playbackRate, 1.5);
  });

  await step("periodic check does not fight the pending local change", async () => {
    await sleep(1300); // at least one tick, echo not yet received
    assert.ok(video.currentTime >= 499, "must not be pulled back to the old room position");
    assert.equal(playbackSent().length, 2);
  });

  await step("drift beyond tolerance is corrected by the periodic check", async () => {
    push(snapshot({ playback: { currentTime: 600, playState: "playing", playbackRate: 1 } }));
    await sleep(300);
    video._t = 580; // fell far behind (e.g. buffering), no event fired
    await sleep(1300);
    assert.ok(video.currentTime > 600, `expected catch-up, got ${video.currentTime}`);
    assert.equal(playbackSent().length, 2, "catch-up seek is not a user action");
  });

  await step("ads: nothing is broadcast, then the tab catches up", async () => {
    video.player.classes.add("ad-showing");
    video._t = 3; // the element now plays the ad
    video.pause();
    video.play();
    video.currentTime = 7;
    await sleep(1300);
    assert.equal(playbackSent().length, 2);
    video.player.classes.delete("ad-showing");
    video._t = 580; // content resumes where the ad interrupted
    video.fire("play");
    await sleep(350);
    assert.ok(video.currentTime > 600, `expected catch-up after ad, got ${video.currentTime}`);
    assert.equal(playbackSent().length, 2);
  });

  await step("a non-shared page is local only", async () => {
    setPage(OTHER);
    docListeners["yt-navigate-start"]();
    docListeners["yt-navigate-finish"]();
    video._t = 5;
    video.pause();
    video.play();
    video.currentTime = 42;
    await sleep(1300);
    assert.equal(playbackSent().length, 2);
    assert.equal(video.currentTime, 42, "room state must not touch a local page");
    assert.ok(toasts.includes("toastLocalMode"));
  });

  await step("returning to the shared video re-adopts the room state", async () => {
    setPage(SHARED);
    docListeners["yt-navigate-start"]();
    docListeners["yt-navigate-finish"]();
    await sleep(350);
    assert.ok(video.currentTime > 600);
    assert.equal(playbackSent().length, 2);
  });

  await step("sharer's autoplay-next after a natural end shares the next video", async () => {
    push(snapshot({ sharedBy: "me", playback: { currentTime: 990, playState: "playing" } }));
    await sleep(300);
    video.fire("ended");
    await sleep(50);
    setPage(OTHER);
    document.title = "(2) Next video - YouTube";
    docListeners["yt-navigate-start"]();
    video._t = 0;
    docListeners["yt-navigate-finish"]();
    await sleep(1200);
    const shares = sent.filter((m) => m.type === "content:share");
    assert.equal(shares.length, 1);
    assert.equal(shares[0].video.videoId, OTHER);
    assert.equal(shares[0].video.title, "Next video");
  });

  await step("manual share request reports the page video", async () => {
    let reply = null;
    onBgMessage({ type: "bg:collect-share" }, null, (r) => (reply = r));
    assert.equal(reply.ok, true);
    assert.equal(reply.video.videoId, OTHER);
    setPage(null);
    onBgMessage({ type: "bg:collect-share" }, null, (r) => (reply = r));
    assert.deepEqual(reply, { ok: false, error: "not_video_page" });
  });

  console.log(`\n${passed} checks passed`);
  process.exit(0);
} catch (err) {
  console.error("FAILED:", err);
  process.exit(1);
}
