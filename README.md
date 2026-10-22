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

- **Throw bodies:** drag on empty space to launch a planet, star, moon, or black hole. A dashed line previews its path. A quick click gives it a circular orbit.
- **Try scenarios:** Solar System, Binary Stars, Figure-8 three-body orbit, Gravity Assist, Black Hole Disk, Random Cluster.
- **Compare integrators:** switch between Euler and Velocity Verlet and watch the energy graph.
- **See the physics:** velocity and gravity arrows, a gravity field view with equipotential rings, and a "How it works" panel in the app.

### Controls

| Input | Action |
|---|---|
| Drag | Throw a body |
| Click | Place a body in a circular orbit |
| Scroll | Zoom |
| Right-drag | Pan |
| Space | Play / pause |
| R / F | Reset / fit view |
| 1-4 | Planet / Star / Moon / Black Hole |
| Delete | Remove selected body |

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

- Barnes-Hut tree for thousands of bodies
- Galaxy collision scenario
