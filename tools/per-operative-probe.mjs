// Do Weapon, Grapple and Items already work one-per-operative, or do they collide?
//
// The fortress collision had a shape worth checking for again: an effect recomputed
// ABSOLUTELY from stack counts is correct with one owner and destructive with two, whenever
// it writes to an object the two owners share. The fortress case was `plating` writing
// `trampler.damageScale`. The personal catalogue has the same shape pointed at a WEAPON:
//
//   rifle    -> weapon.damageScale
//   trigger  -> weapon.fireRateScale
//   sabot    -> weapon.armourPierce
//
// So if two operatives share one Weapon, crew 2's recompute should wipe crew 1's rifle
// stacks exactly as it wiped the hull plating. And `Items.update` clears and rebuilds
// `weapon.damageBonus` every frame, which is a second writer to the same field.
//
// Measured rather than reasoned, because "I read it and I think" is a different claim from
// "I ran it and it did".

import * as THREE from "three";
import { CFG } from "../src/config.js";
import { World } from "../src/world.js";
import { Trampler } from "../src/trampler.js";
import { Player } from "../src/player.js";
import { Crew } from "../src/crew.js";
import { Horde } from "../src/enemies.js";
import { Director } from "../src/waves.js";
import { Weapon } from "../src/weapon.js";
import { Grapple } from "../src/grapple.js";
import { Repair } from "../src/repair.js";
import { DeckGun } from "../src/deckgun.js";
import { Emitters } from "../src/emitters.js";
import { Modules } from "../src/modules.js";
import { Events } from "../src/events.js";
import { Economy, Treasury } from "../src/economy.js";
import { Items } from "../src/items.js";

const scene = new THREE.Scene();
const cam = () => {
  const c = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
  c.rotation.order = "YXZ";
  return c;
};

const world = new World(scene);
const trampler = new Trampler(scene);
const horde = new Horde(scene, trampler);
const events = new Events();
horde.events = events;
const guns = CFG.deckGun.mounts.map((m) => new DeckGun(scene, trampler, m));
const emitters = new Emitters(scene, trampler, horde);
const modules = new Modules({ trampler, horde, emitters, guns });
const crew = new Crew();
const director = new Director(horde, trampler, crew);
const treasury = new Treasury({ director, events });

/**
 * Build one operative's whole personal stack.
 *
 * `weapon` lets the caller deliberately share one between two operatives, which is the
 * arrangement under test.
 */
function operative(weapon = null) {
  const player = new Player(cam(), world, trampler);
  crew.add(player);
  const w = weapon ?? new Weapon(scene, player, horde, world, trampler);
  w.events = events;
  const grapple = new Grapple(scene, player, trampler, world);
  player.grapple = grapple;
  const repair = new Repair(player, trampler, horde, crew);
  const economy = new Economy({
    player, trampler, weapon: w, repair, horde, director, modules, events, treasury,
  });
  const items = new Items({ economy, player, trampler, weapon: w, horde, repair, events });
  return { player, weapon: w, grapple, repair, economy, items };
}

const line = (label, a, b) => console.log(`  ${label.padEnd(30)} ${a}   |   ${b}`);

// ---------------------------------------------------------------- A. shared Weapon
//
// This USED to demonstrate the collision: crew 1 bought four rifle calibrations for a
// damageScale of 2.00, crew 2 recomputed their own unrelated kit, and it dropped to 1.00.
// Four stacks gone, counts intact, nothing thrown.
//
// It is now refused at construction, which is the better outcome and the reason the control
// case moved out of the probe and into an assertion: a wrong answer became a load failure.
console.log("A. two operatives sharing ONE Weapon");
{
  const shared = new Weapon(scene, new Player(cam(), world, trampler), horde, world, trampler);
  let refused = "";
  try {
    operative(shared);
    operative(shared);
  } catch (err) {
    refused = err.message;
  }
  console.log(`  -> ${refused
    ? `REFUSED at construction: ${refused.split(":")[0]}`
    : "ACCEPTED — the guard is not working"}`);
}

// ------------------------------------------------------------- B. a Weapon each
console.log("\nB. two operatives with a Weapon EACH");
{
  crew.members.length = 0;
  const c1 = operative();
  const c2 = operative();

  c1.economy.stacks.rifle = 4;
  c1.economy.applyAll();
  c2.economy.stacks.rifle = 1;
  c2.economy.applyAll();
  line("damageScale", `crew 1 ${c1.weapon.damageScale.toFixed(2)}`,
    `crew 2 ${c2.weapon.damageScale.toFixed(2)}`);

  c1.economy.stacks.sabot = 2;
  c1.economy.applyAll();
  line("armourPierce", `crew 1 ${c1.weapon.armourPierce}`, `crew 2 ${c2.weapon.armourPierce}`);

  const independent = c1.weapon.damageScale !== c2.weapon.damageScale
    && c1.weapon.armourPierce !== c2.weapon.armourPierce;
  console.log(`  -> ${independent ? "INDEPENDENT: each operative's kit is their own" : "SHARED"}`);

  // ---- and the conditional half, which has a SECOND writer per frame.
  //
  // Items.update clears and rebuilds weapon.damageBonus from current conditions. Two
  // Items over one Weapon would be two authors of one field; over their own Weapons they
  // should be able to hold different bonuses at the same instant.
  c1.economy.stacks.understudy = 3;
  c1.economy.applyAll();
  // Crew 1 under the hull, crew 2 out in the open.
  const under = trampler.localToWorld(new THREE.Vector3(0, -CFG.trampler.deckHeight, 0));
  c1.player.position.set(under.x, 1.2, under.z);
  c1.player.base = null;
  c2.player.position.set(700, 1.2, 700);
  c2.player.base = null;
  c1.items.update(1 / 60);
  c2.items.update(1 / 60);
  line("damageBonus", `crew 1 +${(c1.weapon.damageBonus * 100).toFixed(0)}%`,
    `crew 2 +${(c2.weapon.damageBonus * 100).toFixed(0)}%`);
  line("reasons", `crew 1 [${c1.items.reasons.join(", ")}]`,
    `crew 2 [${c2.items.reasons.join(", ")}]`);
  console.log(`  -> ${c1.weapon.damageBonus > 0 && c2.weapon.damageBonus === 0
    ? "INDEPENDENT: one operative's position does not buff the other"
    : "COUPLED"}`);

  // ---- grapples: separate ropes, separate anchors.
  console.log(`  -> grapples are distinct objects: ${c1.grapple !== c2.grapple}`
    + `, and each player points at their own: `
    + `${c1.player.grapple === c1.grapple && c2.player.grapple === c2.grapple}`);
}
