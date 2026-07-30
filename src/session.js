// The authoritative session: what the server RUNS, and what a client APPLIES.
//
// In src/ for the same reason snapshot.js is: the harness has to be able to drive both
// ends. That makes the central claim of slice 1 testable without a socket — build a server
// sim, build a client sim, pass snapshots between them, and assert the client's fortress
// ends up where the server's is. A socket cannot be tested here; arithmetic can, and every
// bug worth fearing in this layer is arithmetic.
//
// THREE COPIES OF CONSTRUCTION ORDER NOW EXIST, and that is worth stating plainly rather
// than discovering later: `verify.mjs`'s makeSim(), `worker/sim-check.js`, and this. They
// agree today. They will not agree forever, and the failure when they diverge is that the
// server runs a differently-wired game from the one the tests pass against — which is
// exactly the class of drift `npm run audit`'s check 9 exists to catch for frame ORDER.
//
// This file is the one that should win. It is the only one of the three that ships, so the
// intended end state is that makeSim() and sim-check both call createSession(). That is
// deliberately NOT done in this slice: makeSim is load-bearing for 1055 assertions, and
// folding a construction refactor into the first netcode slice would make any resulting
// failure unattributable. Recorded here as the follow-up it is.
//
// WHAT SLICE 1 SHARES: the hull and the director. Not the horde, not the operatives, not
// the economy. The hull first because it cannot be second — every attached body's position
// is expressed in its frame, so nothing downstream can be right before it is.

import * as THREE from "three";
import { CFG } from "./config.js";
import { World } from "./world.js";
import { Trampler } from "./trampler.js";
import { Player } from "./player.js";
import { Crew } from "./crew.js";
import { Grapple } from "./grapple.js";
import { Horde } from "./enemies.js";
import { Director } from "./waves.js";
import { Weapon } from "./weapon.js";
import { Repair } from "./repair.js";
import { DeckGun, handleStationInput } from "./deckgun.js";
import { Emitters } from "./emitters.js";
import { Economy, routePurchaseInput } from "./economy.js";
import { Events } from "./events.js";
import { Items } from "./items.js";
import { Modules } from "./modules.js";
import { Run, RUN } from "./run.js";
import { ENEMY_STATE } from "./enemies.js";
import { enemyCfg } from "./config.js";
import {
  packHullBits, unpackHullBits, packPhaseBits, unpackPhaseBits,
  packEnemyBits, unpackEnemyBits, packOperativeBits, unpackOperativeBits,
  packWeaponBits, unpackWeaponBits, packGrappleBits, HELD_BIT, EDGE_BIT,
} from "./snapshot.js";

/** Scratch, hoisted. `snapshotOf` runs 20 times a second over up to 420 bodies. */
const _enc = new THREE.Vector3();

/**
 * A duck-typed input that reports nothing pressed.
 *
 * The simulation modules only ever ask an input five questions, so a stub answering all
 * five is indistinguishable from a real one. Same trick the harness and the spike use, and
 * safe for the same reason: nothing in the simulation reaches for anything else.
 *
 * Slice 3 replaces this with a per-seat input driven from the wire. Until then the server
 * runs a fortress nobody is aboard, which is exactly what slice 1 shares.
 */
export function idleInput() {
  return {
    locked: false,
    down: () => false,
    pressed: () => false,
    mouseDown: () => false,
    mousePressed: () => false,
    mouse: { dx: 0, dy: 0 },
    endFrame() {},
  };
}

/**
 * An `Input` driven from decoded network commands, with a de-jitter queue.
 *
 * THE QUEUE IS THE WHOLE DESIGN, and it exists because of the difference between a level and
 * an edge. `down()` is a level: repeating it when a packet is late is correct, because a key
 * that was held is probably still held. `pressed()` is an EDGE that the reader consumes, and
 * repeating it fires a second grapple, mounts a station twice, or buys the same refit again.
 *
 * So a starved tick repeats the last HELD mask only for a short grace and supplies NO edges.
 * That bridges ordinary packet jitter without letting an unfocused or disconnected tab keep
 * walking, firing or repairing forever. Once the grace expires the held mask is neutral until
 * a fresh command arrives. Edges are never repeated at all.
 *
 * One command per tick, in order. Over a WebSocket that ordering is free — it is TCP, so
 * packets cannot arrive out of sequence — which is one of the few places this transport's
 * head-of-line blocking pays a dividend rather than a cost.
 */
export function netInput({
  maxQueue = CFG.net.inputQueue,
  maxHoldTicks = CFG.net.inputGraceTicks,
} = {}) {
  const queue = [];
  let current = { held: 0, edges: 0, lookDx: 0, lookDy: 0, seq: 0, clientTick: 0 };
  let consumedEdges = 0;
  let starvedTicks = 0;
  let fresh = false;

  return {
    // The last sequence actually STEPPED, which is what goes back in the snapshot's `ackSeq`.
    // Not the last received: a client must be told what has been simulated, or it would throw
    // away inputs still sitting in this queue.
    ackSeq: 0,
    starved: 0,
    dropped: 0,
    locked: true,

    push(cmd) {
      // A backlog means the client is sending faster than the server steps, or a burst
      // arrived after a stall. Oldest goes, because the newest input is the one that
      // describes what the player is doing NOW — the same "latest wins" argument the pose
      // relay makes, applied to a queue that must not grow without bound.
      if (queue.length >= maxQueue) {
        queue.shift();
        this.dropped++;
      }
      queue.push(cmd);
    },

    /** Immediately cancel queued and held intent after blur, suspension or disconnect. */
    release() {
      // This is deliberately NOT another queued neutral command. A release that waits behind
      // sixteen stale commands permits a quarter-second of walking or firing after the player
      // has left. WebSocket message order guarantees every pre-release command arrived first;
      // clearing here makes the release the boundary, and later commands begin a new stream.
      queue.length = 0;
      current = {
        ...current,
        held: 0,
        edges: 0,
        lookDx: 0,
        lookDy: 0,
      };
      consumedEdges = 0;
      starvedTicks = maxHoldTicks + 1;
      fresh = false;
    },

    /** Take the next command for this tick. Called once per step, before the step. */
    advance() {
      const next = queue.shift();
      fresh = !!next;
      if (next) {
        current = next;
        this.ackSeq = next.seq;
        starvedTicks = 0;
      } else {
        starvedTicks++;
        // Preserve levels only across the configured jitter grace. After that, neutralise the
        // authority: a browser may stop requestAnimationFrame entirely in a background tab,
        // and its last W or trigger state is not permission to act until it returns.
        current = {
          ...current,
          held: starvedTicks <= maxHoldTicks ? current.held : 0,
          edges: 0,
          lookDx: 0,
          lookDy: 0,
        };
        this.starved++;
      }
      consumedEdges = 0;
    },

    down(code) {
      const bit = HELD_FOR[code];
      return bit !== undefined && (current.held & bit) !== 0;
    },

    pressed(code) {
      const bit = EDGE_FOR[code];
      if (bit === undefined) return false;
      // CONSUMING, exactly like the real Input. `player.update` reads Space once and routes
      // it to either the winch or the jump buffer, and a non-consuming version here would let
      // both have it.
      if ((current.edges & bit) === 0 || (consumedEdges & bit) !== 0) return false;
      consumedEdges |= bit;
      return true;
    },

    mouseDown(button) {
      return button === 0 && (current.held & HELD_BIT.fire) !== 0;
    },

    mousePressed(button) {
      const bit = button === 0
        ? EDGE_BIT.firePressed
        : button === 2
          ? EDGE_BIT.grapple
          : 0;
      if (bit === 0 || (current.edges & bit) === 0) return false;
      if ((consumedEdges & bit) !== 0) return false;
      consumedEdges |= bit;
      return true;
    },

    get mouse() {
      return { dx: current.lookDx, dy: current.lookDy };
    },

    // Deliberately empty. The real Input clears its own edges here; this one clears them in
    // `advance()`, because a command's lifetime is one tick rather than one frame and the
    // server has no frames.
    endFrame() {},

    get queued() { return queue.length; },
    get seq() { return current.seq; },
    // True only on the tick that consumed a command, never on a repeated grace tick. The
    // acknowledgement pose is captured from this distinction after the complete sim step.
    get fresh() { return fresh; },
  };
}

/**
 * Key code to bit. Kept as one table each way rather than as a switch, so a key that is
 * NOT in the table is silently inert rather than throwing — which is the right behaviour for
 * the debug keys, which are deliberately absent and must never reach the authority.
 */
const HELD_FOR = {
  KeyW: HELD_BIT.forward,
  KeyS: HELD_BIT.back,
  KeyA: HELD_BIT.left,
  KeyD: HELD_BIT.right,
  ShiftLeft: HELD_BIT.sprint,
  ShiftRight: HELD_BIT.sprint,
  [CFG.repair.key]: HELD_BIT.repair,
};

const EDGE_FOR = {
  Space: EDGE_BIT.jump,
  [CFG.deckGun.key]: EDGE_BIT.station,
  [CFG.emitters.deployKey]: EDGE_BIT.deploy,
  [CFG.emitters.recallKey]: EDGE_BIT.recall,
  [CFG.fortress.toggleKey]: EDGE_BIT.bay,
  Digit1: EDGE_BIT.key1,
  Digit2: EDGE_BIT.key2,
  Digit3: EDGE_BIT.key3,
  Digit4: EDGE_BIT.key4,
  Digit5: EDGE_BIT.key5,
  Digit6: EDGE_BIT.key6,
  KeyQ: EDGE_BIT.callEarly,
  KeyK: EDGE_BIT.restart,
  [CFG.combat.loadout.swapKey]: EDGE_BIT.swap,
};

/**
 * Read the local Input into a command a server can replay.
 *
 * Lives here rather than in net.js so the harness can test it, and so the two directions of
 * the mapping sit in one file. A key added to one table and not the other is the classic
 * silent half-wiring, and having them adjacent is the cheapest defence.
 *
 * NOTE THE CONSUMPTION HAZARD. `input.pressed()` deletes what it returns, so calling it here
 * would STEAL the press from the local prediction — the client would send the jump and never
 * perform it. So this reads the underlying set directly. That asymmetry is ugly and it is the
 * correct kind of ugly: the alternative is a press that works in single player and vanishes
 * in multiplayer.
 */
export function readInput(input, { seq, clientTick }) {
  let held = 0;
  for (const [code, bit] of Object.entries(HELD_FOR)) {
    if (input.down(code)) held |= bit;
  }
  if (input.mouseDown(0)) held |= HELD_BIT.fire;

  let edges = 0;
  for (const [code, bit] of Object.entries(EDGE_FOR)) {
    // `isPressed`, which is a non-consuming peek. NOT `pressed()`, which would steal the press
    // from the local prediction — and not a reach into `justPressed`, which is what the first
    // version did and which returned zero edges against the harness's stub because that stub
    // names its set `presses`. See Input.isPressed for the full argument.
    if (input.isPressed?.(code)) edges |= bit;
  }
  if (input.isMousePressed?.(0)) edges |= EDGE_BIT.firePressed;
  if (input.isMousePressed?.(2)) edges |= EDGE_BIT.grapple;

  return {
    seq,
    clientTick,
    held,
    edges,
    lookDx: input.mouse.dx,
    lookDy: input.mouse.dy,
  };
}

/**
 * Build a complete simulation.
 *
 * Construction ORDER is load-bearing and is the same order main.js uses: modules before
 * economy because the economy owns the purse that buys them and calls modules.reset();
 * economy before run because the run pays arrival bonuses into it; items after the economy
 * because it reads stack counts. The bus is created before anything subscribes, so listener
 * order is registration order is construction order — which is what keeps a build
 * deterministic when several items react to one kill.
 *
 * @param scene optional. A server passes nothing and gets a bare Scene; look.js already
 *        degrades to flat materials with no document, so the meshes cost memory and are
 *        never drawn. Not worth special-casing: a headless branch through construction
 *        would be a second code path that the harness could not exercise.
 */
export function createSession({
  scene = new THREE.Scene(),
  // A count preserves every existing call site; an explicit array preserves sparse lobby
  // identities such as [1, 3] instead of silently inventing ghost seat 2.
  seats = 1,
  // A server passes true, so every seat gets a de-jitter queue instead of a stub that
  // reports nothing pressed. Off by default because the harness and `tools/scene-cost.mjs`
  // both build sessions nobody is playing, and a queue they never feed would starve on every
  // tick and count it.
  networked = false,
  autoReset = networked,
} = {}) {
  const seatIds = Array.isArray(seats)
    ? [...seats]
    : Array.from({ length: seats }, (_, index) => index + 1);
  if (seatIds.length === 0
      || seatIds.some((seat) => !Number.isInteger(seat) || seat < 1)
      || new Set(seatIds).size !== seatIds.length) {
    throw new Error(`invalid operative seats [${seatIds.join(",")}]`);
  }

  const camera = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 2000);
  camera.rotation.order = "YXZ";
  scene.add(camera);

  const world = new World(scene);
  const trampler = new Trampler(scene);
  const player = new Player(camera, world, trampler);
  const grapple = new Grapple(scene, player, trampler, world);
  player.grapple = grapple;

  const crew = new Crew();
  crew.add(player, seatIds[0]);
  const horde = new Horde(scene, trampler);
  const events = new Events();
  horde.events = events;
  const director = new Director(horde, trampler, crew);
  const weapon = new Weapon(scene, player, horde, world, trampler);
  weapon.events = events;
  const repair = new Repair(player, trampler, horde, crew);
  const guns = CFG.deckGun.mounts.map((m) => new DeckGun(scene, trampler, m));
  const emitters = new Emitters(scene, trampler, horde);
  const modules = new Modules({ trampler, horde, emitters, guns });
  const economy = new Economy({
    player, trampler, weapon, repair, horde, director, modules, events,
  });
  const items = new Items({ economy, player, trampler, weapon, horde, repair, events });
  const run = new Run(director, horde, economy, crew);

  // Raycasting needs current matrices and the renderer is what normally refreshes them,
  // so seed them once. The terrain is static, so one pass is enough for it.
  scene.updateMatrixWorld(true);

  const sim = {
    scene, camera, world, trampler, player, crew, grapple, horde, director, weapon,
    repair, guns, emitters, modules, economy, items, run, events,
    input: idleInput(),
    // Per-seat kit. The first id is the primary object constructed above; Worker callers sort
    // the explicit roster, so seat 1 remains primary while gaps stay gaps.
    operatives: [{
      seat: seatIds[0], player, weapon, grapple, repair, items, economy,
      input: networked ? netInput() : idleInput(),
      ackPose: null,
      bayOpen: false,
    }],
    treasury: economy.treasury,
    networked,
    autoReset,
    resetId: 0,
    lossTimer: 0,
  };

  for (const seat of seatIds.slice(1)) addOperative(sim, seat);
  for (const op of sim.operatives) captureAckPose(sim, op);
  return sim;
}

/**
 * Seat another operative, with their own kit.
 *
 * THIS IS THE FUNCTION THAT MAKES SEVEN BUILT-AND-DORMANT RULES REACHABLE. Wave size scales
 * off `crew.size`, and nothing in the browser has ever increased it — so with four people
 * connected, each faced a solo-sized fight. The scaling table, the shared repair claim, the
 * road vote, the per-seat purses, the proc attribution and the stomp's crew sweep are all in
 * the same position: correct, tested, and unreachable until this array grows.
 *
 * ONE INSTANCE EACH OF Weapon, Grapple, Repair, Items AND Economy, and that is not
 * conservatism. `Weapon.assertOperative` refuses a weapon belonging to somebody else,
 * because every personal item recomputes absolutely from stack counts: two operatives over
 * one Weapon means each purchase silently reverts the other's, measured as crew 1's four
 * rifle calibrations being wiped by crew 2 buying anything at all.
 *
 * The Treasury is deliberately SHARED — one pot of scrap, one set of fortress stack counts —
 * which is invariant 22 expressed as construction rather than as a rule someone has to
 * remember. And the absolute recompute is idempotent across the crew, which is why no
 * ownership flag exists anywhere in the economy.
 */
export function addOperative(sim, seat = Math.max(0, ...sim.operatives.map((op) => op.seat)) + 1) {
  if (!Number.isInteger(seat) || seat < 1 || sim.operatives.some((op) => op.seat === seat)) {
    throw new Error(`invalid or duplicate operative seat ${seat}`);
  }
  const player = new Player(sim.camera, sim.world, sim.trampler);
  const grapple = new Grapple(sim.scene, player, sim.trampler, sim.world);
  player.grapple = grapple;
  player.respawnOnDeck();

  const weapon = new Weapon(sim.scene, player, sim.horde, sim.world, sim.trampler);
  weapon.events = sim.events;
  const repair = new Repair(player, sim.trampler, sim.horde, sim.crew);
  const economy = new Economy({
    player,
    trampler: sim.trampler,
    weapon,
    repair,
    horde: sim.horde,
    director: sim.director,
    modules: sim.modules,
    events: sim.events,
    // The crew's half, shared. Handed in rather than defaulted, which is the difference
    // between four operatives spending one pot and four operatives each with their own.
    treasury: sim.treasury,
  });
  const items = new Items({
    economy, player, trampler: sim.trampler, weapon, horde: sim.horde, repair,
    events: sim.events,
  });

  // AFTER the kit is built, not before. `Repair` and the horde's contact-damage loop both
  // walk the crew, and a Player in the roster without a Repair of their own would be a
  // half-seated operative that other people's code can already see.
  sim.crew.add(player, seat);
  const op = {
    seat, player, weapon, grapple, repair, items, economy,
    input: sim.networked ? netInput() : idleInput(),
    ackPose: null,
    bayOpen: false,
  };
  sim.operatives.push(op);
  sim.run.addEconomy(economy);
  captureAckPose(sim, op);
  return op;
}

/**
 * Remove one operative from a running authority without renumbering the survivors.
 *
 * A disconnected body cannot remain in Crew: it would still count toward wave scaling,
 * road majorities, pending picks, repair claims and gun occupancy. Personal event listeners
 * are identity-gated, so once this Player is no longer a possible damage source they become
 * inert; the shared Treasury remains owned by the session.
 */
export function removeOperative(sim, seat) {
  const index = sim.operatives.findIndex((op) => op.seat === seat);
  if (index < 0) return null;
  const op = sim.operatives[index];

  op.input.release?.();
  op.grapple.cancel?.();
  op.player.cancelMantle?.();
  op.player.repairing = null;
  if (op.player.station) op.player.station.dismount(op.player);
  for (const gun of sim.guns) {
    if (gun.operator === op.player) gun.evict();
  }

  op.economy.pendingPick = [];
  sim.crew.remove(op.player);
  sim.run.removeEconomy(op.economy);
  sim.operatives.splice(index, 1);

  // Preserve the long-standing singular aliases for harness/solo readers. They name the
  // first surviving operative, not seat 1; stable seat identity remains on the roster.
  const primary = sim.operatives[0] ?? null;
  sim.player = primary?.player ?? null;
  sim.weapon = primary?.weapon ?? null;
  sim.grapple = primary?.grapple ?? null;
  sim.repair = primary?.repair ?? null;
  sim.items = primary?.items ?? null;
  sim.economy = primary?.economy ?? null;
  return op;
}

/** Current operative pose in the coordinate frame the wire carries. */
function operativePose(sim, op) {
  const t = sim.trampler;
  const p = op.player;
  const based = p.base === t;
  _enc.copy(p.position);
  let yaw = p.yaw;
  if (based) {
    t.worldToLocal(_enc);
    yaw -= t.yaw;
  }
  return {
    x: _enc.x,
    y: _enc.y,
    z: _enc.z,
    yaw,
    pitch: p.pitch,
    bits: packOperativeBits({
      based,
      station: p.station ? sim.guns.indexOf(p.station) + 1 : 0,
      repairing: !!p.repairing,
      downed: false,
      grounded: !!p.grounded,
      bayOpen: !!op.bayOpen,
    }),
  };
}

/** Freeze the exact outcome associated with the newest freshly consumed command. */
function captureAckPose(sim, op) {
  op.ackPose = operativePose(sim, op);
}

/**
 * Rewind every owner of encounter state, for both local play and the server authority.
 *
 * Presentation cleanup stays in main.js; everything that can affect the next deterministic
 * step lives here so a browser reset and a Worker reset cannot omit different systems.
 */
export function resetSession(sim, { advanceGeneration = true } = {}) {
  sim.horde.clear();
  sim.emitters.clear();
  for (const op of sim.operatives) op.economy.reset();
  sim.trampler.repairAll();
  sim.trampler.resetPose();
  sim.director.reset();
  sim.run.reset();
  sim.world.setFogScale(1);

  for (const gun of sim.guns) {
    gun.evict();
    gun.remoteOperatorSeat = 0;
    gun.heat = 0;
    gun.overheated = false;
    gun.cooldown = 0;
  }

  for (const op of sim.operatives) {
    op.bayOpen = false;
    op.player.hp = op.player.maxHp;
    op.player.repairing = null;
    op.player.respawnOnDeck();
    op.items.reset();
    if (sim.networked) op.input.release?.();
  }

  sim.lossTimer = 0;
  if (advanceGeneration) sim.resetId = (sim.resetId ?? 0) + 1;
  for (const op of sim.operatives) captureAckPose(sim, op);
  return sim.resetId;
}

/**
 * One fixed simulation step, in the game's order.
 *
 * THE ORDER IS COPIED FROM main.js's simStep AND MUST STAY THAT WAY. The hull moves first
 * so everything aboard inherits this step's motion, footfalls resolve against where bodies
 * actually are, the grapple fires before the player so a shot lands on the step it was
 * pressed, and the horde reads the hull transform after it has moved.
 *
 * `dt` is always the fixed step. Never a measured frame time: the server counts ticks, and
 * a variable dt here would make the authority disagree with every client's prediction of
 * its own last second. That is the whole reason CFG.loop exists.
 */
export function stepSession(sim, dt) {
  // Each operative's queue advances exactly once per tick, before anything reads it. Doing it
  // here rather than inside the per-seat loop below matters: `handleStationInput` and the
  // purchase router both arbitrate BETWEEN operatives, so every seat's command for this tick
  // has to be settled before the first one is examined.
  for (const op of sim.operatives) op.input.advance?.();

  // Shared run actions are consumed before the world advances, matching main.js's
  // pre-step toggle slot. One restart wins the tick and releases every queued input;
  // continuing after it would immediately advance the freshly reset encounter.
  for (const op of sim.operatives) {
    if (op.input.pressed("KeyK")) {
      resetSession(sim);
      return;
    }
  }
  for (const op of sim.operatives) {
    if (op.input.pressed("KeyQ")) sim.director.callEarly();
  }

  sim.trampler.update(dt);
  sim.trampler.resolveStomps(sim.horde, sim.crew);
  sim.director.update(dt);
  sim.run.update();

  // PER OPERATIVE, IN SEAT ORDER. Order matters for exactly one thing and it is worth naming:
  // two operatives reaching for the same gun mount on the same tick. `handleStationInput`
  // resolves that by whoever asks first, and seat order makes "first" deterministic rather
  // than dependent on a Map's iteration or a socket's arrival time. A seeded fight has to
  // replay identically, and that includes the ties.
  for (let opIndex = 0; opIndex < sim.operatives.length; opIndex++) {
    const op = sim.operatives[opIndex];
    const input = op.input;
    // The sequence this tick's command carries, so a shot's cone spread is a function of an index
    // the client also has rather than of a stream position only this side knows. Reset per tick,
    // because `shotsThisKey` counts shots WITHIN one sequence.
    if (op.weapon) {
      const seq = input.seq ?? 0;
      if (op.weapon.spreadKey !== seq) {
        op.weapon.spreadKey = seq;
        op.weapon.shotsThisKey = 0;
      }
    }
    handleStationInput(sim.guns, input, op.player);
    op.grapple.handleInput(input);
    op.player.update(dt, input);
    op.weapon.update(dt, input);
    for (const g of sim.guns) g.update(dt, input, op.player, op.weapon, opIndex === 0);
    op.repair.update(dt, input);
    sim.emitters.update(dt, input, op.player, opIndex === 0);
    op.items.update(dt);

    if (input.pressed(CFG.fortress.toggleKey)) op.bayOpen = !op.bayOpen;
    // Blocking crew decisions outrank a personal bay and cannot be hidden underneath it.
    if (sim.run.choosing || sim.run.picking) op.bayOpen = false;
    routePurchaseInput({ economy: op.economy, run: sim.run, bayOpen: op.bayOpen, input, dt });
    op.grapple.update(dt);
    input.endFrame();
  }

  // The horde LAST, so contact damage is dealt against where every operative actually ended
  // the tick. This is also the call that hurts the crew — `p.hurt()` lives inside it — which
  // is why a client having it gated off means enemies cannot touch anybody, and why seating
  // the real crew here is what gives the horde somebody to fight.
  sim.horde.update(dt, sim.crew);

  // Ack identity belongs to the complete tick, including contact damage and a death/respawn
  // that happened in the horde's final phase. Grace-repeated held input deliberately does not
  // capture again: its later pose is current state, not the outcome of a newer sequence.
  for (const op of sim.operatives) {
    if (op.input.fresh) captureAckPose(sim, op);
  }

  if (sim.autoReset) {
    if (sim.trampler.destroyed) {
      sim.lossTimer += dt;
      if (sim.lossTimer > CFG.run.resetDelay) resetSession(sim);
    } else {
      sim.lossTimer = 0;
    }
  }
}

/**
 * The plain state object `snapshot.encode()` wants.
 *
 * Reads only. Nothing here mutates the simulation, which matters because a getter with a
 * side effect would make observing the world change it — `emitters.canDeploy()` writes
 * `blockReason`, and that is precisely why `emitters.ready` was published as a field
 * instead. Everything below is a field or a pure getter.
 *
 * @param tick the server's own tick counter, which is the ONLY clock in the system.
 */
export function snapshotOf(sim, tick) {
  const t = sim.trampler;
  const d = sim.director;
  const h = sim.horde;
  const run = sim.run;
  const p = t.group.position;
  const operatives = operativesOf(sim);
  const lastDeath = h.lastKill ?? { x: 0, y: 0, z: 0, type: 0, paid: false };

  const routeWireIndex = (road) => {
    const id = typeof road === "string" ? road : road?.id;
    const index = CFG.run.routes.findIndex((candidate) => candidate.id === id);
    return index >= 0 ? index + 1 : 0;
  };
  const moduleWireIndex = (id) => {
    const index = CFG.fortress.catalogue.findIndex((item) => item.id === id);
    return index >= 0 ? index + 1 : 0;
  };

  const economyStacks = [];
  const economyOffers = [];
  const economyPicks = [];
  for (const op of sim.operatives) {
    for (const item of CFG.economy.catalogue) {
      economyStacks.push(op.economy.stacks[item.id] ?? 0);
    }
    for (let i = 0; i < CFG.economy.keys.length; i++) {
      const index = op.economy.offers[i];
      economyOffers.push(index === undefined ? 0 : index + 1);
    }
    for (let i = 0; i < CFG.economy.pickCount; i++) {
      const index = op.economy.pendingPick[i];
      economyPicks.push(index === undefined ? 0 : index + 1);
    }
  }

  const roadVotes = [];
  for (const [voter, index] of run.votes) {
    const seat = sim.crew.seatOf(voter);
    if (seat > 0 && index >= 0 && index < 3) roadVotes.push((seat << 2) | (index + 1));
  }
  roadVotes.sort((a, b) => a - b);

  return {
    tick,
    // THE FIELD THIS WHOLE SLICE EXISTS FOR. Difficulty scales with elapsed time, and
    // every client currently starts its own clock on its own click — so two players who
    // clicked ten seconds apart have been fighting measurably different waves, for ever.
    // Milliseconds because the wire carries a u32 and a biome is about fifteen minutes.
    elapsedMs: Math.round(d.elapsed * 1000),
    resetId: sim.resetId ?? 0,

    hullX: p.x,
    hullZ: p.z,
    hullYaw: t.yaw,
    gait: t.time,
    reactorHp: t.reactorHp,
    driveScale: t.driveScale,
    turnScale: t.turnScale,
    hullBits: packHullBits({
      walking: t.walking,
      turning: t.turning,
      destroyed: t.destroyed,
      immobilised: t.immobilised,
    }),

    wave: d.wave,
    resolved: d.resolved,
    phaseTimer: Math.max(0, d.timer),
    arcOffset: d.arcOffset,
    phaseBits: packPhaseBits({
      phase: d.phase,
      runPhase: run.phase,
      calledEarly: d.calledEarly,
      bossLeg: run.isBossLeg,
    }),
    runLeg: run.leg,

    threatScale: run.threatScale,
    extraCount: run.extraCount,
    fogScale: run.fogScale,
    speedScale: h.speedScale,
    treasuryScrap: sim.treasury.scrap,
    treasuryEarnedScrap: sim.treasury.earnedScrap,
    moduleCredits: sim.treasury.moduleCredits,

    hordeKills: h.killCount,
    hordeDeaths: h.deathCount,
    lastDeathX: lastDeath.x,
    lastDeathY: lastDeath.y,
    lastDeathZ: lastDeath.z,
    lastDeathType: lastDeath.type,
    lastDeathBits: lastDeath.paid ? 1 : 0,

    legHp: [...t.legHp],
    moduleSockets: sim.modules.sockets.map(moduleWireIndex),
    roadHistory: run.history.map(routeWireIndex),
    roadOffers: run.offers.map(routeWireIndex),
    roadVotes,
    economyStacks,
    economyOffers,
    economyPicks,

    gunOperatorSeats: sim.guns.map((gun) => sim.crew.seatOf(gun.operator)),
    gunYaw: sim.guns.map((gun) => gun.yawLocal),
    gunPitch: sim.guns.map((gun) => gun.pitch),
    gunHeat: sim.guns.map((gun) => gun.heat),
    gunCooldown: sim.guns.map((gun) => Math.max(0, gun.cooldown)),
    gunBits: sim.guns.map((gun) => (gun.overheated ? 1 : 0)),
    gunShots: sim.guns.map((gun) => gun.shots),

    emitterLive: sim.emitters.slots.map((slot) => (slot.live ? 1 : 0)),
    emitterX: sim.emitters.slots.map((slot) => slot.local.x),
    emitterY: sim.emitters.slots.map((slot) => slot.local.y),
    emitterZ: sim.emitters.slots.map((slot) => slot.local.z),
    emitterCooldown: sim.emitters.slots.map((slot) => Math.max(0, slot.cd)),
    emitterCharge: sim.emitters.slots.map((slot) => slot.charge),

    entities: entitiesOf(sim),
    operatives,
  };
}

/**
 * Every seated operative, in the frame they are standing in.
 *
 * Same frame rule as everything else: hull-local when aboard, world when on the sand, because
 * the receiver already knows the hull's current transform. Section 115 measures that at
 * 0.00 cm against 45 cm, and a crewmate skating across the deck was the specific failure
 * net.js was written to rule out.
 *
 * `ackSeq` is the reconciliation half and it comes from the input queue rather than from the
 * socket: it is the last command actually STEPPED for this seat, not the last received. A
 * client told about a command still sitting in the server's queue would discard an input that
 * has not been simulated yet, and then be surprised when the next snapshot appears to undo it.
 */
export function operativesOf(sim) {
  const out = [];
  for (const op of sim.operatives) {
    const p = op.player;
    const current = operativePose(sim, op);
    const ack = op.ackPose ?? current;
    const grappleActive = !!op.grapple?.active;
    const grappleAnchor = grappleActive
      ? (op.grapple.onHull ? op.grapple.anchorLocal : op.grapple.anchorWorld)
      : null;
    const weapon = op.weapon;
    const shotStart = weapon?.lastShotStart;
    const shotEnd = weapon?.lastShotEnd;
    out.push({
      seat: op.seat,
      ackSeq: op.input.ackSeq ?? 0,
      ackX: ack.x,
      ackY: ack.y,
      ackZ: ack.z,
      ackYaw: ack.yaw,
      ackPitch: ack.pitch,
      ackBits: ack.bits,
      x: current.x,
      y: current.y,
      z: current.z,
      vx: p.velocity.x,
      vy: p.velocity.y,
      vz: p.velocity.z,
      yaw: current.yaw,
      pitch: current.pitch,
      hp: Math.max(0, Math.round(p.hp)),
      hurtCount: p.hurtCount ?? 0,
      deaths: p.deaths ?? 0,
      kills: op.weapon?.kills ?? 0,
      salvage: op.economy?.salvage ?? 0,
      earnedSalvage: op.economy?.earned?.salvage ?? 0,
      purchases: op.economy?.purchases ?? 0,
      refitCallouts: op.economy?.refitCallouts ?? 0,
      weaponBits: packWeaponBits({
        slot: weapon?.slot,
        cooldown: weapon?.cooldown,
        shots: weapon?.shotCues,
      }),
      weaponSwaps: weapon?.swaps ?? 0,
      shotStartX: shotStart?.x ?? 0,
      shotStartY: shotStart?.y ?? 0,
      shotStartZ: shotStart?.z ?? 0,
      shotEndX: shotEnd?.x ?? 0,
      shotEndY: shotEnd?.y ?? 0,
      shotEndZ: shotEnd?.z ?? 0,
      grappleX: grappleAnchor?.x ?? 0,
      grappleY: grappleAnchor?.y ?? 0,
      grappleZ: grappleAnchor?.z ?? 0,
      grappleBits: packGrappleBits({ active: grappleActive, onHull: op.grapple?.onHull }),
      bits: current.bits,
    });
  }
  return out;
}

/**
 * Every live body, in the frame it belongs to.
 *
 * THE FRAME CHOICE IS THE WHOLE POINT, and it is the same argument net.js makes for a
 * crewmate's pose, one level down. A body that is riding the deck or latched to a leg is
 * carried by the hull, so it is sent in HULL-LOCAL space: the receiver already knows the
 * hull's current transform, so a 120 ms old position is stale only by the body's own motion
 * relative to the deck, which for a latched chewer is zero. Sent in world space it would be
 * stale by the hull's travel — 45 cm at 120 ms, measured in section 115 — relative to the
 * leg it is chewing.
 *
 * That matters more here than for a crewmate. The two carried cases are exactly the two
 * things a player reads to decide which of the two positions to be in: a chewer on a leg,
 * and a boarder on the deck. A chewer sliding half a metre off the leg it is attacking is
 * the pillar's core readout lying.
 *
 * The gate is `onHull || latched`, which is not invented here — `Horde.update` already uses
 * that exact pair to decide which bodies to carry through the hull's frame change, so the
 * wire and the simulation agree by construction rather than by coincidence.
 */
export function entitiesOf(sim) {
  const t = sim.trampler;
  const out = [];
  for (let i = 0; i < sim.horde.pool.length; i++) {
    const e = sim.horde.pool[i];
    if (!e.alive) continue;

    const carried = e.onHull || e.latched;
    _enc.set(e.x, e.y, e.z);
    if (carried) t.worldToLocal(_enc);

    const bits = packEnemyBits({
      type: e.type,
      state: e.state,
      carried,
      // A one-frame white flash is the only "that connected" signal in the game (invariant
      // 8a), so it has to survive the wire even though it is gone by the next snapshot. Sent
      // as a boolean rather than the decaying float: the client runs its own decay, and the
      // exact remaining fraction is not something an eye resolves in one frame.
      flash: e.flash > 0,
      hpFraction: e.maxHp > 0 ? e.hp / e.maxHp : 0,
      // A lit fuse is a timer the crew has to answer, and the sapper is the one enemy that
      // is a timer rather than a damage race. The flag drives the packed tint byte; the
      // remaining time travels separately at tenth-second precision for the HUD warning.
      fuseLit: e.fuseT > 0,
    });

    out.push({
      id: i,
      bitsA: bits.bitsA,
      bitsB: bits.bitsB,
      x: _enc.x,
      y: _enc.y,
      z: _enc.z,
      fuseT: Math.max(0, e.fuseT),
      yaw: e.yaw,
    });
  }
  return out;
}

/**
 * Write a snapshot's horde into a client's pool.
 *
 * THE CLIENT DOES NOT RUN ENEMY AI. That is the contract this function implies and
 * `stepSessionClient` enforces: every field here is presentation, and none of the state the
 * AI needs is transmitted at all. A client that also stepped the horde would immediately
 * disagree with what it had just been told, and would then be corrected 20 times a second —
 * which is rubber-banding, and is exactly the failure the relay had at the whole-simulation
 * level.
 *
 * Bodies are matched by POOL INDEX. A slot holds one enemy at a time, so an index is a
 * stable identity for as long as that body lives, which is what lets the caller interpolate
 * rather than redraw 400 unrelated positions every 50 ms.
 */
export function applyEntities(sim, entities) {
  const t = sim.trampler;
  const horde = sim.horde;
  const pool = horde.pool;
  const seen = new Set();

  for (const w of entities) {
    const e = pool[w.id];
    // An id outside the pool means the server has a larger CFG.enemies.max than this client.
    // Skipped rather than thrown: one stale client should not lose the whole horde, and the
    // protocol version check has already had its chance to catch a real mismatch.
    if (!e) continue;
    seen.add(w.id);

    const b = unpackEnemyBits(w.bitsA, w.bitsB);
    e.alive = true;
    e.type = b.type;
    e.state = b.state;
    e.onHull = b.carried && b.state === ENEMY_STATE.ON_DECK;
    e.latched = b.carried && !e.onHull;
    e.reactorSlot = false;
    e.yaw = w.yaw;

    // Health is carried as a fraction because that is all the drawing needs — the tint band
    // is `ceil(fraction * 4)`. maxHp comes from config, so the absolute value is recoverable
    // for anything that wants it, and the elapsed-time hp ramp lives on the server where the
    // clock does.
    e.maxHp = enemyCfg(b.type).hp;
    e.hp = b.hpFraction * e.maxHp;
    // Re-armed rather than assigned, so the client's own decay runs. `flash` is a duration on
    // the client and a boolean on the wire; conflating them would make a hit flash last
    // exactly one frame at 20 Hz, which is a flicker rather than a signal.
    if (b.flash) e.flash = CFG.combat.weapon.hitFlash;
    e.fuseT = b.fuseLit ? Math.max(0, w.fuseT ?? 0) : 0;

    // BACK INTO WORLD SPACE, THROUGH THE HULL'S CURRENT TRANSFORM. The receiving pool stores
    // world coordinates — the same convention the simulation uses — so a carried body's
    // hull-local position is read out against the transform this frame, which is what makes
    // it track the walking fortress instead of skating behind it.
    if (b.carried) {
      _enc.set(w.x, w.y, w.z);
      t.localToWorld(_enc);
      e.x = _enc.x;
      e.y = _enc.y;
      e.z = _enc.z;
    } else {
      e.x = w.x;
      e.y = w.y;
      e.z = w.z;
    }
  }

  // Anything the server did not mention is dead. Cleared directly rather than through
  // `Horde.damage` or `#kill`, because those pay income and fire the kill bus — and on a
  // client that would credit a purse the snapshot owns and fire procs for kills this player
  // did not make. The same reason a client deals no damage at all.
  let live = 0;
  let underHull = 0;
  let aboard = 0;
  let burrowed = 0;
  let fusesLit = 0;
  let fuseWarning = 0;
  for (let i = 0; i < pool.length; i++) {
    const e = pool[i];
    if (!e.alive) continue;
    if (!seen.has(i)) {
      e.alive = false;
      e.latched = false;
      e.onHull = false;
      e.reactorSlot = false;
      e.fuseT = 0;
      e.tintBand = -1;
      continue;
    }

    live++;
    if (e.state === ENEMY_STATE.BURROWED) {
      burrowed++;
    } else if (e.onHull) {
      aboard++;
    } else {
      _enc.set(e.x, e.y, e.z);
      t.worldToLocal(_enc);
      if (Math.abs(_enc.x) < t.halfW && Math.abs(_enc.z) < t.halfL && _enc.y < -1) {
        underHull++;
      }
    }
    if (e.fuseT > 0) {
      fusesLit++;
      if (fuseWarning === 0 || e.fuseT < fuseWarning) fuseWarning = e.fuseT;
    }
  }
  horde.liveCount = live;
  horde.underHull = underHull;
  horde.aboard = aboard;
  horde.burrowed = burrowed;
  horde.fusesLit = fusesLit;
  horde.fuseWarning = fuseWarning;
}

/** Apply row-major personal progression for every operative this client actually owns. */
function applyProgression(sim, state) {
  const wireOps = state.operatives ?? [];
  const catalogue = CFG.economy.catalogue;
  const stackWidth = catalogue.length;
  const offerWidth = CFG.economy.keys.length;
  const pickWidth = CFG.economy.pickCount;

  for (const op of sim.operatives) {
    const row = wireOps.findIndex((wire) => wire.seat === op.seat);
    if (row < 0) continue;
    const wire = wireOps[row];
    const economy = op.economy;

    economy.salvage = wire.salvage;
    economy.earned.salvage = wire.earnedSalvage;
    economy.purchases = wire.purchases;
    economy.refitCallouts = wire.refitCallouts;

    const stackAt = row * stackWidth;
    for (let i = 0; i < stackWidth; i++) {
      economy.stacks[catalogue[i].id] = state.economyStacks?.[stackAt + i] ?? 0;
    }
    const offerAt = row * offerWidth;
    economy.offers = (state.economyOffers ?? [])
      .slice(offerAt, offerAt + offerWidth)
      .filter((encoded) => encoded > 0)
      .map((encoded) => encoded - 1);
    const pickAt = row * pickWidth;
    economy.pendingPick = (state.economyPicks ?? [])
      .slice(pickAt, pickAt + pickWidth)
      .filter((encoded) => encoded > 0)
      .map((encoded) => encoded - 1);
    economy.applyAll();

    const weaponState = unpackWeaponBits(wire.weaponBits ?? 0);
    const slot = Math.max(
      0,
      Math.min(op.weapon.profiles.length - 1, weaponState.slot),
    );
    op.weapon.slot = slot;
    op.weapon.profile = op.weapon.profiles[slot];
    op.weapon.cooldown = weaponState.cooldown;
    op.weapon.swaps = wire.weaponSwaps ?? op.weapon.swaps;
    op.bayOpen = unpackOperativeBits(wire.bits).bayOpen;
  }
}

/** Restore shared gun state, representing unseen occupants as lightweight reservations. */
function applyGuns(sim, state, localSeat) {
  for (let i = 0; i < sim.guns.length; i++) {
    const gun = sim.guns[i];
    const seat = state.gunOperatorSeats?.[i] ?? 0;
    const currentSeat = sim.crew.seatOf(gun.operator);
    if (gun.operator && currentSeat !== seat && currentSeat !== localSeat) gun.evict();

    const op = sim.operatives.find((candidate) => candidate.seat === seat);
    if (seat > 0 && seat !== localSeat && op) {
      if (gun.operator !== op.player) {
        gun.evict();
        gun.operator = op.player;
        op.player.station = gun;
      }
      gun.remoteOperatorSeat = 0;
    } else {
      gun.remoteOperatorSeat = seat > 0 && seat !== localSeat ? seat : 0;
    }

    gun.yawLocal = state.gunYaw?.[i] ?? gun.yawLocal;
    gun.pitch = state.gunPitch?.[i] ?? gun.pitch;
    gun.heat = state.gunHeat?.[i] ?? gun.heat;
    gun.cooldown = state.gunCooldown?.[i] ?? gun.cooldown;
    gun.overheated = ((state.gunBits?.[i] ?? 0) & 1) !== 0;
    gun.shots = state.gunShots?.[i] ?? gun.shots;
    gun.traverseGroup.rotation.y = gun.yawLocal;
    gun.pitchGroup.rotation.x = gun.pitch;
    gun.pad.visible = !gun.mounted;
  }
}

/** Restore the hull-local emitter rack without invoking placement or dealing damage. */
function applyEmitters(sim, state) {
  for (let i = 0; i < sim.emitters.slots.length; i++) {
    const slot = sim.emitters.slots[i];
    slot.live = (state.emitterLive?.[i] ?? 0) !== 0;
    slot.local.set(
      state.emitterX?.[i] ?? 0,
      state.emitterY?.[i] ?? 0,
      state.emitterZ?.[i] ?? 0,
    );
    slot.cd = Math.max(0, state.emitterCooldown?.[i] ?? 0);
    slot.charge = Math.max(0, state.emitterCharge?.[i] ?? 0);
    slot.group.position.copy(slot.local);
    slot.group.visible = slot.live;
  }
}

/**
 * Drive a client's simulation from a decoded snapshot.
 *
 * CALL THIS BEFORE stepSession, NOT AFTER, and the reason is the subtlest thing in this
 * file. `Trampler.update` captures the PREVIOUS frame's inverse transform at its top, and
 * `Player.#applyBasedMovement` uses that capture to carry anybody standing on the deck from
 * the old hull frame into the new one. A correction applied after the step would therefore
 * be seen by the NEXT step as though the hull had really travelled that far, and it would
 * drag the local operative along with it — a 30 cm correction becoming a 30 cm shove.
 * Applied first, the step's own capture happens after the correction and the correction is
 * invisible to based movement, which is what it should be: it is bookkeeping, not motion.
 *
 * This is invariant 20 in a new place. Anything that repositions a body has to do it
 * through velocity and let the integrator carry it — and a network correction is the one
 * thing that legitimately cannot, so it must at least not be mistaken for travel.
 */
export function applySnapshot(sim, state, localSeat = 0) {
  const t = sim.trampler;
  const d = sim.director;
  sim.resetId = state.resetId ?? sim.resetId ?? 0;

  // ANYBODY ABOARD IS CARRIED BY THE CORRECTION, AND THIS IS NOT OPTIONAL.
  //
  // Measured before it was written: a one-metre hull correction moved a standing operative
  // 114 cm across the deck. The reason is that a correction relocates the DECK while
  // leaving the player's world position alone, so their deck-relative position shifts by
  // the whole correction — they slide toward the stern by however wrong the prediction was,
  // several times a second.
  //
  // The right answer is invariant 5 restated: what is anchored to the hull is stored in
  // hull space and read back out through the hull's current transform. Someone standing on
  // the deck is anchored to it. So their hull-local position is the ground truth across a
  // correction, and their world position is the thing that has to move.
  //
  // Note this is the SAME conversion `Player.#applyBasedMovement` performs for real hull
  // motion — express in the old frame, read out of the new one. A correction is not motion,
  // which is why it must not go through the prev-frame capture (see the ordering note in
  // this function's docstring); but it is a change of frame, and a change of frame has to
  // carry its passengers either way.
  let correctionYaw = (state.hullYaw - t.yaw) % (Math.PI * 2);
  if (correctionYaw > Math.PI) correctionYaw -= Math.PI * 2;
  if (correctionYaw < -Math.PI) correctionYaw += Math.PI * 2;

  const riders = [];
  for (const p of sim.crew) {
    if (!p || p.base !== t) continue;
    riders.push({ who: p, local: t.worldToLocal(p.position.clone()) });
  }

  t.group.position.x = state.hullX;
  t.group.position.z = state.hullZ;
  t.yaw = state.hullYaw;
  t.time = state.gait;
  t.group.rotation.y = t.yaw;
  // y is DERIVED, not transmitted: deck height plus a bob read off the gait phase. Sending
  // it would be sending the same fact twice and inviting the copies to disagree. The
  // expression is duplicated from Trampler.update, which is a real cost — if the bob ever
  // changes shape, this has to follow. Cheaper than a field that can contradict itself.
  t.group.position.y = CFG.trampler.deckHeight + (CFG.trampler.bob
    ? Math.sin(t.time * CFG.trampler.bobSpeed * Math.PI * 2) * CFG.trampler.bobAmount
    : 0);

  for (let i = 0; i < t.legHp.length && i < state.legHp.length; i++) {
    t.legHp[i] = state.legHp[i];
  }
  t.reactorHp = state.reactorHp;
  t.driveScale = state.driveScale;
  t.turnScale = state.turnScale;

  const hb = unpackHullBits(state.hullBits);
  t.walking = hb.walking;
  t.turning = hb.turning;
  t.destroyed = hb.destroyed;

  // THE TRANSFORM MUST BE REFRESHED HERE, and forgetting it is the single easiest way to
  // make this whole layer subtly wrong. Every hull-local read — a grapple anchor, a repair
  // point, a boarder's deck position, a crewmate's avatar — goes through `matrix` and
  // `matrixInverse`. Writing the pose without recomputing them leaves every one of those
  // reading last frame's fortress, which presents as everything aboard lagging the hull by
  // one correction rather than as a transform bug.
  t.group.updateMatrixWorld(true);
  t.matrix.copy(t.group.matrixWorld);
  t.matrixInverse.copy(t.matrix).invert();

  // And the previous-frame transform is set to the CURRENT one, so the correction reads as
  // zero displacement to anything asking "how far did the hull move". See the note above
  // on ordering: this is the belt to that braces.
  t.prevMatrixInverse.copy(t.matrixInverse);
  t.prevPos.copy(t.group.position);

  // Passengers back out through the corrected transform, so they are still standing exactly
  // where on the deck they were standing. Position is not the only hull-relative fact:
  // Player velocity and facing are stored in world axes even while position is based, so a
  // correction that turns the deck must rotate both exactly as Player.#applyBasedMovement
  // does for real hull motion. Omitting that leaves the camera in the old frame; the next ack
  // then sees a fabricated local-yaw error.
  const c = Math.cos(correctionYaw);
  const s = Math.sin(correctionYaw);
  for (const r of riders) {
    r.who.position.copy(t.localToWorld(r.local));
    if (correctionYaw === 0) continue;
    r.who.yaw += correctionYaw;
    const vx = r.who.velocity.x;
    const vz = r.who.velocity.z;
    r.who.velocity.x = vx * c + vz * s;
    r.who.velocity.z = -vx * s + vz * c;
  }

  // NOT DONE HERE, and it will matter in slice 2: bodies with `onHull` or `latched` are
  // stored in WORLD space and are carried by the same conversion inside Horde.update. The
  // horde is not shared yet, so a client's boarders are its own business; once it is, they
  // need exactly this treatment or every latched chewer slides down the leg on each
  // correction.

  d.elapsed = state.elapsedMs / 1000;
  d.wave = state.wave;
  d.resolved = state.resolved;
  d.timer = state.phaseTimer;
  d.arcOffset = state.arcOffset;

  const pb = unpackPhaseBits(state.phaseBits);
  d.phase = pb.phase;
  d.calledEarly = pb.calledEarly;
  sim.run.phase = pb.runPhase;
  sim.run.leg = state.runLeg;
  d.siegeLength = sim.run.siegeLength;
  d.run = sim.run;
  sim.run.seenResolved = d.resolved;

  sim.run.threatScale = state.threatScale;
  sim.run.extraCount = state.extraCount;
  sim.run.fogScale = state.fogScale;
  sim.horde.speedScale = state.speedScale;
  sim.world.setFogScale(state.fogScale);

  sim.treasury.scrap = state.treasuryScrap;
  sim.treasury.earnedScrap = state.treasuryEarnedScrap;
  sim.treasury.moduleCredits = state.moduleCredits;

  const routes = CFG.run.routes;
  const history = (state.roadHistory ?? [])
    .map((encoded) => routes[encoded - 1]?.id)
    .filter(Boolean);
  const historyChanged = history.length !== sim.run.history.length
    || history.some((id, i) => id !== sim.run.history[i]);
  sim.run.history.splice(0, sim.run.history.length, ...history);
  sim.run.offers = (state.roadOffers ?? [])
    .map((encoded) => routes[encoded - 1])
    .filter(Boolean);
  sim.run.road = history.length > 0
    ? routes.find((road) => road.id === history[history.length - 1]) ?? null
    : null;
  if (historyChanged) {
    const road = sim.run.road;
    sim.run.lastArrival = road ? {
      name: road.name,
      detail: road.detail,
      road,
      salvage: road.salvage,
      scrap: road.scrap,
      module: !!road.module,
      leg: sim.run.leg,
      boss: sim.run.isBossLeg,
    } : null;
  }
  sim.run.setAuthorityVotes(state.operatives?.length ?? 0, state.roadVotes ?? []);

  const socketIds = (state.moduleSockets ?? [])
    .map((encoded) => CFG.fortress.catalogue[encoded - 1]?.id ?? null);
  sim.modules.restore(socketIds);
  // Module restoration may resize the reactor and recompute drive multipliers. The wire is
  // the final authority on their current values, so re-apply them after rebuilding effects.
  t.reactorHp = state.reactorHp;
  t.driveScale = state.driveScale;
  t.turnScale = state.turnScale;

  if (state.hordeDeaths !== sim.horde.deathCount) {
    sim.horde.lastKill = {
      x: state.lastDeathX,
      y: state.lastDeathY,
      z: state.lastDeathZ,
      type: state.lastDeathType,
      paid: (state.lastDeathBits & 1) !== 0,
    };
  }
  sim.horde.killCount = state.hordeKills;
  sim.horde.deathCount = state.hordeDeaths;

  applyProgression(sim, state);
  applyGuns(sim, state, localSeat);
  applyEmitters(sim, state);

  // The horde LAST, and after the transform has been refreshed above, because a carried
  // body's hull-local position is read out through it. Applied before the transform it would
  // place every boarder against the previous correction's fortress.
  if (state.entities) applyEntities(sim, state.entities);
  if (state.operatives) applyOperatives(sim, state.operatives, localSeat);
}

/**
 * Write the crew's authoritative state into a client's operatives.
 *
 * `localSeat` is the one seat NOT overwritten, and that exclusion is the whole of client
 * prediction. This operative is being simulated locally from live input so the controls feel
 * immediate; snapping it to a position 120 ms old would undo exactly the thing prediction
 * exists to provide, and would do it twenty times a second.
 *
 * Reconciliation — replaying the inputs the server has not yet acknowledged, and smoothing the
 * residual — is slice 3b. Until then the local operative is predicted and NOT corrected, which
 * is honest about what is built: the server is still the authority on damage and on what
 * everybody else sees, and a client that walks somewhere the server disagrees with will find
 * out when it stops being able to act there.
 */
export function applyOperatives(sim, wire, localSeat = 0) {
  const t = sim.trampler;
  for (const w of wire) {
    const op = sim.operatives.find((candidate) => candidate.seat === w.seat);
    if (!op) continue;
    op.ackSeq = w.ackSeq;
    op.ackPose = {
      x: w.ackX, y: w.ackY, z: w.ackZ,
      yaw: w.ackYaw, pitch: w.ackPitch, bits: w.ackBits,
    };
    if (w.seat === localSeat) continue;

    const p = op.player;
    const b = unpackOperativeBits(w.bits);
    p.hp = w.hp;
    p.hurtCount = w.hurtCount;
    p.deaths = w.deaths;
    if (op.weapon) op.weapon.kills = w.kills;

    // The same frame rule, read back out through the hull's CURRENT transform. `base` is set
    // directly rather than through `attachTo()`, and that is deliberate: `attachTo` converts
    // stored velocity between frames, and converting a remote operative's velocity — which
    // this client does not track — would inject the hull's speed as a phantom kick. The
    // project has fixed that exact bug three times in three places.
    if (b.based) {
      p.base = t;
      _enc.set(w.x, w.y, w.z);
      t.localToWorld(_enc);
      p.position.copy(_enc);
      p.yaw = w.yaw + t.yaw;
    } else {
      p.base = null;
      p.position.set(w.x, w.y, w.z);
      p.yaw = w.yaw;
    }
    p.pitch = w.pitch;
    p.grounded = b.grounded;
    if (!b.repairing) p.repairing = null;
    // Zeroed rather than integrated. A remote operative's motion comes entirely from the next
    // snapshot, so a non-zero velocity here would be a second source of movement fighting the
    // first — and would drift between packets.
    p.velocity.set(0, 0, 0);
    p.station = b.station > 0 ? (sim.guns[b.station - 1] ?? null) : null;
  }
}

/**
 * One step of a CLIENT's simulation: everything except the parts the server owns.
 *
 * WHAT IS OMITTED, AND WHY EACH ONE WOULD BE A BUG:
 *
 *   `director.update`  would advance a phase and a timer the snapshot overwrites, and would
 *                      SPAWN bodies the server has not spawned — which then vanish on the
 *                      next correction. Two spawners for one horde.
 *   `horde.update`     would run enemy AI over positions it was just handed, immediately
 *                      disagreeing with the authority and being corrected 20 times a second.
 *                      That is rubber-banding, and it is the relay's failure at a smaller
 *                      scale.
 *   `resolveStomps`    resolves footfalls against bodies, deals damage and pays income. All
 *                      three belong to the authority; a client doing it locally would kill
 *                      things that are alive on the server.
 *   `run.update`       advances legs and offers picks, which is run state the server owns.
 *
 * WHAT IS KEPT is everything about THIS operative: their movement, their winch, their
 * weapon's own cooldowns and aim scan, their repair progress, their items' conditional
 * bonuses. Those are predicted locally so the controls stay responsive, which is the entire
 * point of client prediction — and slice 3 is where they start being reconciled rather than
 * merely predicted.
 *
 * `trampler.update` IS kept, because the fortress consumes no input and is therefore
 * predictable exactly rather than approximately. See structure.md on predicting the hull.
 */
export function stepSessionClient(sim, dt) {
  const { input } = sim;
  const op = sim.operatives.find((candidate) => candidate.player === sim.player)
    ?? sim.operatives[0];

  sim.trampler.update(dt);
  handleStationInput(sim.guns, input, sim.player);
  sim.grapple.handleInput(input);
  sim.player.update(dt, input);
  sim.weapon.update(dt, input);
  for (const g of sim.guns) g.update(dt, input, sim.player, sim.weapon);
  sim.repair.update(dt, input);
  sim.emitters.updateClient(dt, sim.player);
  sim.items.update(dt);

  // The edge is predicted for an immediate panel response, but purchases, votes, picks and
  // placement remain server-only and arrive in the next snapshot.
  if (op && input.pressed(CFG.fortress.toggleKey)) op.bayOpen = !op.bayOpen;
  if (op && (sim.run.choosing || sim.run.picking)) op.bayOpen = false;
  sim.economy.lastEvent = null;
  sim.grapple.update(dt);
  input.endFrame();
}

/**
 * How far the local prediction has drifted from the authority, and what to do about it.
 *
 * A PURE FUNCTION over numbers, so the harness can drive every branch without a socket.
 *
 * WHAT THIS DOES NOT DO, stated first because the omission is the design decision. It does not
 * REPLAY. The textbook reconciliation keeps every unacknowledged input, rewinds the operative to
 * the server's last acknowledged position, and re-simulates forward — which for this game means
 * re-running collision against a hull that has since moved, for every frame in flight, every
 * time a packet lands. That is a real amount of machinery and it buys exactness in a situation
 * the exactness may not be needed: the local operative is mostly walking on a flat deck, where
 * prediction and authority agree to within a rounding error.
 *
 * So this measures the disagreement instead and smooths it away, and reports the size so the
 * question "is replay needed" becomes a measurement rather than an argument. If the residual
 * turns out to be large in play, replay is the answer and the input history it needs is already
 * being kept.
 *
 * THREE BANDS, because one threshold cannot serve two purposes:
 *
 *   under `deadZone`   ignored outright. Quantisation is 1 cm on each axis, so a correction
 *                      chasing that would fight the wire's own precision forever.
 *   under `snapAt`     smoothed, by handing back an offset the caller decays over several
 *                      frames. Invariant 20's rule applies to the local operative as much as
 *                      to an enemy: anything that repositions a body instantly reads as a
 *                      teleport.
 *   at or over         snapped. Past a couple of metres the prediction is not slightly wrong,
 *                      it is wrong about what happened — refused by a station, blocked by
 *                      geometry, killed and respawned — and smoothing toward the truth would
 *                      drag the player visibly across the deck instead of putting them where
 *                      they are.
 */
export function reconcile(predicted, authoritative, {
  deadZone = 0.03,
  snapAt = 2.0,
} = {}) {
  const dx = authoritative.x - predicted.x;
  const dy = authoritative.y - predicted.y;
  const dz = authoritative.z - predicted.z;
  const error = Math.hypot(dx, dy, dz);

  if (!Number.isFinite(error)) return { action: "snap", error: 0, dx: 0, dy: 0, dz: 0 };
  if (error < deadZone) return { action: "none", error, dx: 0, dy: 0, dz: 0 };
  if (error >= snapAt) return { action: "snap", error, dx, dy, dz };
  return { action: "smooth", error, dx, dy, dz };
}

/**
 * How far apart two hulls are, for reporting and for tests.
 *
 * Returned as a breakdown rather than one number because the three components have
 * different causes: position drift is integration, yaw drift is the turn rate, and gait
 * drift is the phase accumulator. A single distance would hide which one is wrong.
 */
export function hullDivergence(a, b) {
  const pa = a.trampler.group.position;
  const pb = b.trampler.group.position;
  let dYaw = (b.trampler.yaw - a.trampler.yaw) % (Math.PI * 2);
  if (dYaw > Math.PI) dYaw -= Math.PI * 2;
  if (dYaw < -Math.PI) dYaw += Math.PI * 2;
  return {
    position: Math.hypot(pb.x - pa.x, pb.z - pa.z),
    yaw: Math.abs(dYaw),
    gait: Math.abs(b.trampler.time - a.trampler.time),
    elapsed: Math.abs(b.director.elapsed - a.director.elapsed),
  };
}

/** The run phases, re-exported so a consumer needs one import rather than two. */
export { RUN };
