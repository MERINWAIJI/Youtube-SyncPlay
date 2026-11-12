(() => {
  "use strict";
  const { parseYouTubeVideoRef } = self.YTSync;
  const $ = (id) => document.getElementById(id);
  const t = (key, ...subs) => chrome.i18n.getMessage(key, subs) || key;

  let snapshot = null;
  let activeVideoId = null; // video shown in the active tab, if any
  let localError = null; // error from a popup-initiated action
  let seeded = false;

  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }

  function request(message) {
    return chrome.runtime.sendMessage(message).catch(() => null);
  }

  function errorText(code) {
    if (!code) return "";
    const known = chrome.i18n.getMessage("err_" + code);
    return known || t("err_generic", code);
  }

  function inviteString() {
    const s = snapshot && snapshot.session;
    return s ? `${s.roomCode}:${s.joinToken}` : "";
  }

  function flash(button, key) {
    const original = button.dataset.i18n;
    button.textContent = t(key);
    setTimeout(() => (button.textContent = t(original)), 1200);
  }

  function render() {
    if (!snapshot) return;
    const { conn, session, room, settings, busy } = snapshot;
    const inRoom = Boolean(session);

    // Before joining, an idle socket is normal, so only show status in a room
    // or while a request is in flight.
    const shownConn = inRoom || busy ? conn : "idle";
    $("status").dataset.conn = shownConn;
    $("status-text").textContent =
      shownConn === "connected"
        ? t("statusConnected")
        : shownConn === "connecting"
          ? t("statusConnecting")
          : shownConn === "idle"
            ? ""
            : t("statusDisconnected");
    $("status").hidden = shownConn === "idle";

    const err = localError || snapshot.lastError;
    $("error").hidden = !err;
    $("error").textContent = errorText(err);

    $("view-lobby").hidden = inRoom;
    $("view-room").hidden = !inRoom;

    if (!seeded) {
      seeded = true;
      $("name").value = settings.displayName || "";
      $("server").value = settings.serverUrl || "";
      $("auto-next").checked = Boolean(settings.autoShareNext);
    }

    $("create").disabled = busy;
    $("join").disabled = busy;

    if (!inRoom) return;

    $("room-code").textContent = session.roomCode;
    $("invite-text").textContent = inviteString();
    $("invite-text").title = inviteString();

    const shared = room && room.sharedVideo;
    $("shared").hidden = !shared;
    $("shared-empty").hidden = Boolean(shared);
    if (shared) {
      $("shared-title").textContent = shared.title;
      $("shared-by").textContent = shared.sharedByDisplayName
        ? t("sharedBy", shared.sharedByDisplayName)
        : "";
    }

    const alreadyShared = Boolean(shared && activeVideoId && shared.videoId === activeVideoId);
    $("share").disabled = !activeVideoId || alreadyShared || conn !== "connected";
    $("share-hint").textContent = !activeVideoId
      ? t("hintShareNeedsVideo")
      : alreadyShared
        ? t("hintShareAlready")
        : "";

    const members = (room && room.members) || [];
    $("members-label").textContent = t("labelMembers", String(members.length));
    const list = $("members");
    list.replaceChildren(
      ...members.map((m) => {
        const li = document.createElement("li");
        li.textContent = m.name + (m.id === session.memberId ? t("you") : "");
        return li;
      }),
    );
  }

  function setSnapshot(next) {
    if (!next || typeof next !== "object" || !("conn" in next)) return;
    snapshot = next;
    render();
  }

  async function act(message) {
    localError = null;
    const result = await request(message);
    if (result && result.ok === false && result.error) localError = result.error;
    render();
    return result;
  }

  // ---- events ----
  $("create").addEventListener("click", () => {
    act({ type: "popup:create", displayName: $("name").value });
  });

  $("join").addEventListener("click", () => {
    act({ type: "popup:join", invite: $("invite").value, displayName: $("name").value });
  });

  $("invite").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("join").click();
  });

  $("name").addEventListener("change", () => {
    request({ type: "popup:set-name", displayName: $("name").value });
  });

  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteString());
      flash($("copy"), "copied");
    } catch {}
  });

  $("share").addEventListener("click", () => act({ type: "popup:share" }));
  $("open-shared").addEventListener("click", () => act({ type: "popup:open-shared" }));
  $("leave").addEventListener("click", () => act({ type: "popup:leave" }));

  $("auto-next").addEventListener("change", () => {
    request({ type: "popup:set-auto-next", value: $("auto-next").checked });
  });

  $("save-server").addEventListener("click", async () => {
    const result = await act({ type: "popup:set-server", url: $("server").value });
    if (result && result.ok) {
      flash($("save-server"), "saved");
      const fresh = await request({ type: "popup:get" });
      if (fresh) {
        $("server").value = fresh.settings.serverUrl;
        setSnapshot(fresh);
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "bg:popup-state") {
      if (msg.snapshot && msg.snapshot.lastError) localError = null;
      setSnapshot(msg.snapshot);
    }
    return false;
  });

  // ---- init ----
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
    const ref = tab && tab.url ? parseYouTubeVideoRef(tab.url) : null;
    activeVideoId = ref ? ref.videoId : null;
    render();
  });
  request({ type: "popup:get" }).then(setSnapshot);
})();
