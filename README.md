# Coil

A slither-style snake arena that installs to your phone's home screen and plays
completely offline. Vanilla JS + Canvas 2D, no build step, no dependencies.

## Rules

- Drag a finger anywhere to steer. The stick follows your thumb, so you never run out of room.
- Eat pellets to grow.
- **You can cross your own tail freely.** Running your head into *another* snake kills you.
- If a rival runs into *your* tail, they die.
- Any dead snake bursts into food — the longer it was, the bigger the feast.
- Hold the ⚡ button (or a second finger, or space on desktop) to sprint. Sprinting burns length and leaves a trail of food behind you.

On desktop the snake follows the mouse and click-or-space sprints.

## Run it

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

A service worker is required for offline play, so it must be served over
http(s) — opening `index.html` straight off the disk won't register one.

## Install on a phone

Serve the folder somewhere your phone can reach it over **HTTPS** (or
`localhost`), then:

- **iOS Safari** — Share → *Add to Home Screen*.
- **Android Chrome** — the in-game *Install app* button, or ⋮ → *Install app*.

Once installed, all assets are cached and it runs in airplane mode.

## Layout

```
index.html              shell, HUD markup
css/style.css           HUD, overlay, boost button
js/game.js              engine: snakes, AI, collision, rendering
sw.js                   offline cache
manifest.webmanifest    install metadata
icons/                  generated PNG icon set
tools/make-icons.js     regenerates icons/ (node tools/make-icons.js)
```

## Tuning

Everything playable lives in the `CFG` object at the top of `js/game.js` —
arena size, speeds, turn rate, bot count, food density, sprint cost, and how
much of a dead snake turns into food (`deathYield`).
