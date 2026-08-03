// Keyboard + mouse with pointer lock. Tracks held keys, one-shot presses
// (consumed by the reader), and per-frame mouse delta.

export class Input {
  constructor(canvas, gate) {
    this.canvas = canvas;
    this.gate = gate;
    this.cta = gate.querySelector(".cta");

    this.held = new Set();
    this.justPressed = new Set();
    this.mouse = { dx: 0, dy: 0 };
    this.mouseHeld = new Set();
    this.mouseJustPressed = new Set();
    this.locked = false;
    // The resolver is installed by main once the economy/run objects exist. Ownership is
    // latched in the DOM event itself, before a newer snapshot can change the visible panel.
    this.purchaseOwnerResolver = null;
    this.purchaseOwner = undefined;
    this.purchaseContext = undefined;
    // The first gate is session setup; every later gate is only a way to reacquire pointer
    // lock. Without this distinction, alt-tab or Escape resurrects the title, host controls,
    // and join form on top of a run that never actually ended.
    this.hasLocked = false;

    // Ignore browser key repeat so "just pressed" stays a single event. Pointer lock is
    // control ownership: keys pressed while the gate or another application owns the cursor
    // must never become gameplay intent or survive into the first fixed step.
    addEventListener("keydown", (e) => {
      if (!this.locked) return;
      if (e.code === "Tab") e.preventDefault();
      if (e.repeat) return;
      const purchase = this.purchaseOwnerResolver?.(e.code);
      if (purchase !== undefined) {
        // One wire command has one edge mask. If two number presses from different visible
        // owners/episodes coalesce before a fixed step, discarding both is safer than
        // inventing an order the mask cannot represent and committing a shared choice.
        if (this.purchaseOwner === undefined) {
          this.purchaseOwner = purchase.owner;
          this.purchaseContext = purchase.context;
        } else if (this.purchaseOwner !== purchase.owner
            || this.purchaseContext !== purchase.context) {
          this.purchaseOwner = "discard";
        }
      }
      this.held.add(e.code);
      this.justPressed.add(e.code);
    });
    addEventListener("keyup", (e) => this.held.delete(e.code));

    // Losing focus must clear every level AND edge. Keeping a pending jump or mouse delta
    // across a throttled background tab fires it on resume, long after the gesture happened.
    addEventListener("blur", () => this.clear());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.clear();
    });

    canvas.addEventListener("mousedown", (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.mouseHeld.add(e.button);
      this.mouseJustPressed.add(e.button);
    });
    addEventListener("mouseup", (e) => this.mouseHeld.delete(e.button));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
    });

    gate.addEventListener("click", () => {
      if (this.ready) canvas.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (this.locked) {
        // The ready-but-unlocked gate may have been open for an arbitrary time. Start every
        // ownership period neutral instead of inheriting a key or edge from before the lock.
        this.clear();
        this.hasLocked = true;
        gate.classList.remove("resume");
        gate.classList.add("hidden");
        return;
      }

      this.clear();
      gate.classList.remove("hidden");
      if (this.hasLocked) {
        gate.classList.add("resume");
        if (this.cta) this.cta.textContent = "CLICK TO RESUME";
      }
    });
  }

  /** The first pointer-lock gesture is accepted only after assets and shaders are ready. */
  get ready() {
    return !this.gate.classList.contains("loading");
  }

  setReady() {
    // Loading can finish after keys were pressed against the page but before this version's
    // unlocked-key guard ran (for example across a hot reload). Readiness always begins neutral.
    this.clear();
    this.gate.classList.remove("loading");
    this.gate.removeAttribute("aria-busy");
    delete this.gate.dataset.loading;
  }

  /** Resolve the number-key owner at DOM-event time; undefined means this key is unrelated. */
  setPurchaseOwnerResolver(resolve) {
    this.purchaseOwnerResolver = typeof resolve === "function" ? resolve : null;
  }

  /** Clear all intent when this document can no longer own the controls. */
  clear() {
    this.held.clear();
    this.justPressed.clear();
    this.mouseHeld.clear();
    this.mouseJustPressed.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.purchaseOwner = undefined;
    this.purchaseContext = undefined;
  }

  down(code) {
    return this.held.has(code);
  }

  /** True once per physical press. */
  pressed(code) {
    if (!this.justPressed.has(code)) return false;
    this.justPressed.delete(code);
    return true;
  }

  /**
   * Was this pressed this frame, WITHOUT consuming it?
   *
   * Exists because the network layer has to read every edge in order to send it, and
   * `pressed()` deletes what it returns — so reading it there would steal the press from the
   * local prediction. The player would send a jump and never perform it: working in single
   * player, silently broken in multiplayer, which is the worst shape a bug can have.
   *
   * A METHOD RATHER THAN A REACH INTO `justPressed`, and that is the point. The first version
   * of `readInput` did reach in, and it worked against the real Input and returned nothing at
   * all against the harness's duck-typed stub, whose set is called `presses`. Two spellings of
   * one question, one of which silently answered "no edges, ever".
   *
   * Same lesson as exporting `isSubmerged`: when a condition is asked in more than one module,
   * export the question rather than letting each caller guess at the state behind it. A wrong
   * property name is not an error, it is a wrong answer.
   */
  isPressed(code) {
    return this.justPressed.has(code);
  }

  /** The same, for a mouse button. */
  isMousePressed(button) {
    return this.mouseJustPressed.has(button);
  }

  mouseDown(button) {
    return this.mouseHeld.has(button);
  }

  mousePressed(button) {
    if (!this.mouseJustPressed.has(button)) return false;
    this.mouseJustPressed.delete(button);
    return true;
  }

  /** Call at the very end of each frame. */
  endFrame() {
    this.justPressed.clear();
    this.mouseJustPressed.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.purchaseOwner = undefined;
    this.purchaseContext = undefined;
  }
}
