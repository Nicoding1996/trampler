// Does the horde's walk cycle keep the drawn silhouette in agreement with the box a
// shot tests against? Invariant 8, for animated geometry.
//
// This exists because CFG.enemies.gait's comment records a measurement and tells the
// next person to re-measure rather than reason about it. A measurement with no way to
// re-run it is a comment, and this project's own rule is that a number defended only
// by a comment is not defended.
//
// Two questions, and both would otherwise be false greens:
//
//   1. Did any part actually get classified as a limb? A rig where everything
//      defaulted to BODY animates nothing and reads as correct in source. Counting
//      vertices per code is the only way to see it. The first run of this found the
//      chewer and burrower at zero, which is deliberate -- neither has legs in its
//      silhouette -- and would have looked identical to a wiring failure.
//   2. How far does the animation push the silhouette past the hit box? Replicates
//      the vertex shader in JS and sweeps a full phase cycle at FULL amplitude, which
//      is the worst case rather than a sample of one instant.
//
// It found a real problem on its first run: the climber's forward-pointing forelimbs,
// classified as limbs, were shoved 18 cm further forward and nearly doubled an
// overhang that already existed. They are body now, and the reason is in look.js.
//
// Run after changing any gait number, any enemy silhouette, or hitPad.
import { CFG, ENEMY_TYPE_KEYS, enemyCfg } from "../src/config.js";
import { enemyGeometry } from "../src/look.js";

const gait = CFG.enemies.gait;
const pad = CFG.combat.weapon.hitPad;
const STEPS = 720;

const f = (v) => v.toFixed(3).padStart(7);

console.log("");
console.log("Rig classification: vertices per part code");
console.log("  type       body   limbA   limbB   pivots");

const geos = new Map();
for (const key of ENEMY_TYPE_KEYS) {
  const cfg = CFG.enemies[key];
  const geo = enemyGeometry(key, cfg);
  geos.set(key, geo);

  const rig = geo.attributes.aRig;
  if (!rig) {
    console.log(`  ${key.padEnd(9)} NO aRig ATTRIBUTE — the animation is wired to nothing`);
    continue;
  }
  const n = [0, 0, 0];
  const pivots = new Set();
  for (let i = 0; i < rig.count; i++) {
    const code = rig.getX(i);
    n[code]++;
    if (code > 0) pivots.add(rig.getY(i).toFixed(3));
  }
  console.log(
    `  ${key.padEnd(9)} ${String(n[0]).padStart(5)}   ${String(n[1]).padStart(5)}` +
    `   ${String(n[2]).padStart(5)}   ${[...pivots].join(" ") || "-"}`,
  );
}

console.log("");
console.log("Drawn extent vs the box a shot tests, at FULL gait amplitude");
console.log("  the box is radius*1.2*bulk + pad in x/z, height/2 + pad in y");
console.log("");
console.log("  type        axis     box    static  animated   added");

let worstAdded = 0;
let worstWhere = "";

for (const key of ENEMY_TYPE_KEYS) {
  const cfg = enemyCfg(ENEMY_TYPE_KEYS.indexOf(key));
  const geo = geos.get(key);
  const pos = geo.attributes.position;
  const rig = geo.attributes.aRig;

  const boxH = cfg.radius * 1.2 * cfg.bulk + pad;
  const boxV = cfg.height / 2 + pad;

  // Cadence is per type, exactly as enemies.js builds it. It cannot change the
  // extents (phase is swept fully either way) but keeping it identical means this
  // probe and the game share one expression.
  const rate = gait.rate / Math.pow(cfg.bulk, gait.bulkDrag);

  const stat = { x: 0, y: 0, z: 0 };
  const anim = { x: 0, y: 0, z: 0 };

  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    stat.x = Math.max(stat.x, Math.abs(px));
    stat.y = Math.max(stat.y, Math.abs(py));
    stat.z = Math.max(stat.z, Math.abs(pz));

    const code = rig.getX(i);
    const pivot = rig.getY(i);
    const limb = code > 0.5 ? 1 : 0;
    const dir = 1 - 2 * (code > 1.5 ? 1 : 0);
    const hang = Math.min(py - pivot, 0);

    for (let s = 0; s < STEPS; s++) {
      // Phase swept directly. `rate` only maps wall-clock to phase, and every phase
      // is visited either way, so the extents do not depend on it.
      const ph = (s / STEPS) * Math.PI * 2;
      void rate;

      const bob = Math.sin(ph * 2) * gait.bob;
      const sway = Math.sin(ph) * gait.sway;
      const c = Math.cos(sway);
      const sn = Math.sin(sway);

      let tx = c * px + sn * pz;
      let tz = -sn * px + c * pz;
      const ty = py + bob;
      tz += Math.sin(ph) * gait.swing * limb * dir * hang;

      anim.x = Math.max(anim.x, Math.abs(tx));
      anim.y = Math.max(anim.y, Math.abs(ty));
      anim.z = Math.max(anim.z, Math.abs(tz));
    }
  }

  for (const [axis, box] of [["x", boxH], ["y", boxV], ["z", boxH]]) {
    const added = anim[axis] - stat[axis];
    if (added > worstAdded) {
      worstAdded = added;
      worstWhere = `${key} ${axis}`;
    }
    const flag = stat[axis] > box ? " (already outside)" : "";
    console.log(
      `  ${key.padEnd(9)} ${axis}     ${f(box)}   ${f(stat[axis])}   ${f(anim[axis])}` +
      `  ${f(added)}${flag}`,
    );
  }
  console.log("");
}

console.log(`worst extent ADDED by the animation: ${worstAdded.toFixed(3)} m  (${worstWhere})`);
console.log("");
console.log("The question is not whether the silhouette fits the box -- parts of it");
console.log("already did not, before any of this. It is whether the animation");
console.log("meaningfully widens a gap it did not create.");
