# Trampler

A first-person prototype about a crew and a giant walking fortress. You defend it
from the deck and from underneath, and you can't be in both places at once.

Browser game, three.js, no engine, no build step.

## Running it

```
npm start
```

Then open http://localhost:5173.

Desktop only. It needs a mouse and keyboard, and it takes pointer lock when you
click to start.

`node_modules` is committed on purpose so a clone runs offline with nothing to
install. Most of the tuning happens away from a connection.

## Tests

```
npm run verify
```

Runs the real simulation modules in node with no renderer and no DOM: 829
assertions, all green. It has caught a lot of things that looked fine in review.

Four other checks cover what the harness structurally can't see:

```
npm run audit      config paths, element ids, the headless boundary, dead exports
npm run imports    resolves every import against the importmap in index.html
npm run smoke      asks the running server for every file the page needs
npm run cost       draw calls, triangles, shadow casters, lights
```

Everything stochastic is seeded, so two runs of the suite are identical apart
from the timing readout. `npm run diff` compares them. That's the check that
tells you whether a change did anything at all.

## State

It's a prototype, not a game. It exists to answer whether the two-positions idea
holds up, and it does. Netcode, a second biome and any kind of meta-progression
are deliberately absent.

## Art

Eight CC0 texture sets and one HDRI from Poly Haven, vendored in `assets/`.
Credits in ATTRIBUTION.md.

All of it is optional. Delete `assets/` and the game plays the same in flat
colours. `npm run assets` re-fetches it, and it's the only thing here that
touches the network.

## License

The code is MIT. See LICENSE.

Two things in here aren't mine and aren't covered by it. three.js is vendored in
`node_modules/` and is MIT under its own copyright, with its licence text at
`node_modules/three/LICENSE`. The art is CC0, credited above.
