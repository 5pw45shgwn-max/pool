(() => {
  "use strict";

  const game = window.chrisClub;
  const $ = (selector) => document.querySelector(selector);
  const storage = {
    get(key, fallback = "") {
      try { return localStorage.getItem(`chris-club:${key}`) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`chris-club:${key}`, value); } catch { /* Private browsing can disable storage. */ }
    },
    remove(key) {
      try { localStorage.removeItem(`chris-club:${key}`); } catch { /* Private browsing can disable storage. */ }
    },
  };

  const tables = {
    tournament: { title: "Professional tournament", felt: "#1b8ce0", wood: "#805637", rail: "#17201e", brass: "#bca06b", cushion: "#154638", room: "#101819" },
    classic: { title: "Classic wood", felt: "#1b6344", wood: "#a9784f", rail: "#151c1c", brass: "#b7a274", cushion: "#1d6459", room: "#101819" },
    dark: { title: "Modern dark", felt: "#0d3f42", wood: "#303a3b", rail: "#111718", brass: "#70888a", cushion: "#153238", room: "#101719" },
    luxury: { title: "Luxury burgundy", felt: "#592f45", wood: "#503128", rail: "#1e1b1c", brass: "#d4b478", cushion: "#47263a", room: "#1b1719" },
    custom: { title: "Custom premium", felt: "#143e52", wood: "#49362a", rail: "#171d22", brass: "#9fc3bf", cushion: "#123648", room: "#111a20" },
  };
  const quality = {
    low: { cap: 1, shadows: false, shadowType: 1, environment: 0.25, anisotropy: 1 },
    medium: { cap: 1.35, shadows: true, shadowType: 1, environment: 0.38, anisotropy: 4 },
    high: { cap: 1.8, shadows: true, shadowType: 2, environment: 0.5, anisotropy: 8 },
    ultra: { cap: 2.25, shadows: true, shadowType: 3, environment: 0.65, anisotropy: 16 },
  };

  const state = {
    socket: null,
    ticket: null,
    room: null,
    previousStatus: null,
    profileName: storage.get("name", "Player"),
    connected: false,
  };

  function getServerUrl() {
    let url = String(window.CHRIS_CLUB_SERVER_URL || "").trim();
    while (url.endsWith("/")) url = url.slice(0, -1);
    return url;
  }

  function toast(message) {
    const node = $("#toast");
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, 3400);
  }

  function setConnection(connected) {
    state.connected = connected;
    const mode = $("#modeLabel");
    if (mode && !state.room) mode.textContent = connected ? "CHRIS CLUB · ONLINE" : getServerUrl() ? "CHRIS CLUB · SERVER OFFLINE" : "CHRIS CLUB · LOCAL PLAY";
    const label = $("#onlineConnection");
    if (label) {
      label.textContent = connected ? "CONNECTED" : getServerUrl() ? "RECONNECTING" : "SERVER REQUIRED";
      label.classList.toggle("connected", connected);
      label.classList.toggle("error", !connected);
    }
    const status = $("#mpConnection");
    if (status) {
      status.className = `online-status${connected ? " connected" : ""}`;
      status.innerHTML = `<i></i>${connected ? "Connected to Chris Club" : getServerUrl() ? "Connecting to the game server…" : "Add the hosted server URL to server-config.js to enable online play."}`;
    }
    for (const id of ["#mpCreate", "#mpFind", "#mpJoin"]) {
      const button = $(id);
      if (button) button.disabled = !connected;
    }
    const lobbyStatus = $("#mpStatus");
    if (lobbyStatus && !connected) lobbyStatus.textContent = getServerUrl() ? "The server connection is being restored." : "Set the backend URL in server-config.js to enable online multiplayer.";
  }

  function readTicket() {
    const code = storage.get("room");
    const token = storage.get("ticket");
    const seat = Number(storage.get("seat", "-1"));
    return code && token && (seat === 0 || seat === 1) ? { code, token, seat } : null;
  }

  function storeTicket(ticket) {
    state.ticket = ticket;
    if (!ticket) {
      storage.remove("room");
      storage.remove("ticket");
      storage.remove("seat");
      return;
    }
    storage.set("room", ticket.code);
    storage.set("ticket", ticket.token);
    storage.set("seat", String(ticket.seat));
  }

  function setProfile(name) {
    state.profileName = String(name || "Player").trim().slice(0, 24) || "Player";
    storage.set("name", state.profileName);
    state.socket?.emit("player:profile", { name: state.profileName });
    return state.profileName;
  }

  function displayError(message) {
    const node = $("#mpFeedback");
    if (node) {
      node.textContent = message;
      node.classList.add("online-status", "error");
    }
    toast(message);
  }

  function modeSelection() {
    return $("#mpMode")?.value || "8";
  }

  function tableSelection() {
    return $("#mpTable")?.value || storage.get("table", "tournament");
  }

  function send(eventName, payload, onSuccess) {
    if (!state.socket?.connected) return displayError("The game server is not connected yet.");
    state.socket.emit(eventName, payload, (result) => {
      if (!result?.ok) return displayError(result?.message || "The server could not complete that request.");
      if (result.ticket) storeTicket(result.ticket);
      if (result.room) acceptRoom(result.room, result.seat);
      onSuccess?.(result);
    });
  }

  function applyTableStyle(styleName) {
    const style = tables[styleName] || tables.tournament;
    const materials = game?.view?.tableMaterials;
    if (!materials) return;
    materials.felt.color.set(style.felt);
    materials.wood.color.set(style.wood);
    materials.rail.color.set(style.rail);
    materials.brass.color.set(style.brass);
    materials.cushion.color.set(style.cushion);
    if (game.view.scene?.background?.set) game.view.scene.background.set(style.room);
    game.view.scene?.traverse((object) => {
      if (object.isMesh && object.material) object.material.needsUpdate = true;
    });
    game.view.dirty = true;
    storage.set("table", styleName);
  }

  function applyGraphics(preset, resolutionScale) {
    const setting = quality[preset] || quality.high;
    const renderer = game?.view?.renderer;
    if (!renderer) return;
    const scale = Math.max(0.65, Math.min(1.35, Number(resolutionScale) || 1));
    const pixelRatio = Math.min((window.devicePixelRatio || 1) * scale, setting.cap);
    renderer.setPixelRatio(pixelRatio);
    renderer.shadowMap.enabled = setting.shadows;
    renderer.shadowMap.type = setting.shadowType;
    renderer.shadowMap.needsUpdate = true;
    if (game.view.scene) game.view.scene.environmentIntensity = setting.environment;
    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    game.view.scene?.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material.map && "anisotropy" in material.map) {
          material.map.anisotropy = Math.min(maxAnisotropy, setting.anisotropy);
          material.map.needsUpdate = true;
        }
      }
    });
    game.view.resize();
    storage.set("quality", preset);
    storage.set("resolution", String(scale));
  }

  function openSettings() {
    const camera = game.network.camera;
    const currentQuality = storage.get("quality", "high");
    const resolution = storage.get("resolution", "1");
    const selectedTable = state.room ? state.room.tableStyle : storage.get("table", "tournament");
    const tableOptions = Object.entries(tables).map(([key, value]) => `<option value="${key}"${key === selectedTable ? " selected" : ""}>${value.title}</option>`).join("");
    document.querySelector("#modalContent").innerHTML = `
      <div class="eyebrow">YOUR TABLE, YOUR WAY</div><h2>Game settings</h2>
      <div class="online-layout">
        <label class="setting">Sound volume <input id="settingVolume" type="range" min="0" max="100" value="${Math.round(game.network.volume * 100)}"></label>
        <label class="setting">Aiming sensitivity <input id="settingSensitivity" type="range" min="10" max="200" value="${Math.round(camera.sensitivity * 100)}"></label>
        <label class="setting">Camera height <input id="settingHeight" type="range" min="25" max="220" value="${Math.round(camera.height * 100)}"></label>
        <label class="setting">Camera look-ahead / pitch <input id="settingLook" type="range" min="0" max="150" value="${Math.round(camera.look * 100)}"></label>
        <label class="online-field">Graphics quality<select id="settingQuality"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="ultra">Ultra</option></select></label>
        <label class="online-field">Resolution scaling <input id="settingResolution" type="range" min="65" max="135" step="5" value="${Math.round(Number(resolution) * 100)}"><span id="resolutionReadout">${Math.round(Number(resolution) * 100)}%</span></label>
        <label class="online-field">Table style<select id="settingTable"${state.room ? " disabled" : ""}>${tableOptions}</select></label>
        <p class="online-note">Table style follows the room host during an online match. Guide paths show geometry and do not predict spin or pocket rattles.</p>
      </div>`;
    $("#modal").hidden = false;
    $("#settingQuality").value = currentQuality;
    $("#settingVolume").oninput = (event) => game.network.setVolume(Number(event.target.value) / 100);
    $("#settingSensitivity").oninput = (event) => game.network.setCamera({ sensitivity: Number(event.target.value) / 100 });
    $("#settingHeight").oninput = (event) => game.network.setCamera({ height: Number(event.target.value) / 100 });
    $("#settingLook").oninput = (event) => game.network.setCamera({ look: Number(event.target.value) / 100 });
    $("#settingQuality").onchange = (event) => applyGraphics(event.target.value, Number($("#settingResolution").value) / 100);
    $("#settingResolution").oninput = (event) => {
      $("#resolutionReadout").textContent = `${event.target.value}%`;
      applyGraphics($("#settingQuality").value, Number(event.target.value) / 100);
    };
    $("#settingTable").onchange = (event) => applyTableStyle(event.target.value);
  }

  function getLobbyMarkup() {
    const modes = ["8", "9", "10"].map((mode) => `<option value="${mode}">${mode}-ball</option>`).join("");
    const tableOptions = Object.entries(tables).map(([key, value]) => `<option value="${key}">${value.title}</option>`).join("");
    return `
      <div class="eyebrow">ONLINE PLAY</div><h2>Meet at the table.</h2>
      <div class="online-layout">
        <p id="mpConnection" class="online-status"><i></i>Connecting to the game server…</p>
        <div id="mpControls">
          <label class="online-field">Player name<input id="mpName" maxlength="24" value="${escapeHtml(state.profileName)}" autocomplete="nickname"></label>
          <div class="online-grid" style="margin-top:10px">
            <label class="online-field">Game mode<select id="mpMode">${modes}</select></label>
            <label class="online-field">Table style<select id="mpTable">${tableOptions}</select></label>
          </div>
          <div class="online-actions" style="margin-top:12px">
            <button id="mpCreate" class="primary">Create private room</button>
            <button id="mpFind">Find public match</button>
          </div>
          <div class="online-join" style="margin-top:9px">
            <input id="mpCode" class="online-code-input" maxlength="6" placeholder="ROOM CODE" aria-label="Room code" autocomplete="off">
            <button id="mpJoin">Join room</button>
          </div>
        </div>
        <section id="mpLobby" class="online-lobby" hidden>
          <div class="online-room-code"><div><small class="eyebrow">ROOM CODE</small><strong id="mpRoomCode">—</strong></div><button id="mpCopy">Copy code</button></div>
          <p id="mpStatus" class="online-note"></p>
          <ul id="mpPlayers" class="online-players"></ul>
          <div class="online-lobby-actions">
            <button id="mpReady" class="primary">Ready up</button>
            <button id="mpLeave">Leave room</button>
            <button id="mpRematch" hidden>Request rematch</button>
          </div>
        </section>
        <p id="mpFeedback" class="online-note" aria-live="polite"></p>
      </div>`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }

  function updateLobby() {
    if (!$("#mpLobby")) return;
    const room = state.room;
    const hasTicket = Boolean(state.ticket);
    $("#mpControls").hidden = hasTicket;
    $("#mpLobby").hidden = !hasTicket;
    if (!room || !hasTicket) return;
    $("#mpRoomCode").textContent = room.code;
    const statusText = room.status === "countdown" ? `Match starting in ${room.countdown}…`
      : room.status === "playing" ? "Match in progress · server verified"
        : room.status === "finished" ? (room.rules?.message || "Rack complete")
          : room.players.filter(Boolean).length < 2 ? "Waiting for an opponent to join."
            : "Both players ready up to start.";
    $("#mpStatus").textContent = statusText;
    $("#mpPlayers").innerHTML = room.players.map((player, seat) => {
      const label = !player ? "Open seat" : !player.connected ? "Reconnecting" : player.ready ? "Ready" : "Not ready";
      const name = player ? escapeHtml(player.name) : "Waiting for opponent";
      return `<li><span>${seat === state.ticket.seat ? "You · " : ""}${name}</span><small>${label}</small></li>`;
    }).join("");
    const ownPlayer = room.players[state.ticket.seat];
    const readyButton = $("#mpReady");
    readyButton.textContent = ownPlayer?.ready ? "Cancel ready" : "Ready up";
    readyButton.disabled = room.status === "playing" || room.status === "finished";
    $("#mpRematch").hidden = room.status !== "finished";
  }

  function acceptRoom(room, seat) {
    state.room = room;
    if (Number.isInteger(seat)) {
      state.ticket = { ...(state.ticket || {}), code: room.code, seat };
      storage.set("room", room.code);
      storage.set("seat", String(seat));
    }
    if (state.ticket?.seat !== undefined) game.network.setEnabled(true, state.ticket.seat);
    game.network.applyState(room);
    updateLobby();
  }

  function clearRoom() {
    storeTicket(null);
    state.room = null;
    state.previousStatus = null;
    game.network.setEnabled(false);
    const currentMode = $("[data-mode].selected")?.dataset.mode || "8";
    game.reset(currentMode);
    $("#menu").hidden = false;
    $("#hud").hidden = true;
    $("#modal").hidden = true;
  }

  function openOnlineMenu() {
    document.querySelector("#modalContent").innerHTML = getLobbyMarkup();
    $("#modal").hidden = false;
    $("#mpName").onchange = (event) => setProfile(event.target.value);
    $("#mpMode").value = state.room?.mode || $("[data-mode].selected")?.dataset.mode || "8";
    $("#mpTable").value = state.room?.tableStyle || storage.get("table", "tournament");
    setConnection(state.connected);
    updateLobby();

    $("#mpCreate").onclick = () => {
      const name = setProfile($("#mpName").value);
      storage.set("table", tableSelection());
      applyTableStyle(tableSelection());
      send("room:create", { name, mode: modeSelection(), tableStyle: tableSelection() });
    };
    $("#mpFind").onclick = () => {
      const name = setProfile($("#mpName").value);
      send("match:find", { name, mode: modeSelection(), tableStyle: tableSelection() });
    };
    $("#mpJoin").onclick = () => {
      const name = setProfile($("#mpName").value);
      send("room:join", { name, code: $("#mpCode").value.trim().toUpperCase() });
    };
    $("#mpCode").oninput = (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); };
    $("#mpReady").onclick = () => {
      const player = state.room?.players[state.ticket?.seat];
      send("room:ready", { ready: !player?.ready });
    };
    $("#mpCopy").onclick = async () => {
      try {
        await navigator.clipboard.writeText(state.room.code);
        $("#mpCopy").textContent = "Copied";
      } catch {
        const range = document.createRange();
        range.selectNodeContents($("#mpRoomCode"));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        $("#mpCopy").textContent = "Select and copy";
      }
    };
    $("#mpLeave").onclick = () => {
      if (state.socket?.connected) send("room:leave", {}, clearRoom);
      else clearRoom();
    };
    $("#mpRematch").onclick = () => send("match:rematch", {}, () => { $("#mpRematch").textContent = "Rematch requested"; });
  }

  function showResult(room) {
    const winner = room.rules?.winner;
    const winnerName = room.players[winner]?.name || `Player ${Number(winner) + 1}`;
    const history = room.rules?.history || [];
    document.querySelector("#modalContent").innerHTML = `
      <div class="online-result"><div class="eyebrow">MATCH COMPLETE · ${room.mode}-BALL</div>
      <h2>${escapeHtml(winnerName)}<br>takes the table.</h2>
      <p class="online-note">${escapeHtml(room.rules?.message || "Rack complete")} · ${history.length} shots recorded by the server.</p>
      <div class="online-actions"><button id="resultRematch" class="primary">Request rematch</button><button id="resultLeave">Return to lobby</button></div></div>`;
    $("#modal").hidden = false;
    $("#resultRematch").onclick = () => send("match:rematch", {}, () => { $("#resultRematch").textContent = "Rematch requested"; });
    $("#resultLeave").onclick = () => openOnlineMenu();
  }

  function handleRoomState(room) {
    const oldStatus = state.previousStatus;
    state.room = room;
    state.previousStatus = room.status;
    if (state.ticket) game.network.setEnabled(true, state.ticket.seat);
    game.network.applyState(room);
    if (room.tableStyle) applyTableStyle(room.tableStyle);
    for (const event of room.events || []) {
      if (["cue", "ball", "rail", "pocket"].includes(event.type)) game.network.playEvent(event.type, event.speed || 1);
    }
    updateLobby();
    if (room.status === "playing" && oldStatus !== "playing") $("#modal").hidden = true;
    if (room.status === "finished" && oldStatus !== "finished") showResult(room);
  }

  function initSocket() {
    if (!game) return;
    const serverUrl = getServerUrl();
    if (typeof window.io !== "function") {
      if (!serverUrl) { setConnection(false); return; }
      const script = document.createElement("script");
      script.src = serverUrl + "/socket.io/socket.io.js";
      script.async = true;
      script.onload = () => {
        if (typeof window.io === "function") initSocket();
        else {
          setConnection(false);
          displayError("The multiplayer server did not provide its Socket.IO client.");
        }
      };
      script.onerror = () => {
        setConnection(false);
        displayError("Could not load the multiplayer server at " + serverUrl);
      };
      document.head.append(script);
      return;
    }
    const socketOptions = { reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 4000, timeout: 6000 };
    state.socket = serverUrl ? window.io(serverUrl, socketOptions) : window.io(socketOptions);
    state.ticket = readTicket();
    game.network.setShotHandler((shot) => {
      if (!state.socket?.connected || !state.room || !state.ticket) return displayError("Join an online room before shooting.");
      send("shot:request", {
        ...shot,
        sequence: state.room.sequence,
        call: {
          ball: Number($("#callBall")?.value || 0),
          pocket: Number($("#callPocket")?.value || 0),
        },
      });
    });
    game.network.setPlacementHandler((x, z) => {
      if (!state.socket?.connected || !state.room) return displayError("The game server is not connected.");
      send("cue:place", { x, z, sequence: state.room.sequence });
    });

    state.socket.on("connect", () => {
      setConnection(true);
      state.socket.emit("player:profile", { name: state.profileName });
      if (state.ticket) {
        state.socket.emit("room:reconnect", state.ticket, (result) => {
          if (!result?.ok) {
            storeTicket(null);
            state.room = null;
            displayError(result?.message || "Your room session expired.");
          }
        });
      }
    });
    state.socket.on("disconnect", () => setConnection(false));
    state.socket.on("connect_error", () => setConnection(false));
    state.socket.on("room:ticket", (ticket) => {
      storeTicket(ticket);
      if (!state.room || state.room.code !== ticket.code) state.room = { code: ticket.code, mode: "8", players: [null, null], status: "lobby" };
      game.network.setEnabled(true, ticket.seat);
      updateLobby();
    });
    state.socket.on("room:state", handleRoomState);
    state.socket.on("room:closed", (message = {}) => {
      state.room = null;
      storeTicket(null);
      game.network.setEnabled(false);
      if (message.reason) displayError(message.reason);
      if (!$("#menu").hidden) openOnlineMenu();
    });
    state.socket.on("room:error", (result) => displayError(result.message || "The server rejected that action."));
  }

  function openSettingsOverride() {
    openSettings();
  }

  function bindHeaderConnection() {
    const top = $(".topcenter");
    if (!top || $("#onlineConnection")) return;
    const indicator = document.createElement("span");
    indicator.id = "onlineConnection";
    indicator.className = "online-connection";
    indicator.textContent = "CONNECTING";
    top.append(indicator);
  }

  if (game) {
    bindHeaderConnection();
    $("#multiplayerBtn").onclick = openOnlineMenu;
    $("#settingsBtn").onclick = openSettingsOverride;
    const previousMenuHandler = $("#menuBtn").onclick;
    $("#menuBtn").onclick = () => {
      if (state.ticket) openOnlineMenu();
      else previousMenuHandler?.();
    };
    const savedQuality = storage.get("quality", "high");
    const savedResolution = Number(storage.get("resolution", "1"));
    applyGraphics(savedQuality, savedResolution);
    applyTableStyle(storage.get("table", "tournament"));
  }

  initSocket();
})();
