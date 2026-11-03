import test from "node:test";
import assert from "node:assert/strict";
import { io as createSocket } from "socket.io-client";
import { createGameServer } from "../server.js";

function waitFor(socket, event, predicate = () => true, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const onEvent = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(value);
    };
    socket.on(event, onEvent);
  });
}

test("two independent clients join, ready up, reject an out-of-turn shot, and receive the same authoritative foul", async (t) => {
  const game = createGameServer({ disconnectGraceMs: 1000 });
  const address = await game.listen(0, "127.0.0.1");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const first = createSocket(endpoint, { transports: ["websocket"], reconnection: false });
  const second = createSocket(endpoint, { transports: ["websocket"], reconnection: false });
  t.after(async () => {
    first.disconnect();
    second.disconnect();
    await game.close();
  });
  await Promise.all([waitFor(first, "connect"), waitFor(second, "connect")]);

  const created = await first.emitWithAck("room:create", { mode: "9", name: "Riley" });
  assert.equal(created.ok, true);
  const joined = await second.emitWithAck("room:join", { code: created.room.code, name: "Jordan" });
  assert.equal(joined.ok, true);
  await Promise.all([
    first.emitWithAck("room:ready", { ready: true }),
    second.emitWithAck("room:ready", { ready: true }),
  ]);
  const started = await Promise.all([
    waitFor(first, "room:state", (state) => state.status === "playing" && state.rules),
    waitFor(second, "room:state", (state) => state.status === "playing" && state.rules),
  ]);
  assert.deepEqual(started[0].balls.map((ball) => ball.id), started[1].balls.map((ball) => ball.id));
  assert.equal(started[0].rules.player, 0);

  const wrongTurn = await second.emitWithAck("shot:request", {
    sequence: started[1].sequence,
    angle: 0,
    power: 0.4,
    spinGain: 1,
    spin: { x: 0, y: 0 },
    elevation: 0,
  });
  assert.equal(wrongTurn.ok, false);
  assert.equal(wrongTurn.code, "TURN_MISMATCH");

  const initialPositions = new Map(started[0].balls.map((ball) => [ball.id, { x: ball.x, z: ball.z }]));
  const movedOnFirst = waitFor(first, "room:state", (state) => state.shot && state.balls.some((ball) => {
    const initial = initialPositions.get(ball.id);
    return initial && (Math.abs(ball.x - initial.x) > 1e-5 || Math.abs(ball.z - initial.z) > 1e-5);
  }));
  const movedOnSecond = waitFor(second, "room:state", (state) => state.shot && state.balls.some((ball) => {
    const initial = initialPositions.get(ball.id);
    return initial && (Math.abs(ball.x - initial.x) > 1e-5 || Math.abs(ball.z - initial.z) > 1e-5);
  }));
  const accepted = await first.emitWithAck("shot:request", {
    sequence: started[0].sequence,
    angle: Math.PI,
    power: 0.1,
    spinGain: 1,
    spin: { x: 0, y: 0 },
    elevation: 0,
    cueId: "starter",
    balls: [{ id: 0, x: 999, z: 999 }],
  });
  assert.equal(accepted.ok, true);
  const moving = await Promise.all([movedOnFirst, movedOnSecond]);
  assert.deepEqual(moving[0].balls, moving[1].balls);

  const settled = await Promise.all([
    waitFor(first, "room:state", (state) => state.status === "playing" && state.shot === null && state.rules?.ballInHand),
    waitFor(second, "room:state", (state) => state.status === "playing" && state.shot === null && state.rules?.ballInHand),
  ]);
  assert.equal(settled[0].rules.player, 1);
  assert.deepEqual(settled[0].balls, settled[1].balls);
  assert.ok(settled[0].balls.every((ball) => Math.abs(ball.x) < 2 && Math.abs(ball.z) < 2));
});

test("the server preserves aim direction and rejects invalid cue or 10-ball call data", async (t) => {
  const game = createGameServer({ disconnectGraceMs: 1000 });
  const address = await game.listen(0, "127.0.0.1");
  const endpoint = "http://127.0.0.1:" + address.port;
  const first = createSocket(endpoint, { transports: ["websocket"], reconnection: false });
  const second = createSocket(endpoint, { transports: ["websocket"], reconnection: false });
  t.after(async () => {
    first.disconnect();
    second.disconnect();
    await game.close();
  });
  await Promise.all([waitFor(first, "connect"), waitFor(second, "connect")]);

  const created = await first.emitWithAck("room:create", { mode: "10", name: "Riley" });
  const joined = await second.emitWithAck("room:join", { code: created.room.code, name: "Jordan" });
  assert.equal(created.ok, true);
  assert.equal(joined.ok, true);
  await Promise.all([
    first.emitWithAck("room:ready", { ready: true }),
    second.emitWithAck("room:ready", { ready: true }),
  ]);
  const [started] = await Promise.all([
    waitFor(first, "room:state", (state) => state.status === "playing" && state.rules),
    waitFor(second, "room:state", (state) => state.status === "playing" && state.rules),
  ]);

  const request = {
    sequence: started.sequence,
    angle: 0.7,
    power: 0.2,
    spinGain: 1,
    spin: { x: 0, y: 0 },
    elevation: 0,
    cueId: "__proto__",
    call: { ball: 1, pocket: 0 },
  };
  const invalidCue = await first.emitWithAck("shot:request", request);
  assert.equal(invalidCue.ok, false);
  assert.equal(invalidCue.code, "INVALID_CUE");
  await new Promise((resolve) => setTimeout(resolve, 270));

  const invalidCall = await first.emitWithAck("shot:request", {
    ...request,
    cueId: "starter",
    call: { ball: 15, pocket: 0 },
  });
  assert.equal(invalidCall.ok, false);
  assert.equal(invalidCall.code, "INVALID_CALL");
  await new Promise((resolve) => setTimeout(resolve, 270));

  const room = game.rooms.get(started.code);
  const strike = room.physics.strike.bind(room.physics);
  let acceptedAngle = null;
  room.physics.strike = (angle, ...args) => {
    acceptedAngle = angle;
    return strike(angle, ...args);
  };
  const accepted = await first.emitWithAck("shot:request", {
    ...request,
    cueId: "starter",
  });
  assert.equal(accepted.ok, true);
  assert.ok(Math.abs(acceptedAngle - 0.7) < 1e-9);
});

test("Socket.IO accepts the configured Netlify origin", async (t) => {
  const originalOrigins = process.env.ALLOWED_ORIGINS;
  const allowedOrigin = "https://chris-club-test.netlify.app";
  const configuredOrigins = [originalOrigins, allowedOrigin].filter(Boolean).join(",");
  process.env.ALLOWED_ORIGINS = configuredOrigins;

  const game = createGameServer({ disconnectGraceMs: 1000 });
  const address = await game.listen(0, "127.0.0.1");
  const endpoint = "http://127.0.0.1:" + address.port;
  const client = createSocket(endpoint, {
    reconnection: false,
    extraHeaders: { Origin: allowedOrigin },
  });
  t.after(async () => {
    client.disconnect();
    await game.close();
    if (originalOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = originalOrigins;
  });

  await waitFor(client, "connect");
  const created = await client.emitWithAck("room:create", { mode: "8", name: "Netlify player" });
  assert.equal(created.ok, true);
  assert.equal(created.room.isPrivate, true);
});
