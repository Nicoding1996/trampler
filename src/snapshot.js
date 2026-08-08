// The wire format. PURE FUNCTIONS, no WebSocket, no DOM, no three.js.
//
// WHY THIS IS A MODULE IN src/ AND NOT CODE IN net.js
//
// Because a rule that matters belongs somewhere the harness can reach. That is the
// project's most expensive lesson, learned twice: `routePurchaseInput` lived in main.js
// and was the only piece of wiring with no test behind it, and the sim-check spike lived
// outside `src/` and rotted silently through a refactor.
//
// A wire format is exactly that shape of hazard. It is arithmetic — quantisation, field
// order, byte offsets — and every one of its failure modes is silent. A field written as
// int16 and read as uint16 does not throw; it reports a fortress 600 metres away. Written
// in net.js this would be browser-only and untestable by construction. Written here,
// verify.mjs round-trips it and asserts the error bounds directly.
//
// It also has to be importable by BOTH ends: `worker/` for the authority and `net.js` for
// the client. That rules out touching `document`, and it rules out three.js — so this
// module speaks in plain numbers and plain objects, and the callers do their own Vector3
// conversion. Keeping THREE out is not squeamishness: it is what lets the harness test
// the codec with object literals instead of building a scene.
//
// ONE TABLE, TWO DIRECTIONS. The encoder and the decoder are generated from the same
// field list rather than hand-written as a matching pair. A hand-written pair is two
// places that must agree about order, width and scale forever, and they drift — that is
// the classic netcode bug and it presents as garbage rather than as an error. Here, order
// and width have exactly one owner, in the same way the salvage catalogue is the one owner
// of what the shop offers and `ENEMY_BASE` is the one owner of an enemy's field set.
//
// WHAT SLICE 1 CARRIES: the hull and the director. Not the horde, not the operatives.
// The hull comes first because it cannot come second — every attached body's position is
// expressed in the hull's frame, so nothing downstream can be correct before the hull is
// (see verify.mjs section 115). And the director carries `elapsedMs`, which is the single
// field that closes the largest divergence in the game: difficulty scales with elapsed
// time, each client currently starts its own clock on its own click, so two players who
// clicked ten seconds apart are in permanently different fights.

// PROTOCOL VERSION. Bumped whenever a field is added, removed, reordered or rescaled.
//
// Checked on decode, and a mismatch is a NAMED refusal rather than a misparse. This is
// the refit terminal's lesson applied to a socket: a refusal has to say which clause
// refused it, because "could not connect" sends someone to check their network when the
// actual problem is a stale browser tab holding last week's JavaScript. That specific
// case is not hypothetical for a project with no build step and no cache busting.
export const PROTOCOL_VERSION = 12;

// Message kinds. One byte, so there is room to add the horde and the operatives in later
// slices without touching anything here.
export const MSG = {
  SNAPSHOT: 1,
  INPUT: 2,
};

/**
 * WHAT A CLIENT SENDS, AND WHY IT IS KEYS RATHER THAN A POSITION.
 *
 * The relay sent positions and believed them, which is why its own comment called it
 * trivially cheatable. An authoritative server takes INTENT and decides the outcome itself:
 * a client says "I am holding W", never "I am at (4.05, 0.9, -7.65)".
 *
 * Held state and edges are separate bitmasks because they have different lifetimes, and
 * conflating them is a real bug rather than an inelegance. `input.down()` is a level — true
 * for as long as a key is down, safe to repeat — while `input.pressed()` is an EDGE that the
 * reader CONSUMES, so it must fire exactly once. A server that replayed the held mask when a
 * packet went missing would be correct; one that replayed the edge mask would fire a second
 * grapple, mount a station twice, or buy the same refit again.
 *
 * 1-6, Tab and shared run actions are here because `routePurchaseInput`, weapon
 * selection, the grapple and restart all execute on the authority. Presentation-only
 * tuning keys are deliberately absent; a client cannot mutate shared CFG or debug state.
 */
export const HELD_BIT = {
  forward: 1,
  back: 2,
  left: 4,
  right: 8,
  sprint: 16,
  fire: 32,
  repair: 64,
};

// Nine high bits of the existing held u16 carry number-key ownership metadata: three for
// the visible panel and six for its road/restart episode. These are command metadata rather
// than simulated held levels, and keep ownership through queue delay without increasing
// INPUT_BYTES.
export const PURCHASE_OWNER_SHIFT = 7;
export const PURCHASE_OWNER_MASK = 0x0380;
export const PURCHASE_CONTEXT_SHIFT = 10;
export const PURCHASE_CONTEXT_MASK = 0xfc00;

export const EDGE_BIT = {
  jump: 1,
  station: 2,
  deploy: 4,
  recall: 8,
  bay: 16,
  key1: 32,
  key2: 64,
  key3: 128,
  key4: 256,
  key5: 512,
  key6: 1024,
  firePressed: 2048,
  callEarly: 4096,
  restart: 8192,
  swap: 16384,
  grapple: 32768,
};

/**
 * Commit the one hands action local prediction selected for this command.
 *
 * Physical E and fire are captured before the predicted step. Afterwards `repairing` says
 * whether that step admitted real work. If it did, carried-weapon fire is removed; if it did
 * not, repair is removed and fire remains available. A mounted gun is the exception: the
 * station owns that trigger, so repair and mounted fire may coexist exactly as before.
 * Sending an ambiguous on-foot pair would let the authority reinterpret a simultaneously
 * claimed point as a fallback shot the client never drew.
 *
 * The authority still verifies every repair condition. This only says what the operative
 * chose after the world visible to that client was considered; it grants no outcome.
 */
export function commitHandsInput(cmd, repairing, stationOwnsFire = false) {
  if (!cmd || (cmd.held & HELD_BIT.repair) === 0) return cmd;
  if (repairing && stationOwnsFire) return cmd;
  return {
    ...cmd,
    held: repairing
      ? cmd.held & ~HELD_BIT.fire
      : cmd.held & ~HELD_BIT.repair,
  };
}

/** Thrown by decode() so the caller can name the cause instead of guessing. */
export class SnapshotError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "SnapshotError";
    Object.assign(this, detail);
  }
}

const TAU = Math.PI * 2;

/**
 * The codecs a field may use.
 *
 * `bytes` is the width, `write` takes an already-scaled integer (or a float, for f32),
 * `read` returns it. Scaling and clamping happen in the field layer above, so a codec is
 * only ever responsible for bytes.
 *
 * LITTLE-ENDIAN EVERYWHERE, stated explicitly in every call. DataView defaults to
 * BIG-endian, which is the opposite of every platform this runs on, and a default that
 * silently disagrees with the machine is how a byte-order bug survives code review.
 */
const CODECS = {
  u8: {
    bytes: 1,
    write: (dv, o, v) => dv.setUint8(o, v),
    read: (dv, o) => dv.getUint8(o),
    max: 255,
    min: 0,
  },
  u16: {
    bytes: 2,
    write: (dv, o, v) => dv.setUint16(o, v, true),
    read: (dv, o) => dv.getUint16(o, true),
    max: 65535,
    min: 0,
  },
  i16: {
    bytes: 2,
    write: (dv, o, v) => dv.setInt16(o, v, true),
    read: (dv, o) => dv.getInt16(o, true),
    max: 32767,
    min: -32768,
  },
  u32: {
    bytes: 4,
    write: (dv, o, v) => dv.setUint32(o, v, true),
    read: (dv, o) => dv.getUint32(o, true),
    max: 4294967295,
    min: 0,
  },
  f32: {
    bytes: 4,
    write: (dv, o, v) => dv.setFloat32(o, v, true),
    read: (dv, o) => dv.getFloat32(o, true),
  },
};

/**
 * Field kinds, each one a (scale, clamp, wrap) policy over a codec.
 *
 * Written as named kinds rather than as raw scale numbers at each field, because "i16 at
 * 100" appears eleven times and a twelfth one written as "i16 at 10" would be a silent
 * ten-fold error in one coordinate. A name that means "a world coordinate in centimetres"
 * cannot be got subtly wrong.
 */
const KINDS = {
  /**
   * A world coordinate, centimetre precision.
   *
   * int16 at 1 cm reaches +/-327.67 m. The play area is bounded by
   * CFG.world.patrolRadius at 165 m, so the hull has roughly twice the room it needs —
   * and `clamped` below reports it rather than wrapping if that assumption ever breaks,
   * because a coordinate that silently wraps puts the fortress on the far side of the map.
   */
  metres: { codec: "i16", scale: 100 },

  /** Seconds, hundredth precision, for timers that never exceed a few minutes. */
  seconds: { codec: "u16", scale: 100 },

  /** Short countdowns, tenth precision, reaching 25.5 seconds in one byte. */
  shortSeconds: { codec: "u8", scale: 10 },

  /** Milliseconds since the run began. u32 reaches 49 days; a biome is ~15 minutes. */
  millis: { codec: "u32", scale: 1 },

  /**
   * An angle, full turn over 16 bits: 0.0001 rad, or about 5.5 thousandths of a degree.
   *
   * 16 bits rather than 8 for the hull's yaw specifically, and the reason generalises to
   * anything a body is attached to: every deck position is derived by rotating a
   * hull-local offset, so the angular error is MULTIPLIED by distance from the
   * centreline. At the deck's 13 m half-length, 8 bits (0.025 rad) would throw a
   * crewmate at the stern 32 cm sideways. At 16 bits it is 1.3 mm.
   */
  angle: { codec: "u16", scale: 65536 / TAU, wrap: TAU },

  /**
   * An angle in one byte: 0.025 rad, about 1.4 degrees.
   *
   * For a body's OWN facing, where the error rotates nothing but that body. Never for the
   * hull — see the note on `angle` above, and test 117, which measures 8-bit hull yaw
   * throwing a stern-standing crewmate 16 cm sideways against 0.62 mm at 16 bits.
   */
  angle8: { codec: "u8", scale: 256 / TAU, wrap: TAU },

  /** A signed view angle. Pitch never wraps and stays inside +/-pi. */
  signedAngle: { codec: "i16", scale: 32767 / Math.PI },

  /** A 0..1 fraction at 1/255. For health bars and gauges, where a pixel is coarser. */
  unit: { codec: "u8", scale: 255 },

  /** A multiplier around 1, thousandth precision, reaching 65.5. */
  scalar: { codec: "u16", scale: 1000 },

  /** A small non-negative count. */
  count: { codec: "u8", scale: 1 },

  /** A larger count that accumulates across a run. */
  tally: { codec: "u16", scale: 1 },

  /** Hit points, whole numbers, up to 65535. */
  hp: { codec: "u16", scale: 1 },

  /** A bit field. The caller packs and unpacks; this is just a byte. */
  bits: { codec: "u8", scale: 1 },

  /** Unquantised, for a value with no bounded range worth reasoning about. */
  float: { codec: "f32", scale: 1 },
};

/**
 * THE LAYOUT. Order is the wire order; changing it means bumping PROTOCOL_VERSION.
 *
 * Every entry is [key, kind] and optionally a count for a repeated field. The header is
 * separate because its first two bytes have to be readable before anything else is
 * trusted — a version check that came after parsing would be a version check performed
 * on a misparse.
 */
const HEADER = [
  ["version", "count"],
  ["kind", "count"],
  ["tick", "millis"],
];

const BODY = [
  // ---- the clock, first because it is the point of slice 1 ------------------
  ["elapsedMs", "millis"],
  // Encounter generation. The Worker tick never rewinds when a lost run resets, so this is
  // the identity that tells a client not to interpolate or reconcile across two runs.
  ["resetId", "tally"],

  // ---- hull -----------------------------------------------------------------
  // y is deliberately absent: it is deckHeight plus a bob derived from `gait`, so
  // sending it would be sending the same information twice and inviting the two copies
  // to disagree. Same argument as the HUD polling a counter rather than watching a value.
  ["hullX", "metres"],
  ["hullZ", "metres"],
  ["hullYaw", "angle"],
  // The gait phase. Unquantised because it grows without bound within a run and drives
  // two oscillators at different frequencies (legs and bob), so there is no modulus that
  // preserves both. A float32 is four bytes and exact enough that no correction is visible.
  ["gait", "float"],
  ["reactorHp", "hp"],
  // Multipliers the client needs in order to PREDICT the hull rather than interpolate it.
  // Trampler.update consumes no input, so given these the client re-runs the real code and
  // lands on the same answer — see structure.md on predicting the hull.
  ["driveScale", "scalar"],
  ["turnScale", "scalar"],
  // walking / turning / destroyed / immobilised, packed. Two of those are debug toggles
  // and they still have to be shared: a host who pressed P has a stationary fortress, and
  // a client predicting a walking one would fight its own correction every frame.
  ["hullBits", "bits"],

  // ---- director -------------------------------------------------------------
  ["wave", "count"],
  ["resolved", "tally"],
  ["phaseTimer", "seconds"],
  // The telegraphed bearing. An angle rather than the LABEL, because the label is derived
  // from CFG.waves.forwardArc and invariant 19d requires the threshold to be derived from
  // the arc rather than fixed — sending the label would put that derivation on the sender
  // and let the two ends disagree about what "off the port bow" means.
  ["arcOffset", "angle"],
  // director phase (3 bits) + run phase (2 bits) + calledEarly + boss leg, packed.
  ["phaseBits", "bits"],
  ["runLeg", "count"],
  // Absolute director-clock deadline for the only timed run transition: unanswered
  // personal picks at a held siege. Zero outside PICKING. Absolute rather than a remaining
  // duration so every client derives the same countdown from the elapsed clock above.
  ["pickDeadlineMs", "millis"],

  // ---- shared run/economy state -------------------------------------------
  ["threatScale", "scalar"],
  ["extraCount", "count"],
  ["fogScale", "scalar"],
  ["speedScale", "scalar"],
  ["treasuryScrap", "float"],
  ["treasuryEarnedScrap", "float"],
  ["moduleCredits", "count"],

  // Lifetime counters plus the newest removal. `deathCount` includes an unpaid sapper
  // detonation, so clients can publish a fresh lastKill object exactly once even when the
  // paid-kill counter does not move.
  ["hordeKills", "tally"],
  ["hordeDeaths", "tally"],
  ["lastDeathX", "metres"],
  ["lastDeathY", "metres"],
  ["lastDeathZ", "metres"],
  ["lastDeathType", "count"],
  ["lastDeathBits", "bits"],
];

// Repeated fields, appended after BODY in this order. Kept separate because their COUNT
// comes from config, so hard-coding six leg slots here would be a second owner of a
// number CFG.trampler.legCount already owns.
const REPEATED = [
  ["legHp", "hp"],

  // Nullable catalogue/route indexes are encoded as index + 1; zero is empty.
  ["moduleSockets", "count"],
  ["roadHistory", "count"],
  ["roadOffers", "count"],
  // (seat << 2) | (offer index + 1). Seats are 1..4 and two offers fit in two bits.
  ["roadVotes", "count"],

  // Row-major in `operatives` wire order. Widths come from the shared catalogues;
  // nullable offers and picks use the same index + 1 convention.
  ["economyStacks", "count"],
  ["economyOffers", "count"],
  ["economyPicks", "count"],

  // Shared gun runtime. Parallel arrays keep each field on its honest codec rather than
  // rounding every value up to a generic record width.
  ["gunOperatorSeats", "count"],
  ["gunYaw", "angle"],
  ["gunPitch", "signedAngle"],
  ["gunHeat", "unit"],
  ["gunCooldown", "shortSeconds"],
  ["gunBits", "bits"],
  ["gunShots", "tally"],

  // The deployed rack, in stable slot order and hull-local coordinates.
  ["emitterLive", "bits"],
  ["emitterX", "metres"],
  ["emitterY", "metres"],
  ["emitterZ", "metres"],
  ["emitterCooldown", "shortSeconds"],
  ["emitterCharge", "scalar"],
];

/**
 * ONE ENEMY, FOURTEEN BYTES. Appended after REPEATED, prefixed by a 16-bit count.
 *
 * This is the section that actually scales with crowd size: shared and per-operative state is
 * fixed for a roster, while the horde is 14 bytes per live body. With a four-seat roster and
 * every repeated shared section present, roughly 100 bodies are 1.9 KiB per snapshot (about
 * 39 KiB/s per client); the structural 420-body cap is about 6.3 KiB (about 126 KiB/s).
 * Both remain comfortable, and the harness derives those totals from real arrays so protocol
 * growth cannot hide behind a stale hand-written count.
 *
 * WHAT IS ABSENT IS THE INTERESTING PART. None of the AI state travels — no `atkCd`, no
 * `legIndex`, no `routeIndex`, no `climbT`, no `climbFrom`, no `burrowT`, no `shoveVx`, no
 * `reactorSlot`, no velocity. All of it exists only to decide where the body goes NEXT, and
 * the server has already decided that; a client that received it would be carrying the
 * inputs to a computation it must not perform. Sending them would also be the invitation to
 * run the AI locally "just for smoothness", which is how two simulations start disagreeing.
 *
 * `(id, generation)` is the body's identity. `id` is the pool index and remains stable for
 * one life; `generation` increments whenever that slot is spawned again. The second half is
 * what prevents interpolation and lag compensation from joining an old pose to a new occupant
 * when a slot dies and is reused between snapshots.
 */
const ENTITY = [
  ["id", "tally"],
  ["generation", "tally"],
  // type | state | carried | flash, packed. See packEnemyBits.
  ["bitsA", "bits"],
  // health in 7 bits | fuse lit in the high bit, packed. See packEnemyBits.
  ["bitsB", "bits"],
  // Position in the frame `carried` names: hull-local for a body riding the deck or latched
  // to a leg, world otherwise. int16 at 1 cm reaches +/-327 m, which covers both — the play
  // area is 165 m and the deck is 13 m, so one scale serves and there is no second range to
  // get wrong.
  ["x", "metres"],
  ["y", "metres"],
  ["z", "metres"],
  // One mutually-exclusive enemy cue timer: a sapper fuse or a Spiker charge. A tenth of a
  // second is finer than either displayed cue and keeps the per-body growth to one byte.
  ["fuseT", "shortSeconds"],
  // 8 bits, not 16, and the asymmetry with the hull's yaw is deliberate. The hull's rotation
  // is applied to every attached body, so its angular error multiplies by distance from the
  // centreline; an enemy's facing rotates nothing but itself. 0.025 rad on a 1 m body is a
  // couple of millimetres at the silhouette's edge.
  ["yaw", "angle8"],
];

/**
 * ONE SPIKER RELEASE, SIXTEEN BYTES. Appended after entities, prefixed by a 16-bit count.
 *
 * Releases are sparse and discrete, so charging every live body for an endpoint would make
 * the hot 14-byte entity record carry mostly zeroes. The reset-scoped sequence deduplicates
 * the repeated recent journal; exact world-space endpoints preserve what stopped the shot
 * even after the shooter dies, its pool slot is reused, or bodies are rendered 120 ms late.
 */
const SPIKER_SHOT = [
  // A reset-scoped monotonic sequence. The u32 `millis` codec is the honest width even
  // though this value is an index rather than a clock.
  ["seq", "millis"],
  ["startX", "metres"],
  ["startY", "metres"],
  ["startZ", "metres"],
  ["endX", "metres"],
  ["endY", "metres"],
  ["endZ", "metres"],
];

/**
 * ONE OPERATIVE. Appended after the sparse Spiker releases, prefixed by a count.
 *
 * The frame bit is here for the same reason it is on an enemy and on a relayed pose: a
 * crewmate standing on the deck is sent in hull-local space, because the receiver already
 * knows the hull's current transform. Measured at 0.00 cm against 45 cm in section 115.
 *
 * `ackSeq` is the field that makes client prediction possible at all. It is the last input
 * sequence the server processed for THIS seat, so a client can throw away the inputs the
 * server has already consumed and replay only the ones it has not — which is what turns "the
 * server disagrees with me" into "the server has not seen my last three frames yet". Without
 * it a client cannot tell a correction from a stale packet.
 */
const OPERATIVE = [
  ["seat", "count"],

  // The exact outcome of the newest FRESH command. Starved grace ticks may keep moving the
  // current pose, but they do not relabel that later moment with an older sequence.
  ["ackSeq", "millis"],
  ["ackX", "metres"],
  ["ackY", "metres"],
  ["ackZ", "metres"],
  ["ackYaw", "angle"],
  ["ackPitch", "signedAngle"],
  ["ackBits", "bits"],

  // Current authoritative state. Position is in the frame named by `bits`; velocity is the
  // Player's stored base-relative velocity, in world axes, and is needed for a hard adoption
  // after death, reset, or a refused frame/station transition.
  ["x", "metres"],
  ["y", "metres"],
  ["z", "metres"],
  ["vx", "metres"],
  ["vy", "metres"],
  ["vz", "metres"],
  ["yaw", "angle"],
  ["pitch", "signedAngle"],
  ["hp", "hp"],
  ["hurtCount", "tally"],
  ["deaths", "tally"],
  ["kills", "tally"],

  // Personal progression and weapon runtime. Shared scrap/module credit lives in BODY;
  // these values belong to exactly this seat.
  ["salvage", "float"],
  ["earnedSalvage", "float"],
  ["purchases", "tally"],
  ["refitCallouts", "tally"],
  // weapon slot (1 bit) | cooldown in tenths (4 bits) | rolling trigger sequence (3 bits).
  // Folding values that already belonged to the weapon into one byte leaves the six tracer
  // coordinates as the only operative-wire growth. The measured four-crew case stayed below
  // 30 KiB/s until enemy generations deliberately added two bytes per live body; it is now
  // held below 35 KiB/s by the harness.
  ["weaponBits", "bits"],
  ["weaponSwaps", "tally"],

  // The latest authoritative tracer, in world space. An observer draws this once when the
  // rolling sequence changes; it never replays the ray, damage, hit bus, procs or recoil.
  ["shotStartX", "metres"],
  ["shotStartY", "metres"],
  ["shotStartZ", "metres"],
  ["shotEndX", "metres"],
  ["shotEndY", "metres"],
  ["shotEndZ", "metres"],

  // The active winch anchor, hull-local when grappleBits says it belongs to the fortress and
  // world-space otherwise. The pull itself is already authoritative movement; these fields
  // let an observer see the rope that explains it rather than a crewmate apparently flying.
  ["grappleX", "metres"],
  ["grappleY", "metres"],
  ["grappleZ", "metres"],
  ["grappleBits", "bits"],

  // Exact point claimed by this operative: 0 none, 1 reactor, 2..255 leg index + 2.
  // The broad repairing bit below remains useful to presentation, but cannot arbitrate one
  // welder per point: two simultaneous claims need the key, not merely the fact of welding.
  ["repairTarget", "count"],

  // Incapacitation is authority state, not a duration reconstructed from packet arrival.
  // Tenths are ample for both the eight-second fallback and two-second recovery channel;
  // the owner is a stable numeric seat, with zero meaning no active rescuer.
  ["medevacRemaining", "shortSeconds"],
  ["recoveryProgress", "shortSeconds"],
  ["rescuerSeat", "count"],

  // based | repairing | downed | station index (2 bits) | grounded | bay open.
  ["bits", "bits"],
];

/** Byte width of a field list. */
function widthOf(fields) {
  let n = 0;
  for (const [, kind] of fields) n += CODECS[KINDS[kind].codec].bytes;
  return n;
}

/**
 * Bytes a snapshot occupies, given how many of each repeated field there are.
 *
 * Exported so a caller can size a buffer, and so the harness can assert the format has
 * not quietly grown — a snapshot is sent 20 times a second to every client, and "it got
 * a bit bigger" is the failure mode that is invisible until it is a bandwidth problem.
 */
export function snapshotBytes(counts = {}) {
  const lengthOf = (value) => (typeof value === "number" ? value : value?.length ?? 0);
  let n = widthOf(HEADER) + widthOf(BODY);
  for (const [key, kind] of REPEATED) {
    const len = lengthOf(counts[key]);
    n += CODECS[KINDS[kind].codec].bytes * len;
    n += 1; // a length byte, so the decoder never infers a count from the buffer size
  }
  // The entity count is 16 bits, not 8: CFG.enemies.max is 420 and a byte stops at 255. A
  // count that silently wrapped would truncate the horde to whatever 420 mod 256 happens to
  // be, which reads as enemies vanishing under load rather than as an overflow.
  n += 2;
  n += ENTITY_BYTES * lengthOf(counts.entities);
  // Sparse Spiker releases: a 16-bit count plus exact world-space segments. Kept outside
  // ENTITY so a quiet 420-body horde pays only these two bytes.
  n += 2;
  n += SPIKER_SHOT_BYTES * lengthOf(counts.spikerShots);
  // Operatives: a count byte plus the crew. One byte is ample where CREW_MAX is 4, and the
  // asymmetry with the entity count is deliberate rather than sloppy — the crew cap is a
  // design decision justified by the fortress's geometry, not a number that grows.
  n += 1;
  n += OPERATIVE_BYTES * lengthOf(counts.operatives);
  return n;
}

/** Bytes one enemy occupies. Exported so a caller can reason about bandwidth. */
export const ENTITY_BYTES = (() => {
  let n = 0;
  for (const [, kind] of ENTITY) n += CODECS[KINDS[kind].codec].bytes;
  return n;
})();

/** Bytes one sparse Spiker release occupies. */
export const SPIKER_SHOT_BYTES = (() => {
  let n = 0;
  for (const [, kind] of SPIKER_SHOT) n += CODECS[KINDS[kind].codec].bytes;
  return n;
})();

/** Bytes one operative occupies. */
export const OPERATIVE_BYTES = (() => {
  let n = 0;
  for (const [, kind] of OPERATIVE) n += CODECS[KINDS[kind].codec].bytes;
  return n;
})();

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Turn a value into the integer the wire carries, and report if it had to be clamped.
 *
 * `clamped` is collected and returned by encode() rather than thrown, and that choice is
 * deliberate: a fortress at 400 m would be a bug somewhere else entirely, and dropping
 * the whole snapshot would turn one bad field into a frozen world for every client. But
 * silently clamping is how invariant 31's dune ended up inside the patrol ring, so the
 * caller is told and can assert on it. The harness does.
 */
function quantise(kind, value, out) {
  const k = KINDS[kind];
  const codec = CODECS[k.codec];
  if (k.codec === "f32") return Number.isFinite(value) ? value : 0;

  let v = Number.isFinite(value) ? value : 0;
  if (k.wrap) {
    v = ((v % k.wrap) + k.wrap) % k.wrap;
  }
  const raw = Math.round(v * k.scale);
  const fit = clamp(raw, codec.min, codec.max);
  if (fit !== raw) out.push({ kind, value, raw, fit });
  return fit;
}

function dequantise(kind, raw) {
  const k = KINDS[kind];
  if (k.codec === "f32") return raw;
  return raw / k.scale;
}

/**
 * Pack a plain state object into an ArrayBuffer.
 *
 * @returns {{buffer: ArrayBuffer, clamped: Array}} `clamped` is empty in normal
 *          operation; a non-empty one means a value did not fit its field and the world
 *          being sent is not the world being described.
 */
/**
 * TWO PASSES, SO THE SIZE CANNOT DISAGREE WITH THE WRITES.
 *
 * `put` collects (kind, value) pairs on the first pass and writes them on the second, and the
 * buffer is allocated from what was actually collected. That makes the size derived rather
 * than declared, which kills a whole bug class:
 *
 * The first version sized the buffer from a `snapshotBytes({ ... })` bag passed by hand. That
 * bag defaults a missing key to zero, so adding a SECTION and forgetting to add its count
 * under-sized the buffer and DataView threw `Offset is outside the bounds`. It happened for
 * the entities and then, having been "fixed", happened again for the operatives — the same
 * mistake twice, because the fix addressed the instance and not the shape.
 *
 * Loud both times, which is the only good thing about it: an over-allocated buffer would have
 * shipped a snapshot with a silently truncated horde instead. `snapshotBytes` survives as the
 * thing tests assert against, so a size that grows is still visible — it just no longer has
 * to be remembered.
 */
export function encode(state) {
  const kinds = [];
  const values = [];
  const clamped = [];

  const put = (kind, value) => {
    kinds.push(kind);
    values.push(value);
  };

  // The header is written from the same table the reader uses, but `version` and `kind`
  // are supplied HERE rather than taken from `state`. A caller that could pass its own
  // version byte could claim to speak a protocol it does not.
  put("count", PROTOCOL_VERSION);
  put("count", MSG.SNAPSHOT);
  put("millis", state.tick ?? 0);

  for (const [key, kind] of BODY) put(kind, state[key]);

  for (const [key, kind] of REPEATED) {
    const arr = state[key] ?? [];
    put("count", arr.length);
    for (const v of arr) put(kind, v);
  }

  const entities = state.entities ?? [];
  put("tally", entities.length);
  for (const e of entities) {
    for (const [key, kind] of ENTITY) put(kind, e[key]);
  }

  const spikerShots = state.spikerShots ?? [];
  put("tally", spikerShots.length);
  for (const shot of spikerShots) {
    for (const [key, kind] of SPIKER_SHOT) put(kind, shot[key]);
  }

  const ops = state.operatives ?? [];
  put("count", ops.length);
  for (const p of ops) {
    for (const [key, kind] of OPERATIVE) put(kind, p[key]);
  }

  // Now size it from what was collected, and write.
  let bytes = 0;
  for (const kind of kinds) bytes += CODECS[KINDS[kind].codec].bytes;
  const buffer = new ArrayBuffer(bytes);
  const dv = new DataView(buffer);
  let o = 0;
  for (let i = 0; i < kinds.length; i++) {
    const k = KINDS[kinds[i]];
    const codec = CODECS[k.codec];
    codec.write(dv, o, quantise(kinds[i], values[i], clamped));
    o += codec.bytes;
  }

  return { buffer, clamped };
}

/**
 * Unpack a buffer written by encode().
 *
 * Throws SnapshotError with a named cause. Three things can go wrong and they want three
 * different responses, which is why they are distinguished rather than collapsed into
 * "bad packet": a version mismatch means somebody is running stale code and should
 * reload, an unknown kind means a newer server is sending a message this client has no
 * handler for, and a truncated buffer means the transport is broken.
 */
/**
 * A DataView over whatever a transport handed us, RESPECTING A VIEW'S BOUNDS.
 *
 * This cost a debugging round and the bug is worth recording, because the naive version looks
 * obviously correct. It was:
 *
 *     new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer)
 *
 * A typed array's `.buffer` is the WHOLE underlying allocation, not the view's slice of it.
 * Runtimes pool those: workerd delivered every 18-byte input command as a view over a much
 * larger buffer, so `byteLength` came back as the pool size, the length check rejected all
 * sixty commands as malformed, and the operative stood still. Measured as `60 received, 60
 * undecodable` — which is only distinguishable from "not arriving" because /status counts both.
 *
 * `byteOffset` matters for the same reason: a view starting part-way into a pool would decode
 * somebody else's bytes rather than throwing, which is the worse failure of the two.
 */
function viewOf(buffer) {
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export function decode(buffer) {
  const dv = viewOf(buffer);
  const total = dv.byteLength;
  let o = 0;

  const take = (kind) => {
    const k = KINDS[kind];
    const codec = CODECS[k.codec];
    if (o + codec.bytes > total) {
      throw new SnapshotError(
        `snapshot truncated: wanted ${codec.bytes} bytes at ${o}, buffer is ${total}`,
        { cause: "truncated", offset: o, total },
      );
    }
    const raw = codec.read(dv, o);
    o += codec.bytes;
    return dequantise(kind, raw);
  };

  const version = take("count");
  if (version !== PROTOCOL_VERSION) {
    throw new SnapshotError(
      `snapshot protocol ${version}, this build speaks ${PROTOCOL_VERSION}`
      + " — one end is running stale code; reload the page",
      { cause: "version", got: version, want: PROTOCOL_VERSION },
    );
  }
  const kind = take("count");
  if (kind !== MSG.SNAPSHOT) {
    throw new SnapshotError(
      `unknown message kind ${kind} — a newer server is sending something this build`
      + " has no handler for",
      { cause: "kind", got: kind },
    );
  }

  const state = { version, kind, tick: take("millis") };
  for (const [key, k] of BODY) state[key] = take(k);
  for (const [key, k] of REPEATED) {
    const len = take("count");
    const arr = new Array(len);
    for (let i = 0; i < len; i++) arr[i] = take(k);
    state[key] = arr;
  }

  const count = take("tally");
  // A count larger than the buffer could possibly hold means the header was misread, and
  // trusting it would allocate a 65535-element array before `take` got around to throwing.
  // Checked against the bytes actually remaining rather than against CFG.enemies.max, so
  // this file needs no opinion about how big a horde is allowed to be.
  const remaining = total - o;
  if (count * ENTITY_BYTES > remaining) {
    throw new SnapshotError(
      `snapshot claims ${count} entities (${count * ENTITY_BYTES} bytes) with only`
      + ` ${remaining} left in the buffer`,
      { cause: "truncated", claimed: count, remaining },
    );
  }
  const entities = new Array(count);
  for (let i = 0; i < count; i++) {
    const e = {};
    for (const [key, k] of ENTITY) e[key] = take(k);
    entities[i] = e;
  }
  state.entities = entities;

  const shotCount = take("tally");
  const shotRemaining = total - o;
  if (shotCount * SPIKER_SHOT_BYTES > shotRemaining) {
    throw new SnapshotError(
      `snapshot claims ${shotCount} Spiker shots (${shotCount * SPIKER_SHOT_BYTES} bytes)`
      + ` with only ${shotRemaining} left in the buffer`,
      { cause: "truncated", claimed: shotCount, remaining: shotRemaining },
    );
  }
  const spikerShots = new Array(shotCount);
  for (let i = 0; i < shotCount; i++) {
    const shot = {};
    for (const [key, k] of SPIKER_SHOT) shot[key] = take(k);
    spikerShots[i] = shot;
  }
  state.spikerShots = spikerShots;

  const opCount = take("count");
  const operatives = new Array(opCount);
  for (let i = 0; i < opCount; i++) {
    const p = {};
    for (const [key, k] of OPERATIVE) p[key] = take(k);
    operatives[i] = p;
  }
  state.operatives = operatives;

  // Trailing bytes mean the sender wrote a layout this build does not share, with a
  // version number that nonetheless matched — which is worse than a mismatch, because it
  // parses. Only reachable if someone edits the layout without bumping the version, so
  // this is the guard that makes that mistake loud.
  if (o !== total) {
    throw new SnapshotError(
      `snapshot has ${total - o} trailing bytes: the layout was changed without bumping`
      + ` PROTOCOL_VERSION (read ${o} of ${total})`,
      { cause: "layout", read: o, total },
    );
  }

  return state;
}

// ---------------------------------------------------------------------------- bit fields
//
// Packed as explicit named helpers rather than as inline shifts at the call sites, for
// the reason `isSubmerged` and `causedBy` are exported: a bit index written out by hand in
// two places is a wrong answer rather than an error the second time somebody counts.

export const HULL_BIT = { walking: 1, turning: 2, destroyed: 4, immobilised: 8 };

export function packHullBits({ walking, turning, destroyed, immobilised }) {
  return (walking ? HULL_BIT.walking : 0)
    | (turning ? HULL_BIT.turning : 0)
    | (destroyed ? HULL_BIT.destroyed : 0)
    | (immobilised ? HULL_BIT.immobilised : 0);
}

export function unpackHullBits(bits) {
  return {
    walking: (bits & HULL_BIT.walking) !== 0,
    turning: (bits & HULL_BIT.turning) !== 0,
    destroyed: (bits & HULL_BIT.destroyed) !== 0,
    immobilised: (bits & HULL_BIT.immobilised) !== 0,
  };
}

/**
 * Director and run phases share a byte.
 *
 * Sent as INDICES into these lists rather than as the strings the modules use, and the
 * lists live here so the wire order cannot be changed by reordering an enum elsewhere.
 * `phaseName` resolves back to the exact string `PHASE` and `RUN` use, so a client's
 * comparisons keep working unchanged.
 */
export const WIRE_PHASES = ["rest", "prep", "spawning", "engaged", "held"];
export const WIRE_RUN_PHASES = ["siege", "picking", "choosing", "done"];

export function packPhaseBits({ phase, runPhase, calledEarly, bossLeg }) {
  const p = Math.max(0, WIRE_PHASES.indexOf(phase));
  const r = Math.max(0, WIRE_RUN_PHASES.indexOf(runPhase));
  return (p & 0x07) | ((r & 0x03) << 3) | (calledEarly ? 32 : 0) | (bossLeg ? 64 : 0);
}

export function unpackPhaseBits(bits) {
  return {
    phase: WIRE_PHASES[bits & 0x07] ?? WIRE_PHASES[0],
    runPhase: WIRE_RUN_PHASES[(bits >> 3) & 0x03] ?? WIRE_RUN_PHASES[0],
    calledEarly: (bits & 32) !== 0,
    bossLeg: (bits & 64) !== 0,
  };
}

// ---------------------------------------------------------------------------- enemy bits
//
// Two bytes, and the split between them is not arbitrary: byte A is everything that decides
// WHICH MESH and WHERE, byte B is everything that decides how it is TINTED. Byte A is
// therefore full and byte B has room, which is where a later slice's per-enemy flags go.

/** Health uses seven bits; the remaining high bit carries the fuse flag. */
const HP_STEPS = 127;

export function packEnemyBits(e) {
  // type 0-6 in 3 bits, state 0-7 in 3 bits, then the two booleans that change how a body is
  // DRAWN rather than what it is. Exactly 8 bits, with nothing spare — all eight numeric
  // type values fit, but a ninth would not, and that is worth knowing before someone adds
  // one: `ENEMY_TYPE_KEYS.length` is the number to check.
  const a = (e.type & 0x07)
    | ((e.state & 0x07) << 3)
    | (e.carried ? 64 : 0)
    | (e.flash ? 128 : 0);
  // The old four-bit fraction hid several five-damage rifle hits behind one unchanged band.
  // Seven bits still fit in this existing byte and make authoritative damage move the tint/
  // target readout every one or two armoured hits instead of appearing broken.
  const hp = Math.round(Math.max(0, Math.min(1, e.hpFraction ?? 1)) * HP_STEPS);
  const b = (hp & 0x7f) | (e.fuseLit ? 128 : 0);
  return { bitsA: a, bitsB: b };
}

export function unpackEnemyBits(bitsA, bitsB) {
  return {
    type: bitsA & 0x07,
    state: (bitsA >> 3) & 0x07,
    // WHICH FRAME THE POSITION IS IN, and this single bit is the whole reason a latched
    // chewer does not skate. A body riding the deck or holding a leg is sent in hull-local
    // space, because the receiver already knows the hull's current transform; sent in world
    // space it would be stale by the hull's own travel — 45 cm at 120 ms, measured in
    // section 115 — relative to the leg it is chewing, which is the readout a player uses
    // to decide whether to drop down and fight.
    carried: (bitsA & 64) !== 0,
    flash: (bitsA & 128) !== 0,
    hpFraction: (bitsB & 0x7f) / HP_STEPS,
    fuseLit: (bitsB & 128) !== 0,
  };
}

// ------------------------------------------------------------------------ operative bits

/**
 * Exact repair-point ownership on the wire.
 *
 * Zero is deliberately "none", as it is for seats and stations. One names the reactor and
 * every later value is a leg index plus two, leaving no table in session.js that can drift
 * from this codec. The one-byte ceiling is explicit rather than wrapping onto another point.
 */
export function packRepairTarget(key) {
  if (key == null) return 0;
  if (key === "reactor") return 1;
  const match = /^leg:(\d+)$/.exec(key);
  const index = match ? Number(match[1]) : -1;
  if (!Number.isSafeInteger(index) || index < 0 || index > 253) {
    throw new RangeError(`repair target ${String(key)} does not fit the v${PROTOCOL_VERSION} wire`);
  }
  return index + 2;
}

export function unpackRepairTarget(code) {
  const value = Number(code);
  if (!Number.isInteger(value) || value <= 0 || value > 255) return null;
  return value === 1 ? "reactor" : `leg:${value - 2}`;
}

// Two bits for the station, so 0 means "on foot" and 1..3 name a mount. Derived from the
// mount count rather than hard-coded: `CFG.deckGun.mounts` has two today, and a third would
// still fit, but a fourth would silently wrap onto "on foot" — which would read as an
// operative teleporting off a gun. Worth the check being possible.
export const STATION_BITS = 2;
export const MAX_WIRE_STATIONS = (1 << STATION_BITS) - 1;

export function packOperativeBits({ based, station, repairing, downed, grounded, bayOpen }) {
  const s = Math.max(0, Math.min(MAX_WIRE_STATIONS, station ?? 0));
  return (based ? 1 : 0)
    | (repairing ? 2 : 0)
    | (downed ? 4 : 0)
    | ((s & MAX_WIRE_STATIONS) << 3)
    | (grounded ? 32 : 0)
    | (bayOpen ? 64 : 0);
}

export function unpackOperativeBits(bits) {
  return {
    based: (bits & 1) !== 0,
    repairing: (bits & 2) !== 0,
    downed: (bits & 4) !== 0,
    // 0 is on foot; 1..3 is a mount index plus one. The offset is what makes 0 mean "nobody
    // is at a gun" rather than "everybody is at gun zero", which is the same reason
    // `Crew.seatOf` is 1-based and 0 means nobody.
    station: (bits >> 3) & MAX_WIRE_STATIONS,
    grounded: (bits & 32) !== 0,
    bayOpen: (bits & 64) !== 0,
  };
}

// --------------------------------------------------------------------------- weapon bits

const WEAPON_SLOT_MASK = 0x01;
const WEAPON_COOLDOWN_MASK = 0x0f;
const WEAPON_SHOT_MASK = 0x07;

/** Weapon slot, cooldown and a rolling trigger sequence, packed into one byte. */
export function packWeaponBits({ slot, cooldown, shots }) {
  const s = Math.max(0, Math.trunc(slot ?? 0));
  if (s > WEAPON_SLOT_MASK) {
    throw new RangeError(`weapon slot ${s} does not fit the v${PROTOCOL_VERSION} wire`);
  }
  const cooldownStep = Math.round(Math.max(0, cooldown ?? 0) * 10);
  if (cooldownStep > WEAPON_COOLDOWN_MASK) {
    throw new RangeError(
      `weapon cooldown ${(cooldown ?? 0).toFixed(2)} does not fit the v${PROTOCOL_VERSION} wire`,
    );
  }
  const sequence = Math.max(0, Math.trunc(shots ?? 0)) & WEAPON_SHOT_MASK;
  return s | (cooldownStep << 1) | (sequence << 5);
}

export function unpackWeaponBits(bits) {
  return {
    slot: bits & WEAPON_SLOT_MASK,
    cooldown: ((bits >> 1) & WEAPON_COOLDOWN_MASK) / 10,
    shots: (bits >> 5) & WEAPON_SHOT_MASK,
  };
}

/** Grapple activity and the coordinate frame its anchor is encoded in. */
export function packGrappleBits({ active, onHull }) {
  return (active ? 1 : 0) | (active && onHull ? 2 : 0);
}

export function unpackGrappleBits(bits) {
  return {
    active: (bits & 1) !== 0,
    onHull: (bits & 2) !== 0,
  };
}

// --------------------------------------------------------------------------- input packets
//
// A separate message rather than a field on the snapshot, because it travels the other way
// and at a different rate: input goes up every TICK so the server never starves, while
// snapshots come down at 20 Hz. Sharing a codec would mean sharing a rate.

const INPUT = [
  ["version", "count"],
  ["kind", "count"],
  // Monotonic per client, never reset within a connection. The server echoes the last one it
  // consumed back in `ackSeq`, and that pairing is the whole of reconciliation.
  ["seq", "millis"],
  // The server tick whose targets the CLIENT was rendering for this command. Untrusted — a
  // client can claim any number — so the authority clamps it into the configured 250 ms
  // history before a ray query. It rewinds targets only, never the shooter or world geometry.
  ["clientTick", "millis"],
  ["held", "tally"],
  ["edges", "tally"],
  // Accumulated mouse movement since the last packet, in raw counts. Sent rather than a
  // resulting yaw, because the server owns where the operative is looking for the same reason
  // it owns where they are standing — and because `CFG.player.lookSensitivity` should be
  // applied once, on the authority, not twice.
  //
  // These are floats rather than the centimetre-coordinate kind. A delta can accumulate over
  // zero-step render frames or a browser stall and has no useful coordinate-style bound; i16
  // at scale 100 silently clipped fast pans above 327.67 counts, leaving prediction several
  // degrees ahead of authority and making reconciliation stutter left/right and up/down.
  ["lookDx", "float"],
  ["lookDy", "float"],
];

export const INPUT_BYTES = (() => {
  let n = 0;
  for (const [, kind] of INPUT) n += CODECS[KINDS[kind].codec].bytes;
  return n;
})();

export function encodeInput(cmd) {
  const buffer = new ArrayBuffer(INPUT_BYTES);
  const dv = new DataView(buffer);
  const clamped = [];
  let o = 0;
  const put = (kind, value) => {
    const k = KINDS[kind];
    const codec = CODECS[k.codec];
    codec.write(dv, o, quantise(kind, value, clamped));
    o += codec.bytes;
  };
  put("count", PROTOCOL_VERSION);
  put("count", MSG.INPUT);
  for (const [key, kind] of INPUT.slice(2)) put(kind, cmd[key]);
  return { buffer, clamped };
}

export function decodeInput(buffer) {
  const dv = viewOf(buffer);
  const total = dv.byteLength;
  // The input layout changed in protocol 9, so an old client necessarily sends a packet of
  // the old size. Read the one byte whose position is stable across versions before enforcing
  // this version's exact layout; otherwise every genuine stale-client mismatch is mislabeled
  // as a truncated current packet and the Worker's diagnostic points at transport corruption.
  if (total > 0) {
    const announcedVersion = dv.getUint8(0);
    if (announcedVersion !== PROTOCOL_VERSION) {
      throw new SnapshotError(
        `input protocol ${announcedVersion}, this build speaks ${PROTOCOL_VERSION}`,
        { cause: "version", got: announcedVersion, want: PROTOCOL_VERSION },
      );
    }
  }
  if (total !== INPUT_BYTES) {
    throw new SnapshotError(
      `input packet is ${total} bytes, expected ${INPUT_BYTES}`,
      { cause: "truncated", total },
    );
  }
  let o = 0;
  const take = (kind) => {
    const k = KINDS[kind];
    const codec = CODECS[k.codec];
    const raw = codec.read(dv, o);
    o += codec.bytes;
    return dequantise(kind, raw);
  };
  const version = take("count");
  if (version !== PROTOCOL_VERSION) {
    throw new SnapshotError(
      `input protocol ${version}, this build speaks ${PROTOCOL_VERSION}`,
      { cause: "version", got: version, want: PROTOCOL_VERSION },
    );
  }
  const kind = take("count");
  if (kind !== MSG.INPUT) {
    throw new SnapshotError(`expected an input packet, got kind ${kind}`, { cause: "kind" });
  }
  const cmd = { version, kind };
  for (const [key, k] of INPUT.slice(2)) {
    const value = take(k);
    // Unlike locally encoded values, bytes from a socket are untrusted. Float32 can represent
    // NaN and infinities, and either look delta would flow straight into Player.yaw/pitch and
    // poison authoritative transforms for the rest of the run. Reject the packet at the codec
    // boundary so malformed intent costs one input tick, as the Worker already promises.
    if (k === "float" && !Number.isFinite(value)) {
      throw new SnapshotError(
        `input field ${key} must be finite`,
        { cause: "value", field: key, got: value },
      );
    }
    cmd[key] = value;
  }
  return cmd;
}

/**
 * The worst error a kind can introduce at a given magnitude, in the field's own units.
 *
 * Exported so the harness can assert round-trip accuracy against the format's own stated
 * precision instead of against numbers typed into a test — which is the difference between
 * a test that checks the codec and a test that agrees with whoever wrote it.
 *
 * TAKES THE VALUE, because for one kind the error is not absolute. The first version was a
 * flat table with `f32: 0`, on the assumption that an unquantised field is exact. It is
 * not: float32 keeps 24 mantissa bits, so its error is RELATIVE to magnitude, and the
 * round-trip test duly failed on a gait phase of 918.27 by 2.35e-5. That was float32
 * behaving exactly as specified and a tolerance that had been asserted rather than derived.
 */
export function toleranceOf(kind, value = 1) {
  const k = KINDS[kind];
  if (k.codec === "f32") return Math.max(Math.abs(value), 1) * (2 ** -23);
  return 0.5 / k.scale;
}

/** The layout, for tests and for anything that wants to report on the format. */
export const LAYOUT = {
  HEADER, BODY, REPEATED, ENTITY, SPIKER_SHOT, OPERATIVE, INPUT, KINDS, CODECS,
};

// --------------------------------------------------------------------------- interpolation

/** Shortest-arc angle lerp, so a facing does not spin the long way round at +/-pi. */
function lerpAngle(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

const mix = (a, b, t) => a + (b - a) * t;

/**
 * Blend two decoded snapshots into one, for rendering between them.
 *
 * A PURE FUNCTION, so the harness can test it without a socket or a clock. That is the same
 * reason the codec lives in this file: everything here is arithmetic whose failures are
 * silent, and an interpolator that gets the frame rule wrong produces bodies sliding through
 * the hull rather than an error.
 *
 * WHAT IS BLENDED AND WHAT IS NOT. Only positions and facings are continuous; everything else
 * is taken from `b`, the newer snapshot. Blending a discrete value is meaningless at best —
 * half way between CHEWER and CLIMBER is BULWARK — and actively wrong for the flags: a hit
 * flash lerped to 0.5 is neither on nor off, and a tint band between two integers is a band
 * that does not exist.
 *
 * THE HULL IS NOT BLENDED AT ALL. It is predicted by re-running the real `Trampler.update`,
 * because the fortress consumes no input and is therefore reproducible exactly rather than
 * approximately. Interpolating it would put every hull-local reader 120 ms behind — which is
 * the 45 cm skate section 115 measures, reintroduced through the back door for every enemy,
 * anchor, emitter and repair point at once.
 *
 * A CHANGE OF FRAME IS NOT INTERPOLABLE, and this is the subtle one. If a body was carried in
 * `a` and free in `b` — it just fell off the deck — the two positions are in different
 * coordinate systems, and mixing the numbers gives a point in neither. The result would be a
 * body travelling through the hull on its way to a plausible answer. Snap to `b` instead,
 * which is what `attachTo()` does for the real player and what net.js already does for a
 * relayed pose, for exactly this reason.
 */
export function lerpSnapshot(a, b, t) {
  if (!a || a === b) return b;
  const f = t <= 0 ? 0 : t >= 1 ? 1 : t;

  const out = { ...b };

  // Release events are discrete newest-authority facts, never interpolated. Net consumes
  // them from the newest packet rather than this delayed render frame; retaining b's array
  // here makes the pure interpolator's contract explicit for any other caller.
  out.spikerShots = b.spikerShots ?? [];

  // Entities, matched by pool id AND spawn generation. A body present in `b` but not `a`,
  // or a slot whose occupant changed between them, has no history to blend from and appears
  // at its authoritative position rather than sliding in from the previous body's death.
  const prev = new Map();
  for (const e of a.entities ?? []) prev.set(e.id, e);

  out.entities = (b.entities ?? []).map((e) => {
    const p = prev.get(e.id);
    if (!p || p.generation !== e.generation) return e;
    // Bit 64 of bitsA is `carried`. Compared before blending, because it names the frame the
    // coordinates are in.
    if (((p.bitsA ^ e.bitsA) & 64) !== 0) return e;
    return {
      ...e,
      x: mix(p.x, e.x, f),
      y: mix(p.y, e.y, f),
      z: mix(p.z, e.z, f),
      yaw: lerpAngle(p.yaw, e.yaw, f),
    };
  });

  const prevOps = new Map();
  for (const o of a.operatives ?? []) prevOps.set(o.seat, o);

  out.operatives = (b.operatives ?? []).map((o) => {
    const p = prevOps.get(o.seat);
    if (!p) return o;
    // Bit 1 of `bits` is `based`. Same frame rule: a crewmate who stepped off the deck between
    // the two snapshots must not be lerped through the hull on the way down.
    if (((p.bits ^ o.bits) & 1) !== 0) return o;
    return {
      ...o,
      x: mix(p.x, o.x, f),
      y: mix(p.y, o.y, f),
      z: mix(p.z, o.z, f),
      yaw: lerpAngle(p.yaw, o.yaw, f),
    };
  });

  return out;
}
