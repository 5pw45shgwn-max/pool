import test from "node:test";
import assert from "node:assert/strict";
import { BilliardsPhysics, BilliardsRules, FIXED_TIMESTEP, rackBalls } from "../shared/physics.mjs";

test("the shared solver racks each supported mode at the fixed 480 Hz timestep", () => {
  assert.equal(FIXED_TIMESTEP, 1 / 480);
  assert.equal(rackBalls("8").length, 16);
  assert.equal(rackBalls("9").length, 10);
  assert.equal(rackBalls("10").length, 11);
});

test("a shot advances balls and keeps the cue ball within the cushion boundaries", () => {
  const physics = new BilliardsPhysics();
  physics.balls = rackBalls("8");
  assert.equal(physics.strike(Math.PI, 0.25), true);
  for (let step = 0; step < 480; step += 1) physics.step(FIXED_TIMESTEP);
  const cue = physics.balls.find((ball) => ball.id === 0);
  assert.ok(cue.x >= -1.43 && cue.x <= 1.43);
  assert.ok(cue.z >= -0.80 && cue.z <= 0.80);
});

test("rules hand over a turn and ball in hand after a no-contact foul", () => {
  const balls = rackBalls("9");
  const rules = new BilliardsRules("9");
  rules.begin(balls, { ball: 0, pocket: 0 });
  const result = rules.end(balls);
  assert.equal(result.foul, "No object ball contacted");
  assert.equal(rules.player, 1);
  assert.equal(rules.ballInHand, true);
});
