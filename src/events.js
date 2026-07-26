import { CFG } from "./config.js";

// The event bus, and it is deliberately tiny.
//
// This exists because item procs need things a poll cannot reconstruct. Most of
// this codebase publishes a COUNTER and lets readers poll it -- fx.js and audio.js
// both work that way, and it is the right pattern there, because "how many
// footfalls since last frame" is all a dust puff needs to know.
//
// Two moments do not fit that pattern:
//
//   kill -- which enemy, of what type, where it stood, and whether a player
//           earned it. Several can happen in one frame and a counter loses all of
//           them but the last.
//   hit  -- which enemy took how much. Same problem, more often.
//
// Everything else an item might want is already a pollable state change and is
// deliberately NOT here:
//
//   boarding      `player.base` is readable, and a transition is one comparison
//                 against last frame's value. Threading an event through Player
//                 would also have missed the direct `this.base = null` writes in
//                 the mantle and drop paths, which is a bug waiting to happen.
//   repair done   `repair.completions` is a counter, and at most one repair can
//                 finish in a frame.
//   wave resolved `director.resolved` already exists.
//   arrival       `run.lastArrival` already exists.
//
// So: two channels, not a general pub/sub. A bus that can carry anything ends up
// carrying things that would have been better as state.

/** Named arrays rather than a Map keyed by channel name.
 *
 * A string-keyed bus is more extensible and strictly worse here, because both of
 * its failure modes are silent: a misspelled channel in `on()` registers a
 * listener that is never called, and a misspelled channel in `emit()` fires into
 * nothing. Neither throws, neither logs, and both look like "the item does not
 * work". With named methods a typo is a TypeError at the call site.
 */
export class Events {
  constructor() {
    this.killListeners = [];
    this.hitListeners = [];

    // Guards proc chains. An item that deals damage on kill can kill something,
    // which fires the same listener again -- unbounded recursion from two
    // perfectly reasonable items combining. Depth is capped rather than forbidden
    // because a chain of two or three IS the appeal; it is only the unbounded case
    // that is a crash.
    this.depth = 0;
    this.deepest = 0;      // diagnostic: how far chains actually got
    this.suppressed = 0;   // and how often the cap had to bite
  }

  onKill(fn) {
    this.killListeners.push(fn);
  }

  onHit(fn) {
    this.hitListeners.push(fn);
  }

  /**
   * An enemy died and somebody earned it.
   *
   * Fired from Horde's single kill choke point, so it covers the rifle, both deck
   * guns, a shock emitter and a foot coming down without any of them knowing.
   * Deliberately NOT fired for an unpaid removal -- a sapper consumed by its own
   * charge is not a kill, and an on-kill item should not reward failing to stop it.
   *
   * `source` names what killed it: "player" for anything the crew aimed, "emitter"
   * for automation. Item procs must gate on it, because a proc that fires for an
   * emitter kill is automation compounding itself with nobody present, which is
   * invariant 2b failing quietly. The economy ignores it and pays either way.
   */
  emitKill(enemy, source = null) {
    if (this.depth >= CFG.events.maxProcDepth) {
      this.suppressed++;
      return;
    }
    this.depth++;
    if (this.depth > this.deepest) this.deepest = this.depth;
    try {
      // Indexed rather than for..of: this runs inside the damage path, and a
      // listener that registers another listener mid-iteration would otherwise
      // change what is being walked.
      const list = this.killListeners;
      for (let i = 0; i < list.length; i++) list[i](enemy, source);
    } finally {
      // finally, so a throwing item cannot leave the depth counter stuck high and
      // silently disable every proc for the rest of the run.
      this.depth--;
    }
  }

  /**
   * A shot connected.
   *
   * `damage` is what the SHOT was worth, before the target's armour — it is the
   * number `shootFrom` computed from the weapon profile and the player's multipliers,
   * not what the health bar actually lost. Stated precisely because the difference is
   * load-bearing for the arc caster, which chains a share of it: against a bulwark
   * the chain is a share of 25, not of the 5 that got through. That is defensible (a
   * proc off a heavy hit should be a heavy proc, and the arc's own damage still goes
   * through `Horde.damage`, so the SECOND target's armour applies normally) but it is
   * not obvious, and a reader assuming otherwise would tune the wrong number.
   */
  emitHit(enemy, damage) {
    if (this.depth >= CFG.events.maxProcDepth) {
      this.suppressed++;
      return;
    }
    this.depth++;
    if (this.depth > this.deepest) this.deepest = this.depth;
    try {
      const list = this.hitListeners;
      for (let i = 0; i < list.length; i++) list[i](enemy, damage);
    } finally {
      this.depth--;
    }
  }
}
