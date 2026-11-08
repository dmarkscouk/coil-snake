# Coil

**Play / install: https://dmarkscouk.github.io/coil-snake/**

A slither-style snake arena that installs to your phone's home screen and plays
completely offline. Vanilla JS + Canvas 2D, no build step, no dependencies.

## Rules

- Drag a finger anywhere to steer. The stick follows your thumb, so you never run out of room. Turning is deliberately sharp — a full U-turn takes about 0.28s and barely 30 units of ground.
- Eat pellets to grow.
- **You can cross your own tail freely.** Running your head into *another* snake kills you.
- If a rival runs into *your* tail, they die.
- Any dead snake bursts into food — the longer it was, the bigger the feast.
- **The world has no edge.** It runs on forever in every direction, and the further you stray the more rivals you meet (13 near the start, up to 24).
- **Pause** with the button at the top of the screen, or Escape / P on desktop. The run also pauses itself if you switch apps, lock the phone or take a call, so backgrounding the game can't get you killed.
- **Double-tap and hold** to sprint: tap once, then press and hold. You keep steering while you burn. A second finger held down works too. Sprinting costs length and leaves a trail of food behind you.

On desktop the snake follows the mouse and click-or-space sprints.

## Run it

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

A service worker is required for offline play, so it must be served over
http(s) — opening `index.html` straight off the disk won't register one.

## Install on a phone

It's already served over HTTPS at
**https://dmarkscouk.github.io/coil-snake/** — open that on your phone, then:

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

## How the endless world works

There is no arena and no global state that grows. Food belongs to a 500-unit
chunk; the 7x7 chunks around you are filled in as you cross chunk borders and
dropped once you leave, so memory stays flat at ~580 pellets however far you
travel. Walk away and come back and the pellets are freshly scattered — you
cannot see far enough to tell. Food dropped by deaths and sprinting belongs to
no chunk and is culled by distance instead.

Rivals are kept topped up around you rather than living in a fixed space: any
that fall more than 4200 units behind are forgotten, and replacements fade in
off-screen at 950–1700 units, faster when you are a long way short.

## Why the bots don't circle

A bot that only ever picks the cheapest next heading settles happily into a
perfect circle — nothing in "chase the nearest pellet" ever says *stop
orbiting*. So each snake carries a `coil` figure: every turn it makes is added
on, and the total decays with a 2.2s half-life. Ordinary weaving cancels
itself out; going round and round pushes it away from zero. Past `coilLimit`
the bot enters unwind mode, where turning further the same way is simply not
among the options it may choose, until it has straightened out. In practice no
bot gets past about two-thirds of a full revolution.

## Tuning

Everything playable lives in the `CFG` object at the top of `js/game.js` —
arena size, speeds, turn rate, bot count, food density, sprint cost, and how
much of a dead snake turns into food (`deathYield`).
