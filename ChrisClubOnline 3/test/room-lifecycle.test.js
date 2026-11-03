import test from "node:test";
import assert from "node:assert/strict";
import { io as createSocket } from "socket.io-client";
import { createGameServer } from "../server.js";

function waitFor(socket, event, predicate = () => true, timeoutMs = 5000) {
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

test("public matchmaking pairs clients and a seat ticket restores a disconnected player", async (t) => {
  const game = createGameServer({ disconnectGraceMs: 2000 });
  const address = await game.listen(0, "127.0.0.1");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const first = createSocket(endpoint, { transports: ["websocket"], reconnection: false });
  const second = createSocket(endpoint, { transports: ["websocket"], reconnection: false });
  let resumed;
  t.after(async () => {
    first.disconnect();
    second.disconnect();
    resumed?.disconnect();
    await game.close();
  });
  await Promise.all([waitFor(first, "connect"), waitFor(second, "connect")]);

  const host = await first.emitWithAck("match:find", { mode: "8", name: "North" });
  const guest = await second.emitWithAck("match:find", { mode: "8", name: "South" });
  assert.equal(host.ok, true);
  assert.equal(guest.ok, true);
  assert.equal(host.room.isPrivate, false);
  assert.equal(host.room.code, guest.room.code);
  assert.equal(guest.seat, 1);

  const lost = waitFor(second, "room:state", (room) => room.players[0]?.connected === false);
  first.disconnect();
  await lost;

  resumed = createSocket(endpoint, { transports: ["websocket"], reconnection: false });
  await waitFor(resumed, "connect");
  const restored = await resumed.emitWithAck("room:reconnect", {
    code: host.room.code,
    token: host.ticket.token,
    seat: host.seat,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.seat, 0);
  assert.equal(restored.room.players[0].name, "North");
  assert.equal(restored.room.players[0].connected, true);

  await Promise.all([
    resumed.emitWithAck("room:leave", {}),
    second.emitWithAck("room:leave", {}),
  ]);
});
