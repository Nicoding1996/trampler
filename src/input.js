// Keyboard + mouse with pointer lock. Tracks held keys, one-shot presses
// (consumed by the reader), and per-frame mouse delta.

export class Input {
  constructor(canvas, gate) {
    this.canvas = canvas;
    this.gate = gate;

    this.held = new Set();
    this.justPressed = new Set();
    this.mouse = { dx: 0, dy: 0 };
    this.mouseHeld = new Set();
    this.mouseJustPressed = new Set();
    this.locked = false;

    // Ignore browser key repeat so "just pressed" stays a single event.
    addEventListener("keydown", (e) => {
      if (e.code === "Tab") e.preventDefault();
      if (e.repeat) return;
      this.held.add(e.code);
      this.justPressed.add(e.code);
    });
    addEventListener("keyup", (e) => this.held.delete(e.code));

    // Losing focus must clear held keys or the player keeps sliding.
    addEventListener("blur", () => {
      this.held.clear();
      this.mouseHeld.clear();
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

    gate.addEventListener("click", () => canvas.requestPointerLock());
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      gate.classList.toggle("hidden", this.locked);
      if (!this.locked) {
        this.held.clear();
        this.mouseHeld.clear();
      }
    });
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
  }
}
