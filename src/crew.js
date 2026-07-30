// The crew: one to four operatives, and the queries the simulation asks ABOUT them
// rather than of any one of them.
//
// WHY THIS IS SMALLER THAN IT LOOKS
//
// A survey of every `player` touch in the simulation found that almost all of them
// are about ONE SPECIFIC PERSON: this operative pressed the key, is sitting in this
// mount, is doing this repair, owns this purse. Those do not become crew queries --
// in co-op they become one instance per operative, which is a separate and much
// larger change (Weapon, Grapple, Repair, Items and the station all being per-person).
//
// Four places ask about the crew as a GROUP, and they are the places where "there are
// four people in the world" actually means something:
//
//   1. Horde.update -- contact damage. Anything adjacent hurts whoever is adjacent.
//   2. Trampler.resolveStomps -- a foot coming down crushes whoever is under it.
//   3. Director.#pressureOf -- how much trouble the crew is in, which paces the waves.
//   4. Repair -- whether somebody ELSE is already working this point, and which seat
//      they are, so the refusal can name them.
//
// The fourth is worth noting as the shape the others will take. Repair itself is
// per-operative -- one instance each, holding one Player -- and what it needs from here
// is not an aggregate but a ROSTER: who exists, and in what order. Membership is the
// crew's own business, so an operative who leaves takes their claims with them without
// anybody having to release anything.
//
// So this class is deliberately thin. It is not an entity manager and it must not
// become one: anything that belongs to a single operative belongs on that Player.
//
// AT ONE MEMBER EVERY QUERY HERE REDUCES TO THE OLD EXPRESSION, exactly. That is the
// acceptance test for this change -- the suite's output has to be byte-identical --
// and it is why the aggregates are written as folds over the array rather than as
// anything cleverer.

export class Crew {
  constructor(members = []) {
    /** @type {Array<object>} in join order; index 0 is the primary. */
    this.members = [];
    /** Stable lobby seat labels, independent of array position. */
    this.seats = new Map();
    for (const member of members) this.add(member);
  }

  get size() {
    return this.members.length;
  }

  /**
   * The first operative.
   *
   * Not "the important one" -- it is the anchor for the things that are still
   * singular while the rest of the refactor is outstanding, and for the harness,
   * whose 800-odd assertions all speak about one person. Every use of this is a
   * place that will eventually need to name WHICH operative it means, so it is worth
   * being able to find them all by searching for the word.
   */
  get primary() {
    return this.members[0] ?? null;
  }

  /** Iterating a Crew iterates its members, so `for (const p of crew)` reads right. */
  [Symbol.iterator]() {
    return this.members[Symbol.iterator]();
  }

  /**
   * Which stable lobby seat an operative owns. 0 means "not in this crew".
   *
   * This cannot be derived from the array index: a running roster may legitimately be
   * [1, 3] after seat 2 disconnects, and renaming seat 3 to seat 2 would move repair
   * claims and road votes onto the wrong person. Membership order decides deterministic
   * tie-breaking; the explicit seat map decides identity.
   */
  seatOf(player) {
    return this.seats.get(player) ?? 0;
  }

  add(player, requestedSeat = null) {
    if (this.members.includes(player)) return player;

    const used = new Set(this.seats.values());
    let seat = requestedSeat;
    if (seat === null || seat === undefined) {
      seat = 1;
      while (used.has(seat)) seat++;
    }
    if (!Number.isInteger(seat) || seat < 1 || used.has(seat)) {
      throw new Error(`invalid or occupied crew seat ${seat}`);
    }

    this.members.push(player);
    this.seats.set(player, seat);
    return player;
  }

  remove(player) {
    const i = this.members.indexOf(player);
    if (i < 0) return false;
    this.members.splice(i, 1);
    this.seats.delete(player);
    return true;
  }

  // ------------------------------------------------------------------ aggregates
  //
  // THE CHOICE OF AGGREGATOR IS A DESIGN DECISION AND IT IS NOT SETTLED HERE.
  //
  // At one member, min, max and mean are all the same number, so nothing below is
  // observable yet and nothing in the suite can distinguish them. That is precisely
  // why the choice must not be treated as made: the moment there are two operatives,
  // "how hurt is the crew" becomes a real question with real consequences for pacing
  // (invariant 19), and it needs measuring rather than deciding.
  //
  // Worst-case is the STARTING POSITION, on the argument that Left 4 Dead's director
  // responds to whoever is in trouble rather than to an average that hides them. The
  // opposite case is arguable for the recent-hurt term, where "somebody was hit in
  // the last two seconds" is nearly always true in a crowd of four and would peg the
  // pressure term permanently. Both are for the pressure-aggregation change to
  // measure with a real crew, not for this one to assume.

  /**
   * The health fraction of the WORST-OFF operative, 0..1.
   *
   * Empty crew returns 1, meaning "nobody is hurt". That is the correct reading for
   * pacing -- an empty crew is not in trouble -- and it also keeps a crewless
   * director from dividing by nothing, which the harness relies on for the tests that
   * construct a director with no scenario around it.
   */
  worstHealthFraction() {
    let worst = 1;
    for (const p of this.members) {
      if (!p || !(p.maxHp > 0)) continue;
      const f = p.hp / p.maxHp;
      if (f < worst) worst = f;
    }
    return worst;
  }

  /**
   * Seconds since ANY operative was last hurt.
   *
   * The minimum, so it reads "somebody was hit this recently". A large default for an
   * empty crew, matching the Player's own initial 99.
   */
  secondsSinceAnyHurt() {
    let soonest = Infinity;
    for (const p of this.members) {
      if (!p) continue;
      if (p.timeSinceHurt < soonest) soonest = p.timeSinceHurt;
    }
    return soonest === Infinity ? 99 : soonest;
  }
}
