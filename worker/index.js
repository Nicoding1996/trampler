// The multiplayer session layer: a Worker that mints join codes, and a Durable
// Object that owns one game session.
//
// WHY A DURABLE OBJECT RATHER THAN A PLAYER HOSTING
//
// A DO is addressable by name, so `idFromName(code)` makes the join code *the
// server's address*. No matchmaking service, no lobby table, no NAT traversal,
// no port forwarding, no certificate. And because the authority sits at an edge
// PoP instead of on somebody's PC, two things that are normally unavoidable
// simply do not exist here: host advantage (the host at 0 ms while everyone else
// pays RTT) and host migration.
//
// WHAT THIS SLICE IS FOR
//
// This began as a tick-rate relay spike and now owns the authoritative game state. The
// architectural check is still whether a 60 Hz tick inside a Durable Object actually
// holds 60 Hz. Local whole-run measurements put the 400-body crowd around 0.6–0.95 ms
// per frame, roughly 40–55 ms of CPU per second of wall clock; the sim-check also includes
// the authority-only rewind-history write. Those are local planning figures, not a bound on
// edge hardware. What the runtime docs do not promise is timer *fidelity*. If the tick is
// ragged, the simulation cannot live here and the architecture changes to a client host
// with the DO as a relay. Better to know that on day one than in week three.
//
// HIBERNATION IS DELIBERATELY NOT USED
//
// `ctx.acceptWebSocket()` lets the runtime evict the isolate after ~10 s of
// inactivity, which is right for a chat room and exactly wrong for an object
// holding a tick loop and an in-memory world. `server.accept()` keeps it hot.
// The lobby-before-the-run could hibernate; the running session cannot.

// Four. Not a lobby limit -- the fortress caps the crew long before the lobby
// does: two gun mounts (and manning one pins you), four legs, three reactor
// slots, and a 26 x 16 m deck to fight under. Six players means two with no
// station to take, which turns the oscillation into a fixed assignment.
import { PROTOCOL_VERSION } from "../src/snapshot.js";

const CREW_MAX = 4;
// Multiplayer begins with a pair. A one-seat lobby is still useful while the host shares
// its code, but starting it would create a solo run that nobody else can join afterwards.
const CREW_MIN = 2;

// The simulation rate. Matches the harness's fixed DT of 1/60 on purpose -- that
// is the timestep the 829 assertions are measured against, and the game loop
// still needs to be moved onto it.
const TICK_HZ = 60;

// Snapshots go out at every third tick, so 20 Hz. That is the band Valve's
// interpolation figures put a client in at 60 fps, and sending every tick would
// triple the bandwidth for state nobody can perceive changing that fast.
const SNAPSHOT_EVERY = 3;

// HOW OFTEN TO ASK THE RUNTIME TO WAKE US, WHICH IS NOT THE TICK RATE.
//
// The first version of this file did `setInterval(1000 / TICK_HZ)` and measured
// 32.81 Hz. The cause was not workerd: plain node on the same Windows box, with
// no runtime and no network in the way, holds a ~15.5 ms floor and rounds every
// request up to a multiple of it, so a 16.67 ms request becomes 31 ms and a
// 33.33 ms request becomes 46.5. tools/tick-granularity.mjs is that measurement.
//
// Asking for less than a step and stepping on MEASURED elapsed time makes the
// rate independent of the timer's resolution: at a 15.5 ms floor we wake ~64
// times a second and run one or two steps each time, and the average is a true
// 60 Hz. At a 1 ms floor we wake often and mostly run zero steps. Either way the
// tick counter advances at 60 Hz, which is the only thing downstream cares about.
//
// This is Fix Your Timestep applied to a server, and it is the same accumulator
// the game loop still needs. Worth noting it arrived here first because a network
// made the variable timestep measurable, which is what the plan predicted.
const WAKE_MS = 5;
const STEP_MS = 1000 / TICK_HZ;
// The same number in seconds, which is what the simulation wants. Derived rather than
// written out, so the two cannot drift -- and it must equal CFG.loop.stepHz's reciprocal,
// which tools/smoke-lobby.mjs asserts because a Durable Object cannot import config.js.
const STEP_SECONDS = 1 / TICK_HZ;

// A stall must not turn into one enormous invocation. The game loop clamps dt to
// 1/30 for the same reason -- so an alt-tab cannot tunnel the player through the
// hull -- and here it stops a hundred queued steps landing in a single WebSocket
// message's CPU budget. Fifteen steps is a quarter second of catch-up.
const MAX_CATCHUP_MS = 250;

// No 0/O, no 1/I/L, no U. People read these aloud and type them from memory, and
// every one of those pairs is a transcription error waiting to happen. Thirty
// symbols over six characters is 729 million codes.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;

// How many WAKE deltas to keep -- roughly ten seconds' worth, since a healthy
// clock wakes about as often as it steps. Long enough for a percentile to mean
// something, short enough that a stall shows up rather than being averaged away
// by a good minute either side of it.
const JITTER_WINDOW = TICK_HZ * 10;

// Application close codes. A refusal has to name its cause: "cannot join" sends
// the player to guess, and the three causes want three different responses. Same
// argument as the refit terminal naming which clause refused it.
const CLOSE_FULL = 4001;
const CLOSE_IN_PROGRESS = 4002;
const CLOSE_PROTOCOL = 4003;

// `WebSocket.OPEN`. Spelled out because the class constant is not reliably
// reachable off an instance in every runtime, and a wrong `undefined` here would
// silently skip every send -- a server that ticks and broadcasts nothing.
const WS_OPEN = 1;

/** Codes are read aloud and pasted, so normalise before looking anything up. */
function normaliseCode(raw) {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function validCode(code) {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

function mintCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  // Modulo bias over a 30-symbol alphabet from 256 values is about 4% on the
  // first ten symbols. Irrelevant for a room code -- this is not a secret, it is
  // a thing you say out loud -- and rejection sampling here would buy nothing.
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** Is a browser origin allowed to mutate or join this lobby endpoint? */
function originAllowed(request) {
  const raw = request.headers.get("origin");
  // CLI smoke tools and Worker-to-DO requests do not carry Origin. They are not browser
  // cross-origin requests, and remain supported deliberately.
  if (!raw) return true;
  try {
    const source = new URL(raw);
    const target = new URL(request.url);
    if (source.origin === target.origin) return true;
    // Local development necessarily crosses 5173 -> 8787. Trust only a page served from
    // this machine; an arbitrary internet origin must not mint codes or board a socket.
    return source.hostname === "localhost"
      || source.hostname === "127.0.0.1"
      || source.hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * CORS headers, and ONLY for a loopback origin.
 *
 * Deployed, the page and the lobby share an origin and none of this is reached --
 * same-origin requests are not CORS-checked at all. It exists purely because local
 * development cannot share a port: `npm start` serves the page from 5173 and
 * `npm run dev:mp` serves the lobby from 8787, so every fetch between them is
 * cross-origin. See CFG.net.devPagePort for why that split is unavoidable.
 *
 * WHY NOT `*`. That would be one character and it would let any page on the internet
 * mint lobby codes against a deployed instance. The endpoint holds no secrets and a
 * spare Durable Object evicts itself, so the damage is small -- but "small" is not a
 * reason to hand a write endpoint to every origin when the only caller that needs it
 * is on this machine. Reflecting a verified loopback origin costs the same and grants
 * nothing to anybody else.
 *
 * WebSocket upgrades are not protected by CORS. `originAllowed` is therefore enforced
 * explicitly below for both state-changing POSTs and upgrades; headers alone would only
 * hide a successful foreign request from its caller after the mutation had happened.
 */
function corsHeaders(request) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return null;
  // `vary` so a cache cannot serve one origin's allowance to another.
  return { "access-control-allow-origin": origin, vary: "origin" };
}

const json = (body, status = 200, cors = null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...(cors ?? {}) },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only /lobby/* is ours. `run_worker_first` is scoped to that prefix, so
    // every other request is served straight from static assets and never
    // reaches this code -- except when no asset matched, which is a genuine 404
    // and is what the ASSETS binding will report.
    if (!url.pathname.startsWith("/lobby")) {
      if (env.ASSETS) return env.ASSETS.fetch(request);

      // No ASSETS binding means this is wrangler.dev.jsonc, which serves the lobby
      // and deliberately nothing else. A bare "Not found" here is a trap: wrangler
      // dev prints a `[b] open a browser` shortcut that lands exactly on this path,
      // so the first thing anyone sees when starting the lobby is a 404 with no
      // indication of whether the thing they just started is broken. It is not --
      // the game is on another port. Say which one.
      const hint =
        "TRAMPLER LOBBY — this port serves /lobby/* only.\n\n"
        + "The game is not here. Start it with `npm start` and open:\n\n"
        + `    http://localhost:5173/?lobby=${url.origin}\n\n`
        + "The ?lobby= parameter is needed only in local development, because the\n"
        + "page and the lobby are on different ports. Deployed, they share an origin.\n";
      return new Response(hint, {
        // 200 for the root, because someone who typed this address is asking "is it
        // running?" and the answer is yes. A 404 for anything else, because that is
        // the truth and a blanket 200 would hide a mistyped path.
        status: url.pathname === "/" ? 200 : 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const upgrading = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    if ((request.method === "POST" || upgrading) && !originAllowed(request)) {
      return json({ error: "origin not allowed" }, 403);
    }

    const cors = corsHeaders(request);

    // Preflight. Nothing sent today triggers one -- a bodiless POST and a plain GET
    // are both "simple requests" -- but the moment anyone adds a JSON content-type to
    // a POST the browser will preflight, and the failure looks EXACTLY like the
    // missing-CORS bug this was written to fix: a 200 in the server log and a blocked
    // request in the console. Answering it now costs four lines and saves that
    // diagnosis being done twice.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: cors ? 204 : 403,
        headers: {
          ...(cors ?? {}),
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    // GET /lobby/sim-check -> can the real simulation load and step in local workerd?
    //
    // LOCAL DEVELOPMENT ONLY. The deployed config has an ASSETS binding; returning a
    // plain 404 there makes the expensive, unauthenticated probe indistinguishable from
    // an absent route and does so before its frame count is parsed or simulation code is
    // imported. wrangler.dev.jsonc deliberately has no ASSETS binding, so the same code
    // remains available on loopback for compatibility checks.
    if (url.pathname === "/lobby/sim-check") {
      if (env.ASSETS) return new Response("Not found", { status: 404 });

      // Keep the local probe bounded too. A mistyped `?frames=1e9` should not pin the
      // development Worker until its CPU limit, and a zero-frame run would skip the
      // pool guard and report a pass having measured nothing. 5000 frames is 83 seconds
      // of simulated time, comfortably more than tools/sim-check.mjs requests.
      const asked = Number(url.searchParams.get("frames"));
      const frames = Number.isFinite(asked) && asked >= 1
        ? Math.min(Math.floor(asked), 5000)
        : 120;
      try {
        const { simCheck } = await import("./sim-check.js");
        return json(simCheck(frames), 200, cors);
      } catch (err) {
        // A failure to IMPORT is the most informative outcome of all -- it means the
        // simulation cannot be bundled or cannot load in workerd, which is the answer
        // rather than an error to work around. Report it as data.
        return json({ ok: false, stage: "import", error: String(err?.message ?? err) }, 200, cors);
      }
    }

    // POST /lobby/new -> mint a free code.
    if (url.pathname === "/lobby/new") {
      if (request.method !== "POST") {
        return json({ error: "use POST" }, 405, cors);
      }
      // Eight attempts is theatre at 729 million codes, but it makes the result
      // correct rather than lucky, and instantiating an empty DO is cheap --
      // one with no sockets is evicted on its own.
      for (let i = 0; i < 8; i++) {
        const code = mintCode();
        const stub = env.LOBBY.get(env.LOBBY.idFromName(code));
        const res = await stub.fetch(`https://lobby/status?code=${code}`);
        const status = await res.json();
        if (status.crew === 0 && status.phase === "lobby") {
          return json({ code, crewMax: CREW_MAX }, 200, cors);
        }
      }
      return json({ error: "could not mint a free code" }, 503, cors);
    }

    // /lobby/<code> and /lobby/<code>/status
    const parts = url.pathname.split("/").filter(Boolean); // ["lobby", code, ...]
    const code = normaliseCode(parts[1]);
    if (!validCode(code)) {
      return json({ error: "bad code" }, 400, cors);
    }

    const stub = env.LOBBY.get(env.LOBBY.idFromName(code));
    const tail = parts[2] === "status" ? "status" : "join";
    const target = new URL(`https://lobby/${tail}`);
    target.searchParams.set("code", code);
    const protocol = url.searchParams.get("protocol");
    if (protocol !== null) target.searchParams.set("protocol", protocol);
    const name = url.searchParams.get("name");
    if (name) target.searchParams.set("name", name);

    const res = await stub.fetch(new Request(target, request));

    // Only the JSON reply gets rebuilt. A 101 carries the `webSocket` property, and
    // reconstructing that Response throws the socket away -- the upgrade would appear
    // to succeed and then never deliver a message. WebSocket upgrades need no CORS
    // header anyway, so there is nothing to add.
    if (tail === "status" && cors) {
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: { "content-type": "application/json; charset=utf-8", ...cors },
      });
    }
    return res;
  },
};

export class Lobby {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    // `idFromName` is one-way: the object cannot read its own name, so the code
    // is handed in on the first request and kept for the readouts.
    this.code = null;
    this.phase = "lobby"; // "lobby" | "starting" | "running"
    // Permission follows a person, not a permanently privileged seat number. The first
    // arrival hosts; if they leave, the longest-connected survivor is promoted.
    this.hostSeat = 0;
    // The one server tick at which the constructed authority became the shared run.
    this.startTick = null;

    /** @type {Map<WebSocket, {seat:number, name:string}>} */
    this.crew = new Map();

    this.tick = 0;
    this.snapshots = 0;
    this.timer = null;

    // THE AUTHORITATIVE SIMULATION, or null while this object is still just a lobby.
    //
    // Created on "start" rather than in the constructor, and imported dynamically, for the
    // same reason sim-check is: `src/session.js` pulls in three.js and the whole simulation,
    // which is about 921 KB the DO should not parse to hand out a join code. A lobby that
    // nobody has started stays cheap.
    //
    // `simBusy` guards the async gap. The import and construction take real time, and the
    // tick timer is already running by then — without it, a second "start" would build a
    // second world and the two would fight over `this.sim`.
    this.sim = null;
    this.simBusy = false;
    this.simError = null;
    this.encode = null;
    this.snapshotOf = null;
    this.stepSession = null;
    this.removeOperative = null;
    // Ticks that elapsed while the simulation was still loading. Counted rather than
    // silently dropped, because "the fortress did not move for the first second" is the
    // kind of thing that gets blamed on the network.
    this.ticksBeforeSim = 0;

    // Accumulated real time not yet consumed by a step. This is what makes the
    // tick rate independent of the timer's resolution.
    this.accumulator = 0;
    this.wakes = 0;

    // Server-side WAKE deltas -- how often the runtime called us, not how often
    // we stepped. Read the comment on #onWake before trusting the numbers: the
    // clock they come from is not a normal clock.
    this.lastWakeAt = 0;
    this.deltas = [];
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.code ??= url.searchParams.get("code");

    if (url.pathname === "/status") {
      return new Response(JSON.stringify(this.#status()), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Refusals close with a named code AFTER accepting, because a WebSocket that
    // is never accepted gives the browser no reason at all -- it presents as the
    // same generic failure as a wrong URL or a dead server.
    server.accept();

    // BINARY AS ArrayBuffer, ON THE SERVER SIDE TOO. Set immediately after accept, before any
    // listener can receive a frame.
    //
    // This is the same trap as the browser's, and it was walked into anyway. src/net.js carries
    // a paragraph explaining that a WebSocket delivers binary as a Blob by default, that a Blob
    // is read asynchronously, and that the failure is silent — and then the server was written
    // without the mirror of that line. Input commands arrived as Blobs, `new DataView(blob)`
    // threw "First argument to DataView constructor must be an ArrayBuffer", and every one of
    // sixty commands was discarded. The operative stood still with nothing logged.
    //
    // Worth naming the shape, because it is the more general mistake: a hazard understood on
    // one side of a boundary is not thereby handled on the other. The client fix was written
    // with the reasoning attached, which is what made this diagnosable in one reading once the
    // error message was actually captured — and unguessable before that, since two rounds of
    // plausible guesses (a realm-crossing `instanceof`, then a typed array's pooled buffer)
    // both produced the identical symptom.
    server.binaryType = "arraybuffer";

    // Reject incompatible code before phase/full checks and, crucially, before allocating
    // a seat. Waiting for the first binary frame lets a stale tab occupy the lobby and may
    // start a run it can no longer rejoin after snapshot decoding finally detects the drift.
    if (url.searchParams.get("protocol") !== String(PROTOCOL_VERSION)) {
      server.close(CLOSE_PROTOCOL, "incompatible protocol - reload the page");
      return new Response(null, { status: 101, webSocket: client });
    }

    if (this.phase !== "lobby") {
      server.close(CLOSE_IN_PROGRESS, "that run has already started");
      return new Response(null, { status: 101, webSocket: client });
    }
    if (this.crew.size >= CREW_MAX) {
      server.close(CLOSE_FULL, `that crew is full (${CREW_MAX})`);
      return new Response(null, { status: 101, webSocket: client });
    }

    const seat = this.#freeSeat();
    const name = url.searchParams.get("name") || `CREW ${seat}`;
    // Map insertion order is connection order, so the first member is the initial host and
    // the first survivor is the deterministic promotion target later.
    if (this.hostSeat === 0) this.hostSeat = seat;
    this.crew.set(server, { seat, name });

    server.addEventListener("message", (ev) => this.#onMessage(server, ev));
    // Both, because a dropped connection fires `close` on a clean hangup and
    // `error` on a network failure, and a seat leaking either way means the
    // fourth player can never join.
    server.addEventListener("close", () => this.#onLeave(server));
    server.addEventListener("error", () => this.#onLeave(server));

    this.#send(server, {
      t: "hello",
      protocol: PROTOCOL_VERSION,
      seat,
      code: this.code,
      crewMin: CREW_MIN,
      crewMax: CREW_MAX,
      hostSeat: this.hostSeat,
      startTick: this.startTick,
      tickHz: TICK_HZ,
      snapshotHz: TICK_HZ / SNAPSHOT_EVERY,
      phase: this.phase,
    });
    this.#broadcastCrew();
    this.#startTicking();

    return new Response(null, { status: 101, webSocket: client });
  }

  #status() {
    return {
      code: this.code,
      phase: this.phase,
      hostSeat: this.hostSeat,
      startTick: this.startTick,
      crew: this.crew.size,
      crewMin: CREW_MIN,
      crewMax: CREW_MAX,
      tick: this.tick,
      snapshots: this.snapshots,
      wakes: this.wakes,
      ticking: this.timer !== null,
      seats: [...this.crew.values()].map((c) => ({ seat: c.seat, name: c.name })),
      jitter: this.#jitter(),
      // Whether this object is actually simulating, and how far its fortress has walked.
      // Exposed so `npm run smoke:lobby` can assert that a started run really does advance
      // a world, rather than only that a counter increments -- a tick loop with no
      // simulation behind it would satisfy every other number on this object.
      sim: this.sim
        ? {
          ready: true,
          // THE HULL'S POSITION, NOT ITS DISTANCE FROM THE ORIGIN.
          //
          // `position.length()` was the obvious thing to report and it is useless here: the
          // fortress walks a patrol CIRCLE of radius CFG.world.patrolRadius, so its distance
          // from the origin is a constant 165 m however far it travels. A check asserting
          // that number grows reads 165.15 -> 163.86 and concludes the fortress is going
          // backwards. worker/sim-check.js reports the same figure under the name
          // `hullMoved`, where it is equally misleading and nothing depends on it.
          //
          // Two coordinates let the caller measure the chord between samples, which is what
          // "did it move" actually means on a circular path.
          hullX: Number(this.sim.trampler.group.position.x.toFixed(2)),
          hullZ: Number(this.sim.trampler.group.position.z.toFixed(2)),
          elapsed: Number(this.sim.director.elapsed.toFixed(2)),
          resetId: this.sim.resetId,
          destroyed: this.sim.trampler.destroyed,
          reactorHp: Math.round(this.sim.trampler.reactorHp),
          phase: this.sim.director.phase,
          wave: this.sim.director.wave,
          live: this.sim.horde.liveCount,
          ticksBeforeSim: this.ticksBeforeSim,
          lastInputError: this.lastInputError ?? null,
          lastInputShape: this.lastInputShape ?? null,
          // PER-SEAT INPUT HEALTH, which is the only way to tell three different failures
          // apart from outside: commands not arriving at all (`received` flat), arriving and
          // failing to decode (`bad` climbing), or arriving faster than the server steps
          // (`dropped` climbing). Without this the symptom for all three is identical — an
          // operative that does not move — and that is a diagnosis nobody can make from a
          // snapshot.
          seats: this.sim.operatives.map((op) => {
            const i = op.seat - 1;
            return {
              seat: op.seat,
              received: this.inputsReceived?.[i] ?? 0,
              rejected: this.inputsRejected?.[i] ?? 0,
              bad: this.badInputs?.[i] ?? 0,
              queued: op.input.queued ?? 0,
              ack: op.input.ackSeq ?? 0,
              starved: op.input.starved ?? 0,
              dropped: op.input.dropped ?? 0,
              hp: Math.round(op.player.hp),
              deaths: op.player.deaths,
              shots: op.weapon.shots,
              hits: op.weapon.hits,
              kills: op.weapon.kills,
            };
          }),
        }
        : { ready: false, error: this.simError, building: this.simBusy },
    };
  }

  /**
   * Lowest unused seat, not a running counter. A player leaving frees their
   * number, and a counter that only goes up would run past CREW_MAX after four
   * joins and four leaves -- an empty crew nobody can join.
   */
  #freeSeat() {
    const taken = new Set([...this.crew.values()].map((c) => c.seat));
    for (let s = 1; s <= CREW_MAX; s++) if (!taken.has(s)) return s;
    return CREW_MAX; // unreachable: the size check above already refused
  }

  #onMessage(socket, ev) {
    const me = this.crew.get(socket);
    if (!me) return;

    // BINARY IS AN INPUT COMMAND. Branch on the frame type, not on a field inside it: an
    // 18-byte command has no room for a discriminator string, which is the point of it being
    // 18 bytes.
    //
    // "NOT A STRING" RATHER THAN `instanceof ArrayBuffer`, and this cost a debugging round.
    // The instanceof version received exactly zero commands: workerd does not guarantee that
    // an inbound binary frame arrives as an ArrayBuffer from THIS realm, and it may hand back
    // a view instead. `instanceof` across realms is false for identical shapes, so every input
    // packet fell through to the JSON branch, failed to parse, and was silently discarded by
    // the catch below — an operative that would not move, with nothing logged anywhere.
    //
    // The clue was already in this file: the JSON branch has always read
    // `typeof ev.data === "string" ? ev.data : "{}"`, which means whoever wrote it knew binary
    // could arrive and chose a duck-type test rather than a constructor check. `decodeInput`
    // accepts either a buffer or a view for the same reason.
    //
    // Diagnosed rather than guessed: /status grew per-seat counters, and `0 received` told the
    // difference between "not arriving", "arriving and not decoding" and "arriving too fast"
    // in one reading. All three present as an operative standing still.
    if (typeof ev.data !== "string") {
      this.#onInput(socket, me, ev.data);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "{}");
    } catch {
      return; // a malformed frame is not worth closing a session over
    }

    switch (msg.t) {
      case "ping":
        // Echoed straight back with the client's own id so the client measures
        // RTT against its own clock. Nothing here is timestamped by the server
        // on purpose -- see the clock note on #onTick.
        this.#send(socket, { t: "pong", id: msg.id });
        break;

      case "name":
        me.name = String(msg.name ?? "").slice(0, 16) || `CREW ${me.seat}`;
        this.#broadcastCrew();
        break;

      case "release":
        // Ordered after all preceding binary commands but OUTSIDE their FIFO. Suspension and
        // disconnect must cancel a backlog immediately, not wait behind the stale movement or
        // fire intent they exist to revoke.
        this.#releaseInput(me.seat);
        break;

      case "start": {
        // Starting is a permissioned lobby transition. The Durable Object remains the game
        // authority; "host" only names who may commit this one shared action.
        if (this.phase !== "lobby") {
          this.#send(socket, {
            t: "start", accepted: false,
            reason: this.phase === "starting" ? "the run is already starting" : "the run has started",
          });
          break;
        }
        if (me.seat !== this.hostSeat) {
          this.#send(socket, {
            t: "start", accepted: false,
            reason: `only host seat ${this.hostSeat} can start the run`,
          });
          break;
        }
        if (this.crew.size < CREW_MIN) {
          this.#send(socket, {
            t: "start", accepted: false,
            reason: `waiting for ${CREW_MIN - this.crew.size} more operative`,
          });
          break;
        }

        // STARTING closes the join race immediately, but RUNNING is not announced until the
        // real world exists. Every browser remains paused for the same first authoritative
        // baseline instead of one client entering while the Worker is still importing it.
        this.phase = "starting";
        this.startTick = null;
        this.#broadcast({
          t: "phase", phase: this.phase, hostSeat: this.hostSeat, startTick: null,
        });
        this.#beginRun();
        break;
      }
    }
  }

  /** Cancel every queued/held command for one operative without advancing its ack. */
  #releaseInput(seat) {
    const op = this.sim?.operatives.find((candidate) => candidate.seat === seat);
    op?.input?.release?.();
  }

  /**
   * An input command from one seat.
   *
   * Queued, never applied directly. `stepSession` advances every seat's queue exactly once
   * per tick, which is what keeps one client's frame rate from deciding how fast their
   * operative moves — a client at 144 fps sending 144 commands a second does not get 144
   * ticks, it gets 60 and the queue drops the surplus.
   *
   * NOTHING HERE IS TRUSTED EXCEPT AS INTENT. The command carries key states and a mouse
   * delta; where the operative ends up is the simulation's answer, not the client's claim.
   * That is the whole difference from the relay this replaces, whose own comment called it
   * trivially cheatable because it believed a position.
   *
   * A decode failure is swallowed per packet rather than closing the session. One malformed
   * frame from a client running stale code should cost that client one tick of input, not
   * everybody's run — and a genuine protocol mismatch is already named by the version byte.
   */
  #onInput(socket, me, buffer) {
    this.inputsReceived ??= [];
    this.inputsRejected ??= [];
    this.badInputs ??= [];
    const i = me.seat - 1;
    this.inputsReceived[i] = (this.inputsReceived[i] ?? 0) + 1;

    if (!this.sim || !this.decodeInput) {
      this.inputsRejected[i] = (this.inputsRejected[i] ?? 0) + 1;
      if (!me.inputWaitNamed) {
        me.inputWaitNamed = true;
        this.#send(socket, {
          t: "input", accepted: false, reason: "authoritative simulation not ready",
        });
      }
      return;
    }
    const op = this.sim.operatives.find((candidate) => candidate.seat === me.seat);
    if (!op?.input?.push) return;
    try {
      op.input.push(this.decodeInput(buffer));
    } catch (err) {
      this.badInputs[i] = (this.badInputs[i] ?? 0) + 1;
      // THE MESSAGE, KEPT. Counting failures told us they were failing and nothing about why,
      // and two rounds of guessing followed — first the frame-type check, then a view's bounds.
      // One of those was a real bug and the other was not, and a counter cannot tell them
      // apart. A diagnostic that names the cause is the difference between fixing a bug and
      // fixing something adjacent to it.
      this.lastInputError = String(err?.message ?? err);
      this.lastInputShape = `${buffer?.constructor?.name}`
        + ` len=${buffer?.byteLength} off=${buffer?.byteOffset ?? "-"}`;
    }
  }

  /**
   * Build the authoritative world.
   *
   * Everything about the simulation lives in `src/session.js` -- construction order, step
   * order, and what a snapshot contains. None of it is written here on purpose: this file
   * cannot be reached by the harness, so a rule that lived here would have no test behind
   * it. That is the same argument that moved the number-key router into `economy.js`, and
   * `npm run audit`'s check 9 now compares session.js's step order against the harness's.
   */
  async #beginRun() {
    if (this.sim || this.simBusy) return;
    this.simBusy = true;
    // Zeroed HERE, not at construction, so it counts ticks lost to BUILDING the world rather
    // than ticks that elapsed while the crew sat in the lobby deciding to start. The first
    // version measured from the tick loop's own start and reported 405 lost ticks for a world
    // that built in 29 ms — a faithful count of a thing nobody wanted to know.
    this.ticksBeforeSim = 0;
    try {
      const [session, snap] = await Promise.all([
        import("../src/session.js"),
        import("../src/snapshot.js"),
      ]);
      this.stepSession = session.stepSession;
      this.removeOperative = session.removeOperative;
      this.snapshotOf = session.snapshotOf;
      this.encode = snap.encode;
      this.decodeInput = snap.decodeInput;
      // ONE SEAT PER CONNECTED PLAYER, and this is the line that makes `crew.size` real.
      //
      // Everything about co-op scales off that number and nothing in the browser has ever
      // increased it, so with four people connected each faced a solo-sized fight. Seats are
      // taken from the lobby's roster because joins are refused once a run starts — the crew
      // is settled before this runs, which is what makes a fixed seat count safe.
      //
      // `networked: true` gives every seat a de-jitter queue rather than a stub that reports
      // nothing pressed.
      // A disconnect may happen while the dynamic imports are in flight. Re-check the
      // accepted lobby condition at the construction boundary so STARTING cannot turn a
      // now-solo room into an unjoinable run.
      if (this.phase !== "starting" || this.crew.size < CREW_MIN) {
        this.phase = "lobby";
        this.startTick = null;
        this.#broadcast({
          t: "phase", phase: this.phase, hostSeat: this.hostSeat, startTick: null,
          reason: "start cancelled: waiting for a crewmate",
        });
        this.#broadcastCrew();
        return;
      }

      const seatIds = [...this.crew.values()].map((member) => member.seat).sort((a, b) => a - b);
      const nextSim = session.createSession({
        seats: seatIds,
        hostSeat: this.hostSeat,
        networked: true,
        autoReset: true,
      });

      // Publish the authority atomically: RUNNING is true only after every constructor has
      // succeeded. `startTick` is the single server-clock boundary all clients adopt; their
      // first binary baseline may arrive a few ticks later, but it describes this same run.
      this.sim = nextSim;
      this.simError = null;
      this.startTick = this.tick;
      this.phase = "running";
      this.#broadcast({
        t: "sim", ready: true, protocol: snap.PROTOCOL_VERSION, seats: seatIds,
        hostSeat: this.hostSeat, startTick: this.startTick,
      });
      this.#broadcast({
        t: "phase", phase: this.phase, hostSeat: this.hostSeat, startTick: this.startTick,
      });
      this.#broadcastCrew();
    } catch (err) {
      // Reported as data to every client rather than thrown into the void. A DO that
      // cannot build its world is the single most important thing a player could be told,
      // and the alternative is a fortress that never moves with nothing saying why.
      this.sim = null;
      this.phase = "lobby";
      this.startTick = null;
      this.simError = String(err?.message ?? err);
      this.#broadcast({ t: "sim", ready: false, error: this.simError });
      this.#broadcast({
        t: "phase", phase: this.phase, hostSeat: this.hostSeat, startTick: null,
        reason: "authoritative simulation failed to start",
      });
      this.#broadcastCrew();
    } finally {
      this.simBusy = false;
    }
  }

  #onLeave(socket) {
    const me = this.crew.get(socket);
    if (!me) return;
    // Neutralise first, then remove the operative from every shared owner before publishing
    // the sparse roster. Keeping an inert ghost would still reserve guns/repair points and
    // count toward vote majorities, so disconnect is lifecycle state, not only input state.
    const hostLeft = me.seat === this.hostSeat;
    this.#releaseInput(me.seat);
    // `removeOperative` is loaded before the async construction boundary, while `sim` is
    // published only after construction succeeds. If STARTING rolls back because somebody
    // left, the function can therefore exist with no world to remove from; guard the world,
    // not merely the function, or the next disconnect throws before roster/host cleanup.
    if (this.sim) this.removeOperative?.(this.sim, me.seat);
    this.crew.delete(socket);

    // Map order is arrival order. Promotion therefore goes to the longest-connected
    // survivor and is stable across sparse seat reuse; host authority never falls back to
    // the numeric accident of whichever seat happens to be 1.
    if (hostLeft) this.hostSeat = this.crew.values().next().value?.seat ?? 0;
    if (this.sim) this.sim.hostSeat = this.hostSeat;

    this.#broadcastCrew();
    if (this.crew.size === 0) this.#stopTicking();
  }

  #startTicking() {
    if (this.timer !== null) return;
    this.tick = 0;
    this.snapshots = 0;
    this.wakes = 0;
    this.accumulator = 0;
    this.deltas.length = 0;
    this.lastWakeAt = Date.now();
    this.timer = setInterval(() => this.#onWake(), WAKE_MS);
  }

  #stopTicking() {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    // Nothing keeps the object alive now, so the runtime evicts it and the code
    // is free again. That is the whole lifetime management: no TTL to write.
  }

  #onWake() {
    // A NOTE ON THIS CLOCK, because it is the reason the probe does not trust it.
    //
    // Workers freeze `Date.now()` during synchronous execution and only advance
    // it across I/O, to close timing side channels. Timer callbacks are separate
    // turns, so it does advance between wakes -- but the resolution is whatever
    // the runtime decides to expose, not a monotonic microsecond counter. So
    // these deltas are a cross-check, not the measurement.
    //
    // The measurement that cannot lie is on the client: count how far `tick`
    // advanced over an interval the CLIENT timed. That needs no server clock at
    // all. tools/smoke-lobby.mjs reports it as the headline number and treats
    // this one as corroboration. Both agreed on the 32.81 Hz that produced the
    // accumulator above, which is the only reason it was believed.
    const now = Date.now();
    const dt = Math.min(now - this.lastWakeAt, MAX_CATCHUP_MS);
    this.lastWakeAt = now;
    this.wakes++;
    if (this.deltas.push(dt) > JITTER_WINDOW) this.deltas.shift();

    this.accumulator += dt;

    let due = false;
    while (this.accumulator >= STEP_MS) {
      this.accumulator -= STEP_MS;
      this.tick++;
      // THE AUTHORITATIVE STEP, on the fixed timestep and nothing else.
      //
      // Always STEP_SECONDS, never the measured wake delta. The accumulator above exists
      // precisely so that a ragged timer cannot leak a variable dt into the simulation:
      // clients predict by re-running this same code, so a server that stepped by measured
      // time would disagree with every one of them about the last second. CFG.loop carries
      // the reasoning at length.
      if (this.sim) this.stepSession(this.sim, STEP_SECONDS, this.tick);
      else this.ticksBeforeSim++;
      if (this.tick % SNAPSHOT_EVERY === 0) due = true;
    }

    // At most one snapshot per wake, even when the accumulator ran several steps.
    // Two frames in the same turn of the event loop is bandwidth spent on state
    // the client will interpolate straight past, and on a coarse clock -- where a
    // wake is two steps -- it would arrive as a pair of packets microseconds
    // apart followed by a 31 ms gap, which reads to a client as jitter it has to
    // buffer for. One per wake is smoother and strictly cheaper.
    if (!due) return;
    this.snapshots++;

    // THE STATE SNAPSHOT. Binary, from src/snapshot.js, and this is the message that makes
    // every client's fortress the same fortress.
    //
    // Slice 1 carries the hull and the director. The hull first because it cannot be
    // second: every attached body's position is expressed in its frame, so nothing
    // downstream can be right before it is. And the director carries `elapsedMs`, which is
    // the single field that closes the largest divergence in the game -- difficulty scales
    // with elapsed time and each client used to start its own clock on its own click.
    //
    // 49 bytes at 20 Hz is under a kilobyte a second per client. The horde is what will
    // actually cost something, and that is slice 2.
    if (this.sim) {
      const { buffer, clamped } = this.encode(this.snapshotOf(this.sim, this.tick));
      // A clamped field means the world being sent is not the world being described --
      // a coordinate outside int16 metres, for instance. Reported once rather than every
      // tick, because a broken snapshot at 20 Hz would bury the log it belongs in.
      if (clamped.length > 0 && !this.clampWarned) {
        this.clampWarned = true;
        this.#broadcast({ t: "sim", ready: true, clamped: clamped[0] });
      }
      this.#broadcastBinary(buffer);
    } else {
      // Still a JSON heartbeat while the world loads, so a client can tell "the server is
      // alive and building" from "the server is gone". Two different waits, two different
      // things worth saying.
      this.#broadcast({
        t: "snap", tick: this.tick, ms: now, waiting: this.ticksBeforeSim,
        error: this.simError,
      });
    }
  }

  #jitter() {
    const d = [...this.deltas].sort((a, b) => a - b);
    if (d.length === 0) return null;
    const at = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))];
    return {
      samples: d.length,
      // WAKE deltas, so the number to compare against is the requested wake
      // interval, not the step. A p50 far above WAKE_MS is a coarse timer, which
      // the accumulator absorbs -- it is diagnostic, not a fault.
      requestedWakeMs: WAKE_MS,
      stepMs: Number(STEP_MS.toFixed(2)),
      p50: at(0.5),
      p95: at(0.95),
      p99: at(0.99),
      max: d[d.length - 1],
    };
  }

  /**
   * The readyState guard is defensive and correct: `close` fires only after the
   * peer is already unreachable, so a broadcast in that window is aimed at a dead
   * socket, and a write that fails asynchronously lands outside any catch block.
   *
   * WHAT IT DOES NOT DO, recorded because the first version of this comment said
   * it did and the measurement disagreed. Local runs print
   * `Uncaught Error: Network connection lost` once per socket close, and adding
   * this guard changed the count from five to five. It is not our writes: the
   * errors appear for sockets that were refused and never written to at all, and
   * every check after each one passes -- the tick counter keeps advancing and
   * /status keeps serving, so the object is not being reset.
   *
   * It is workerd, in local mode only, on close. cloudflare/workerd#1299 is the
   * same behaviour reported against Miniflare. Left alone deliberately: the fix
   * belongs upstream, and a workaround here would be code defending against a log
   * line rather than against a fault. Re-check it against the deployed Worker,
   * where the runtime is not miniflare.
   */
  #send(socket, obj) {
    if (socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      // Synchronous refusal. The close handler will free the seat.
    }
  }

  #broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const socket of this.crew.keys()) {
      if (socket.readyState !== WS_OPEN) continue;
      try {
        socket.send(payload);
      } catch { /* see #send */ }
    }
  }

  /**
   * Fan out one ArrayBuffer.
   *
   * Separate from #broadcast rather than type-sniffing inside it, because the two carry
   * different KINDS of thing: JSON here is session bookkeeping a client must not miss, and
   * binary is state that is superseded 20 times a second. Keeping them apart means the
   * next slice can drop a late snapshot without inventing a rule about which JSON messages
   * are also droppable.
   *
   * The buffer is sent as-is to every socket. workerd does not mutate it and neither does
   * the send, so one allocation serves the whole crew -- which matters at 4 players and
   * will matter more once the horde is in it.
   */
  #broadcastBinary(buffer) {
    for (const socket of this.crew.keys()) {
      if (socket.readyState !== WS_OPEN) continue;
      try {
        socket.send(buffer);
      } catch { /* see #send */ }
    }
  }

  #broadcastCrew() {
    this.#broadcast({
      t: "crew",
      phase: this.phase,
      crewMin: CREW_MIN,
      crewMax: CREW_MAX,
      hostSeat: this.hostSeat,
      startTick: this.startTick,
      crew: [...this.crew.values()]
        .map((c) => ({ seat: c.seat, name: c.name }))
        .sort((a, b) => a.seat - b.seat),
    });
  }
}
