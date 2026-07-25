// Space-agnostic AABB collision. Call it with world-space values for terrain,
// or with Trampler-local values for the deck -- since the Trampler only yaws,
// its colliders are axis-aligned in its own local space, which keeps this
// exact rather than approximate.
//
// The player is treated as an axis-aligned box. A cylinder approximated by an
// AABB is yaw-invariant enough for a grey box, and it never catches on corners.

import { clamp } from "./util.js";

const STEP_HEIGHT = 0.55;

/**
 * Push `pos` out of every overlapping box, cheapest axis first, and zero the
 * velocity components that ran into a surface.
 *
 * @param prevFeetY feet height before this frame's integration. Used to block
 *        "popping" on top of a wall you actually ran into from the side.
 */
export function resolveBoxes(pos, half, boxes, vel, prevFeetY, out) {
  for (let iter = 0; iter < 3; iter++) {
    let moved = false;

    for (const b of boxes) {
      const minX = b.min.x - half.x, maxX = b.max.x + half.x;
      const minY = b.min.y - half.y, maxY = b.max.y + half.y;
      const minZ = b.min.z - half.z, maxZ = b.max.z + half.z;

      if (pos.x <= minX || pos.x >= maxX) continue;
      if (pos.y <= minY || pos.y >= maxY) continue;
      if (pos.z <= minZ || pos.z >= maxZ) continue;

      const pushXp = maxX - pos.x, pushXn = pos.x - minX;
      const pushYp = maxY - pos.y, pushYn = pos.y - minY;
      const pushZp = maxZ - pos.z, pushZn = pos.z - minZ;

      // Only allow landing on top if we were already above the surface, or if
      // the lip is short enough to be a step. Otherwise a fast horizontal
      // impact can teleport the player onto a railing.
      const canLand = prevFeetY >= b.max.y - 0.05 || pushYp <= STEP_HEIGHT;

      let best = Infinity, axis = "x", sign = 1;
      const consider = (amount, a, s) => {
        if (amount < best) { best = amount; axis = a; sign = s; }
      };
      consider(pushXp, "x", 1);
      consider(pushXn, "x", -1);
      consider(pushZp, "z", 1);
      consider(pushZn, "z", -1);
      if (canLand) consider(pushYp, "y", 1);
      consider(pushYn, "y", -1);

      pos[axis] += best * sign;
      moved = true;

      if (axis === "y") {
        if (sign > 0) {
          out.grounded = true;
          out.ground = b;
          if (vel.y < 0) vel.y = 0;
        } else if (vel.y > 0) {
          vel.y = 0; // clipped a ceiling
        }
      } else if (Math.sign(vel[axis]) === -sign) {
        vel[axis] = 0;
      }
    }

    if (!moved) break;
  }
}

/**
 * Find the surface the player is standing on. Separate from resolution because
 * we need a stable answer even on frames with no penetration -- the result
 * decides which platform the player inherits motion from next frame.
 */
export function probeGround(pos, half, boxes, depth = 0.35) {
  const feet = pos.y - half.y;
  let best = null;
  let bestTop = -Infinity;

  for (const b of boxes) {
    if (pos.x <= b.min.x - half.x || pos.x >= b.max.x + half.x) continue;
    if (pos.z <= b.min.z - half.z || pos.z >= b.max.z + half.z) continue;

    const top = b.max.y;
    if (top > feet + 0.10) continue;   // that's a wall beside us, not a floor
    if (top < feet - depth) continue;  // too far below to count

    if (top > bestTop) {
      bestTop = top;
      best = b;
    }
  }

  return best;
}

/** Would a player-sized box centred here overlap anything except `ignore`? */
function occupied(x, y, z, half, boxes, ignore) {
  for (const b of boxes) {
    if (b === ignore) continue;
    if (x <= b.min.x - half.x || x >= b.max.x + half.x) continue;
    if (y <= b.min.y - half.y || y >= b.max.y + half.y) continue;
    if (z <= b.min.z - half.z || z >= b.max.z + half.z) continue;
    return true;
  }
  return false;
}

/**
 * Find a ledge to mantle onto, in whatever space the caller passes in -- world
 * for terrain, hull-local for the deck, exactly like the rest of this module.
 *
 * Returns the position the player's centre should end up at, or null.
 *
 * Three things this has to get right:
 *
 *   Thin geometry is not a ledge. Railings are 0.5 m thick, so a player box
 *   simply does not fit on top of one. Those are things you climb OVER.
 *
 *   Ledges usually have something sitting on the lip -- a railing, a kerb. So
 *   the landing spot walks progressively inboard until the body actually fits
 *   rather than giving up on the first blocked sample.
 *
 *   When several ledges qualify, the lowest wins. Players expect to grab the
 *   thing in front of them, not the roof above it.
 */
export function findMantleTarget(pos, half, fwdX, fwdZ, boxes, cfg) {
  const feet = pos.y - half.y;
  const inset = half.x + 0.08;
  let best = null;

  for (const b of boxes) {
    const top = b.max.y;
    const rise = top - feet;
    if (rise < cfg.minRise || rise > cfg.maxRise) continue;

    // Too narrow to stand on at all.
    if (b.max.x - b.min.x < inset * 2 || b.max.z - b.min.z < inset * 2) continue;

    // Nearest point on the footprint to a spot just ahead of the player.
    const ax = pos.x + fwdX * cfg.reach;
    const az = pos.z + fwdZ * cfg.reach;
    const nx = clamp(ax, b.min.x, b.max.x);
    const nz = clamp(az, b.min.z, b.max.z);

    const dx = nx - pos.x;
    const dz = nz - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > cfg.reach + half.x) continue;
    if (dist > 1e-3 && (dx * fwdX + dz * fwdZ) / dist < cfg.facing) continue;

    const destY = top + half.y + 0.02;

    let spotX = 0;
    let spotZ = 0;
    let found = false;
    for (const extra of cfg.insetSteps) {
      const lx = clamp(ax + fwdX * extra, b.min.x + inset, b.max.x - inset);
      const lz = clamp(az + fwdZ * extra, b.min.z + inset, b.max.z - inset);
      if (!occupied(lx, destY, lz, half, boxes, b)) {
        spotX = lx;
        spotZ = lz;
        found = true;
        break;
      }
    }
    if (!found) continue;

    if (!best || top < best.top) best = { x: spotX, y: destY, z: spotZ, top };
  }

  return best;
}
