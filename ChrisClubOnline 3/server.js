import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import express from "express";
import { Server as SocketServer } from "socket.io";
import {
  BilliardsPhysics,
  BilliardsRules,
  FIXED_TIMESTEP,
  createBall,
  rackBalls,
} from "./shared/physics.mjs";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const CUES = Object.freeze({
  starter: { power: 0.78, spin: 0.72, control: 0.78 },
  heritage: { power: 0.94, spin: 0.96, control: 0.94 },
  eclipse: { power: 1.12, spin: 1.16, control: 1.12 },
  midnight: { power: 1.04, spin: 1.06, control: 1.16 },
  royal: { power: 1.08, spin: 1.01, control: 1.13 },
  tournament: { power: 1.02, spin: 1.04, control: 1.18 },
  phantom: { power: 1.15, spin: 1.12, control: 1.05 },
});
const TABLE_STYLES = new Set(["tournament", "classic", "dark", "luxury", "custom"]);
const GAME_MODES = new Set(["8", "9", "10"]);
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function cleanName(value) {
  if (typeof value !== "string") return "Player";
  const name = value.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 24);
  return name || "Player";
}

function roomCode() {
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += ROOM_ALPHABET[randomBytes(1)[0] % ROOM_ALPHABET.length];
  }
  return code;
}

function safeNumber(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function parseOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    return new URL(value.trim()).origin;
  } catch {
    return "";
  }
}

function createRoom(code, mode, isPrivate, tableStyle) {
  return {
    code,
    mode,
    isPrivate,
    tableStyle,
    players: [null, null],
    ownerSeat: 0,
    status: "lobby",
    countdown: 0,
    physics: null,
    rules: null,
    sequence: 0,
    tick: 0,
    events: [],
    shot: null,
    countdownTimer: null,
  };
}

function rulesSnapshot(rules) {
  if (!rules) return null;
  return {
    mode: rules.mode,
    player: rules.player,
    groups: [...rules.groups],
    breakShot: rules.breakShot,
    ballInHand: rules.ballInHand,
    winner: rules.winner,
    message: rules.message,
    history: rules.history.slice(-120).map((shot) => ({ ...shot, pots: [...shot.pots] })),
  };
}

function copyBalls(physics) {
  return physics ? physics.balls.map((ball) => ({ ...ball })) : [];
}

export function createGameServer({ publicDir = resolve(projectRoot, "public"), disconnectGraceMs = Number(process.env.DISCONNECT_GRACE_MS) || 45_000 } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_request, response) => {
    let playerCount = 0;
    for (const room of rooms.values()) playerCount += room.players.filter(Boolean).length;
    response.json({ ok: true, rooms: rooms.size, players: playerCount, uptime: Math.floor(process.uptime()) });
  });
  app.use(express.static(publicDir, { extensions: ["html"], maxAge: "1h" }));
  app.get("/", (_request, response) => response.sendFile(resolve(publicDir, "index.html")));

  const httpServer = createServer(app);
  const port = Number(process.env.PORT) || 3000;
  const allowedOrigins = [...new Set([
    "http://localhost:" + port,
    "http://127.0.0.1:" + port,
    parseOrigin(process.env.RENDER_EXTERNAL_URL),
    ...String(process.env.ALLOWED_ORIGINS || "").split(",").map(parseOrigin),
  ].filter(Boolean))];
  const io = new SocketServer(httpServer, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
    allowRequest: (request, callback) => {
      const originHeader = request.headers.origin;
      const allowed = originHeader === undefined || allowedOrigins.includes(parseOrigin(originHeader));
      callback(null, allowed);
    },
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectionStateRecovery: { maxDisconnectionDuration: disconnectGraceMs, skipMiddlewares: true },
  });
  const rooms = new Map();
  let tickTimer = null;

  function snapshot(room) {
    return {
      code: room.code,
      mode: room.mode,
      isPrivate: room.isPrivate,
      tableStyle: room.tableStyle,
      status: room.status,
      countdown: room.countdown,
      sequence: room.sequence,
      players: room.players.map((player, seat) => player ? ({
        seat,
        name: player.name,
        connected: player.connected,
        ready: player.ready,
        rematch: player.rematch,
      }) : null),
      balls: copyBalls(room.physics),
      rules: rulesSnapshot(room.rules),
      shot: room.shot ? { ...room.shot } : null,
    };
  }

  function publish(room, eventList = []) {
    io.to(room.code).emit("room:state", { ...snapshot(room), events: eventList });
  }

  function errorReply(socket, acknowledgement, code, message) {
    const result = { ok: false, code, message };
    if (typeof acknowledgement === "function") acknowledgement(result);
    socket.emit("room:error", result);
    return result;
  }

  function findRoomPlayer(socket) {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return null;
    const player = room.players[socket.data.seat];
    if (!player || player.socketId !== socket.id || !player.connected) return null;
    return { room, player };
  }

  function emitTicket(socket, room, player) {
    const ticket = { code: room.code, token: player.token, seat: player.seat };
    socket.emit("room:ticket", ticket);
    return ticket;
  }

  function attach(socket, room, player, acknowledgement) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    player.socketId = socket.id;
    player.connected = true;
    socket.data.roomCode = room.code;
    socket.data.seat = player.seat;
    socket.join(room.code);
    const ticket = emitTicket(socket, room, player);
    publish(room);
    const response = { ok: true, room: snapshot(room), seat: player.seat, ticket };
    if (typeof acknowledgement === "function") acknowledgement(response);
    return response;
  }

  function makePlayer(socket, room, seat, name) {
    return {
      id: randomUUID(),
      token: randomBytes(24).toString("base64url"),
      seat,
      name: cleanName(name || socket.data.name),
      ready: false,
      rematch: false,
      connected: true,
      socketId: socket.id,
      disconnectTimer: null,
    };
  }

  function getAvailableSeat(room) {
    return room.players.findIndex((player) => player === null);
  }

  function cancelCountdown(room) {
    if (room.countdownTimer) clearInterval(room.countdownTimer);
    room.countdownTimer = null;
    room.countdown = 0;
    if (room.status === "countdown") room.status = "lobby";
  }

  function beginRack(room) {
    cancelCountdown(room);
    room.physics = new BilliardsPhysics();
    room.physics.balls = rackBalls(room.mode);
    room.physics.time = 0;
    room.rules = new BilliardsRules(room.mode);
    room.shot = null;
    room.events = [];
    room.tick = 0;
    room.status = "playing";
    room.sequence += 1;
    room.physics.onEvent = (event) => {
      room.rules.event(event);
      room.events.push({ ...event });
    };
    publish(room);
  }

  function startCountdown(room) {
    cancelCountdown(room);
    room.status = "countdown";
    room.countdown = 3;
    publish(room);
    room.countdownTimer = setInterval(() => {
      if (room.players.some((player) => !player || !player.connected || !player.ready)) {
        cancelCountdown(room);
        publish(room);
        return;
      }
      room.countdown -= 1;
      if (room.countdown <= 0) {
        beginRack(room);
      } else {
        publish(room);
      }
    }, 1000);
  }

  function allPlayers(room) {
    return room.players.every((player) => player && player.connected);
  }

  function readyChanged(room) {
    if (allPlayers(room) && room.players.every((player) => player.ready)) {
      if (room.status !== "countdown") startCountdown(room);
      else publish(room);
      return;
    }
    if (room.status === "countdown") cancelCountdown(room);
    publish(room);
  }

  function setWinner(room, winnerSeat, reason) {
    if (!room.rules || room.rules.winner !== null) return;
    room.rules.winner = winnerSeat;
    room.rules.message = reason;
    room.status = "finished";
    room.shot = null;
    room.physics?.balls.forEach((ball) => {
      ball.vx = ball.vy = ball.vz = ball.wx = ball.wy = ball.wz = 0;
      ball.falling = false;
    });
    publish(room);
  }

  function disconnectPlayer(room, player) {
    if (!player || player.connected) return;
    if (room.status === "playing" && room.rules) {
      const otherSeat = player.seat === 0 ? 1 : 0;
      if (room.players[otherSeat]?.connected) {
        setWinner(room, otherSeat, `${player.name} disconnected · Player ${otherSeat + 1} wins`);
        return;
      }
    }
    room.players[player.seat] = null;
    if (room.status === "countdown") cancelCountdown(room);
    if (!room.players.some(Boolean)) {
      if (room.countdownTimer) clearInterval(room.countdownTimer);
      rooms.delete(room.code);
    } else {
      publish(room);
    }
  }

  function settleShot(room) {
    if (!room.rules || !room.physics || !room.shot) return;
    room.shot = null;
    room.sequence += 1;
    room.status = room.rules.winner === null ? "playing" : "finished";
    const result = room.rules.end(room.physics.balls);
    for (const id of result.respot) {
      const ball = room.physics.balls.find((item) => item.id === id);
      if (!ball) continue;
      for (let offset = 0; offset < 200; offset += 1) {
        const x = 1.27 * 0.5 - offset * 0.012;
        if (room.physics.validPosition(x, 0, id)) {
          Object.assign(ball, createBall(id, x, 0));
          break;
        }
      }
    }
    publish(room, room.events.splice(0));
  }

  function simulateTick() {
    for (const room of rooms.values()) {
      if (room.status !== "playing" || !room.shot || !room.physics) continue;
      for (let step = 0; step < 8; step += 1) room.physics.step(FIXED_TIMESTEP);
      room.tick += 1;
      if (room.tick % 3 === 0) publish(room, room.events.splice(0));
      if (!room.physics.moving) settleShot(room);
      else if (Date.now() - room.shot.startedAt > 25_000) {
        for (const ball of room.physics.balls) {
          ball.vx = ball.vy = ball.vz = ball.wx = ball.wy = ball.wz = 0;
          ball.falling = false;
          ball.y = 0.028575;
        }
        settleShot(room);
      }
    }
  }

  function joinRoom(socket, room, name, acknowledgement) {
    const seat = getAvailableSeat(room);
    if (seat < 0) return errorReply(socket, acknowledgement, "ROOM_FULL", "That room already has two players.");
    if (room.status !== "lobby") return errorReply(socket, acknowledgement, "MATCH_IN_PROGRESS", "That room is already in a match.");
    const player = makePlayer(socket, room, seat, name);
    room.players[seat] = player;
    attach(socket, room, player, acknowledgement);
    return player;
  }

  io.on("connection", (socket) => {
    socket.data.name = "Player";
    socket.on("player:profile", (payload = {}, acknowledgement) => {
      socket.data.name = cleanName(payload.name);
      const found = findRoomPlayer(socket);
      if (found) {
        found.player.name = socket.data.name;
        publish(found.room);
      }
      if (typeof acknowledgement === "function") acknowledgement({ ok: true, name: socket.data.name });
    });

    socket.on("room:create", (payload = {}, acknowledgement) => {
      if (findRoomPlayer(socket)) return errorReply(socket, acknowledgement, "ALREADY_IN_ROOM", "Leave your current room before creating another.");
      const mode = String(payload.mode || "8");
      if (!GAME_MODES.has(mode)) return errorReply(socket, acknowledgement, "INVALID_MODE", "Choose 8-ball, 9-ball, or 10-ball.");
      const tableStyle = TABLE_STYLES.has(payload.tableStyle) ? payload.tableStyle : "tournament";
      let code;
      do code = roomCode(); while (rooms.has(code));
      const room = createRoom(code, mode, true, tableStyle);
      rooms.set(code, room);
      const player = makePlayer(socket, room, 0, payload.name);
      room.players[0] = player;
      attach(socket, room, player, acknowledgement);
    });

    socket.on("room:join", (payload = {}, acknowledgement) => {
      if (findRoomPlayer(socket)) return errorReply(socket, acknowledgement, "ALREADY_IN_ROOM", "Leave your current room before joining another.");
      const code = String(payload.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      const room = rooms.get(code);
      if (!room) return errorReply(socket, acknowledgement, "ROOM_NOT_FOUND", "No open room uses that code.");
      joinRoom(socket, room, payload.name, acknowledgement);
    });

    socket.on("match:find", (payload = {}, acknowledgement) => {
      if (findRoomPlayer(socket)) return errorReply(socket, acknowledgement, "ALREADY_IN_ROOM", "Leave your current room before looking for a match.");
      const mode = GAME_MODES.has(String(payload.mode)) ? String(payload.mode) : "8";
      let room = [...rooms.values()].find((candidate) => !candidate.isPrivate && candidate.mode === mode && candidate.status === "lobby" && getAvailableSeat(candidate) >= 0);
      if (!room) {
        let code;
        do code = roomCode(); while (rooms.has(code));
        room = createRoom(code, mode, false, TABLE_STYLES.has(payload.tableStyle) ? payload.tableStyle : "tournament");
        rooms.set(code, room);
        const player = makePlayer(socket, room, 0, payload.name);
        room.players[0] = player;
        attach(socket, room, player, acknowledgement);
        return;
      }
      joinRoom(socket, room, payload.name, acknowledgement);
    });

    socket.on("room:reconnect", (payload = {}, acknowledgement) => {
      const code = String(payload.code || "").toUpperCase().slice(0, 6);
      const room = rooms.get(code);
      const player = room?.players.find((candidate) => candidate && candidate.token === payload.token);
      if (!room || !player) {
        if (typeof acknowledgement === "function") acknowledgement({ ok: false, code: "RECONNECT_EXPIRED", message: "That room session has expired." });
        socket.emit("room:closed", { reason: "Reconnect session expired." });
        return;
      }
      if (player.socketId && player.socketId !== socket.id) io.sockets.sockets.get(player.socketId)?.disconnect(true);
      attach(socket, room, player, acknowledgement);
    });

    socket.on("room:ready", (payload = {}, acknowledgement) => {
      const found = findRoomPlayer(socket);
      if (!found) return errorReply(socket, acknowledgement, "NOT_IN_ROOM", "Join a room first.");
      const { room, player } = found;
      if (room.status !== "lobby" && room.status !== "countdown") return errorReply(socket, acknowledgement, "MATCH_ALREADY_STARTED", "The rack has already started.");
      player.ready = payload.ready === true;
      readyChanged(room);
      if (typeof acknowledgement === "function") acknowledgement({ ok: true, room: snapshot(room) });
    });

    socket.on("shot:request", (payload = {}, acknowledgement) => {
      const found = findRoomPlayer(socket);
      if (!found) return errorReply(socket, acknowledgement, "NOT_IN_ROOM", "Join a room first.");
      const { room, player } = found;
      const now = Date.now();
      if (now - (socket.data.lastActionAt || 0) < 250) return errorReply(socket, acknowledgement, "RATE_LIMITED", "Wait a moment before sending another action.");
      socket.data.lastActionAt = now;
      if (room.status !== "playing" || !room.rules || !room.physics) return errorReply(socket, acknowledgement, "NOT_PLAYING", "The match is not accepting shots.");
      if (room.shot || room.physics.moving) return errorReply(socket, acknowledgement, "SHOT_IN_PROGRESS", "Wait for all balls to stop.");
      if (room.rules.winner !== null) return errorReply(socket, acknowledgement, "MATCH_FINISHED", "The rack is complete.");
      if (player.seat !== room.rules.player) return errorReply(socket, acknowledgement, "TURN_MISMATCH", "It is the other player's turn.");
      if (room.rules.ballInHand) return errorReply(socket, acknowledgement, "BALL_IN_HAND", "Place the cue ball before shooting.");
      if (payload.sequence !== room.sequence) return errorReply(socket, acknowledgement, "STALE_SEQUENCE", "The table changed. Use the latest game state.");
      if (!safeNumber(payload.angle, -10_000, 10_000) || !safeNumber(payload.power, 0.02, 1) || !safeNumber(payload.spinGain, 0, 2) || !safeNumber(payload.elevation, 0, 45)) {
        return errorReply(socket, acknowledgement, "INVALID_SHOT", "The shot values are outside the allowed range.");
      }
      const spin = payload.spin || {};
      if (!safeNumber(spin.x, -0.82, 0.82) || !safeNumber(spin.y, -0.82, 0.82)) return errorReply(socket, acknowledgement, "INVALID_SPIN", "Spin must stay inside the cue ball.");
      const cueId = payload.cueId == null ? "starter" : payload.cueId;
      if (typeof cueId !== "string" || !Object.hasOwn(CUES, cueId)) {
        return errorReply(socket, acknowledgement, "INVALID_CUE", "Choose one of the available cues before shooting.");
      }
      const cue = CUES[cueId];
      const call = payload.call || {};
      const calledBall = Number(call.ball);
      const calledPocket = Number(call.pocket);
      if ((room.mode === "8" && !Number.isInteger(calledPocket)) || (room.mode === "10" && (!Number.isInteger(calledBall) || !Number.isInteger(calledPocket)))) {
        return errorReply(socket, acknowledgement, "INVALID_CALL", "Choose a valid ball and pocket before shooting.");
      }
      if ((Number.isInteger(calledBall) && (calledBall < 1 || calledBall > 15)) || (Number.isInteger(calledPocket) && (calledPocket < 0 || calledPocket > 5))) {
        return errorReply(socket, acknowledgement, "INVALID_CALL", "The called ball or pocket is invalid.");
      }
      if (room.mode === "10" && !room.physics.balls.some((ball) => ball.id === calledBall && !ball.pocketed && !ball.falling)) {
        return errorReply(socket, acknowledgement, "INVALID_CALL", "Choose an object ball that is still on the table.");
      }
      room.rules.begin(room.physics.balls, {
        ball: Number.isInteger(calledBall) ? calledBall : 0,
        pocket: Number.isInteger(calledPocket) ? calledPocket : 0,
      });
      const power = Math.min(1, Math.pow(payload.power, 1 + (1 - cue.control) * 0.22) * cue.power);
      const angle = Math.atan2(Math.sin(payload.angle), Math.cos(payload.angle));
      const struck = room.physics.strike(
        angle,
        power,
        { x: spin.x * payload.spinGain * cue.spin, y: spin.y * payload.spinGain * cue.spin },
        payload.elevation,
      );
      if (!struck) {
        room.rules.shot = null;
        return errorReply(socket, acknowledgement, "SHOT_REJECTED", "The cue ball cannot be struck in its current position.");
      }
      room.sequence += 1;
      room.tick = 0;
      room.shot = { seat: player.seat, angle, startedAt: now, cueId };
      const response = { ok: true, sequence: room.sequence };
      if (typeof acknowledgement === "function") acknowledgement(response);
      io.to(room.code).emit("shot:start", { sequence: room.sequence, seat: player.seat, angle, cueId: room.shot.cueId });
      publish(room, room.events.splice(0));
    });

    socket.on("cue:place", (payload = {}, acknowledgement) => {
      const found = findRoomPlayer(socket);
      if (!found) return errorReply(socket, acknowledgement, "NOT_IN_ROOM", "Join a room first.");
      const { room, player } = found;
      if (room.status !== "playing" || !room.physics || !room.rules?.ballInHand) return errorReply(socket, acknowledgement, "NO_BALL_IN_HAND", "Cue ball placement is not available now.");
      if (player.seat !== room.rules.player) return errorReply(socket, acknowledgement, "TURN_MISMATCH", "It is the other player's turn.");
      if (payload.sequence !== room.sequence) return errorReply(socket, acknowledgement, "STALE_SEQUENCE", "The table changed. Use the latest game state.");
      if (!safeNumber(payload.x, -1.241, 1.241) || !safeNumber(payload.z, -0.606, 0.606)) return errorReply(socket, acknowledgement, "INVALID_POSITION", "Choose a position on the playing cloth.");
      if (!room.physics.place(0, payload.x, payload.z)) return errorReply(socket, acknowledgement, "INVALID_POSITION", "Choose a clear position away from rails, pockets, and balls.");
      room.rules.ballInHand = false;
      room.rules.message = `${room.players[player.seat].name} placed the cue ball`;
      room.sequence += 1;
      publish(room);
      if (typeof acknowledgement === "function") acknowledgement({ ok: true, sequence: room.sequence });
    });

    socket.on("match:rematch", (_payload = {}, acknowledgement) => {
      const found = findRoomPlayer(socket);
      if (!found) return errorReply(socket, acknowledgement, "NOT_IN_ROOM", "Join a room first.");
      const { room, player } = found;
      if (room.status !== "finished") return errorReply(socket, acknowledgement, "MATCH_NOT_FINISHED", "The current rack is still in play.");
      player.rematch = true;
      publish(room);
      if (allPlayers(room) && room.players.every((entry) => entry.rematch)) {
        for (const entry of room.players) {
          entry.rematch = false;
          entry.ready = true;
        }
        startCountdown(room);
      }
      if (typeof acknowledgement === "function") acknowledgement({ ok: true });
    });

    socket.on("room:leave", (_payload = {}, acknowledgement) => {
      const found = findRoomPlayer(socket);
      if (!found) {
        if (typeof acknowledgement === "function") acknowledgement({ ok: true });
        return;
      }
      const { room, player } = found;
      const otherSeat = player.seat === 0 ? 1 : 0;
      if (room.status === "playing" && room.rules && room.players[otherSeat]) {
        setWinner(room, otherSeat, `${player.name} left the match · Player ${otherSeat + 1} wins`);
      }
      clearTimeout(player.disconnectTimer);
      room.players[player.seat] = null;
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.seat = null;
      room.status = "lobby";
      room.rules = null;
      room.physics = null;
      room.shot = null;
      room.players.forEach((entry) => { if (entry) { entry.ready = false; entry.rematch = false; } });
      if (!room.players.some(Boolean)) {
        if (room.countdownTimer) clearInterval(room.countdownTimer);
        rooms.delete(room.code);
      } else {
        publish(room);
      }
      if (typeof acknowledgement === "function") acknowledgement({ ok: true });
    });

    socket.on("disconnect", () => {
      const room = rooms.get(socket.data.roomCode);
      const player = room?.players[socket.data.seat];
      if (!player || player.socketId !== socket.id) return;
      player.connected = false;
      player.ready = false;
      if (room.status === "countdown") cancelCountdown(room);
      publish(room);
      player.disconnectTimer = setTimeout(() => disconnectPlayer(room, player), disconnectGraceMs);
      player.disconnectTimer.unref?.();
    });
  });

  tickTimer = setInterval(simulateTick, 1000 / 60);
  tickTimer.unref?.();

  return {
    app,
    httpServer,
    io,
    rooms,
    listen(port = Number(process.env.PORT) || 3000, host = process.env.HOST || "0.0.0.0") {
      return new Promise((resolveListen, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolveListen(httpServer.address());
        });
      });
    },
    async close() {
      clearInterval(tickTimer);
      for (const room of rooms.values()) if (room.countdownTimer) clearInterval(room.countdownTimer);
      await new Promise((resolveClose) => io.close(() => resolveClose()));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const game = createGameServer();
  game.listen().then((address) => {
    console.log(`Chris Club listening on ${typeof address === "object" ? `http://${address.address}:${address.port}` : address}`);
  }).catch((error) => {
    console.error("Could not start Chris Club:", error);
    process.exitCode = 1;
  });
}
