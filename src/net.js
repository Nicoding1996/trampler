// The multiplayer client. BROWSER ONLY -- imported by main.js and nothing else,
// like render.js, fx.js, viewmodel.js and audio.js. The harness never sees it,
// which is why nothing here may be a rule the game depends on.
//
// WHAT THIS IS, STATED PLAINLY SO NOBODY LATER MISTAKES IT
//
// A RELAY. Every client simulates its own world and broadcasts where its own
// operative is standing; the server stores the latest pose per seat and fans them
// out. There is no authority, no prediction, no reconciliation, and no shared
// horde. Two players see each other move and nothing else. It is trivially
// cheatable and it is not the shipping architecture.
//
// It exists to answer the one question that can invalidate the whole plan, and
// which no amount of reasoning settles: DOES A CREWMATE STAY WELDED TO A WALKING,
// TURNING DECK? Unreal's own MovementBase handling is reported to struggle exactly
// there, and every entity in this game is stored relative to that hull. If a
// teammate skates astern, the architecture is wrong and it is better to find out
// with 200 lines than after the crew-array refactor.
//
// THE LATENCY ANSWER, WHICH IS THE POINT OF THE STRUCTURE
//
// A pose is sent in the frame it belongs to: hull-local when the sender is aboard,
// world when they are on the ground. That is not tidiness. The hull walks at 4.5 m/s, so
// a world-space pose 120 ms old is stale by however far the hull travelled -- measured at
// 45 cm for a crewmate standing still, every frame, forever, which is the whole crew
// visibly skating across a 26 m deck. In hull-local space that term disappears, because a
// stale pose is reinterpreted against a hull transform the RECEIVER already has: measured
// at 0.00 cm for the same standing crewmate.
//
// MEASURED, AND THE FIRST VERSION OF THIS COMMENT GOT THE OTHER HALF WRONG. It claimed
// the residual for a MOVING crewmate was "about 5 cm". It is not. The residual is their
// own travel across the deck over the delay, and at CFG.player.walkSpeed of 7.0 m/s that
// is 84 cm -- 132 cm sprinting. Larger than the skate it removes, not a twentieth of it.
// Nothing here needed changing; what needed changing was a number that invited the next
// reader to treat a remote position as exact.
//
// SO THE REAL ARGUMENT IS ABOUT WHAT EACH ERROR DEPENDS ON, not about its size:
//
//   hull-local   error = the walker's own deck-relative travel. Bounded by player speed,
//                and INDEPENDENT of the hull -- measured at 52 cm with the fortress
//                walking and 53 cm with it parked.
//   world-space  error = hull travel and own travel composed as vectors. Contains a term
//                nobody controls, which grows with hull speed -- and which can cancel by
//                luck, measured at 12 cm walking against the hull and 53 cm parked.
//
// That last figure is why a single side-by-side distance comparison is the wrong
// instrument and an earlier version of the test asserted one and failed: a walker heading
// against the hull's motion briefly makes WORLD-space the more accurate of the two. The
// property that holds regardless of which way anybody faces is the decoupling, and that
// is what verify.mjs section 115 asserts.

import * as THREE from "three";
import { CFG } from "./config.js";
import { Look, operativeGeometry } from "./look.js";
import { clamp01, damp, lerp } from "./util.js";
import {
  commitHandsInput, decode, encodeInput, lerpSnapshot, SnapshotError,
  unpackGrappleBits, unpackOperativeBits, unpackRepairTarget, unpackWeaponBits,
} from "./snapshot.js";
import { applyEntities, applySnapshot, readInput, reconcile, resetSession } from "./session.js";

const WS_OPEN = 1;
const _v = new THREE.Vector3();
const _remoteHand = new THREE.Vector3();
const _remoteAnchor = new THREE.Vector3();
const _remoteDirection = new THREE.Vector3();
const _remoteMidpoint = new THREE.Vector3();
const _remoteRight = new THREE.Vector3();
const _remoteForward = new THREE.Vector3();
const _remoteQuaternion = new THREE.Quaternion();
const _remoteShotStart = new THREE.Vector3();
const _remoteShotEnd = new THREE.Vector3();
const _remoteShotDirection = new THREE.Vector3();
const _remoteShotMidpoint = new THREE.Vector3();
const REMOTE_UP = new THREE.Vector3(0, 1, 0);
const REMOTE_ROPE_MAT = new THREE.MeshBasicMaterial({ color: CFG.grapple.ropeColor });
const REMOTE_HOOK_MAT = new THREE.MeshBasicMaterial({ color: CFG.grapple.hookColor });
const REMOTE_SHOT_MAT = new THREE.MeshBasicMaterial({
  color: CFG.combat.weapon.tracerColor,
  transparent: true,
  opacity: CFG.combat.weapon.tracerOpacity,
  depthWrite: false,
});
/** Scratch for the avatar draw, hoisted so a frame with three crewmates allocates nothing. */
const _pose = { x: 0, y: 0, z: 0, yaw: 0, based: false };
const _seen = new Set();

/** cm precision. Not a real quantisation, just an honest refusal to send 17 digits. */
const cm = (n) => Math.round(n * 100) / 100;

/** Shortest-arc angle lerp, so facing does not spin the long way round at ±pi. */
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Net {
  /**
   * @param sim the local simulation, or null for pose-relay-only behaviour.
   *
   * Wanted as a bag rather than as a growing argument list because `applySnapshot` needs
   * the trampler, the director, the run and the crew, and slices 2 and 3 add the horde and
   * the operatives. It is the same shape main.js already builds for its pure readers.
   *
   * Optional on purpose. With no `sim` this class is exactly the relay it was, which keeps
   * the solo path and `tools/scene-cost.mjs` unaffected -- and means a snapshot arriving
   * before main.js has finished wiring cannot throw.
   */
  constructor(scene, player, trampler, sim = null) {
    this.scene = scene;
    this.player = player;
    this.trampler = trampler;
    this.sim = sim;

    // The crew as the newest blended snapshot describes them, which is what the avatars are
    // drawn from. Held rather than drawn on arrival for the same reason `pending` is: a
    // snapshot lands at 20 Hz and the avatars are drawn every frame.
    this.wireOps = [];
    this.wireAt = 0;

    // THE LATEST SNAPSHOT, HELD RATHER THAN APPLIED ON ARRIVAL.
    //
    // Applied by main.js immediately before the fixed-step loop, and the ordering is
    // load-bearing: `Trampler.update` captures the previous frame's inverse transform at
    // its top, and `Player.#applyBasedMovement` uses that capture to carry anybody standing
    // on the deck. A correction applied mid-frame would be seen by the next step as real
    // hull travel and would shove the local operative across the deck -- measured at 114 cm
    // for a one-metre correction before session.js was taught to carry its passengers.
    //
    // LATEST WINS, and nothing is queued. A snapshot superseded before it was applied is
    // worthless: the newer one describes the same world more recently. Queueing would only
    // add latency to state nobody ever saw. Same argument the server makes for poses.
    // THE SNAPSHOT BUFFER, held rather than applied on arrival, and now deep enough to
    // interpolate through rather than one-deep.
    //
    // Playback advances in SERVER TICKS, not in packet-arrival milliseconds. TCP preserves
    // packets but can deliver several together after head-of-line blocking; arrival-time
    // interpolation compressed that server-time interval into a few milliseconds and made
    // every burst look like a teleport. The cursor advances at the server's fixed rate and
    // never extrapolates beyond the newest complete sample.
    this.buffer = [];
    this.renderTick = null;
    this.renderReady = false;
    this.renderEntities = null;
    this.snapshotsApplied = 0;
    this.snapshotsDropped = 0;
    this.lastSnapshotTick = 0;
    this.lastSnapshotResetId = null;
    // Interpolation samples the same bracketing packet for several render frames. Local
    // reconciliation must not: one authoritative tick is one measurement, however many times
    // its world state is drawn.
    this.lastReconciledTick = -1;
    this.interpAlpha = 0;
    this.starvedFrames = 0;

    // PREDICTION HISTORY for the local operative, keyed on the input sequence it belongs to.
    // Held in HULL-LOCAL space when aboard, for the same reason everything else is: the
    // comparison against the server's position has to happen in one frame, and the hull will
    // have moved between predicting and hearing back.
    this.history = [];
    // A decaying residual in the frame it was measured in. Hull-local residuals stay local
    // while the fortress turns and are rotated only as each portion is paid; converting the
    // whole vector once would rotate the deck underneath a world-space correction.
    this.correction = new THREE.Vector3();
    this.correctionBased = false;
    // Orientation residuals use the same measured frame and exponential pay-off as position.
    // Applying them all at once made one dropped mouse packet a visible camera snap even while
    // the positional half of the same reconciliation eased correctly.
    this.yawCorrection = 0;
    this.pitchCorrection = 0;
    this.lastError = 0;
    this.worstError = 0;
    this.lastLookError = 0;
    this.worstLookError = 0;
    this.snaps = 0;
    this.smoothings = 0;

    // OUTGOING INPUT. `seq` is monotonic for the life of the connection and never rewinds:
    // the server echoes the last one it consumed back as `ackSeq`, and that pairing is the
    // whole of reconciliation. A sequence that restarted would make an old ack look current.
    this.inputSeq = 0;
    this.inputsSent = 0;
    // What the server has acknowledged for OUR seat, so the HUD can show how far behind the
    // authority is without the number having to be inferred from a timestamp.
    this.ackSeq = 0;
    // Reconcile an acknowledgement once. Current snapshots may keep moving under a repeated
    // held input, but only `ack*` names the moment this sequence actually produced.
    this.lastReconciledSeq = 0;
    this.authorityResetId = null;
    this.authorityDeaths = null;
    this.authorityHurtCount = null;
    // A decode failure names its own clause. Kept as a field rather than only logged so the
    // gate can say "reload, you are running stale code" instead of "disconnected".
    this.protocolError = "";
    this.simReady = false;

    // Lobby admission waits for local art upload and shader preparation. A connected seat is
    // eligible for an authoritative start, so joining earlier would let another browser start
    // the run while this one is still behind a mandatory local gate.
    this.graphicsReady = false;
    this.pendingAdmission = null;

    // Multiplayer is a latched session mode, not a synonym for an open socket. Once a
    // client has chosen a lobby, losing the transport pauses at the last authority instead
    // of silently forking the same world into a new solo simulation.
    this.sessionActive = false;
    this.startRequested = false;

    this.socket = null;
    this.seat = 0;
    this.code = "";
    this.crew = [];
    this.crewMin = 2;
    this.crewMax = 4;
    this.hostSeat = 0;
    this.startTick = null;
    this.phase = "";
    this.status = "SOLO";
    this.error = "";
    this.startRefusal = "";

    /** seat -> { buffer: [], avatar, lastAt } */
    this.remotes = new Map();

    this.sendAcc = 0;

    // Where the lobby is. Explicit override first, then the local-development guess,
    // then same-origin -- which is the deployed case and the one that needs nothing.
    //
    // The guess exists because the alternative is a query string every developer has
    // to remember, and the failure when they forget is a gate that says it cannot
    // reach the lobby while a lobby is plainly running in the next terminal. See
    // CFG.net.devPagePort for why the two cannot share a port locally.
    const q = new URLSearchParams(location.search);
    // Built through URL rather than by string concatenation, and not only for
    // tidiness: a template literal containing "//" breaks tools/audit.mjs, which
    // strips line comments before template literals and so treats the protocol
    // separator as the start of a comment. That silently hid every CFG reference
    // after it in this file. The audit is fixed too, but the URL API is the right
    // way to change a port regardless.
    const devLobby = new URL(location.origin);
    devLobby.port = CFG.net.devLobbyPort;

    this.base = q.get("lobby")
      ?? (location.port === CFG.net.devPagePort ? devLobby.origin : "");

    this.#bindUi();

    // Auto-join from a shared link, so an invite is a URL and not an instruction.
    const invite = q.get("join");
    if (invite) this.join(invite);
  }

  get connected() {
    return this.socket !== null && this.socket.readyState === WS_OPEN;
  }

  // ---- session --------------------------------------------------------------

  /** Open any invite, join, or host request that arrived while graphics were warming. */
  setGraphicsReady() {
    if (this.graphicsReady) return;
    this.graphicsReady = true;

    const pending = this.pendingAdmission;
    this.pendingAdmission = null;
    if (!pending) return;

    if (pending.kind === "host") void this.host();
    else void this.join(pending.code);
  }

  async host() {
    if (!this.graphicsReady) {
      // Latest explicit choice wins over an invite that may have queued at construction.
      this.pendingAdmission = { kind: "host" };
      this.#say("PREPARING GRAPHICS BEFORE HOSTING…");
      return false;
    }

    this.#say("MINTING…");
    try {
      const res = await fetch(`${this.base}/lobby/new`, { method: "POST" });
      const body = await res.json();
      if (!body.code) throw new Error(body.error ?? "no code");
      await this.join(body.code);
    } catch (err) {
      this.#fail(`could not reach the lobby — ${err.message}`);
    }
  }

  async join(rawCode) {
    const code = (rawCode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 6) return this.#fail("a code is six characters");
    if (!this.graphicsReady) {
      this.pendingAdmission = { kind: "join", code };
      this.#say(`PREPARING GRAPHICS BEFORE JOINING ${code}…`);
      return false;
    }

    this.leave();
    this.#say(`JOINING ${code}…`);

    const wsBase = this.base
      ? this.base.replace(/^http/, "ws")
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

    const socket = new WebSocket(`${wsBase}/lobby/${code}`);
    // BEFORE ANY LISTENER, AND NOT OPTIONAL.
    //
    // A browser WebSocket delivers binary frames as a `Blob` by default, and reading a Blob
    // is asynchronous. That would have made every snapshot arrive a microtask late, out of
    // order under load, and impossible to decode synchronously in the frame loop -- and the
    // failure mode is not an error, it is `ev.data` being an object that JSON.parse chokes
    // on and the catch below silently discards. A shared fortress that never moves, with a
    // clean console.
    //
    // workerd sends ArrayBuffers regardless; this is purely the receiving end.
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.sessionActive = true;

    socket.addEventListener("message", (ev) => {
      // A replaced socket may still have an already-queued message callback. Connection
      // generation is the socket identity; old authority must never enter the new run.
      if (this.socket === socket) this.#onMessage(ev);
    });
    socket.addEventListener("close", (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.#clearRemotes();
      this.#clearAuthority();
      // The server names its refusals with an application close code, so say which
      // clause refused rather than "disconnected". Same argument as the refit
      // terminal naming its clause: a generic refusal sends the player to fix the
      // wrong thing.
      this.#fail(ev.reason || (ev.code === 1006 ? "no route to the lobby" : "disconnected"));
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.#fail("connection failed");
    });
  }

  /**
   * Tell the server to begin the authoritative run.
   *
   * NOTHING IS SHARED UNTIL THIS IS SENT, and its absence was a real bug that shipped through
   * four slices. The Durable Object builds its world on `start` and on nothing else; without the
   * message it stays a lobby, sends no snapshots, and every connected client runs its own
   * complete simulation. Two tabs, two separate games, exactly as before any of this existed.
   *
   * It went unnoticed because `tools/smoke-lobby.mjs` sends `start` itself in order to test the
   * server, so every live check passed against a server that was working and a client that never
   * asked it to. That is the project's own recurring lesson — a module can be correct and
   * uncalled — arriving for the third time, and the second time in this feature.
   *
   * HOST ONLY, matching the lobby's explicit transferable role. The server enforces the
   * permission too; this client-side gate exists so a guest click cannot hide the lobby or
   * acquire pointer lock while everybody is still waiting. The host may commit only once at
   * least two operatives are present.
   */
  start() {
    if (!this.graphicsReady) {
      this.#say("PREPARING GRAPHICS…");
      return false;
    }
    if (!this.sessionActive || this.phase === "running" || this.phase === "starting") return false;
    if (!this.isHost) {
      this.#say(`WAITING FOR HOST SEAT ${this.hostSeat || "—"}`);
      return false;
    }
    if (this.crew.length < this.crewMin) {
      this.#say("WAITING FOR A CREWMATE");
      return false;
    }
    this.startRequested = true;
    this.startRefusal = "";
    this.#tryStart();
    return true;
  }

  #tryStart() {
    if (!this.graphicsReady || !this.startRequested || !this.connected || !this.isHost) return;
    if (this.phase !== "lobby" || this.crew.length < this.crewMin) return;
    try {
      this.socket.send(JSON.stringify({ t: "start" }));
    } catch { /* the close handler will report it */ }
  }

  /** Release every authoritative level before the browser throttles this tab. */
  suspendInput() {
    this.history.length = 0;
    this.correction.set(0, 0, 0);
    this.correctionBased = false;
    this.yawCorrection = 0;
    this.pitchCorrection = 0;
    if (!this.connected || !this.seat) return;

    // Ordered with binary input by the WebSocket, but OUTSIDE that input queue. A neutral
    // command enqueued behind sixteen stale commands permits the exact movement/fire tail this
    // method exists to stop. Release clears the authority's queue immediately and deliberately
    // consumes neither an input sequence nor a simulation tick.
    try {
      this.socket.send(JSON.stringify({ t: "release" }));
    } catch { /* the close handler will report it */ }
  }

  /** Collapse a paused tab onto the latest packet instead of playing its buffered past. */
  resumeFromPause() {
    this.history.length = 0;
    this.correction.set(0, 0, 0);
    this.correctionBased = false;
    this.yawCorrection = 0;
    this.pitchCorrection = 0;
    this.renderEntities = null;
    this.sim?.horde?.clearRenderCombatFrame?.();
    if (this.buffer.length === 0) {
      this.renderTick = null;
      this.renderReady = false;
      return;
    }

    const latest = this.buffer[this.buffer.length - 1];
    // A fully suspended browser may not have dispatched WebSocket messages either. Never
    // relabel an old packet as current: that would rewind the whole sim on focus and snap it
    // forward again when the first real packet arrived. Wait for fresh authority instead.
    if (performance.now() - latest.at > CFG.net.staleMs) {
      this.buffer.length = 0;
      this.renderTick = null;
      this.renderReady = false;
      return;
    }
    this.buffer.length = 0;
    this.buffer.push(latest);
    this.renderTick = latest.state.tick;
    this.renderReady = false;
    this.renderEntities = latest.state.entities ?? null;
    // lastReconciledTick intentionally survives. A resumed render cursor may point at the
    // packet already consumed before suspension; one server tick is still one measurement.
  }

  leave() {
    this.pendingAdmission = null;
    const socket = this.socket;
    this.socket = null;
    this.sessionActive = false;
    this.startRequested = false;
    this.#clearRemotes();
    this.#clearAuthority();
    if (socket) {
      try { socket.close(1000, "left"); } catch { /* already gone */ }
    }
    this.seat = 0;
    this.code = "";
    this.crew = [];
    this.hostSeat = 0;
    this.startTick = null;
    this.phase = "";
    this.startRefusal = "";
  }

  /** Drop every fact tied to one authoritative run, so solo/rejoin cannot replay it. */
  #clearAuthority() {
    this.buffer.length = 0;
    this.renderTick = null;
    this.renderReady = false;
    this.renderEntities = null;
    this.history.length = 0;
    this.correction.set(0, 0, 0);
    this.correctionBased = false;
    this.yawCorrection = 0;
    this.pitchCorrection = 0;
    this.snapshotsApplied = 0;
    this.snapshotsDropped = 0;
    this.lastSnapshotTick = 0;
    this.lastSnapshotResetId = null;
    this.lastReconciledTick = -1;
    this.interpAlpha = 0;
    this.starvedFrames = 0;
    this.ackSeq = 0;
    this.lastReconciledSeq = 0;
    this.authorityResetId = null;
    this.authorityDeaths = null;
    this.authorityHurtCount = null;
    this.lastError = 0;
    this.worstError = 0;
    this.lastLookError = 0;
    this.worstLookError = 0;
    this.snaps = 0;
    this.smoothings = 0;
    this.wireOps = [];
    this.wireAt = 0;
    this.sendAcc = 0;
    this.simReady = false;
    this.sim?.horde?.clearRenderCombatFrame?.();
    this.sim?.repair?.setExternalClaims?.([]);
    this.sim?.repair?.setAuthorityTarget?.(null);
    if (this.sim?.weapon) this.sim.weapon.arbitrated = false;
    const localOp = this.sim?.operatives?.find((op) => op.player === this.player);
    if (localOp) localOp.seat = 0;
  }

  #onMessage(ev) {
    // BINARY IS STATE, TEXT IS BOOKKEEPING. Branch on the frame type rather than on a field
    // inside it, because a snapshot has no room for a discriminator string -- the whole
    // point of 49 bytes is that it carries no JSON at all.
    if (ev.data instanceof ArrayBuffer) {
      this.#onSnapshot(ev.data);
      return;
    }

    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.t) {
      case "hello":
        this.seat = msg.seat;
        this.code = msg.code;
        this.phase = msg.phase;
        this.hostSeat = msg.hostSeat ?? 0;
        this.crewMin = msg.crewMin ?? this.crewMin;
        this.crewMax = msg.crewMax ?? this.crewMax;
        this.startTick = msg.startTick ?? null;
        this.error = "";
        this.startRefusal = "";
        if (this.ui?.gateError) this.ui.gateError.textContent = "";
        // The browser owns one simulated operative. Its lobby seat arrives asynchronously;
        // name the kit now so sparse IDs are looked up by identity rather than array index.
        const localOp = this.sim?.operatives?.find((op) => op.player === this.player);
        if (localOp) {
          localOp.seat = msg.seat;
          // The browser constructs its one-member Crew before a lobby seat exists. Keep the
          // Crew identity map in step with the operative identity; otherwise a client seated
          // as 3 still reports itself as seat 1 to vote and gun-occupancy readers.
          const localCrew = this.sim?.crew;
          if (localCrew && localCrew.seatOf(localOp.player) !== msg.seat) {
            localCrew.remove(localOp.player);
            localCrew.add(localOp.player, msg.seat);
          }
        }
        // The server is the authority on its own rates. Reading them rather than
        // assuming them is what stops CFG.net.sendHz and the Worker's
        // SNAPSHOT_EVERY drifting into disagreement across two files.
        this.serverTickHz = msg.tickHz;
        this.serverSnapshotHz = msg.snapshotHz;
        this.#tryStart();
        break;

      case "crew": {
        const rosterChanged = msg.crew.length !== this.crew.length
          || msg.crew.some((member, i) => {
            const previous = this.crew[i];
            return previous?.seat !== member.seat || previous?.name !== member.name;
          });
        this.crew = msg.crew;
        this.phase = msg.phase;
        this.hostSeat = msg.hostSeat ?? this.hostSeat;
        this.crewMin = msg.crewMin ?? this.crewMin;
        this.crewMax = msg.crewMax ?? this.crewMax;
        this.startTick = msg.startTick ?? null;
        // Preserve a STARTING rollback's reason through the immediately following crew
        // broadcast, whose roster is unchanged. A real join/leave is the next actionable
        // state and clears the old refusal.
        if (rosterChanged) {
          this.startRefusal = "";
          if (this.ui?.gateError && !this.error) this.ui.gateError.textContent = "";
        }
        // Anyone no longer on the list has left; their avatar must go with them or
        // it stands on the deck forever.
        for (const seat of [...this.remotes.keys()]) {
          if (!msg.crew.some((c) => c.seat === seat)) this.#dropRemote(seat);
        }
        this.#renderCrew();
        break;
      }

      case "phase": {
        const previousPhase = this.phase;
        this.phase = msg.phase;
        this.hostSeat = msg.hostSeat ?? this.hostSeat;
        this.startTick = msg.startTick ?? null;
        const rolledBack = previousPhase === "starting" && msg.phase === "lobby";
        if (rolledBack) {
          // The host click already acquired pointer lock. If construction is cancelled
          // because the crew changed during its async imports, return every client to the
          // visible lobby instead of leaving a paused simulation behind a hidden gate.
          this.startRequested = false;
          this.simReady = false;
          this.startRefusal = msg.reason || "start cancelled";
          if (this.ui?.gateError) this.ui.gateError.textContent = this.startRefusal;
          // Input's pointerlockchange listener normally relabels an unlocked gate as
          // RESUME. This is not a paused run; install a later one-shot listener so the
          // lobby labels win after that generic handler has run.
          if (document.pointerLockElement) {
            document.addEventListener("pointerlockchange", () => {
              this.ui?.gate?.classList.remove("hidden", "resume");
              this.#renderCrew();
            }, { once: true });
          }
          document.exitPointerLock?.();
          this.ui?.gate?.classList.remove("hidden", "resume");
        } else if (msg.phase === "starting" || msg.phase === "running") {
          this.startRequested = false;
          // A construction failure is retryable on the same socket. An accepted authority
          // transition supersedes that old failure; transport failures cannot reach here.
          this.error = "";
          this.startRefusal = "";
          if (this.ui?.gateError) this.ui.gateError.textContent = "";
        }
        this.#renderCrew();
        break;
      }

      case "start":
        if (msg.accepted === false) {
          this.startRequested = false;
          this.startRefusal = msg.reason || "start refused";
          if (this.ui?.gateError) this.ui.gateError.textContent = this.startRefusal;
          // The roster can change after the host's click passes the local gate but before the
          // authority checks it. A refusal while the server is still in LOBBY must undo the
          // pointer lock acquired by that click; otherwise the host is left behind a hidden
          // awaiting-authority gate until Escape, mislabeled as a paused run when it returns.
          if (this.phase === "lobby") {
            if (document.pointerLockElement) {
              document.addEventListener("pointerlockchange", () => {
                this.ui?.gate?.classList.remove("hidden", "resume");
                this.#renderCrew();
              }, { once: true });
            }
            document.exitPointerLock?.();
            this.ui?.gate?.classList.remove("hidden", "resume");
            this.#renderCrew();
          }
          this.#say(`START REFUSED — ${this.startRefusal.toUpperCase()}`);
        }
        break;

      case "poses":
        this.#onPoses(msg.seats);
        break;

      case "input":
        // A current client never sends before its first baseline. If an old/racing client does,
        // the Worker names the refusal instead of counting and discarding intent invisibly.
        if (msg.accepted === false) {
          this.history.length = 0;
          this.simReady = false;
        }
        break;

      case "sim":
        // The server saying whether it managed to build a world. Worth surfacing rather
        // than inferring from "no snapshots have arrived": a client cannot otherwise tell
        // a server still loading from a server that failed, and those are different waits.
        this.simReady = !!msg.ready;
        this.hostSeat = msg.hostSeat ?? this.hostSeat;
        this.startTick = msg.startTick ?? this.startTick;
        if (msg.error) this.#fail(`the server could not build the world — ${msg.error}`);
        this.#renderCrew();
        break;
    }
  }

  /**
   * A state snapshot arrived. Decoded now, applied later.
   *
   * Decoding here rather than at apply time is deliberate: a malformed packet should be
   * discovered when it lands, so the refusal names the packet, and so a bad frame cannot
   * take the frame loop down with it. Applying here would be the ordering bug this class's
   * `pending` field exists to avoid.
   */
  #onSnapshot(buffer) {
    let state;
    try {
      state = decode(buffer);
    } catch (err) {
      if (err instanceof SnapshotError) {
        // A version mismatch is worth saying out loud EXACTLY ONCE and then living with,
        // because it will repeat 20 times a second and it is not recoverable by waiting.
        // The message already tells the player to reload, which is the actual fix for a
        // project with no build step and no cache busting.
        if (err.cause === "version" && this.protocolError !== err.message) {
          this.protocolError = err.message;
          this.#fail(err.message);
        }
        return;
      }
      throw err;
    }

    // Out-of-order delivery cannot happen on a WebSocket -- it is TCP, ordered and reliable,
    // which is the whole reason `interpDelayMs` pays for head-of-line blocking. So a tick
    // going backwards means the SERVER restarted its counter, which is a new run rather than
    // a late packet: drop the history, because interpolating from the old world into the new
    // one would drag every body across the map.
    const resetChanged = this.lastSnapshotResetId !== null
      && state.resetId !== this.lastSnapshotResetId;
    if (state.tick < this.lastSnapshotTick || resetChanged) {
      this.buffer.length = 0;
      this.renderTick = null;
      this.renderReady = false;
      this.renderEntities = null;
      this.sim?.horde?.clearRenderCombatFrame?.();
      this.history.length = 0;
      this.correction.set(0, 0, 0);
      this.correctionBased = false;
      this.lastReconciledTick = -1;
      this.lastReconciledSeq = 0;
      this.ackSeq = 0;
    }
    this.lastSnapshotTick = state.tick;
    this.lastSnapshotResetId = state.resetId;

    this.buffer.push({ at: performance.now(), state });
    while (this.buffer.length > CFG.net.snapshotBuffer) {
      this.buffer.shift();
      this.snapshotsDropped++;
    }
  }

  /**
   * The pair of snapshots bracketing one SERVER TICK, and how far between them we are.
   *
   * Packet arrival time cannot stand in for simulation time. TCP may release three packets
   * together after blocking; those snapshots still describe three 50 ms server intervals and
   * must be played over those intervals rather than compressed into one render frame.
   * Deliberately does NOT extrapolate past the newest sample: bodies stop, latch, burrow and
   * die, so holding is the only honest answer once the cursor catches authority.
   */
  #bracket(targetTick) {
    const b = this.buffer;
    if (b.length === 0) return null;
    if (b.length === 1 || targetTick <= b[0].state.tick) {
      return { a: null, b: b[0].state, t: 1 };
    }

    for (let i = 1; i < b.length; i++) {
      const lo = b[i - 1].state;
      const hi = b[i].state;
      if (targetTick > hi.tick) continue;
      const span = hi.tick - lo.tick;
      return {
        a: lo,
        b: hi,
        t: span > 0 ? clamp01((targetTick - lo.tick) / span) : 1,
      };
    }

    return {
      a: b[b.length - 2].state,
      b: b[b.length - 1].state,
      t: 1,
    };
  }

  /**
   * Apply the buffered world state and pay this frame's local correction. Returns true when a
   * snapshot was applied; correction payment still runs between packet arrivals.
   *
   * CALLED BY main.js IMMEDIATELY BEFORE THE FIXED-STEP LOOP, and nowhere else. The reason
   * is spelled out on `pending` and at length in session.js: a correction applied after a
   * step is read by the next step as real hull travel and drags anybody aboard with it.
   * `dt` is render time because smoothing is visual, but the resulting position must exist
   * before this frame's fixed steps are recorded into prediction history.
   *
   * Separate from `update()` on purpose. `update()` is a pure reader that runs with fx and
   * audio at the end of a frame; this MUTATES the simulation and belongs before it. Folding
   * them together would put a simulation write inside the presentation phase, which is the
   * one boundary this project keeps hardest.
   */
  applyPending(dt = 0, playbackDt = dt) {
    let applied = false;

    if (this.sim && this.buffer.length > 0) {
      const latestPacket = this.buffer[this.buffer.length - 1];
      const newest = latestPacket.state;
      const oldest = this.buffer[0].state;
      const tickHz = Number.isFinite(this.serverTickHz)
        ? this.serverTickHz
        : CFG.loop.stepHz;
      const delayTicks = (CFG.net.interpDelayMs / 1000) * tickHz;
      const bufferedTicks = newest.tick - oldest.tick;

      if (this.renderTick === null) this.renderTick = oldest.tick;

      // Do not consume the first packet immediately and then trail live by only one snapshot
      // interval forever. Hold until the buffer spans the configured delay, then play the
      // server timeline at exactly its fixed rate. Once started, a packet burst increases the
      // available ceiling but never the cursor's speed.
      if (!this.renderReady) {
        if (bufferedTicks >= delayTicks) {
          this.renderTick = Math.max(oldest.tick, newest.tick - delayTicks);
          this.renderReady = true;
        }
      } else {
        const nextTick = this.renderTick + Math.max(0, playbackDt) * tickHz;
        if (nextTick > newest.tick) this.starvedFrames++;
        this.renderTick = Math.min(newest.tick, nextTick);
      }

      // A prolonged burst may overrun even the bounded eight-packet history. The oldest
      // retained state is then the only valid lower bound; jumping to it is preferable to
      // interpolating against a packet that no longer exists.
      if (this.renderTick < oldest.tick) this.renderTick = oldest.tick;

      const pair = this.#bracket(this.renderTick);
      if (pair) {
        this.interpAlpha = pair.t;

        // The hull and all gameplay queries use the FRESHEST authority before fixed steps.
        // On frames without a new packet, restore newest entities because the preceding
        // presentation phase deliberately left the shared pool at its delayed render pose.
        if (newest.tick !== this.lastReconciledTick) {
          const generationChanged = this.authorityResetId === null
            || newest.resetId !== this.authorityResetId;
          if (generationChanged) resetSession(this.sim, { advanceGeneration: false });
          applySnapshot(this.sim, newest, this.seat);
          this.lastReconciledTick = newest.tick;
          this.#reconcileLocal(newest, generationChanged);
          this.snapshotsApplied++;
          // The gate may still say CONNECTING from the preceding `sim` message. The first
          // applied packet is the moment this client actually becomes authoritative, so
          // refresh the scope sentence on that transition rather than waiting for a later
          // crew event that may never come.
          if (this.snapshotsApplied === 1) this.#renderCrew();
        } else if (newest.entities) {
          applyEntities(this.sim, newest.entities);
        }

        // Delayed bodies are stored for the post-step presentation phase, never written into
        // the gameplay pool here. Weapon rays, repair threat checks, shop safety and emitter
        // targeting therefore see newest authority rather than a 120 ms-old visual pose.
        const blended = lerpSnapshot(pair.a, pair.b, pair.t);
        this.renderEntities = blended.entities ?? null;
        // The local presentation ray and the authority now ask about one named server tick.
        // Load the already-blended positions rather than approximating them from the newest
        // pool; applyPresentation draws this exact array after the predicted steps below.
        this.sim.horde.setRenderCombatFrame(
          this.renderTick,
          this.renderEntities ?? [],
        );
        this.sim.horde.combatTick = this.renderTick;
        this.wireOps = blended.operatives ?? [];
        this.wireAt = latestPacket.at;
        applied = true;
      }
    }

    // Before main.js records this frame's predicted steps. Paying at the old end-of-frame slot
    // made those marks omit a correction the visible player had already received.
    this.#payCorrection(dt);

    // A high-refresh render frame often performs no fixed step, so Player.update() may not run
    // after authority changed yaw, pitch, the hull transform, or a smoothed position. Refresh
    // the camera from the corrected player now; otherwise the renderer shows the previous pose
    // for a frame and the next packet appears as a second, unrelated camera jump.
    if (this.authoritative) {
      const p = this.sim.player;
      p.eyePosition(p.camera.position);
      p.camera.rotation.set(p.pitch, p.yaw, 0, "YXZ");
    }
    return applied;
  }

  /**
   * Apply delayed entity transforms only after this frame's fixed simulation work is done.
   *
   * The horde pool is shared with gameplay for now, so the next applyPending() restores newest
   * authority before any query. This narrow presentation phase is the minimal separation that
   * prevents delayed interpolation from changing combat while retaining one fixed pool.
   */
  applyPresentation(dt = 0) {
    if (!this.sim || this.renderEntities === null) return false;
    applyEntities(this.sim, this.renderEntities);
    this.sim.horde.updateSnapshotVisuals?.(dt);
    return true;
  }

  #syncLocalMetadata(mine, baseline) {
    const p = this.sim.player;
    const hurtChanged = this.authorityHurtCount !== null
      && mine.hurtCount !== this.authorityHurtCount;
    if (!baseline && hurtChanged) {
      p.timeSinceHurt = 0;
      p.lastHurt = Math.max(0, p.hp - mine.hp);
    }
    p.hp = mine.hp;
    p.hurtCount = mine.hurtCount;
    p.deaths = mine.deaths;
    if (this.sim.weapon) this.sim.weapon.kills = mine.kills;
    const authorityRepair = unpackRepairTarget(mine.repairTarget);
    // Position remains predicted, but exact repair identity is authority-owned. Do not
    // resurrect a locally stopped action from an older packet; only rename work still active,
    // while an authoritative refusal always clears it.
    if (!authorityRepair || p.repairing) p.repairing = authorityRepair;
    this.authorityDeaths = mine.deaths;
    this.authorityHurtCount = mine.hurtCount;
  }

  /**
   * Reconcile the winch's authoritative level after every local command is accounted for.
   *
   * The wire already carries this state for observer ropes. The local path used to ignore it,
   * so a hard adoption cancelled an active authoritative pull and left the operative moving
   * with no rope. Do not apply an older level while a local fire/cut command is still in flight;
   * once authority has caught up—or hard adoption is already required—the current level and
   * anchor are definitive.
   */
  #syncLocalGrapple(mine) {
    const grapple = this.player.grapple ?? this.sim.grapple;
    if (!grapple) return;

    const state = unpackGrappleBits(mine.grappleBits);
    if (!state.active) {
      if (grapple.active) grapple.cancel();
      return;
    }

    const resumed = !grapple.active;
    const frameChanged = grapple.onHull !== state.onHull;
    grapple.active = true;
    grapple.onHull = state.onHull;
    const anchor = state.onHull ? grapple.anchorLocal : grapple.anchorWorld;
    anchor.set(mine.grappleX, mine.grappleY, mine.grappleZ);
    grapple.cooldown = 0;

    if (resumed || frameChanged) {
      grapple.timer = 0;
      grapple.stuckTime = 0;
      grapple.lastDist = Infinity;
      _v.copy(anchor);
      if (state.onHull) this.trampler.localToWorld(_v);
      grapple.anchorWasAbove = _v.y > this.player.position.y;
    }
  }

  /** Adopt CURRENT authority when two states cannot be reconciled in one coordinate frame. */
  #hardAdoptCurrent(mine) {
    const p = this.sim.player;
    const b = unpackOperativeBits(mine.bits);

    p.grapple?.cancel();
    p.cancelMantle();
    if (p.station) p.station.dismount(p);
    for (const gun of this.sim.guns ?? []) {
      if (gun.operator === p) gun.evict();
    }

    if (b.based) {
      p.base = this.trampler;
      _v.set(mine.x, mine.y, mine.z);
      this.trampler.localToWorld(_v);
      p.position.copy(_v);
      p.yaw = mine.yaw + this.trampler.yaw;
    } else {
      p.base = null;
      p.position.set(mine.x, mine.y, mine.z);
      p.yaw = mine.yaw;
    }
    p.pitch = mine.pitch;
    p.velocity.set(mine.vx, mine.vy, mine.vz);
    p.grounded = b.grounded;

    const station = b.station > 0 ? this.sim.guns?.[b.station - 1] : null;
    if (station && !station.operator) station.mount(p);
    // `cancel()` above clears a locally predicted rope before the coordinate-frame rewrite.
    // Restore it immediately when the CURRENT authority says the pull is still active.
    this.#syncLocalGrapple(mine);

    // A hard authority change may land between fixed steps; refresh the camera now rather
    // than rendering one stale frame before Player.update gets its next turn.
    p.eyePosition(p.camera.position);
    p.camera.rotation.set(p.pitch, p.yaw, 0, "YXZ");

    this.history.length = 0;
    this.correction.set(0, 0, 0);
    this.correctionBased = b.based;
    this.yawCorrection = 0;
    this.pitchCorrection = 0;
    this.lastReconciledSeq = mine.ackSeq;
    this.snaps++;
  }

  /**
   * Move retained prediction marks by a correction already applied to the live player.
   *
   * Marks newer than an acknowledgement are outcomes in the same prediction timeline. If the
   * live player is corrected but those marks are not, every later ack measures the original
   * error again and applies it again — one real turn becoming a rapid spin as the queue drains.
   * A mark in another coordinate frame is left alone; that transition is deliberately handled
   * by hard adoption when its acknowledgement arrives.
   */
  #rebaseHistory(based, dx = 0, dy = 0, dz = 0, dYaw = 0, dPitch = 0) {
    for (const mark of this.history) {
      if (mark.based !== based) continue;
      mark.x += dx;
      mark.y += dy;
      mark.z += dz;
      mark.yaw += dYaw;
      mark.pitch = Math.max(
        -CFG.player.pitchLimit,
        Math.min(CFG.player.pitchLimit, mark.pitch + dPitch),
      );
    }
  }

  /**
   * Reconcile one exact acknowledgement, while current metadata remains authoritative every
   * snapshot. A grace-repeated held command may move current state under an unchanged ack; it
   * must not generate a second correction for a moment already measured.
   */
  #reconcileLocal(newest, generationChanged = false) {
    const mine = newest.operatives?.find((o) => o.seat === this.seat);
    if (!mine) return;
    this.ackSeq = mine.ackSeq;

    const p = this.sim.player;
    const current = unpackOperativeBits(mine.bits);
    const localBased = p.base === this.trampler;
    const localStation = p.station ? (this.sim.guns?.indexOf(p.station) ?? -1) + 1 : 0;
    const deathChanged = this.authorityDeaths !== null && mine.deaths !== this.authorityDeaths;
    const firstBaseline = this.authorityResetId === null;
    // Current authority and the live client are only comparable after every local prediction
    // has been acknowledged. Before then the client may already have jumped or mounted while
    // this packet still describes the older frame; adopting it would rewind that transition
    // and its look input, then snap forward again when the exact acknowledgement arrives.
    const authorityCaughtUp = mine.ackSeq >= this.inputSeq;
    const currentFrameMismatch = current.based !== localBased
      || current.station !== localStation;
    const incompatible = generationChanged || firstBaseline || deathChanged
      || (authorityCaughtUp && currentFrameMismatch);

    this.#syncLocalMetadata(mine, firstBaseline || generationChanged);
    this.authorityResetId = newest.resetId;

    if (incompatible) {
      this.#hardAdoptCurrent(mine);
      return;
    }

    // Current grapple state is safe to adopt only after every locally predicted fire/cut edge
    // has an acknowledgement. Before then this snapshot may legitimately describe the level
    // from before that edge.
    if (authorityCaughtUp) this.#syncLocalGrapple(mine);

    // Current health and counters still update above, but one sequence gets one positional
    // measurement however many newer snapshots repeat it.
    if (mine.ackSeq <= this.lastReconciledSeq) return;
    this.lastReconciledSeq = mine.ackSeq;

    while (this.history.length > 0 && this.history[0].seq < mine.ackSeq) this.history.shift();
    const mark = this.history[0]?.seq === mine.ackSeq ? this.history[0] : null;
    if (!mark) {
      // The mark aged out or the authority skipped commands after a queue overflow. There is
      // no same-moment comparison left, so current authority is safer than inventing one.
      this.#hardAdoptCurrent(mine);
      return;
    }

    const ackState = unpackOperativeBits(mine.ackBits);
    if (ackState.based !== mark.based) {
      // A transition may straddle this historical sequence by one tick yet already have
      // converged by the time its packet arrives (most visibly, two sides landing one tick
      // apart). Those ack positions are in incompatible frames, so there is no residual to
      // measure, but adopting CURRENT authority would rewrite an already-correct live frame
      // and erase every newer mark. Consume only this measurement and let the next ack compare
      // normally. A transition that is still refused now remains a hard authority change.
      if (current.based === localBased) {
        while (this.history.length > 0 && this.history[0].seq <= mine.ackSeq) {
          this.history.shift();
        }
        return;
      }
      this.#hardAdoptCurrent(mine);
      return;
    }

    // Orientation is a residual just like position. Paying this whole delta on the packet's
    // render frame made a dropped mouse command a visible snap—the reproduced 300 ms burst
    // produced five degrees in one frame. `#payCorrection` applies and rebases only the portion
    // actually paid, so later acknowledgements cannot charge the same turn twice.
    const yawFix = angleDelta(mark.yaw, mine.ackYaw);
    const pitchFix = mine.ackPitch - mark.pitch;
    this.yawCorrection = yawFix;
    this.pitchCorrection = pitchFix;
    this.lastLookError = Math.hypot(yawFix, pitchFix);
    if (this.lastLookError > this.worstLookError) this.worstLookError = this.lastLookError;

    const r = reconcile(mark, {
      x: mine.ackX,
      y: mine.ackY,
      z: mine.ackZ,
    }, {
      deadZone: CFG.net.correctionDeadZone,
      snapAt: CFG.net.correctionSnapAt,
    });
    this.lastError = r.error;
    if (r.error > this.worstError) this.worstError = r.error;
    while (this.history.length > 0 && this.history[0].seq <= mine.ackSeq) this.history.shift();

    if (r.action === "none") {
      this.correction.set(0, 0, 0);
      this.correctionBased = ackState.based;
      return;
    }

    if (r.action === "snap") {
      this.snaps++;
      this.correction.set(0, 0, 0);
      this.correctionBased = ackState.based;
      if ((p.base === this.trampler) !== ackState.based) return;

      // Unlike a smoothed correction, a snap is fully paid now, so every retained mark in
      // this frame must move with the live prediction now as well.
      this.#rebaseHistory(ackState.based, r.dx, r.dy, r.dz);
      _v.set(r.dx, r.dy, r.dz);
      if (ackState.based) {
        const x = _v.x;
        const z = _v.z;
        const c = Math.cos(this.trampler.yaw);
        const s = Math.sin(this.trampler.yaw);
        _v.x = x * c + z * s;
        _v.z = -x * s + z * c;
      }
      p.position.add(_v);
      return;
    }

    this.smoothings++;
    this.correction.set(r.dx, r.dy, r.dz);
    this.correctionBased = ackState.based;
  }

  /**
   * Record what this client predicted for one input sequence.
   *
   * Called by main.js right after the step that consumed that command, so the recorded position
   * is the OUTCOME of the input rather than the state before it. Recording before the step would
   * compare the server's result against this client's starting point and read a whole tick of
   * legitimate movement as error.
   */
  recordPrediction() {
    if (!this.authoritative || !this.sim || !this.seat) return;
    const p = this.sim.player;
    const based = p.base === this.trampler;
    _v.copy(p.position);
    let yaw = p.yaw;
    if (based) {
      this.trampler.worldToLocal(_v);
      yaw -= this.trampler.yaw;
    }
    this.history.push({
      seq: this.inputSeq, based, x: _v.x, y: _v.y, z: _v.z, yaw, pitch: p.pitch,
    });
    // A second of history at 60 Hz. Longer buys nothing: a snapshot acknowledging something
    // older than that has been overtaken several times.
    while (this.history.length > 90) this.history.shift();
  }

  /** Pay off the newest correction target, in the coordinate frame that authored it. */
  #payCorrection(dt) {
    if (!this.sim) return;
    const positionPending = this.correction.lengthSq() > 0;
    const lookPending = Math.abs(this.yawCorrection) > 0
      || Math.abs(this.pitchCorrection) > 0;
    if (!positionPending && !lookPending) return;

    const player = this.sim.player;
    const basedNow = player.base === this.trampler;
    if (basedNow !== this.correctionBased) {
      // Ground and hull-local numbers cannot be mixed. The next authority packet will measure
      // the new frame; carrying either residual across would manufacture a teleport or turn.
      this.correction.set(0, 0, 0);
      this.yawCorrection = 0;
      this.pitchCorrection = 0;
      return;
    }

    // Exponential, which is what `damp` gives every other smoothed quantity in this project.
    const k = 1 - Math.exp(-CFG.net.correctionRate * dt);

    if (lookPending) {
      const yawStep = this.yawCorrection * k;
      const requestedPitchStep = this.pitchCorrection * k;
      const oldPitch = player.pitch;
      player.yaw += yawStep;
      player.pitch = Math.max(
        -CFG.player.pitchLimit,
        Math.min(CFG.player.pitchLimit, player.pitch + requestedPitchStep),
      );
      const pitchStep = player.pitch - oldPitch;
      this.yawCorrection -= yawStep;
      // Decay the requested remainder even if the pitch clamp consumed less of it; authority is
      // clamped by the same rule, so an outward residue at the boundary is only codec noise.
      this.pitchCorrection -= requestedPitchStep;
      this.#rebaseHistory(this.correctionBased, 0, 0, 0, yawStep, pitchStep);
      if (Math.abs(this.yawCorrection) < 1e-6) this.yawCorrection = 0;
      if (Math.abs(this.pitchCorrection) < 1e-6) this.pitchCorrection = 0;
    }

    if (!positionPending) return;

    _v.copy(this.correction).multiplyScalar(k);
    this.correction.sub(_v);

    // Smoothed position is paid over several rendered frames. Move retained prediction marks
    // by exactly the portion paid THIS frame—not by the full target at acknowledgement time—
    // so a later ack compares against the same corrected timeline the live player has actually
    // reached. `_v` is still in the frame that authored the marks here.
    this.#rebaseHistory(this.correctionBased, _v.x, _v.y, _v.z);

    if (this.correctionBased) {
      // Stored hull-local and rotated NOW, so a turning fortress cannot rotate underneath a
      // world-space remainder that was converted once several frames ago.
      const x = _v.x;
      const z = _v.z;
      const c = Math.cos(this.trampler.yaw);
      const s = Math.sin(this.trampler.yaw);
      _v.x = x * c + z * s;
      _v.z = -x * s + z * c;
    }
    player.position.add(_v);

    // The residual below a millimetre is discarded so it cannot accumulate float noise.
    if (this.correction.lengthSq() < 1e-6) this.correction.set(0, 0, 0);
  }

  /**
   * Capture one physical input command before its predicted simulation step.
   *
   * CALLED ONCE PER STEP, NOT ONCE PER RENDERED FRAME, and the distinction matters at both
   * ends of the frame-rate range. A client at 144 fps runs zero steps on most frames, while a
   * client at 30 fps runs two. The command is captured now so edges and mouse delta describe
   * this exact step, but sent afterwards so repair admission can commit which action owns the
   * operative's hands.
   *
   * `includeEdges` is true only for the FIRST step of a rendered frame. The local Input holds
   * one set of one-shot presses per frame, and `pressed()` consumes them, so exactly one step
   * can legitimately claim them.
   */
  prepareInput(input, includeEdges) {
    // No baseline, no prediction. Sending during world construction was counted and discarded
    // by the Worker while the browser moved locally, so the first snapshot looked like a
    // teleport back to spawn. Sequence zero remains the baseline until authority exists.
    if (!this.authoritative || !this.connected || !this.seat) return null;
    this.inputSeq++;
    // This is the target frame visibly under the crosshair, not a second local counter. The
    // authority treats it only as an untrusted rewind request and clamps it to 250 ms; rounding
    // costs at most half a 60 Hz tick while preserving the existing four-byte input field.
    const clientTick = Math.max(0, Math.round(this.renderTick ?? this.lastSnapshotTick));
    // THE SAME KEY THE SERVER WILL USE. Set before the step that fires, so a locally-drawn tracer
    // scatters exactly as the authoritative round does. Without this the two ends draw from
    // independent streams and the beam points somewhere the shot did not go — permanently, from
    // the first mispredicted shot onward.
    const w = this.sim?.weapon;
    if (w) {
      w.spreadKey = this.inputSeq;
      w.shotsThisKey = 0;
      // Presentation only from here on: trace, flash and count, but deal nothing and publish
      // nothing. See the long note in weapon.js's shootFrom.
      w.arbitrated = true;
    }
    const cmd = readInput(input, {
      seq: this.inputSeq,
      clientTick,
      // Captured by Input's keydown handler against the panel actually visible then. Do not
      // infer this from sim state here: applyPending may have installed a newer phase while
      // the edge waited through a zero-step render frame.
      purchaseOwner: input.purchaseOwner,
      purchaseContext: input.purchaseContext,
    });
    if (!includeEdges) cmd.edges = 0;
    return cmd;
  }

  /** Send the action selected by the predicted step for a previously captured command. */
  sendInput(cmd) {
    if (!cmd || !this.connected || !this.seat) return false;
    // E and fire may both be physically held, but the authority must receive the one action
    // prediction actually performed. Otherwise a simultaneous remote claim can turn a locally
    // suppressed shot into an authoritative fallback shot that appears only on correction.
    const committed = commitHandsInput(
      cmd,
      !!this.sim?.player?.repairing,
      !!this.sim?.player?.station,
    );
    try {
      this.socket.send(encodeInput(committed).buffer);
      this.inputsSent++;
      return true;
    } catch {
      // A synchronous refusal means the socket is going away; the close handler deals with it.
      return false;
    }
  }

  /** How far the server is behind this client's input, in commands. */
  get inputLag() {
    return Math.max(0, this.inputSeq - this.ackSeq);
  }

  /** Is this socket the lobby's current, transferable host? */
  get isHost() {
    return this.seat > 0 && this.seat === this.hostSeat;
  }

  /** Is this browser committed to a lobby, including while its transport is down? */
  get multiplayer() {
    return this.sessionActive && this.sim !== null;
  }

  /** Has this multiplayer session received at least one authoritative baseline? */
  get authoritative() {
    return this.multiplayer && this.snapshotsApplied > 0;
  }

  /** Multiplayer without a usable live authority: render the gate, but never fork solo. */
  get awaitingAuthority() {
    return this.multiplayer && (!this.connected || !this.authoritative);
  }

  #onPoses(seats) {
    const now = performance.now();
    for (const p of seats) {
      if (p.seat === this.seat) continue;
      const r = this.#remote(p.seat);
      // Stamped with the LOCAL arrival time, not a server timestamp. Interpolating
      // against our own clock needs no clock sync at all, and a server clock would
      // be the wrong tool twice over -- Workers freeze Date.now() between I/O, and
      // any offset estimate would itself need smoothing.
      r.buffer.push({ at: now, x: p.x, y: p.y, z: p.z, yaw: p.yaw, based: !!p.b });
      r.lastAt = now;
      // Two intervals of delay needs three samples to bracket it; eight is slack for
      // a burst without letting a paused tab accumulate a minute of history.
      while (r.buffer.length > 8) r.buffer.shift();
    }
  }

  // ---- frame ---------------------------------------------------------------

  update(dt) {
    if (this.connected) {
      this.sendAcc += dt;
      const interval = 1 / CFG.net.sendHz;
      if (this.sendAcc >= interval) {
        // Modulo rather than zeroing, so a long frame does not silently halve the
        // send rate. Same reason the server accumulates instead of trusting its
        // timer.
        this.sendAcc %= interval;
        this.#sendPose();
      }
    }
    this.#drawRemotes(dt);
  }

  #sendPose() {
    const based = this.player.base === this.trampler;

    _v.copy(this.player.position);
    let yaw = this.player.yaw;
    if (based) {
      this.trampler.worldToLocal(_v);
      // Yaw goes into the hull's frame too, and this is not symmetry for its own
      // sake. The receiver parents the avatar to trampler.group, which already
      // carries the hull's rotation, so sending a world yaw would apply the hull's
      // turn twice. It is also what the game itself does -- #carry spins the view
      // by yawDelta, so standing still on a turning deck turns you in world space.
      yaw -= this.trampler.yaw;
    }

    this.socket.send(JSON.stringify({
      t: "pose",
      x: cm(_v.x), y: cm(_v.y), z: cm(_v.z),
      yaw: cm(yaw),
      b: based ? 1 : 0,
    }));
  }

  /**
   * Draw the crew, from the SNAPSHOT rather than from the pose relay.
   *
   * WHY THIS MOVED. The avatars used to be fed by `#onPoses`, off a `poses` message the
   * server broadcast twenty times a second. That message no longer exists -- the relay was
   * replaced by the binary snapshot protocol -- so `#onPoses` was never called, `this.remotes`
   * stayed empty, and no crewmate was ever created. The figure was correct code behind a dead
   * entry point, which presents as "multiplayer shows nobody" and is indistinguishable from a
   * broken model.
   *
   * The snapshot carries strictly more than the relay did: seat, position, yaw, hp, and a bit
   * field with the frame flag, the station index, repairing and downed. So the states this
   * avatar cannot yet express -- somebody seated at a deck gun, somebody kneeling at a leg --
   * are already on the wire and are a matter of reading them, not of extending the protocol.
   *
   * Interpolation is NOT done here any more either. `lerpSnapshot` already blended these
   * positions, including snapping rather than mixing across a change of frame, so the local
   * buffer and `#sample` are no longer in this path.
   */
  #drawRemotes(dt) {
    // NO SNAPSHOTS AT ALL is the one case the crew list below cannot cover, and it is why
    // CFG.net.staleMs survived the move off the relay.
    //
    // `wireOps` holds its last value by design -- that is what lets the avatars be drawn every
    // frame from a 20 Hz feed. So if the feed stops, the crew stands frozen on the deck for
    // ever, which is the ghost the knob was written against. The crew list can say "seat 3
    // left"; it cannot say "nothing has arrived from anybody", because a dead connection sends
    // no list either.
    if (this.wireAt > 0 && performance.now() - this.wireAt > CFG.net.staleMs) {
      this.#clearRemotes();
      this.wireOps = [];
      this.wireAt = 0;
      return;
    }

    _seen.clear();

    for (const w of this.wireOps) {
      // Never draw yourself. The local operative is a camera, not a body in front of it.
      if (w.seat === this.seat) continue;
      _seen.add(w.seat);

      const r = this.#remote(w.seat);
      _pose.x = w.x;
      _pose.y = w.y;
      _pose.z = w.z;
      _pose.yaw = w.yaw;
      // The frame flag, which decides whether #place parents the avatar to the hull or to the
      // world. Read through the exported unpacker rather than by masking the bit here, for the
      // reason `isSubmerged` is exported: a bit index written out by hand in a second place is
      // a wrong answer rather than an error.
      _pose.based = unpackOperativeBits(w.bits).based;

      r.lastAt = performance.now();
      this.#animate(r, _pose, dt);
      this.#place(r.avatar, _pose);
      this.#drawRemoteGrapple(r, w);
      this.#drawRemoteShot(r, w, dt);
    }

    // A seat the snapshot has stopped describing has gone. Dropped from what the world
    // actually contains rather than on a stale timer, which is what the relay needed because
    // it had no authoritative crew list to compare against.
    for (const seat of [...this.remotes.keys()]) {
      if (!_seen.has(seat)) this.#dropRemote(seat);
    }
  }

  /**
   * Advance a crewmate's walk cycle.
   *
   * Phase comes from DISTANCE TRAVELLED, not from a clock. A clock-driven cycle
   * scissors the legs of somebody standing still and slides the feet of somebody
   * walking; distance cannot do either, with no threshold to tune. See
   * CFG.net.gaitStride for the dividend this collects from poses being sent in
   * hull-local space.
   */
  #animate(r, pose, dt) {
    const c = CFG.net;

    // A CHANGE OF FRAME IS NOT A DISPLACEMENT. Hull-local and world are different
    // coordinate systems, so the difference between a pose in one and a pose in the
    // other is a number in neither -- and it is a large one, since the deck sits
    // 7.5 m above the sand. Contribute no step across the switch, for the same
    // reason #sample refuses to interpolate across it.
    const framed = r.lastBased === pose.based;
    const step = framed ? Math.hypot(pose.x - r.lastX, pose.z - r.lastZ) : 0;

    r.lastX = pose.x;
    r.lastZ = pose.z;
    r.lastBased = pose.based;

    // Modulo keeps the accumulator small. Wrapping by a full turn leaves both sin(g)
    // and sin(2g) continuous, so the roll below does not jump at the seam.
    r.gait = (r.gait + (step / c.gaitStride) * Math.PI * 2) % (Math.PI * 2);

    // Smooth the AMPLITUDE only. The phase stays welded to real distance.
    const speed = dt > 0 ? step / dt : 0;
    r.speed = damp(r.speed, speed, c.gaitEase, dt);
    const amp = clamp01(r.speed / CFG.player.walkSpeed);

    const swing = Math.sin(r.gait) * c.gaitSwing * amp;
    r.legL.rotation.x = swing;
    r.legR.rotation.x = -swing;

    // Weight shift on every step, so twice the stride frequency. Roll rather than a
    // vertical bob, which would lift the boots off the deck.
    r.rig.rotation.z = Math.sin(r.gait * 2) * c.gaitRoll * amp;
    r.rig.rotation.x = c.gaitLean * amp;
  }

  /**
   * The pose to draw at `target`, interpolated between the two samples that
   * bracket it.
   *
   * Deliberately does NOT extrapolate past the newest sample. A player's next
   * position is not predictable from their last two -- they stop, turn, drop off a
   * deck -- so extrapolation buys a few milliseconds of apparent freshness and pays
   * for it in the one artefact this game cannot afford: invariant 20 forbids
   * anything that reads as a body teleporting, and a corrected extrapolation is
   * exactly that. Holding the last known pose looks like someone standing still,
   * which is a thing players do.
   */
  #sample(buffer, target) {
    if (buffer.length === 0) return null;
    if (buffer.length === 1 || target <= buffer[0].at) return buffer[0];

    for (let i = buffer.length - 1; i > 0; i--) {
      const b = buffer[i];
      const a = buffer[i - 1];
      if (target < a.at) continue;
      if (target > b.at) break;

      // A CHANGE OF FRAME IS NOT INTERPOLABLE, and this is the subtle one.
      //
      // `a` may be hull-local and `b` world, because the sender jumped off the deck
      // between them. Those are different coordinate systems; lerping the numbers
      // produces a position in neither, and the avatar would fly through the hull
      // on its way to a plausible answer. Snap to the newer sample instead -- which
      // is what attachTo() does for the real player, for the same reason.
      if (a.based !== b.based) return b;

      const span = b.at - a.at;
      const t = span > 0 ? (target - a.at) / span : 1;
      return {
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        z: lerp(a.z, b.z, t),
        yaw: lerpAngle(a.yaw, b.yaw, t),
        based: b.based,
      };
    }

    // Past the newest sample: hold it. See the note above on not extrapolating.
    return buffer[buffer.length - 1];
  }

  /**
   * Put the avatar in the frame the pose was authored in, by REPARENTING rather
   * than by converting coordinates every frame.
   *
   * This is the structural rule the whole project runs on -- parent the mesh to
   * trampler.group and store its position in local space -- and using it here means
   * three.js applies the hull's current transform for us. A pose 120 ms old is
   * therefore drawn against the hull's position THIS frame, which is the entire
   * reason a crewmate does not skate.
   */
  #place(avatar, pose) {
    const wantParent = pose.based ? this.trampler.group : this.scene;
    if (avatar.parent !== wantParent) wantParent.add(avatar);
    avatar.position.set(pose.x, pose.y, pose.z);
    avatar.rotation.y = pose.yaw;
    avatar.visible = true;
  }

  #remoteHandPosition(r, pitch, out) {
    r.avatar.updateWorldMatrix(true, false);
    r.avatar.getWorldPosition(out);
    r.avatar.getWorldQuaternion(_remoteQuaternion);

    _remoteRight.set(1, 0, 0).applyQuaternion(_remoteQuaternion);
    _remoteForward.set(0, Math.sin(pitch), -Math.cos(pitch))
      .applyQuaternion(_remoteQuaternion);

    out.y += CFG.player.eyeHeight - CFG.player.height / 2;
    out.addScaledVector(_remoteRight, 0.28);
    out.addScaledVector(_remoteForward, 0.35);
    out.y -= 0.22;
    return out;
  }

  /** Draw the delayed observer cue for an authoritative grapple pull. */
  #drawRemoteGrapple(r, wire) {
    const grapple = unpackGrappleBits(wire.grappleBits);
    if (!grapple.active) {
      r.rope.visible = false;
      r.hook.visible = false;
      return;
    }

    _remoteAnchor.set(wire.grappleX, wire.grappleY, wire.grappleZ);
    if (grapple.onHull) this.trampler.localToWorld(_remoteAnchor);
    this.#remoteHandPosition(r, wire.pitch, _remoteHand);

    _remoteDirection.subVectors(_remoteAnchor, _remoteHand);
    const length = _remoteDirection.length();
    _remoteMidpoint.addVectors(_remoteHand, _remoteAnchor).multiplyScalar(0.5);

    r.rope.position.copy(_remoteMidpoint);
    r.rope.scale.set(1, Math.max(length, 0.001), 1);
    r.rope.quaternion.setFromUnitVectors(REMOTE_UP, _remoteDirection.normalize());
    r.rope.visible = true;
    r.hook.position.copy(_remoteAnchor);
    r.hook.visible = true;
  }

  /** Draw one observer-only cue when the authoritative rolling shot sequence advances. */
  #drawRemoteShot(r, wire, dt) {
    const { shots } = unpackWeaponBits(wire.weaponBits);

    // A crewmate may enter view after firing. Baseline rather than replaying their last shot as
    // a historical flash; only a sequence change observed while this avatar exists is an event.
    if (r.lastWeaponShots === null) {
      r.lastWeaponShots = shots;
      r.shotLife = 0;
      r.tracer.visible = false;
      r.muzzle.visible = false;
      return;
    }

    const changed = shots !== r.lastWeaponShots;
    if (changed) {
      r.lastWeaponShots = shots;
      _remoteShotStart.set(wire.shotStartX, wire.shotStartY, wire.shotStartZ);
      _remoteShotEnd.set(wire.shotEndX, wire.shotEndY, wire.shotEndZ);
      _remoteShotDirection.subVectors(_remoteShotEnd, _remoteShotStart);
      const length = _remoteShotDirection.length();

      if (length < 1e-4) {
        r.shotLife = 0;
        r.tracer.visible = false;
        r.muzzle.visible = false;
      } else {
        _remoteShotMidpoint.addVectors(_remoteShotStart, _remoteShotEnd).multiplyScalar(0.5);
        const w = CFG.combat.weapon;
        const radius = w.tracerRadius + length * w.tracerWiden;

        r.tracer.position.copy(_remoteShotMidpoint);
        r.tracer.scale.set(radius, length, radius);
        r.tracer.quaternion.setFromUnitVectors(
          REMOTE_UP,
          _remoteShotDirection.divideScalar(length),
        );
        r.tracer.visible = true;
        r.muzzle.position.copy(_remoteShotStart);
        r.muzzle.visible = true;
        r.shotLife = w.tracerLife;
      }
    } else if (r.shotLife > 0) {
      r.shotLife = Math.max(0, r.shotLife - dt);
      if (r.shotLife === 0) {
        r.tracer.visible = false;
        r.muzzle.visible = false;
      }
    }
  }

  #remote(seat) {
    let r = this.remotes.get(seat);
    if (r) return r;
    r = {
      buffer: [],
      ...this.#makeAvatar(seat),
      lastAt: performance.now(),
      // Walk-cycle state. `lastBased` starts null rather than false so the first
      // drawn frame counts as a frame CHANGE and contributes no step -- otherwise
      // the distance from the origin to wherever the crewmate actually is arrives as
      // one enormous stride.
      gait: 0,
      speed: 0,
      lastX: 0,
      lastZ: 0,
      lastBased: null,
      // Observer-only shot state. Null suppresses a historical flash when the avatar is first
      // seen; subsequent modulo-sequence changes arm one short-lived tracer and muzzle cue.
      lastWeaponShots: null,
      shotLife: 0,
    };
    this.remotes.set(seat, r);
    return r;
  }

  /**
   * Build one crewmate.
   *
   * Two nested groups, and both are load-bearing. The OUTER group is what #place
   * reparents and positions, so that method stays exactly what it was and keeps
   * owning the frame question on its own. The INNER rig is what the walk cycle
   * rotates, so animation can never fight the pose for the same transform -- which
   * is the same mistake as writing camera shake before player.update and watching it
   * get discarded.
   */
  #makeAvatar(seat) {
    const c = CFG.net;
    const colour = c.seatColors[(seat - 1) % c.seatColors.length];
    const parts = operativeGeometry(c.avatarRadius, c.avatarHeight);

    // Cached by role+params, so seats share materials and re-joining the same seat
    // reuses one rather than leaking a new material per connection.
    //
    // THREE roles, and only the third is per-seat. The coat and the gear are the same
    // drab pair for everybody, so they cache once across the whole crew rather than once
    // per seat; the seat colour rides entirely on the signal pieces. That is the fix for
    // a figure that read as a plastic toy: see CFG.net.bodyColor.
    const mat = Look.std("crew", {
      color: c.bodyColor,
      roughness: 0.85,
      metalness: 0.05,
    });
    const gearMat = Look.std("crew_gear", {
      color: c.gearColor,
      roughness: 0.55,
      metalness: 0.35,
    });
    const signalMat = Look.std("crew_signal", {
      color: colour,
      emissive: colour,
      emissiveIntensity: c.seatEmissive,
      roughness: 0.4,
      metalness: 0.0,
    });

    const avatar = new THREE.Group();
    const rig = new THREE.Group();
    avatar.add(rig);

    const mesh = (geo, material) => {
      const m = new THREE.Mesh(geo, material);
      // castShadow is opt-in here (invariant 32): a shadow pass is the whole scene
      // drawn again, and a crewmate's shadow is not what sells the scale of anything.
      m.castShadow = false;
      m.receiveShadow = false;
      rig.add(m);
      return m;
    };

    mesh(parts.canvas, mat);
    mesh(parts.gear, gearMat);
    mesh(parts.signal, signalMat);

    // One geometry, two meshes. Each leg's origin is its hip, so rotation.x swings it
    // about the joint rather than about the operative's navel.
    //
    // Placed, not mirrored. The leg is symmetric across x already, and a scale.x of -1
    // would flip its winding: three.js sets front-face winding per MATERIAL and does
    // not compensate for a negative-determinant matrix, so the mesh would render
    // inside-out. Free symmetry beats a mirror that needs a second material to be
    // correct.
    const legL = mesh(parts.leg, mat);
    const legR = mesh(parts.leg, mat);
    legL.position.set(-parts.hip.x, parts.hip.y, 0);
    legR.position.set(parts.hip.x, parts.hip.y, 0);

    // World-space observer effects. They cannot be children of the avatar because a hull-local
    // avatar may connect to world geometry, and a fired tracer is the frozen world-space ray
    // the authority actually drew. Keeping both ends in one frame makes that choice explicit.
    const effects = new THREE.Group();
    effects.name = `crew-${seat}-effects`;

    const rope = new THREE.Mesh(
      new THREE.CylinderGeometry(CFG.grapple.ropeRadius, CFG.grapple.ropeRadius, 1, 6),
      REMOTE_ROPE_MAT,
    );
    rope.name = `crew-${seat}-grapple-rope`;
    rope.frustumCulled = false;
    rope.visible = false;
    effects.add(rope);

    const hook = new THREE.Mesh(
      new THREE.SphereGeometry(CFG.grapple.hookRadius, 10, 8),
      REMOTE_HOOK_MAT,
    );
    hook.name = `crew-${seat}-grapple-hook`;
    hook.visible = false;
    effects.add(hook);

    const tracer = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 6),
      REMOTE_SHOT_MAT,
    );
    tracer.name = `crew-${seat}-shot-tracer`;
    tracer.frustumCulled = false;
    tracer.visible = false;
    effects.add(tracer);

    const muzzle = new THREE.Mesh(
      new THREE.SphereGeometry(CFG.combat.weapon.muzzleRadius, 10, 8),
      REMOTE_SHOT_MAT,
    );
    muzzle.name = `crew-${seat}-muzzle-flash`;
    muzzle.frustumCulled = false;
    muzzle.visible = false;
    effects.add(muzzle);

    this.scene.add(effects);
    avatar.visible = false;
    this.scene.add(avatar);
    return { avatar, rig, legL, legR, effects, rope, hook, tracer, muzzle };
  }

  #dropRemote(seat) {
    const r = this.remotes.get(seat);
    if (!r) return;
    r.avatar.parent?.remove(r.avatar);
    r.effects.parent?.remove(r.effects);
    // Traversed rather than named part by part, so a piece added to either the avatar or its
    // observer effects cannot be the one thing nobody remembered to free. Deduped because both
    // legs share one geometry. Materials are shared and deliberately survive a seat leaving.
    const freed = new Set();
    for (const root of [r.avatar, r.effects]) {
      root.traverse((o) => {
        if (o.isMesh && !freed.has(o.geometry)) {
          freed.add(o.geometry);
          o.geometry.dispose();
        }
      });
    }
    this.remotes.delete(seat);
  }

  #clearRemotes() {
    for (const seat of [...this.remotes.keys()]) this.#dropRemote(seat);
  }

  // ---- the gate's multiplayer controls -------------------------------------

  #bindUi() {
    this.ui = {
      gate: document.getElementById("gate"),
      cta: document.querySelector("#gate .cta"),
      panel: document.getElementById("mp"),
      host: document.getElementById("mp-host"),
      join: document.getElementById("mp-join"),
      input: document.getElementById("mp-code"),
      status: document.getElementById("mp-status"),
      crew: document.getElementById("mp-crew"),
      copy: document.getElementById("mp-copy"),
      scope: document.getElementById("mp-scope"),
      gateError: document.getElementById("gate-err"),
    };
    if (!this.ui.panel) return;

    // Input owns the actual pointer-lock request on the gate's bubble phase. Intercept a
    // multiplayer click first when this browser is not allowed to use it: guests wait for
    // the host, a solo host waits for a crewmate, and everyone waits for the first shared
    // authority baseline. Browser security forbids granting pointer lock remotely, so guests
    // still click once after RUNNING; that gesture joins an already common server timeline.
    this.ui.gate?.addEventListener("click", (e) => {
      if (e.target.closest?.("#mp")) return;
      if (!this.sessionActive) return;

      const hostCanStart = this.connected
        && this.phase === "lobby"
        && this.isHost
        && this.crew.length >= this.crewMin;
      const canEnterRun = this.connected
        && this.phase === "running"
        && this.authoritative;
      if (hostCanStart || canEnterRun) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      if (!this.connected) this.#say("WAITING FOR THE LOBBY");
      else if (this.phase === "starting") this.#say("STARTING TOGETHER…");
      else if (this.phase === "running") this.#say("CONNECTING TO THE SHARED START…");
      else if (!this.isHost) this.#say(`WAITING FOR HOST SEAT ${this.hostSeat || "—"}`);
      else this.#say("WAITING FOR A CREWMATE");
    }, true);

    // The gate's own click handler requests pointer lock, which hides the gate and
    // starts the game. Without this, reaching for the join button starts a solo run.
    this.ui.panel.addEventListener("click", (e) => e.stopPropagation());

    // Keep code entry local to the field. Input currently rejects every unlocked gameplay
    // key, and stopping propagation here also prevents a future gate-level shortcut from
    // claiming characters that belong to a join code.
    for (const type of ["keydown", "keyup"]) {
      this.ui.input.addEventListener(type, (e) => e.stopPropagation());
    }
    this.ui.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.join(this.ui.input.value);
    });

    this.ui.host.addEventListener("click", () => this.host());
    this.ui.join.addEventListener("click", () => this.join(this.ui.input.value));

    // Copies a JOIN LINK rather than the bare code, because the constructor already
    // auto-joins from `?join=`, so a link is one click for the person receiving it and a
    // code is a code they then have to type into the right box.
    this.ui.copy.addEventListener("click", async () => {
      if (!this.code) return;
      const link = new URL(location.href);
      link.searchParams.set("join", this.code);
      try {
        await navigator.clipboard.writeText(link.href);
        this.ui.copy.textContent = "COPIED";
      } catch {
        // Clipboard access is permission-gated and fails outright on a non-secure
        // origin, which http://localhost is not but a LAN IP would be. Selecting the
        // text is a working fallback rather than a dead button.
        this.#selectCode();
        this.ui.copy.textContent = "SELECTED — COPY IT";
      }
      setTimeout(() => { this.ui.copy.textContent = "COPY LINK"; }, 1600);
    });

    this.#say("SOLO — the game plays exactly as it does alone");
  }

  /** Put the join link in the code box and select it, for when the clipboard refuses. */
  #selectCode() {
    const link = new URL(location.href);
    link.searchParams.set("join", this.code);
    this.ui.input.value = link.href;
    this.ui.input.select();
  }

  #say(text) {
    this.status = text;
    if (this.ui?.status) this.ui.status.textContent = text;
  }

  #fail(reason) {
    this.error = reason;
    if (this.ui?.gateError) this.ui.gateError.textContent = reason;
    // A transport failure while playing must make the gate visible again. Keeping pointer
    // lock would leave the session correctly paused but provide no visible explanation or
    // route back to the lobby controls.
    document.exitPointerLock?.();
    this.#say(reason.toUpperCase());
    this.#renderCrew();
  }

  #renderCrew() {
    if (!this.ui?.crew) return;
    if (!this.code) {
      this.ui.crew.textContent = "";
      if (this.ui.copy) this.ui.copy.hidden = true;
      if (this.ui.scope) this.ui.scope.textContent = "";
      return;
    }

    this.ui.crew.textContent = `${this.code} · ${this.crew
      .map((c) => `${c.seat}:${c.name}${c.seat === this.hostSeat ? " (HOST)" : ""}`)
      .join("  ")}`;
    if (this.ui.copy) this.ui.copy.hidden = false;

    // Preserve a named transport refusal. A late crew/sim event may still be queued after a
    // close; replacing the error with a normal seat status would hide why the gate reopened.
    if (this.seat && !this.error) {
      if (this.startRefusal) {
        this.#say(`START REFUSED — ${this.startRefusal.toUpperCase()}`);
      } else if (this.phase === "lobby") {
        if (this.isHost) {
          this.#say(this.crew.length < this.crewMin
            ? `HOST · SEAT ${this.seat} — WAITING FOR A CREWMATE`
            : `HOST · ${this.crew.length} OPERATIVES — CLICK TO START`);
        } else {
          this.#say(`SEAT ${this.seat} OF ${this.crew.length} — WAITING FOR HOST SEAT ${this.hostSeat}`);
        }
      } else if (this.phase === "starting") {
        this.#say(`SEAT ${this.seat} OF ${this.crew.length} — STARTING TOGETHER…`);
      } else if (this.phase === "running") {
        this.#say(this.authoritative
          ? `SEAT ${this.seat} OF ${this.crew.length} — AUTHORITATIVE RUN`
          : `SEAT ${this.seat} OF ${this.crew.length} — JOINING SHARED START…`);
      }
    }

    if (this.ui.cta) {
      const resuming = this.ui.gate?.classList.contains("resume");
      if (this.phase === "lobby") {
        this.ui.cta.textContent = this.isHost
          ? (this.crew.length >= this.crewMin ? "CLICK TO START" : "WAITING FOR CREWMATE")
          : "WAITING FOR HOST";
      } else if (this.phase === "starting") {
        this.ui.cta.textContent = "STARTING TOGETHER…";
      } else if (this.phase === "running" && !this.authoritative) {
        this.ui.cta.textContent = "CONNECTING TO SHARED START…";
      } else if (this.phase === "running") {
        this.ui.cta.textContent = resuming ? "CLICK TO RESUME" : "CLICK TO PLAY";
      }
    }

    // WHAT IS ACTUALLY SHARED, said here rather than discovered by playing. STARTING is a
    // real server phase: nobody receives RUNNING until construction succeeds, and startTick
    // identifies the one authority-clock boundary all clients then follow.
    if (this.ui.scope) {
      let shared;
      if (this.phase === "lobby") {
        shared = `LOBBY — the host starts one shared run for ${this.crewMin}–${this.crewMax} operatives.`;
      } else if (this.phase === "starting") {
        shared = "STARTING TOGETHER — building one authority before any client advances.";
      } else if (this.authoritative) {
        shared = `AUTHORITATIVE RUN · START TICK ${this.startTick ?? "—"} — one fortress, one clock, one horde, one damage state.`;
      } else if (this.simReady) {
        shared = `CONNECTING TO SHARED START TICK ${this.startTick ?? "—"}…`;
      } else {
        shared = "WAITING FOR THE SERVER TO BUILD THE AUTHORITATIVE RUN…";
      }
      this.ui.scope.textContent = this.crew.length > 1 || this.phase === "running"
        ? shared
        : `${shared} WAITING FOR A CREWMATE.`;
    }
  }
}
