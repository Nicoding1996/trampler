// Does a second operative's Economy wipe the crew's fortress upgrades?
//
// Suspected by reading `applyAll`: it walks the WHOLE catalogue and applies every static
// effect from ITS OWN stack counts, and two of those effects write to shared fortress
// objects -- `plating` sets trampler.damageScale, `rig` sets repair.rateScale. Absolute
// recomputation from stack counts is exactly right for one owner and destructive with two.
//
// Measured here rather than assumed, because "I read the code and I think" is not the same
// claim as "I ran it and it did".

import * as THREE from "three";
import { CFG } from "../src/config.js";
import { World } from "../src/world.js";
import { Trampler } from "../src/trampler.js";
import { Player } from "../src/player.js";
import { Crew } from "../src/crew.js";
import { Horde } from "../src/enemies.js";
import { Director } from "../src/waves.js";
import { Weapon } from "../src/weapon.js";
import { Repair } from "../src/repair.js";
import { DeckGun } from "../src/deckgun.js";
import { Emitters } from "../src/emitters.js";
import { Modules } from "../src/modules.js";
import { Events } from "../src/events.js";
import { Economy, Treasury } from "../src/economy.js";

const scene = new THREE.Scene();
const cam = () => {
  const c = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
  c.rotation.order = "YXZ";
  return c;
};

const world = new World(scene);
const trampler = new Trampler(scene);
const p1 = new Player(cam(), world, trampler);
const p2 = new Player(cam(), world, trampler);
const crew = new Crew([p1, p2]);
const horde = new Horde(scene, trampler);
const director = new Director(horde, trampler, crew);
const weapon = new Weapon(scene, p1, horde, world, trampler);
const repair = new Repair(p1, trampler, horde, crew);
const guns = CFG.deckGun.mounts.map((m) => new DeckGun(scene, trampler, m));
const emitters = new Emitters(scene, trampler, horde);
const events = new Events();
horde.events = events;
weapon.events = events;
const modules = new Modules({ trampler, horde, emitters, guns });

const shared = { trampler, weapon, repair, horde, director, modules, events };

const report = (label) => {
  console.log(
    `  ${label.padEnd(36)} plating=${trampler.damageScale.toFixed(4)}`
    + `  repairRate=x${repair.rateScale.toFixed(2)}`,
  );
};

/**
 * Run the scenario with two operatives and report whether the fortress survived.
 *
 * `treasury` null gives each operative their own copy of the crew's state, which is the
 * broken arrangement; passing one shared Treasury is the fix.
 */
function scenario(label, treasury) {
  const e1 = new Economy({ player: p1, ...shared, treasury });
  const e2 = new Economy({ player: p2, ...shared, treasury });

  console.log(`\n${label}`);
  report("baseline");

  // Crew 1 buys the fortress track out.
  e1.stacks.plating = 4;
  e1.stacks.rig = 3;
  e1.applyAll();
  report("crew 1 buys 4 plating, 3 rig");

  const wanted = { plating: trampler.damageScale, rig: repair.rateScale };

  // Crew 2 recomputes their own effects. `applyAll` runs on every successful purchase and
  // every reset, so this is the ordinary path rather than a contrived one -- the first
  // version of this probe went through `buy()` and measured NOTHING, because buying needs
  // a terminal and a safe moment and the purchase was refused. A probe has to be handed
  // the thing it is probing.
  e2.stacks.rifle = 1; // purely personal, so only crew 2's own kit should move
  e2.applyAll();
  report("crew 2 recomputes their own kit");

  const wiped = trampler.damageScale !== wanted.plating || repair.rateScale !== wanted.rig;
  console.log(`  -> ${wiped ? "COLLISION: fortress refits WIPED" : "HELD: refits intact"}`
    + `   (crew 2 reads plating x${e2.stacks.plating}, rig x${e2.stacks.rig})`);
  return wiped;
}

console.log("fortress refits are bought with SHARED scrap, so they belong to the crew");

const broken = scenario("A. one Treasury EACH — the counts are duplicated", null);
const fixed = scenario("B. one Treasury SHARED — the counts are the crew's", new Treasury());

console.log(`\n${broken && !fixed ? "FIX CONFIRMED" : "INCONCLUSIVE"}:`
  + ` duplicated counts ${broken ? "collide" : "do not collide"},`
  + ` shared counts ${fixed ? "still collide" : "hold"}.`);
console.log("Note what makes B work: both operatives still apply the fortress effects, and"
  + "\nboth compute 0.85**4 from the same shared 4, so the absolute recompute is"
  + "\nidempotent. No ownership flag, no 'am I the one who applies this' branch.");
