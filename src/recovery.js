import { CFG } from "./config.js";

// Incapacitation is shared simulation state. This module owns the part that is
// ABOUT more than one operative: who is close enough to recover whom, which seat
// wins a simultaneous hold, and whether the medevac clock or a recovery completes
// first. Player owns the lifecycle at either end of that decision.

const LOCKED_INPUT = Object.freeze({
  locked: false,
  networked: false,
  down: () => false,
  pressed: () => false,
  mouseDown: () => false,
  mousePressed: () => false,
  mouse: Object.freeze({ dx: 0, dy: 0 }),
  endFrame() {},
});

// A contender who held E for a body somebody else won has still committed their
// carried trigger for this command, but they are not channeling and must remain
// free to move. Cache one delegating view per physical input so this arbitration
// adds no per-frame allocation.
const HANDS_INPUTS = new WeakMap();

function handsInputFor(input) {
  if (!input || typeof input !== "object") return LOCKED_INPUT;
  let routed = HANDS_INPUTS.get(input);
  if (routed) return routed;
  routed = {
    get locked() { return !!input.locked; },
    get networked() { return !!input.networked; },
    get mouse() { return input.mouse; },
    down(code) {
      return code !== CFG.repair.key && !!input.down?.(code);
    },
    pressed(code) { return !!input.pressed?.(code); },
    isPressed(code) { return !!input.isPressed?.(code); },
    mouseDown: () => false,
    mousePressed: () => false,
    isMousePressed: () => false,
    endFrame() {},
  };
  HANDS_INPUTS.set(input, routed);
  return routed;
}

const playerOf = (entry) => entry?.player ?? null;

function rosterOf(operatives, targets) {
  const bySeat = new Map();
  for (const entry of [...(operatives ?? []), ...(targets ?? [])]) {
    const seat = Number(entry?.seat);
    // Seat zero is the browser's provisional pre-lobby identity. It may own its
    // solo medevac clock, but cannot win a teammate claim until the lobby assigns
    // the positive numeric seat used on the wire.
    if (!Number.isInteger(seat) || seat < 0 || !playerOf(entry)) continue;
    // The local/real operative wins if a caller accidentally supplies the same
    // seat as an external target too.
    if (!bySeat.has(seat) || !entry.remote) bySeat.set(seat, entry);
  }
  return [...bySeat.values()].sort((a, b) => a.seat - b.seat);
}

function held(entry) {
  return !!entry?.input?.down?.(CFG.repair.key);
}

function canApproach(owner, target) {
  const p = playerOf(owner);
  const down = playerOf(target);
  if (!p || !down || p === down || p.downed || !down.downed) return false;
  if (p.station || p.grapple?.active || p.mantle?.active) return false;
  const dx = p.position.x - down.position.x;
  const dy = p.position.y - down.position.y;
  const dz = p.position.z - down.position.z;
  return dx * dx + dy * dy + dz * dz < CFG.combat.recovery.range ** 2;
}

function clearClaim(target) {
  const p = playerOf(target);
  if (!p) return;
  p.rescuerSeat = 0;
  p.recoveryProgress = 0;
}

function activate(owner, target) {
  const p = playerOf(owner);
  const down = playerOf(target);
  if (!p || !down) return;
  down.rescuerSeat = owner.seat;
  p.recovering = true;
  p.recoveryTarget = target;
  p.recoveryTargetProgress = down.recoveryProgress;
  // Recovery owns the operative's feet as well as their hands. Zeroing the
  // horizontal component immediately avoids one last frame of coast after E wins.
  p.velocity.x = 0;
  p.velocity.z = 0;
  p.jumpQueued = 0;
}

function nearestTarget(owner, roster) {
  const p = playerOf(owner);
  let free = null;
  let freeD2 = Infinity;
  let any = null;
  let anyD2 = Infinity;

  for (const target of roster) {
    if (!canApproach(owner, target)) continue;
    const down = playerOf(target);
    const dx = p.position.x - down.position.x;
    const dy = p.position.y - down.position.y;
    const dz = p.position.z - down.position.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < anyD2) {
      any = target;
      anyD2 = d2;
    }
    if (down.rescuerSeat === 0 && d2 < freeD2) {
      free = target;
      freeD2 = d2;
    }
  }
  // A free body beats a closer body somebody is already recovering. If every
  // body is claimed, still expose the nearest one so the prompt can name its owner.
  return free ?? any;
}

/**
 * Set the delay a future incapacitation will receive.
 *
 * Existing downed clocks are never rewritten when somebody joins or leaves. The
 * delay is decided when the operative goes down; changing it halfway through would
 * make a disconnect silently take four seconds away from somebody already waiting.
 */
export function configureRecovery(operatives, targets = []) {
  const crewSize = rosterOf(operatives, targets).length;
  const delay = crewSize > 1
    ? CFG.combat.recovery.multiplayerMedevac
    : CFG.combat.recovery.soloMedevac;
  for (const entry of operatives ?? []) {
    const p = playerOf(entry);
    if (!p) continue;
    p.recoveryHasCrew = crewSize > 1;
    if (!p.downed) p.recoveryDelay = delay;
  }
  return delay;
}

/**
 * Resolve recovery intent once for this fixed step.
 *
 * `operatives` are locally simulated actors with inputs. `targets` are optional
 * snapshot-fed remote actors: they can be selected and can own an authoritative
 * claim, but they never originate a new locally invented claim. With
 * `authoritative: false`, clocks and progress are predicted for presentation while
 * lifecycle transitions wait for the next snapshot.
 */
export function stepRecovery(
  operatives,
  dt,
  { targets = [], authoritative = true } = {},
) {
  configureRecovery(operatives, targets);
  const roster = rosterOf(operatives, targets);
  const bySeat = new Map(roster.map((entry) => [entry.seat, entry]));

  for (const entry of roster) {
    const p = playerOf(entry);
    p.autoMedevac = false;
    p.recovering = false;
    p.recoveryTarget = null;
    p.recoveryTargetProgress = 0;
    p.recoveryHeld = held(entry);
    if (!p.downed) {
      p.medevacRemaining = 0;
      p.recoveryProgress = 0;
      p.rescuerSeat = 0;
    }
  }

  // Preserve a valid prior owner before considering new holds. This is what stops
  // two people beside one body from stealing the channel from each other every tick.
  for (const target of roster) {
    const down = playerOf(target);
    if (!down.downed || down.rescuerSeat <= 0) continue;
    const owner = bySeat.get(down.rescuerSeat);
    const valid = owner && (owner.remote
      ? !playerOf(owner).downed
      : held(owner) && canApproach(owner, target));
    if (!valid) {
      clearClaim(target);
      continue;
    }
    activate(owner, target);
  }

  // New claims resolve in numeric seat order, independent of socket arrival or
  // sparse roster order. Strict distance comparisons leave exact ties in target
  // seat order, which is deterministic too.
  const owners = [...(operatives ?? [])].sort((a, b) => a.seat - b.seat);
  for (const owner of owners) {
    const p = playerOf(owner);
    if (owner.seat <= 0 || !p || p.downed || p.recovering) continue;
    const target = nearestTarget(owner, roster);
    if (!target) continue;

    p.recoveryTarget = target;
    p.recoveryTargetProgress = playerOf(target).recoveryProgress;
    if (held(owner) && playerOf(target).rescuerSeat === 0) activate(owner, target);
  }

  for (const target of roster) {
    const down = playerOf(target);
    if (!down?.downed) continue;

    const owner = bySeat.get(down.rescuerSeat);
    const active = !!owner
      && playerOf(owner).recovering
      && playerOf(owner).recoveryTarget === target;

    down.medevacRemaining = Math.max(0, down.medevacRemaining - dt);
    if (active) {
      down.recoveryProgress = Math.min(
        CFG.combat.recovery.recoverTime,
        down.recoveryProgress + dt,
      );
      playerOf(owner).recoveryTargetProgress = down.recoveryProgress;
    }

    if (down.recoveryProgress >= CFG.combat.recovery.recoverTime) {
      if (authoritative && !target.remote) {
        // Keep `owner.recovering` true until the next step resets the ephemeral
        // field, so the final channel frame cannot also fire or move.
        down.recoverInPlace();
      }
      continue;
    }

    // Reaching zero during an uninterrupted channel grants exactly the grace the
    // channel needs: the clock stays at zero and the recovery may finish. Releasing
    // E or leaving range clears the claim next step and medevacs immediately.
    if (down.medevacRemaining <= 0 && !active && authoritative && !target.remote) {
      down.medevac();
    }
  }
}

/** Cancel every claim owned by a departing seat immediately. */
export function clearRecoverySeat(operatives, seat, targets = []) {
  const roster = rosterOf(operatives, targets);
  for (const target of roster) {
    const p = playerOf(target);
    if (p?.rescuerSeat === seat) clearClaim(target);
  }
  const owner = roster.find((entry) => entry.seat === seat);
  const p = playerOf(owner);
  if (p) {
    p.recovering = false;
    p.recoveryTarget = null;
    p.recoveryTargetProgress = 0;
    p.recoveryHeld = false;
  }
}

/** Input seen by gameplay systems after recovery has arbitrated this frame. */
export function recoveryInputFor(player, input) {
  if (player?.downed || player?.recovering) return LOCKED_INPUT;
  // A losing contender committed their hands but did not win ownership. Suppress
  // repair/fire for this command without freezing their feet as though they did.
  if (player?.recoveryHeld && player?.recoveryTarget) return handsInputFor(input);
  return input;
}
