# Physics validation

How do we know lumi's physics is right? We wrote **34 automated checks**. Each one compares the simulator against an answer worked out independently, from textbook formulas or published results. **All 34 pass.**

Run them yourself (needs [Node.js](https://nodejs.org) 18 or newer):

```bash
npm install playwright
npx playwright install chromium
node tests/validate.js
```

The script opens `index.html` in a hidden browser, runs every check, and prints what it expected, what it measured and the allowed tolerance. It takes a few minutes.

All values are in simulation units (G = 1). Unless a check says otherwise, it uses the simulator's normal settings: Velocity Verlet, time step 0.1, softening ε = 5.

---

## 1. The Equations tab shows the right numbers

For four bodies in the Solar System scenario, every number on the Equations tab (17 each: forces, accelerations, speeds, energies, orbit size and period) was compared with a separate calculation written from scratch in the test.

| Body | Compared with | Worst difference | Allowed |
|---|---|---|---|
| Cinder | Sol | 0.41% | 0.5% |
| Frost | Sol | 0.21% | 0.5% |
| Goliath | Sol | 0.32% | 0.5% |
| Pebble (a moon) | Goliath | 0.31% | 0.5% |

The tab shows 3 significant figures, so up to 0.5% difference is just rounding.

## 2. Kepler's laws

**Real gravity.** With softening switched (almost) off, the time for one lap matches Kepler's third law, T = 2π√(a³/GM):

| Orbit | Kepler predicts | Measured | Difference |
|---|---|---|---|
| Circle | 177.72 | 177.72 | 0.003% |
| Ellipse, e = 0.6 | 177.72 | 177.72 | 0.003% |
| Same ellipse, tilted 40° | 177.72 | 177.72 | 0.003% |

The three orbits have the same semi-major axis, so Kepler says they take the same time, and they do. Tilting the orbit changes nothing, as it shouldn't in 3D.

**T² / a³ is the same for every orbit.** Four planets at distances 70, 120, 200 and 320 all give T²/a³ = 0.003948 = 4π²/GM, within 0.04%.

**With softening (ε = 5).** The ellipse above, which dives to within 80 of the star, takes **1.57% longer** than plain Kepler. That's expected, and we can predict it. Softening makes the gravity well slightly shallower near the star, so the orbit has about 1% more energy and is about 1% larger, and T ∝ a^1.5. Kepler's formula with the softened energy predicts 180.34; we measured 180.50 (0.09% apart).

**The Solar System scenario.** Measured laps are 0.7% to 4.2% longer than the two-body prediction, because every planet also pulls on every other planet. Frost is the most affected (4.2%), because it is closest to the giant planet Goliath.

## 3. Escape speed

| Launch speed | Prediction | Result |
|---|---|---|
| 0.95 × escape speed | Bound; turns back at distance 1851 | Turned back at 1858 (0.4%, softening) |
| 1.02 × escape speed | Escapes for good | Still flying away at distance 30,000 |

## 4. Circular orbits

After "Make it orbit", the body's distance from the star stays the same to within **0.001%** over a whole lap.

## 5. Conservation of energy

| Test | Result |
|---|---|
| Velocity Verlet, Star & Planet, 10 laps | Energy constant to 2 × 10⁻⁸ % |
| Figure-8 and Binary Stars (Direct), 3,000 steps | Changed by less than 0.0001% |
| Galaxy Collision (Barnes-Hut), 600 steps | Changed by 0.015% |
| Galaxy Collision, through the first close pass | Changed by 0.07% (the scenario says ~0.1%) |
| **Euler**, Star & Planet, 10 laps | Planet spirals out from distance 150 to 215; energy rises from −334 to −230 |

The Euler result is what "How it works" says should happen: Euler adds a little energy every step, so orbits spiral outward. That's why we use Velocity Verlet.

## 6. Conservation of momentum

| Test | Total momentum after the run (fraction of Σ m·|v|) |
|---|---|
| Figure-8 (Direct) | 3 × 10⁻¹⁵ |
| Binary Stars (Direct) | 3 × 10⁻¹⁵ |
| Galaxy Collision (Barnes-Hut) | 8 × 10⁻¹⁶ |

Numbers this small are just the limits of computer arithmetic: momentum is conserved exactly.

With Direct this is automatic: each pair pulls equally on both bodies (Newton's 3rd law). **Barnes-Hut on its own does not conserve momentum.** A far-away cube pulls on a body, but the body doesn't pull back on the cube in exactly the same way. Validation caught this: the galaxies slowly drifted sideways, by 0.3% of their total momentum in 600 steps. The drift shrank as θ got smaller (3.3 × 10⁻³ at θ = 1, 1.8 × 10⁻⁴ at θ = 0.3), which confirmed the cause.

**Fix:** real forces inside a system always add up to zero, so after each Barnes-Hut calculation the simulator removes the tiny leftover total force from every body equally. Momentum is now exact. The extra change to each pull is far smaller than the Barnes-Hut error itself (average force error at θ = 0.6 went from 0.161% to 0.165%).

## 7. Collisions

| Quantity | Before | After merging |
|---|---|---|
| Mass | 20 + 12 = 32 | 32 (exact) |
| Momentum | (18, 6, 0) | (18, 6, 0), to within 10⁻⁹ |
| Energy | 19.8 units turned into heat | Drift readout accounts for all but 0.008% |

## 8. A known exact solution: the figure-8

Three equal masses chasing each other along a figure-8 is a famous exact solution of the three-body problem (Moore 1993; Chenciner & Montgomery 2000). Its period is 6.32591398 in units where G = m = 1. Scaled to the scenario (L = 150, M = 1000), that's **367.5**. We measured **368.4** (0.24% longer, from softening), and all three bodies return to within 0.5 units of where they started.

## 9. Barnes-Hut accuracy

Average error in each body's acceleration, compared with the exact Direct method:

| θ | Galaxy Collision (3,002 bodies) | Planet Formation (1,501 bodies) |
|---|---|---|
| 0.3 | 0.031% (99% of bodies under 0.10%) | 0.002% |
| **0.6 (default)** | **0.165% (99% under 0.50%)** | **0.019% (99% under 0.14%)** |
| 1.0 | 0.53% (99% under 2.1%) | 0.084% (99% under 0.45%) |

The error grows with θ, which is the trade-off the θ slider shows: bigger θ is faster but rougher.

## 10. What the scenarios claim

| Claim | Result |
|---|---|
| Gravity Assist: the probe starts trapped, then steals energy from the giant and escapes | Its energy goes from −20.1 to positive by t = 83, and it leaves |
| Galaxy Collision: the prograde (blue) galaxy throws out far more stars into tails than the retrograde (gold) one | Stars more than 300 from their own core: blue 19%, gold 9% |

---

## Known approximations (on purpose)

| Approximation | Why | Effect |
|---|---|---|
| **Softening**: r² + ε² instead of r² | Two bodies passing very close would otherwise get a near-infinite kick | Gravity is slightly weaker within a few ε of a body; close-diving orbits run up to ~1.5% slow |
| **Barnes-Hut** (above 200 bodies) | Checking every pair of 3,000 bodies is 4.5 million pairs per step | ~0.2% force error at θ = 0.6; momentum kept exact by the fix above |
| **Merging collisions** | Real collisions are messy; merging is the simplest model that conserves mass and momentum | Kinetic energy becomes heat, and the drift readout allows for it |
| **Two-body formulas** in the Equations tab (orbit, escape speed, Kepler) | They have an exact answer; the full N-body problem doesn't | They ignore the other bodies, so they're close but not exact in crowded systems |
| **Fixed time step** | Simple and symplectic with Velocity Verlet | Very fast close passes are less accurate; softening keeps them under control |

## What we changed because of this validation

- **Momentum fix for Barnes-Hut** (section 6).
- **Equations tab, gravity card:** it used to show F = GMm / (r² + ε²), which is neither Newton's law nor what the simulator uses. It now shows Newton's law, F = GMm / r², plus a separate row with the exact softened value the simulator uses, GMm·r / (r² + ε²)^(3/2). The potential-energy card does the same.
- **Kepler card:** now notes that softening makes close-diving orbits slightly slower.
- **"One lap in real time"** now allows for computers that can't keep up with the requested speed.
- **Facts in "How it works":** neutron stars are about 1.4 times the Sun's mass (it said "twice").
