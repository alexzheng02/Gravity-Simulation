# GravityLab

An interactive gravity simulator for planets, stars, and black holes. Place bodies, throw them into orbit, and watch how they pull on each other.

Built for the SPS MathPhys (2026) Hackathon, theme: **Visualization of Physical Processes**.

<p align="center">
  <img width="240" height="240" alt="Korone" src="https://github.com/user-attachments/assets/3504b8c8-3786-40ac-af36-3cbcf19f0a61" />
  <img width="450" height="240" alt="image" src="https://github.com/user-attachments/assets/31ae5e7d-0f13-4178-8ae7-f92e78b8f2a1" />
</p>

## Run it

No install needed.

1. Download or clone this repo.
2. Open `index.html` in any modern browser.

## What you can do

- **Throw bodies:** pick Planet, Star, Moon or Black Hole under the canvas, then drag on empty space to launch it. A dashed line previews its path. A quick click gives it a circular orbit.
- **Select and pan:** the default tool. Drag to move the view, click a body to inspect it. Press Esc (or click the active body type again) to go back to it.
- **Edit bodies:** change a selected body's mass, radius or velocity with the sliders, or type exact values in the boxes.
- **Try scenarios:** Solar System, Binary Stars, Figure-8 three-body orbit, Gravity Assist, Black Hole Disk, Random Cluster.
- **Compare integrators:** switch between Euler and Velocity Verlet and watch the energy graph.
- **See the physics:** velocity and gravity arrows, a gravity field view with equipotential rings, and a "How it works" panel in the app.
- **Thousands of bodies:** the Barnes-Hut algorithm (with a tree view) runs Planet Formation with 1,500 rocks.
- **Galaxy collision:** 3,000 stars show how tidal tails form.

### Auto-pause while editing

By default, the simulation keeps running while you edit a body, so you can watch changes take effect live. Tick **Auto-pause while editing** in the Physics panel to pause the simulation while you drag a slider or type in a box. It resumes when you finish, unless you had paused it yourself.

### Controls

| Input | Action |
|---|---|
| Drag (Select / Pan tool) | Pan the view |
| Click a body | Select it |
| Click empty space | Deselect |
| 1-4, or the Tool buttons | Pick Planet / Star / Moon / Black Hole |
| Drag (with a body type picked) | Throw that body |
| Click (with a body type picked) | Place it in a circular orbit |
| Esc | Back to Select / Pan |
| Right-drag | Pan (any tool) |
| Scroll | Zoom |
| Space | Play / pause |
| R / F | Reset / fit view |
| Delete | Remove selected body |
| Enter (in a number box) | Apply the value |

## How it works

**Gravity.** Every pair of bodies pulls on each other with `a = G·M / r²`. Each pair is computed once and applied in opposite directions (Newton's third law).

**Time stepping.** The simulation advances in small steps. Two methods are included:
- *Euler* is simple, but adds a little energy every step, so orbits spiral outward.
- *Velocity Verlet* is symplectic, so energy error stays small and bounded. Orbits stay closed.

**Energy check.** The graph plots kinetic, potential, and total energy. A flat total line means the simulation is accurate. This is how you can see Euler's error and Verlet's stability.

**Softening.** Distance is computed as `r² + ε²` so near-collisions don't produce infinite forces.

**Collisions.** Touching bodies merge, conserving mass and momentum. Some kinetic energy becomes "heat", marked on the energy graph.

**Gravity assist.** The Gravity Assist scenario shows a probe stealing energy from a planet, the way spacecraft like Voyager were sped up.

## Files

- `index.html`: page layout
- `style.css`: styling
- `script.js`: physics, rendering, and controls

## Team

- Alex Zheng
- Dewa Amandara

## Ideas for next steps

- **Formula display tab:** Add a collapsible section showing equations (F=ma, a=GM/r², KE=½mv², etc)
