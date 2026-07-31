import { CFG } from "./config.js";
import { makeRandom } from "./util.js";

// The run: legs of a journey, a siege at each landmark, a boss at the end.
//
// Until this existed a siege WAS the game. That gave the prototype a finish line
// but no arc, which quietly broke the economy: you buy a rifle stack, hold five
// waves, and then nothing happens. Upgrades only mean something if there is a
// later fight to spend them in, and a boss only means something if you arrive at
// it carrying whatever you chose to build.
//
// Structure. Four phases, and that is the whole machine:
//
//   SIEGE    -> the director runs a siege at the landmark.
//   PICKING  -> the siege is HELD; a free pick of three items is offered.
//   CHOOSING -> the pick is taken; two roads are offered and the crew picks one.
//   DONE     -> the biome is cleared.
//
// PICKING and CHOOSING are SEQUENTIAL, never simultaneous. Two menus on one screen
// at the same moment is unreadable, and the number keys already had three contenders
// before the pick existed, which is why test 86 exists at all.
//
// There is deliberately NO travel phase, and this list used to claim one. The
// choice IS the travel: there is no walking minigame, because the interesting part
// of "which way do we go" is the trade, not the walking. The window a travel phase
// would have provided already exists as the director's own rest phase, which is
// when buying is open anyway -- so a fourth state would have duplicated it while
// looking, to anyone reading the header, like a feature that had been built.
//
// It was in fact declared, documented here, and never assigned or read by anything.
// Removed rather than wired: a state machine that describes more states than it has
// is worse than a small one, because the next person to touch it plans around a
// phase that does not exist. The inverse is just as bad and this header briefly had
// it — PICKING was added to the enum while the list above still said three.
//
// One deliberate constraint: ordinary progression never advances on a timer. A finished
// siege waits for the crew to choose its road, and a personal pick waits indefinitely while
// the siege is still live. The sole exception is the anti-deadlock boundary between them: once
// a held siege is waiting only on personal picks, a visible deadline takes slot 1 for any
// connected operative who never answers. Without it one AFK socket owns the whole crew's run.

/**
 * What a road costs and what it pays, as text.
 *
 * Exported and shared because two places need it and they must not drift: the route
 * panel, which describes a road you have not taken yet, and the arrival banner, which
 * has to say what the road you just took actually DID.
 *
 * The banner used to name only the payout — "+20 salvage, +60 scrap" — and say nothing
 * about the cost, which is half of why a playtester asked "when I press one, does it
 * matter? it seems like it just went next." It did matter. Nothing told them.
 */
export function describeRoad(road) {
  const costs = [];
  if (road.threat > 1) costs.push(`+${Math.round((road.threat - 1) * 100)}% enemy health`);
  if (road.count > 0) costs.push(`+${road.count} per wave`);
  if (road.speed > 1) costs.push(`+${Math.round((road.speed - 1) * 100)}% enemy speed`);
  if (road.fog < 1) costs.push("visibility falls");
  if (costs.length === 0) costs.push("no added risk");

  const pays = [];
  if (road.salvage) pays.push(`${road.salvage} salvage`);
  if (road.scrap) pays.push(`${road.scrap} scrap`);
  if (road.module) pays.push("a free module");

  return { costs, pays };
}

export const RUN = {
  SIEGE: "siege",
  // Holding a siege pays a free item BEFORE the road choice, not alongside it.
  // Sequential rather than simultaneous for two reasons: two menus on one screen at
  // the same moment is unreadable, and the number keys already have three
  // contenders (refit panel, refit bay, road) which is why test 86 exists at all. A
  // fourth simultaneous owner is exactly the bug that test was written to catch.
  PICKING: "picking",
  CHOOSING: "choosing",
  DONE: "done",
};

export class Run {
  /**
   * @param economy pays arrival bonuses and owns the salvage pick offered on a hold.
   * @param crew    the roster the road is put to. At one member a vote is a keypress.
   */
  constructor(director, horde, economy = null, crew = null, seed = CFG.run.seed) {
    this.director = director;
    this.horde = horde;
    // One personal Economy per active operative, with their Treasury shared underneath.
    // `economy` remains the primary alias for old solo readers; progression always walks
    // `economies` so a reward cannot silently stop at seat 1.
    this.economies = economy ? [economy] : [];
    this.economy = economy;
    // Set only on snapshot-driven clients, whose local Crew intentionally contains just the
    // camera operative. The authority itself derives both values from the real roster.
    this.authorityCrewSize = null;
    this.authorityVoteSeats = null;
    // Needed for one question: how many operatives have to agree. Reached through the
    // crew rather than counted separately, because membership is the crew's business and
    // a second tally of who exists is a second thing to keep in step.
    this.crew = crew;
    this.seed = seed;
    this.reset();
  }

  addEconomy(economy) {
    if (economy && !this.economies.includes(economy)) this.economies.push(economy);
    this.economy = this.economies[0] ?? null;
    return economy;
  }

  removeEconomy(economy) {
    const i = this.economies.indexOf(economy);
    if (i >= 0) this.economies.splice(i, 1);
    this.economy = this.economies[0] ?? null;
    return i >= 0;
  }

  /** Snapshot-only vote view for a client that does not construct remote Players. */
  setAuthorityVotes(crewSize, packedVotes = []) {
    this.authorityCrewSize = Math.max(0, crewSize ?? 0);
    this.authorityVoteSeats = this.offers.map(() => []);
    for (const packed of packedVotes) {
      const seat = packed >> 2;
      const index = (packed & 0x03) - 1;
      if (seat > 0 && this.authorityVoteSeats[index]) {
        this.authorityVoteSeats[index].push(seat);
      }
    }
    for (const seats of this.authorityVoteSeats) seats.sort((a, b) => a - b);
  }

  clearAuthorityVotes() {
    this.authorityCrewSize = null;
    this.authorityVoteSeats = null;
  }

  reset() {
    this.clearAuthorityVotes();
    // Re-seeded on reset for the same reason the horde and the director are: the
    // point of the seeds is that two attempts at the same run are comparable, and
    // a stream that carried across a restart would hand the player a different
    // set of roads from the same seed.
    this.random = makeRandom(this.seed);

    this.leg = 1;
    this.phase = RUN.SIEGE;
    this.road = null;          // the road taken to get here
    this.offers = [];
    this.history = [];
    this.lastArrival = null;   // payout banner for the frame we arrived
    // Absolute director time, so the authority and every snapshot-driven client count down
    // from the same clock. Zero means no personal choice is blocking shared progression.
    this.pickDeadline = 0;
    // Ephemeral ownership fence for the exact frame a deadline resolves. A number key pressed
    // on that boundary belongs to the pick that just disappeared, never to the newly opened
    // road ballot or a panel underneath it. Cleared at the start of every Run.update().
    this.pickResolvedThisFrame = false;

    // Who has voted for which offered road. Keyed by the operative rather than by an
    // array position: membership order may close up after a disconnect, while the
    // operative object remains the identity that cast the vote. The stable seat map is
    // used only when the panel needs a label.
    /** @type {Map<object, number>} */
    this.votes = new Map();

    // Instance modifiers, never CFG edits. `threatScale` multiplies enemy health,
    // `extraCount` adds to every wave, and the horde's own speedScale is written
    // directly because that is where the horde reads it from.
    this.threatScale = 1;
    this.extraCount = 0;
    this.fogScale = 1;
    this.horde.speedScale = 1;

    // How many resolved waves have already been paid a pick. Polled against the
    // director rather than driven by a callback, the same way the economy watches
    // the same counter -- the director stays unaware that either exists.
    this.seenResolved = this.director?.resolved ?? 0;

    this.#configureSiege();
  }

  // ------------------------------------------------------------------ queries

  get isBossLeg() {
    return this.leg >= CFG.run.legs;
  }

  get legLabel() {
    return this.isBossLeg ? "FINAL LANDMARK" : `LANDMARK ${this.leg} OF ${CFG.run.legs}`;
  }

  get choosing() {
    return this.phase === RUN.CHOOSING;
  }

  get done() {
    return this.phase === RUN.DONE;
  }

  /** How long the siege at this landmark is. The boss leg is deliberately short. */
  get siegeLength() {
    return this.isBossLeg ? CFG.run.bossSiegeLength : CFG.waves.siegeLength;
  }

  /**
   * Is the wave now being released the boss wave?
   *
   * The titan arrives on the last wave of the last landmark. Read by the director
   * when it builds a wave, so the boss is part of the pacing rather than a
   * separate spawner that could fire during a rest phase.
   */
  isBossWave(wave) {
    return this.isBossLeg && wave >= this.siegeLength;
  }

  // ------------------------------------------------------------------ progress

  #configureSiege() {
    this.director.siegeLength = this.siegeLength;
    this.director.run = this;
  }

  /**
   * Called every frame. It pays the wave cadence's picks and watches for a siege
   * being held, at which point it offers roads -- it never advances anything itself.
   */
  update() {
    // Per-frame, not progression state. The router reads this later in the same simulation
    // step and endFrame clears the physical key edge after every operative has been fenced.
    this.pickResolvedThisFrame = false;
    this.#payWavePick();

    if (this.phase === RUN.SIEGE && this.director.held) {
      if (this.isBossLeg) {
        // The boss leg pays no pick FOR HOLDING IT: the run is over at that moment,
        // and an item you can never spend is a menu rather than a reward.
        //
        // Anything still in hand goes with it, for the same reason. The wave cadence
        // does pay during the boss siege -- fighting the titan is exactly when one
        // more piece of build is worth having, and there is a wave left to spend it
        // on -- but an offer left untaken when the biome ends would sit on screen
        // asking for a keypress that can no longer matter.
        this.phase = RUN.DONE;
        this.pickDeadline = 0;
        for (const economy of this.economies) economy.pendingPick = [];
      } else {
        // The reward is personal: every active operative gets a choice from their own seeded
        // pool. Existing cadence picks stay banked rather than being overwritten.
        this.phase = RUN.PICKING;
        this.pickDeadline = this.director.elapsed + CFG.economy.pickAutoAfter;
        for (const economy of this.economies) {
          if (!economy.pendingPick.length) economy.offerPick();
        }
      }
    }

    // A connected but inactive operative must not own a permanent veto over the road ballot.
    // Slot zero is deterministic because the offer itself came from the seeded stream; no
    // extra random draw is introduced at the deadline. This bypasses `pickOpen` deliberately:
    // an AFK body may be standing beside a remnant forever, which is exactly the state that
    // needs a bounded answer. Active players see the deadline in three HUD channels.
    if (this.phase === RUN.PICKING
        && this.pickDeadline > 0
        && this.director.elapsed >= this.pickDeadline) {
      for (const economy of this.economies) {
        if (economy.pendingPick.length === 0) continue;
        if (economy.autoTakePick(0)) this.pickResolvedThisFrame = true;
      }
    }

    // Every active operative resolves their personal pick before the shared road ballot.
    // A disconnect removes its Economy, so a vanished player cannot strand this phase.
    if (this.phase === RUN.PICKING
        && this.economies.every((economy) => economy.pendingPick.length === 0)) {
      this.phase = RUN.CHOOSING;
      this.pickDeadline = 0;
      this.#offerRoads();
    }
  }

  get picking() {
    return this.phase === RUN.PICKING;
  }

  /** Whole seconds until unresolved personal picks are deterministically taken. */
  get pickAutoSeconds() {
    if (!this.picking || this.pickDeadline <= 0) return 0;
    return Math.max(0, this.pickDeadline - (this.director?.elapsed ?? 0));
  }

  /**
   * Everything the roads have done to this run so far, as text, or an empty list.
   *
   * The modifiers were invisible. They are instance state on this object, they compound
   * across the whole biome, and the only place any of it surfaced was a single combined
   * number in the diagnostics panel — which is hidden by default and merges the road
   * effect with the elapsed-time ramp, so even there you could not tell them apart.
   *
   * A cost you cannot perceive is not a cost, and a decision whose consequences are
   * never shown is not a decision. This is read at the moment the next road is offered,
   * which is the moment the question gets asked.
   */
  get modifiers() {
    const out = [];
    if (this.threatScale > 1.0001) {
      out.push(`+${Math.round((this.threatScale - 1) * 100)}% enemy health`);
    }
    if (this.extraCount > 0) out.push(`+${this.extraCount} enemies per wave`);
    if (this.horde.speedScale > 1.0001) {
      out.push(`+${Math.round((this.horde.speedScale - 1) * 100)}% enemy speed`);
    }
    if (this.fogScale < 0.9999) {
      out.push(`visibility ${Math.round(this.fogScale * 100)}%`);
    }
    return out;
  }

  /** The roads taken so far, in order, by name. */
  get roadsTaken() {
    return this.history.map((id) => CFG.run.routes.find((r) => r.id === id)?.name ?? id);
  }

  // -------------------------------------------------------------------- the vote
  //
  // THE ROAD IS THE ONLY DECISION THE WHOLE CREW LIVES WITH, so it is the only one put
  // to a vote.
  //
  // A road's modifiers are cumulative for the rest of the biome, and there are exactly
  // THREE road choices in a run -- legs 1->2, 2->3, 3->4, with the fourth being the boss.
  // That low frequency is what makes a vote affordable here: Ghost Ship's experiment with
  // negotiated upgrades was divisive because it was every negotiation, and this is three.
  //
  // It also costs no tempo, and that is structural rather than lucky. A held siege
  // already sits in CHOOSING until a human presses a key -- nothing here advances on a
  // timer, by design -- so putting the choice to the crew spends time the run was already
  // spending. Pausing for a menu, which co-op cannot afford, is not what this is.
  //
  // NO TIMER, deliberately. Three separate versions of a timing rule have failed in this
  // project for being "on a clock you cannot see", and a road is the last place to
  // introduce a fourth.

  /** Active roster size, authoritative on a snapshot client and local on the server/solo. */
  get crewSize() {
    return this.authorityCrewSize ?? this.crew?.size ?? 1;
  }

  /**
   * How many operatives have to agree: a simple majority.
   *
   * 1 of 1, 2 of 2, 2 of 3, 3 of 4. Note what falls out at one member -- a majority of
   * one is one keypress, so solo behaviour is completely unchanged and the whole vote is
   * invisible until there is somebody to disagree with.
   */
  get votesNeeded() {
    const size = this.crewSize;
    return Math.floor(size / 2) + 1;
  }

  /** Votes per offered road, in offer order. */
  get tally() {
    if (this.authorityVoteSeats) {
      return this.authorityVoteSeats.map((seats) => seats.length);
    }

    const counts = this.offers.map(() => 0);
    for (const [voter, index] of this.votes) {
      // Ignore anyone no longer aboard. Same discipline as the repair claim: the roster
      // is the authority on who exists, so a disconnect cannot leave a vote behind that
      // nobody can change and that keeps the crew one short of a majority for ever.
      if (!this.crew?.members.includes(voter)) continue;
      if (counts[index] !== undefined) counts[index]++;
    }
    return counts;
  }

  /** Seat numbers backing each offered road, for the panel to draw. */
  get voteSeats() {
    if (this.authorityVoteSeats) {
      return this.authorityVoteSeats.map((seats) => seats.slice());
    }

    const out = this.offers.map(() => []);
    for (const [voter, index] of this.votes) {
      const seat = this.crew?.seatOf(voter) ?? 0;
      if (seat > 0 && out[index]) out[index].push(seat);
    }
    for (const seats of out) seats.sort((a, b) => a - b);
    return out;
  }

  /** How this operative voted, or -1. */
  voteOf(voter) {
    if (this.authorityVoteSeats) {
      const seat = this.crew?.seatOf(voter) ?? 0;
      return this.authorityVoteSeats.findIndex((seats) => seats.includes(seat));
    }
    return this.votes.has(voter) ? this.votes.get(voter) : -1;
  }

  /**
   * Everyone has voted and nobody has a majority.
   *
   * THIS IS NOT RESOLVED AUTOMATICALLY, and that is a correction to my own earlier
   * proposal, which was "ties break to the quiet road". The data does not support it:
   * `#offerRoads` draws two of six routes, and exactly one route -- the foundry -- has no
   * cost at all, so most ties would have had no quiet road on the menu to break toward.
   *
   * The alternatives were worse. Ranking the offers by payout gets the order wrong,
   * because the boneyard pays the least in cash and carries the highest threat plus a
   * free module. Scoring the modifiers means inventing weights across four incommensurable
   * units -- health, count, speed, visibility -- which is a number defended by nothing.
   * And "key 1 wins" is deterministic and completely illegible.
   *
   * So a tie stays a tie, and the panel says so. Votes are changeable, the run already
   * waits indefinitely, and any single operative can end it by switching -- which makes
   * the resolution social rather than arbitrary, and never overrides half the crew.
   * Ties are only possible at even crew sizes: with three operatives and two roads, a
   * majority is arithmetically unavoidable.
   */
  get deadlocked() {
    if (!this.choosing) return false;
    const size = this.crewSize;
    let cast = 0;
    if (this.authorityVoteSeats) {
      for (const seats of this.authorityVoteSeats) cast += seats.length;
    } else {
      for (const voter of this.votes.keys()) {
        if (this.crew?.members.includes(voter)) cast++;
      }
    }
    return cast >= size && Math.max(0, ...this.tally) < this.votesNeeded;
  }

  /**
   * Cast or change a vote. Resolves the moment a majority exists.
   *
   * Returns the arrival if this vote decided it, otherwise null -- so a caller can tell
   * "the crew has moved on" from "your vote was recorded and we are still waiting", which
   * are different things to draw.
   */
  vote(voter, index) {
    if (this.phase !== RUN.CHOOSING) return null;
    if (!this.offers[index]) return null;
    if (!voter) return null;

    this.votes.set(voter, index);

    // Resolved as soon as the outcome cannot be overturned, rather than when the last
    // operative has voted. With three of four agreed there is nothing left to wait for,
    // and waiting anyway would make the fourth player's silence hold up the run.
    const counts = this.tally;
    const needed = this.votesNeeded;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] >= needed) return this.choose(i);
    }
    return null;
  }

  /**
   * A free pick every few waves the crew sees off, not only at the end of a siege.
   *
   * The end-of-siege pick is a beat: you held the line, here is something, now
   * choose a road. It is also, on its own, unreachable — a playtest averaged wave
   * four of five, so the reward existed and the player had met it once. This is the
   * same reward on a cadence they can actually reach.
   *
   * Three things about how it is written:
   *
   * It watches the director's own resolved counter rather than taking a callback, so
   * a wave BURIED by pressing Q never pays one. That is not an edge case, it is part
   * of what calling a wave early costs, and it falls out for free by polling the
   * counter the economy already trusts for exactly the same reason.
   *
   * It uses the wave number WITHIN the siege, so the cadence is the same at every
   * landmark. The resolved counter accumulates across the whole run, and keying off
   * that would drift the rhythm — a pick after wave 3 at one landmark and after wave
   * 2 at the next, for no reason a player could ever infer.
   *
   * And it never offers on top of a pick already pending. Overwriting one would make
   * an offered item vanish and be replaced, which reads as a bug; the previous pick
   * simply stands until it is taken.
   */
  #payWavePick() {
    const d = this.director;
    if (!d) return;
    if (d.resolved === this.seenResolved) return;
    this.seenResolved = d.resolved;

    const every = CFG.run.pickEveryWaves;
    if (every <= 0) return;
    // The final wave of a siege is the hold's own business, and it pays a pick of
    // its own a moment later. Two offers a frame apart would replace the first.
    if (d.wave >= d.siegeLength) return;
    if (d.wave % every !== 0) return;

    for (const economy of this.economies) {
      if (economy.pendingPick.length === 0) economy.offerPick();
    }
  }

  #offerRoads() {
    const pool = CFG.run.routes.slice();
    this.offers = [];
    // A fresh ballot per landmark. Cleared here rather than in `choose`, so the votes
    // survive long enough for the arrival frame to still be able to report the split.
    this.votes.clear();

    for (let i = 0; i < CFG.run.branches && pool.length > 0; i++) {
      const pick = (this.random() * pool.length) | 0;
      this.offers.push(pool.splice(pick, 1)[0]);
    }

    // The last landmark before the boss always offers the quiet road as one of
    // its two. Arriving at a boss with a wrecked fortress and no money is a lost
    // run decided several minutes earlier, which reads as unfair rather than as
    // hard -- so there is always a way to arrive intact, and taking it always
    // costs you the payout that would have made the boss easier.
    const quiet = CFG.run.routes.find((r) => r.id === "foundry");
    if (this.leg === CFG.run.legs - 1 && quiet && !this.offers.includes(quiet)) {
      this.offers[this.offers.length - 1] = quiet;
    }
  }

  /**
   * Take one of the offered roads. Advances the leg, applies the modifiers, pays
   * the arrival bonus, and restarts the director for the next siege.
   *
   * Still public, and still the thing that actually commits: `vote` calls it once a
   * majority exists. Kept separate because they answer different questions -- this one is
   * "the crew is taking this road", which a test setting up a later landmark wants to say
   * directly without staging a ballot to say it.
   *
   * Payouts land on ARRIVAL, before the fight, on purpose: you are paid for
   * choosing the hard road while you can still spend it on surviving the hard
   * road. Paying afterwards would make the gamble a punishment with a consolation
   * prize attached.
   */
  choose(index) {
    if (this.phase !== RUN.CHOOSING) return null;
    const road = this.offers[index];
    if (!road) return null;

    this.leg++;
    this.road = road;
    this.history.push(road.id);
    this.phase = RUN.SIEGE;
    this.offers = [];

    // Modifiers are cumulative across a run: a road's hardship stays with you for
    // the rest of the biome. That is what makes an early greedy choice a real
    // commitment rather than a single bad wave.
    this.threatScale *= road.threat;
    this.extraCount += road.count;
    this.fogScale *= road.fog;
    this.horde.speedScale *= road.speed;

    const label = `ARRIVED: ${road.name}`;
    const [firstEconomy, ...otherEconomies] = this.economies;
    if (firstEconomy) {
      // Salvage is personal, so every operative receives it. Scrap and module credit
      // are Treasury accessors shared by all Economies and must be credited once.
      firstEconomy.grant(road.salvage, road.scrap, label);
      if (road.module) firstEconomy.grantModuleCredit();
      for (const economy of otherEconomies) economy.grant(road.salvage, 0, label);

      // Each personal shop owns its own seeded stream and is re-rolled at the new
      // landmark. Walking every active Economy preserves the solo draw while ensuring
      // no operative is left with the previous landmark's stock.
      for (const economy of this.economies) economy.rollOffers();
    }

    this.lastArrival = {
      name: road.name,
      detail: road.detail,
      // The road itself, so a caller can describe what it COST as well as what it paid.
      // The flattened payout fields below are kept because existing readers use them,
      // but anything new should go through `describeRoad(arrival.road)` rather than
      // growing this object a field at a time until it is a copy of the road.
      road,
      salvage: road.salvage,
      scrap: road.scrap,
      module: !!road.module,
      leg: this.leg,
      boss: this.isBossLeg,
    };

    // Fresh siege at the new landmark. resetSiege keeps the elapsed clock running,
    // because difficulty scaling with elapsed time is the anti-stall valve and
    // rewinding it at every landmark would let a slow crew farm the whole biome.
    this.director.resetSiege();
    this.#configureSiege();

    return this.lastArrival;
  }
}
