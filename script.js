"use strict";

/* ==========================================================================
   GravityLab: an interactive N-body gravity simulator

   How the code is organised:
     1. Settings and state
     2. Physics (gravity, time stepping, collisions, energy)
     3. Scenarios (the presets in the dropdown)
     4. Camera (zoom / pan / converting mouse position to world position)
     5. Drawing (stars, planets, trails, arrows, gravity field, energy graph)
     6. Mouse, keyboard and UI controls
     7. The main loop
   ========================================================================== */


/* ==========================================================================
   1. SETTINGS AND STATE
   ========================================================================== */

// Physics constants. These are "simulation units", not metres and kilograms.
const G = 1;                    // gravitational constant
const DT = 0.1;                 // length of one time step
const SOFTENING = 5;            // epsilon: stops gravity going to infinity at r = 0
const STEPS_PER_SECOND = 300;   // physics steps per real second at 1x speed
const MAX_STEPS_PER_FRAME = 80; // safety limit so a slow computer doesn't freeze

const TRAIL_LENGTH = 450;       // how many points each trail remembers
const LAUNCH_SCALE = 0.05;      // how much velocity one unit of mouse drag gives
const ENERGY_HISTORY = 360;     // how many samples the energy graph shows

// The kinds of body you can place.
const BODY_TYPES = {
    planet:    { label: "Planet",     mass: 10,    radius: 8,  color: null },
    star:      { label: "Star",       mass: 10000, radius: 22, color: "#fbbf24" },
    moon:      { label: "Moon",       mass: 1,     radius: 4,  color: "#cbd5e1" },
    blackhole: { label: "Black Hole", mass: 40000, radius: 10, color: "#111111" }
};

const PLANET_COLORS = [
    "#38bdf8", "#a78bfa", "#34d399", "#f472b6",
    "#fb923c", "#2dd4bf", "#f87171", "#818cf8"
];

// Simulation state
let bodies = [];
let selectedBody = null;
let running = true;
let simulationSpeed = 1;
let integrator = "verlet";
let accelerationsFresh = false; // Verlet can reuse last step's gravity if nothing changed
let simTime = 0;
let stepAccumulator = 0;
let nextId = 1;
let typeCounters = {};
let currentScenario = "solar";

const options = {
    trails: true,
    vectors: false,
    field: false,
    merge: true,
    labels: true
};

// Energy tracking
let energyHistory = [];
let energyBaseline = null;
let pendingEnergyEvent = false;

// View state
const canvas = document.getElementById("universe");
const ctx = canvas.getContext("2d");
const energyCanvas = document.getElementById("energyChart");
const energyCtx = energyCanvas.getContext("2d");

let viewWidth = 0;
let viewHeight = 0;
let pixelRatio = 1;

const camera = { x: 0, y: 0, zoom: 1, follow: "free" };

let brush = "planet";   // which body type the mouse places
let pointer = null;     // what the mouse is currently doing (placing or panning)
let effects = [];       // collision flashes
let starfieldPattern = null;

const fieldCanvas = document.createElement("canvas");
const fieldCtx = fieldCanvas.getContext("2d");
let fieldImage = null;


/* ==========================================================================
   2. PHYSICS
   ========================================================================== */

function createBody({ type, name, x, y, vx = 0, vy = 0, mass, radius, color }) {
    const preset = BODY_TYPES[type];
    typeCounters[type] = (typeCounters[type] || 0) + 1;

    return {
        id: nextId++,
        type,
        name: name ?? preset.label + " " + typeCounters[type],
        x, y, vx, vy,
        ax: 0, ay: 0,
        mass: mass ?? preset.mass,
        radius: radius ?? preset.radius,
        color: color ?? preset.color ??
            PLANET_COLORS[(typeCounters[type] - 1) % PLANET_COLORS.length],
        trail: []
    };
}

function nextPlanetColor() {
    const used = typeCounters.planet || 0;
    return PLANET_COLORS[used % PLANET_COLORS.length];
}

/*
 * Newton's law of gravity for every pair of bodies.
 *
 *   a = G * M / r^2, pointing toward the other body
 *
 * We loop over each PAIR once (j starts at i + 1) and apply equal and
 * opposite pulls to both bodies (Newton's third law). That's half the
 * work of the naive "every body looks at every other body" loop.
 *
 * Softening: instead of r^2 we use r^2 + epsilon^2, so two bodies passing
 * extremely close don't get an infinite kick.
 */
function computeAccelerations(list) {
    for (const body of list) {
        body.ax = 0;
        body.ay = 0;
    }

    const eps2 = SOFTENING * SOFTENING;

    for (let i = 0; i < list.length; i++) {
        const a = list[i];

        for (let j = i + 1; j < list.length; j++) {
            const b = list[j];

            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const distSquared = dx * dx + dy * dy + eps2;

            // G / r^3. Multiplying by (dx, dy), which has length r,
            // gives a vector of length G / r^2 pointing at the other body.
            const factor = G / (distSquared * Math.sqrt(distSquared));

            a.ax += dx * factor * b.mass;
            a.ay += dy * factor * b.mass;
            b.ax -= dx * factor * a.mass;
            b.ay -= dy * factor * a.mass;
        }
    }
}

/*
 * Velocity Verlet ("kick, drift, kick").
 *   1. Half-kick: velocity += acceleration * dt/2
 *   2. Drift:     position += velocity * dt
 *   3. Recompute gravity at the new positions
 *   4. Half-kick: velocity += new acceleration * dt/2
 *
 * It's "symplectic": it preserves the geometry of orbital motion, so the
 * energy error stays small and bounded instead of building up.
 * Needs accelerations to already be correct for the current positions.
 */
function stepVerlet(list, dt) {
    for (const b of list) {
        b.vx += b.ax * dt / 2;
        b.vy += b.ay * dt / 2;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
    }

    computeAccelerations(list);

    for (const b of list) {
        b.vx += b.ax * dt / 2;
        b.vy += b.ay * dt / 2;
    }
}

/*
 * Forward Euler: the simplest possible method.
 *   position += velocity * dt
 *   velocity += acceleration * dt
 * Every step overshoots slightly outward, so orbits gain energy and spiral
 * out. Included so you can SEE why Verlet is better.
 */
function stepEuler(list, dt) {
    computeAccelerations(list);

    for (const b of list) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.vx += b.ax * dt;
        b.vy += b.ay * dt;
    }
}

function physicsStep() {
    if (integrator === "verlet") {
        // Verlet's last half-kick already computed gravity at the current
        // positions, so we reuse it: one gravity calculation per step.
        if (!accelerationsFresh) computeAccelerations(bodies);
        stepVerlet(bodies, DT);
        accelerationsFresh = true;
    } else {
        stepEuler(bodies, DT);
        accelerationsFresh = false;
    }

    simTime += DT;

    if (options.merge) handleCollisions();
}

/*
 * Perfectly inelastic collisions: two touching bodies become one.
 * Mass and momentum are conserved exactly. Kinetic energy is not:
 * in reality it becomes heat.
 */
function findTouchingPair() {
    for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
            const a = bodies[i];
            const b = bodies[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const touch = a.radius + b.radius;

            if (dx * dx + dy * dy < touch * touch) return [a, b];
        }
    }
    return null;
}

function mergeBodies(a, b) {
    const big = a.mass >= b.mass ? a : b;
    const small = big === a ? b : a;
    const totalMass = a.mass + b.mass;

    // Centre of mass position and momentum-conserving velocity
    big.x = (a.x * a.mass + b.x * b.mass) / totalMass;
    big.y = (a.y * a.mass + b.y * b.mass) / totalMass;
    big.vx = (a.vx * a.mass + b.vx * b.mass) / totalMass;
    big.vy = (a.vy * a.mass + b.vy * b.mass) / totalMass;
    big.mass = totalMass;

    // Volumes add, so the new radius is the cube root of the summed cubes
    big.radius = Math.min(60, Math.cbrt(a.radius ** 3 + b.radius ** 3));

    effects.push({ x: big.x, y: big.y, radius: big.radius, age: 0, color: small.color });

    bodies = bodies.filter(body => body !== small);
    if (selectedBody === small) selectedBody = big;
}

function handleCollisions() {
    let pair;
    let merged = false;

    while ((pair = findTouchingPair())) {
        mergeBodies(pair[0], pair[1]);
        merged = true;
    }

    if (merged) {
        markSystemChanged();
        refreshBodyList();
        updateProperties();
    }
}

/*
 * Energy of the whole system.
 *   Kinetic   = sum of (1/2) m v^2
 *   Potential = sum over pairs of  -G m1 m2 / r   (softened the same way as the force)
 * With no outside forces the total should stay constant.
 */
function measureEnergy(list) {
    let kinetic = 0;
    let potential = 0;
    const eps2 = SOFTENING * SOFTENING;

    for (const b of list) {
        kinetic += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
    }

    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            potential -= G * a.mass * b.mass / Math.sqrt(dx * dx + dy * dy + eps2);
        }
    }

    return { kinetic, potential, total: kinetic + potential };
}

function recordEnergy() {
    const e = measureEnergy(bodies);

    if (energyBaseline === null) {
        energyBaseline = {
            total: e.total,
            scale: Math.max(1e-9, e.kinetic + Math.abs(e.potential))
        };
    }

    energyHistory.push({ ...e, event: pendingEnergyEvent });
    pendingEnergyEvent = false;

    if (energyHistory.length > ENERGY_HISTORY) energyHistory.shift();
}

// Call whenever the user (or a collision) changes the system, so the
// energy drift measurement starts fresh from the new situation.
function markSystemChanged() {
    accelerationsFresh = false;
    energyBaseline = null;
    pendingEnergyEvent = true;
}

function energyDriftPercent() {
    if (!energyBaseline || energyHistory.length === 0) return null;
    const latest = energyHistory[energyHistory.length - 1];
    return (latest.total - energyBaseline.total) / energyBaseline.scale * 100;
}

function centerOfMass() {
    let mx = 0, my = 0, m = 0;
    for (const b of bodies) {
        mx += b.x * b.mass;
        my += b.y * b.mass;
        m += b.mass;
    }
    return m > 0 ? { x: mx / m, y: my / m } : { x: 0, y: 0 };
}

// Shift every velocity so total momentum is zero.
// Otherwise the whole system slowly drifts off screen.
function zeroMomentum() {
    let px = 0, py = 0, m = 0;
    for (const b of bodies) {
        px += b.mass * b.vx;
        py += b.mass * b.vy;
        m += b.mass;
    }
    if (m === 0) return;
    for (const b of bodies) {
        b.vx -= px / m;
        b.vy -= py / m;
    }
}

// Which body pulls hardest on the point (x, y)?
function dominantAttractor(x, y, exclude) {
    let best = null;
    let bestPull = 0;
    const eps2 = SOFTENING * SOFTENING;

    for (const b of bodies) {
        if (b === exclude) continue;
        const dx = b.x - x;
        const dy = b.y - y;
        const pull = b.mass / (dx * dx + dy * dy + eps2);
        if (pull > bestPull) {
            bestPull = pull;
            best = b;
        }
    }
    return best;
}

/*
 * Velocity for a circular orbit around `attractor`.
 * Circular motion needs  v^2 / r = gravity, so v = sqrt(G (M + m) / r).
 * (The extra factors account for softening so the orbit is truly circular.)
 * The direction is perpendicular to the line joining the two bodies.
 */
function circularVelocity(x, y, mass, attractor) {
    const dx = x - attractor.x;
    const dy = y - attractor.y;
    const r = Math.hypot(dx, dy);

    if (r < 1e-6) return { vx: attractor.vx, vy: attractor.vy };

    const totalMass = attractor.mass + mass;
    const speed = Math.sqrt(
        G * totalMass * r * r / Math.pow(r * r + SOFTENING * SOFTENING, 1.5)
    );

    return {
        vx: attractor.vx + speed * dy / r,
        vy: attractor.vy - speed * dx / r
    };
}

/*
 * Trajectory preview: copy the whole system, add the body being placed,
 * and run the physics forward without touching the real simulation.
 */
function predictPath(start, velocity) {
    const preset = BODY_TYPES[brush];

    const sim = bodies.map(b => ({
        x: b.x, y: b.y, vx: b.vx, vy: b.vy,
        ax: 0, ay: 0, mass: b.mass, radius: b.radius
    }));

    const probe = {
        x: start.x, y: start.y,
        vx: velocity.vx, vy: velocity.vy,
        ax: 0, ay: 0, mass: preset.mass, radius: preset.radius
    };
    sim.push(probe);

    const n = sim.length;
    const steps = Math.max(200, Math.min(1500, Math.floor(600000 / (n * n))));
    const points = [{ x: probe.x, y: probe.y }];
    let hit = null;

    if (integrator === "verlet") computeAccelerations(sim);

    for (let s = 0; s < steps && !hit; s++) {
        if (integrator === "verlet") stepVerlet(sim, DT);
        else stepEuler(sim, DT);

        if (s % 3 === 0) points.push({ x: probe.x, y: probe.y });

        if (options.merge) {
            for (let k = 0; k < n - 1; k++) {
                const o = sim[k];
                const dx = o.x - probe.x;
                const dy = o.y - probe.y;
                const touch = o.radius + probe.radius;
                if (dx * dx + dy * dy < touch * touch) {
                    hit = { x: probe.x, y: probe.y };
                    break;
                }
            }
        }
    }

    points.push({ x: probe.x, y: probe.y });
    return { points, hit };
}


/* ==========================================================================
   3. SCENARIOS
   ========================================================================== */

function addBody(props) {
    const body = createBody(props);
    bodies.push(body);
    return body;
}

// Place a body on a circular orbit around `attractor`.
function addOrbiting(type, attractor, distance, angleDegrees, props = {}) {
    const angle = angleDegrees * Math.PI / 180;
    const x = attractor.x + distance * Math.cos(angle);
    const y = attractor.y + distance * Math.sin(angle);
    const mass = props.mass ?? BODY_TYPES[type].mass;
    const v = circularVelocity(x, y, mass, attractor);

    return addBody({ type, x, y, vx: v.vx, vy: v.vy, ...props });
}

// Small seeded random number generator so "random" presets look
// the same every time you reset them.
function seededRandom(seed) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SCENARIOS = {

    solar: {
        fit: 400,
        note: "A star with five planets and a moon. Switch the integrator to Euler and watch the inner planet spiral outward.",
        build() {
            // Spacing tested to stay stable for several minutes of real time
            const sun = addBody({ type: "star", name: "Sol", x: 0, y: 0 });
            addOrbiting("planet", sun, 70, 20, { name: "Cinder", mass: 3, radius: 5, color: "#fb923c" });
            addOrbiting("planet", sun, 110, 140, { name: "Rosa", mass: 6, radius: 7, color: "#f472b6" });
            addOrbiting("planet", sun, 155, 250, { name: "Azure", mass: 8, radius: 8, color: "#38bdf8" });
            addOrbiting("planet", sun, 215, 60, { name: "Frost", mass: 12, radius: 9, color: "#a5f3fc" });
            const giant = addOrbiting("planet", sun, 360, 330, { name: "Goliath", mass: 150, radius: 12, color: "#e7c59a" });
            addOrbiting("moon", giant, 22, 0, { name: "Pebble", mass: 0.5, radius: 3 });
        }
    },

    sunPlanet: {
        fit: 220,
        note: "The simplest orbit: one star, one planet. Turn on force arrows: gravity always points at the star, velocity is sideways.",
        build() {
            const sun = addBody({ type: "star", name: "Star", x: 0, y: 0, radius: 25 });
            addOrbiting("planet", sun, 150, 0, { name: "Planet", radius: 10, color: "#38bdf8" });
        }
    },

    binary: {
        fit: 640,
        note: "Two stars orbiting their shared centre of mass, with planets circling both (like Tatooine).",
        build() {
            const separation = 160;
            const each = 6000;
            const r = separation;
            const relativeSpeed = Math.sqrt(
                G * 2 * each * r * r / Math.pow(r * r + SOFTENING * SOFTENING, 1.5)
            );

            addBody({ type: "star", name: "Helios A", x: -separation / 2, y: 0, vy: relativeSpeed / 2, mass: each, radius: 18, color: "#fbbf24" });
            addBody({ type: "star", name: "Helios B", x: separation / 2, y: 0, vy: -relativeSpeed / 2, mass: each, radius: 18, color: "#93c5fd" });

            // Far away, the pair pulls like one big mass at the centre
            const pair = { x: 0, y: 0, vx: 0, vy: 0, mass: 2 * each };
            addOrbiting("planet", pair, 450, 200, { name: "Duo", color: "#34d399" });
            addOrbiting("planet", pair, 600, 30, { name: "Far Duo", color: "#a78bfa" });
        }
    },

    figure8: {
        fit: 220,
        note: "Three equal masses chasing each other along a figure-8, a famous solution to the three-body problem (found in 1993). Tiny errors eventually break it: three-body motion is chaotic.",
        build() {
            // Known solution (Chenciner & Montgomery 2000) for G = m = 1,
            // scaled up to screen size.
            const L = 150;
            const M = 1000;
            const v = Math.sqrt(G * M / L);

            const x1 = 0.97000436, y1 = -0.24308753;
            const vx3 = -0.93240737, vy3 = -0.86473146;

            addBody({ type: "planet", name: "Alpha", x: x1 * L, y: y1 * L, vx: -vx3 / 2 * v, vy: -vy3 / 2 * v, mass: M, radius: 6, color: "#38bdf8" });
            addBody({ type: "planet", name: "Beta", x: -x1 * L, y: -y1 * L, vx: -vx3 / 2 * v, vy: -vy3 / 2 * v, mass: M, radius: 6, color: "#f472b6" });
            addBody({ type: "planet", name: "Gamma", x: 0, y: 0, vx: vx3 * v, vy: vy3 * v, mass: M, radius: 6, color: "#fbbf24" });
        }
    },

    slingshot: {
        fit: 430,
        note: "A probe on a trapped orbit flies just behind a giant planet, steals a little of its orbital energy, and escapes the system. NASA used this trick to send Voyager to the outer planets.",
        build() {
            const sun = addBody({ type: "star", name: "Sun", x: 0, y: 0 });
            // The 283 degree start angle was found by searching every angle
            // and picking the one where the probe gains the most energy.
            addOrbiting("planet", sun, 260, 283, { name: "Giant", mass: 400, radius: 14, color: "#e7c59a" });

            const probeStart = { x: 110, y: 0 };
            const circular = circularVelocity(probeStart.x, probeStart.y, 0.01, sun);
            addBody({
                type: "moon", name: "Probe", x: probeStart.x, y: probeStart.y,
                vx: circular.vx * 1.25, vy: circular.vy * 1.25,
                mass: 0.01, radius: 3, color: "#4ade80"
            });
        }
    },

    blackhole: {
        fit: 430,
        note: "A disk of moons around a black hole. A star is falling in from the left; watch it tear the outer disk apart.",
        build() {
            const hole = addBody({ type: "blackhole", name: "Black Hole", x: 0, y: 0 });
            const random = seededRandom(7);

            for (let i = 0; i < 40; i++) {
                const distance = 110 + random() * 190;
                addOrbiting("moon", hole, distance, random() * 360, {
                    name: "Moon " + (i + 1),
                    mass: 1,
                    radius: 3,
                    color: PLANET_COLORS[i % PLANET_COLORS.length]
                });
            }

            // Intruder star starts at the far point of an ellipse
            // whose closest approach skims the edge of the disk.
            const starMass = 8000;
            const start = 1000;
            const closest = 330;
            const semiMajor = (start + closest) / 2;
            const speed = Math.sqrt(G * (hole.mass + starMass) * (2 / start - 1 / semiMajor));
            addBody({ type: "star", name: "Intruder", x: -start, y: 0, vx: 0, vy: speed, mass: starMass, radius: 20, color: "#fca5a5" });
        }
    },

    cluster: {
        fit: 380,
        note: "Thirty random planets with a slight spin. Gravity pulls them together, they collide and merge, and a few survivors end up orbiting the biggest.",
        build() {
            for (let i = 0; i < 30; i++) {
                const angle = Math.random() * Math.PI * 2;
                const distance = 40 + Math.sqrt(Math.random()) * 260;
                const x = distance * Math.cos(angle);
                const y = distance * Math.sin(angle);
                const mass = 20 + Math.random() * 180;

                addBody({
                    type: "planet", x, y,
                    vx: y * 0.012 + (Math.random() - 0.5) * 0.6,
                    vy: -x * 0.012 + (Math.random() - 0.5) * 0.6,
                    mass,
                    radius: 3 + Math.cbrt(mass) * 1.1
                });
            }
        }
    },

    empty: {
        fit: 300,
        note: "Empty space. Pick a body type below the canvas and start throwing things.",
        build() {}
    }
};

function loadScenario(name) {
    const scenario = SCENARIOS[name] || SCENARIOS.solar;
    currentScenario = name;

    bodies = [];
    nextId = 1;
    typeCounters = {};
    selectedBody = null;
    effects = [];
    simTime = 0;
    stepAccumulator = 0;
    energyHistory = [];
    energyBaseline = null;
    pendingEnergyEvent = false;
    accelerationsFresh = false;
    pointer = null;

    scenario.build();
    zeroMomentum();
    fitView(scenario.fit);

    running = true;
    updatePlayButton();
    refreshBodyList();
    updateProperties();

    document.getElementById("scenarioSelect").value = name;
    document.getElementById("scenarioNote").textContent = scenario.note;
}


/* ==========================================================================
   4. CAMERA
   ========================================================================== */

function resizeCanvas() {
    pixelRatio = window.devicePixelRatio || 1;
    viewWidth = canvas.clientWidth;
    viewHeight = canvas.clientHeight;
    canvas.width = Math.round(viewWidth * pixelRatio);
    canvas.height = Math.round(viewHeight * pixelRatio);
    buildStarfield();
}

function resizeEnergyChart() {
    energyCanvas.width = Math.round(energyCanvas.clientWidth * pixelRatio);
    energyCanvas.height = Math.round(energyCanvas.clientHeight * pixelRatio);
}

function screenToWorld(sx, sy) {
    return {
        x: (sx - viewWidth / 2) / camera.zoom + camera.x,
        y: (sy - viewHeight / 2) / camera.zoom + camera.y
    };
}

function worldToScreen(x, y) {
    return {
        x: (x - camera.x) * camera.zoom + viewWidth / 2,
        y: (y - camera.y) * camera.zoom + viewHeight / 2
    };
}

// Draw in world coordinates (zoom + pan applied)
function useWorldTransform() {
    const s = pixelRatio * camera.zoom;
    ctx.setTransform(
        s, 0, 0, s,
        pixelRatio * (viewWidth / 2 - camera.x * camera.zoom),
        pixelRatio * (viewHeight / 2 - camera.y * camera.zoom)
    );
}

// Draw in screen pixels (for text and overlays)
function useScreenTransform() {
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
}

function fitView(radius) {
    const center = centerOfMass();
    camera.x = center.x;
    camera.y = center.y;

    let r = radius;
    if (!r) {
        r = 0;
        for (const b of bodies) {
            r = Math.max(r, Math.hypot(b.x - center.x, b.y - center.y) + b.radius);
        }
        r = Math.max(r * 1.15, 300);
    }

    const size = Math.min(viewWidth, viewHeight) || 600;
    camera.zoom = clamp(size / 2 / r, 0.03, 5);
}

function updateCameraFollow() {
    if (camera.follow === "com" && bodies.length > 0) {
        const c = centerOfMass();
        camera.x = c.x;
        camera.y = c.y;
    } else if (camera.follow === "selected" && selectedBody) {
        camera.x = selectedBody.x;
        camera.y = selectedBody.y;
    }
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}


/* ==========================================================================
   5. DRAWING
   ========================================================================== */

// ---------- Colour helpers ----------

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
}

function mixColor(hex, target, t) {
    const [r, g, b] = hexToRgb(hex);
    const [tr, tg, tb] = target;
    return `rgb(${Math.round(r + (tr - r) * t)},${Math.round(g + (tg - g) * t)},${Math.round(b + (tb - b) * t)})`;
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

// ---------- Background ----------

function buildStarfield() {
    const w = Math.max(1, Math.round(viewWidth * pixelRatio));
    const h = Math.max(1, Math.round(viewHeight * pixelRatio));
    const tile = document.createElement("canvas");
    tile.width = w;
    tile.height = h;
    const t = tile.getContext("2d");
    const random = seededRandom(42);

    for (let i = 0; i < 260; i++) {
        const x = random() * w;
        const y = random() * h;
        const size = (random() < 0.9 ? 0.6 : 1.3) * pixelRatio;
        const tint = random();
        t.fillStyle = tint < 0.15 ? "rgba(191,219,254," : tint < 0.25 ? "rgba(254,240,138," : "rgba(255,255,255,";
        t.fillStyle += (0.25 + random() * 0.6).toFixed(2) + ")";
        t.beginPath();
        t.arc(x, y, size, 0, Math.PI * 2);
        t.fill();
    }

    starfieldPattern = ctx.createPattern(tile, "repeat");
}

function drawStarfield() {
    if (!starfieldPattern) return;
    // Stars move slowly when you pan: a little parallax depth effect
    const offsetX = -camera.x * camera.zoom * 0.05 * pixelRatio;
    const offsetY = -camera.y * camera.zoom * 0.05 * pixelRatio;
    ctx.setTransform(1, 0, 0, 1, offsetX % canvas.width, offsetY % canvas.height);
    ctx.fillStyle = starfieldPattern;
    ctx.fillRect(-canvas.width, -canvas.height, canvas.width * 3, canvas.height * 3);
}

/*
 * Gravity field: for a grid of points, add up the gravitational potential
 * (G * M / r) from every body. Bright = deep gravity well.
 * The rings are equipotential lines.
 */
function drawField() {
    const cell = 4;
    const cols = Math.ceil(viewWidth / cell);
    const rows = Math.ceil(viewHeight / cell);

    if (fieldCanvas.width !== cols || fieldCanvas.height !== rows) {
        fieldCanvas.width = cols;
        fieldCanvas.height = rows;
        fieldImage = fieldCtx.createImageData(cols, rows);
    }

    const data = fieldImage.data;
    const eps2 = 15 * 15;
    const n = bodies.length;

    for (let row = 0; row < rows; row++) {
        const wy = ((row + 0.5) * cell - viewHeight / 2) / camera.zoom + camera.y;

        for (let col = 0; col < cols; col++) {
            const wx = ((col + 0.5) * cell - viewWidth / 2) / camera.zoom + camera.x;

            let potential = 0;
            for (let k = 0; k < n; k++) {
                const b = bodies[k];
                const dx = wx - b.x;
                const dy = wy - b.y;
                potential += b.mass / Math.sqrt(dx * dx + dy * dy + eps2);
            }

            // Logarithmic scale: each step up is a doubling of well depth
            const level = Math.log2(1 + G * potential);   // ~3 (far away) .. ~11 (next to a black hole)
            const t = clamp((level - 3) / 8, 0, 1);

            // Equipotential rings: a soft line every half level
            const ring = level * 2 - Math.floor(level * 2);
            const edge = Math.min(ring, 1 - ring);
            const line = level > 3.5 && edge < 0.06 ? (1 - edge / 0.06) * 0.8 : 0;

            const i = (row * cols + col) * 4;
            data[i] = 40 + 160 * t * t + line * 90;
            data[i + 1] = 25 + 70 * t * t * t + line * 90;
            data[i + 2] = 90 + 160 * t + line * 70;
            data[i + 3] = Math.min(255, 200 * t + line * 110);
        }
    }

    fieldCtx.putImageData(fieldImage, 0, 0);
    useScreenTransform();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fieldCanvas, 0, 0, cols * cell, rows * cell);
}

// ---------- Trails ----------

function recordTrails() {
    for (const b of bodies) {
        b.trail.push({ x: b.x, y: b.y });
        if (b.trail.length > TRAIL_LENGTH) b.trail.shift();
    }
}

function drawTrails() {
    useWorldTransform();
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.lineJoin = "round";

    const chunks = 6;

    for (const b of bodies) {
        const trail = b.trail;
        if (trail.length < 2) continue;

        // Draw in pieces that get brighter toward the body (fading tail)
        const per = Math.ceil(trail.length / chunks);

        for (let c = 0; c < chunks; c++) {
            const start = c * per;
            const end = Math.min(trail.length - 1, (c + 1) * per);
            if (end <= start) continue;

            ctx.beginPath();
            ctx.moveTo(trail[start].x, trail[start].y);
            for (let i = start + 1; i <= end; i++) ctx.lineTo(trail[i].x, trail[i].y);
            ctx.strokeStyle = rgba(b.color === "#111111" ? "#f97316" : b.color, 0.12 + 0.6 * (c + 1) / chunks);
            ctx.stroke();
        }
    }
}

// ---------- Bodies ----------

// Direction toward the brightest nearby star, so planets are lit on that side
function lightDirection(body) {
    let best = null;
    let bestValue = 0;

    for (const b of bodies) {
        if (b === body || b.type !== "star") continue;
        const d2 = (b.x - body.x) ** 2 + (b.y - body.y) ** 2 + 1;
        const value = b.mass / d2;
        if (value > bestValue) {
            bestValue = value;
            best = b;
        }
    }

    if (!best) return { x: -0.6, y: -0.6 };
    const dx = best.x - body.x;
    const dy = best.y - body.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
}

function drawBody(b) {
    const { x, y, radius: r } = b;

    if (b.type === "star") {
        const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 4);
        glow.addColorStop(0, rgba(b.color, 0.45));
        glow.addColorStop(0.4, rgba(b.color, 0.12));
        glow.addColorStop(1, rgba(b.color, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, r * 4, 0, Math.PI * 2);
        ctx.fill();

        const core = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
        core.addColorStop(0, "#fffbea");
        core.addColorStop(0.5, b.color);
        core.addColorStop(1, mixColor(b.color, BLACK, 0.25));
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();

    } else if (b.type === "blackhole") {
        const disk = ctx.createRadialGradient(x, y, r * 0.9, x, y, r * 3.4);
        disk.addColorStop(0, "rgba(255,210,140,0.95)");
        disk.addColorStop(0.25, "rgba(249,115,22,0.55)");
        disk.addColorStop(1, "rgba(249,115,22,0)");
        ctx.fillStyle = disk;
        ctx.beginPath();
        ctx.arc(x, y, r * 3.4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#000";
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = "rgba(255,225,180,0.9)";
        ctx.lineWidth = r * 0.15;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.08, 0, Math.PI * 2);
        ctx.stroke();

    } else {
        const light = lightDirection(b);
        const shade = ctx.createRadialGradient(
            x + light.x * r * 0.45, y + light.y * r * 0.45, r * 0.05,
            x, y, r * 1.1
        );
        shade.addColorStop(0, mixColor(b.color, WHITE, 0.45));
        shade.addColorStop(0.5, b.color);
        shade.addColorStop(1, mixColor(b.color, BLACK, 0.75));
        ctx.fillStyle = shade;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }

    if (b === selectedBody) {
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1.5 / camera.zoom;
        ctx.setLineDash([4 / camera.zoom, 4 / camera.zoom]);
        ctx.lineDashOffset = -performance.now() / 60 / camera.zoom;
        ctx.beginPath();
        ctx.arc(x, y, r + 6 / camera.zoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

function drawArrow(x1, y1, x2, y2, color, width) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;

    const head = Math.min(len * 0.4, 9 / camera.zoom);
    const ux = dx / len;
    const uy = dy / len;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width / camera.zoom;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2 - ux * head * 0.8, y2 - uy * head * 0.8);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - ux * head - uy * head * 0.5, y2 - uy * head + ux * head * 0.5);
    ctx.lineTo(x2 - ux * head + uy * head * 0.5, y2 - uy * head - ux * head * 0.5);
    ctx.closePath();
    ctx.fill();
}

// Green = velocity, orange = acceleration from gravity
function drawVectors() {
    if (!accelerationsFresh) computeAccelerations(bodies);

    for (const b of bodies) {
        const start = b.radius;

        const speed = Math.hypot(b.vx, b.vy);
        if (speed > 1e-3) {
            const length = Math.min(speed * 6, 220);
            drawArrow(
                b.x + b.vx / speed * start, b.y + b.vy / speed * start,
                b.x + b.vx / speed * (start + length), b.y + b.vy / speed * (start + length),
                "#4ade80", 2
            );
        }

        // Square-root scaling keeps arrows readable near a star and far from it
        const accel = Math.hypot(b.ax, b.ay);
        if (accel > 1e-4) {
            const length = Math.min(Math.sqrt(accel) * 45, 90);
            drawArrow(
                b.x + b.ax / accel * start, b.y + b.ay / accel * start,
                b.x + b.ax / accel * (start + length), b.y + b.ay / accel * (start + length),
                "#fb923c", 2
            );
        }
    }
}

function drawEffects() {
    for (const e of effects) {
        const t = e.age / 40;
        ctx.strokeStyle = rgba(e.color === "#111111" ? "#f97316" : e.color, 1 - t);
        ctx.lineWidth = 2.5 / camera.zoom;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.radius + t * 40, 0, Math.PI * 2);
        ctx.stroke();
    }
    effects.forEach(e => e.age++);
    effects = effects.filter(e => e.age < 40);
}

function drawLabels() {
    if (!options.labels) return;
    useScreenTransform();
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";

    const crowded = bodies.length > 14;

    for (const b of bodies) {
        if (b !== selectedBody && crowded && b.type === "moon") continue;
        const p = worldToScreen(b.x, b.y);
        if (p.x < -50 || p.y < -50 || p.x > viewWidth + 50 || p.y > viewHeight + 50) continue;

        ctx.fillStyle = b === selectedBody ? "#ffffff" : "rgba(203,213,225,0.7)";
        ctx.fillText(b.name, p.x, p.y + b.radius * camera.zoom + 14);
    }
}

// ---------- Placing new bodies ----------

function placementVelocity(p) {
    const dragPixels = Math.hypot(
        p.currentScreen.x - p.startScreen.x,
        p.currentScreen.y - p.startScreen.y
    );

    // Just a click: give it a circular orbit around whatever pulls hardest
    if (dragPixels < 6) {
        const attractor = dominantAttractor(p.start.x, p.start.y, null);
        if (!attractor) return { vx: 0, vy: 0, auto: true, attractor: null };
        const v = circularVelocity(p.start.x, p.start.y, BODY_TYPES[brush].mass, attractor);
        return { ...v, auto: true, attractor };
    }

    // A drag: velocity follows the drag direction and length
    return {
        vx: (p.current.x - p.start.x) * LAUNCH_SCALE,
        vy: (p.current.y - p.start.y) * LAUNCH_SCALE,
        auto: false
    };
}

function drawPlacement() {
    if (!pointer || pointer.mode !== "place") return;

    const preset = BODY_TYPES[brush];
    const color = preset.color ?? nextPlanetColor();
    const velocity = placementVelocity(pointer);
    const prediction = predictPath(pointer.start, velocity);

    useWorldTransform();

    // Predicted path
    ctx.setLineDash([6 / camera.zoom, 5 / camera.zoom]);
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    prediction.points.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
    ctx.stroke();
    ctx.setLineDash([]);

    if (prediction.hit) {
        const s = 7 / camera.zoom;
        ctx.strokeStyle = "#f87171";
        ctx.lineWidth = 2.5 / camera.zoom;
        ctx.beginPath();
        ctx.moveTo(prediction.hit.x - s, prediction.hit.y - s);
        ctx.lineTo(prediction.hit.x + s, prediction.hit.y + s);
        ctx.moveTo(prediction.hit.x + s, prediction.hit.y - s);
        ctx.lineTo(prediction.hit.x - s, prediction.hit.y + s);
        ctx.stroke();
    }

    // Ghost of the body
    ctx.globalAlpha = 0.6;
    drawBody({ ...preset, type: brush, x: pointer.start.x, y: pointer.start.y, color, radius: preset.radius });
    ctx.globalAlpha = 1;

    // Launch arrow
    if (!velocity.auto) {
        drawArrow(pointer.start.x, pointer.start.y, pointer.current.x, pointer.current.y, "#f8fafc", 2);
    }

    // Text near the cursor
    useScreenTransform();
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#e2e8f0";
    const speed = Math.hypot(velocity.vx, velocity.vy);
    const text = velocity.auto
        ? (velocity.attractor ? "Release for a circular orbit around " + velocity.attractor.name : "Release to place at rest")
        : "Speed " + speed.toFixed(2);
    ctx.fillText(text, pointer.currentScreen.x + 14, pointer.currentScreen.y - 12);
}

// ---------- Energy graph ----------

function drawEnergyChart() {
    const w = energyCanvas.clientWidth;
    const h = energyCanvas.clientHeight;
    const c = energyCtx;

    c.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    c.clearRect(0, 0, w, h);

    if (energyHistory.length < 2) {
        c.fillStyle = "#64748b";
        c.font = "12px system-ui, sans-serif";
        c.textAlign = "center";
        c.fillText("Press play to start measuring", w / 2, h / 2 + 4);
        return;
    }

    let min = 0;
    let max = 0;
    for (const e of energyHistory) {
        min = Math.min(min, e.kinetic, e.potential, e.total);
        max = Math.max(max, e.kinetic, e.potential, e.total);
    }
    const pad = (max - min) * 0.08 || 1;
    min -= pad;
    max += pad;

    const xFor = i => (i / (ENERGY_HISTORY - 1)) * w;
    const yFor = v => h - ((v - min) / (max - min)) * h;

    // Zero line
    c.strokeStyle = "#334155";
    c.lineWidth = 1;
    c.setLineDash([3, 3]);
    c.beginPath();
    c.moveTo(0, yFor(0));
    c.lineTo(w, yFor(0));
    c.stroke();

    // Events (collisions, edits)
    c.strokeStyle = "rgba(250,204,21,0.45)";
    energyHistory.forEach((e, i) => {
        if (!e.event) return;
        c.beginPath();
        c.moveTo(xFor(i), 0);
        c.lineTo(xFor(i), h);
        c.stroke();
    });
    c.setLineDash([]);

    const series = [
        ["kinetic", "#38bdf8"],
        ["potential", "#f87171"],
        ["total", "#f8fafc"]
    ];

    for (const [key, color] of series) {
        c.strokeStyle = color;
        c.lineWidth = key === "total" ? 2 : 1.5;
        c.beginPath();
        energyHistory.forEach((e, i) => {
            const px = xFor(i);
            const py = yFor(e[key]);
            if (i === 0) c.moveTo(px, py);
            else c.lineTo(px, py);
        });
        c.stroke();
    }
}

// ---------- Main render ----------

function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#02040b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawStarfield();

    if (options.field && bodies.length > 0) drawField();

    if (options.trails) drawTrails();

    useWorldTransform();
    for (const b of bodies) drawBody(b);

    if (options.vectors) drawVectors();

    drawEffects();
    drawPlacement();
    drawLabels();
}


/* ==========================================================================
   6. CONTROLS
   ========================================================================== */

function formatMass(m) {
    if (m >= 1000) return Math.round(m).toLocaleString();
    if (m >= 10) return m.toFixed(0);
    if (m >= 1) return m.toFixed(1);
    return m.toFixed(2);
}

// The mass slider is logarithmic: 0.1 to 100,000
function massFromSlider(value) {
    return Number((10 ** (-1 + value * 6 / 1000)).toPrecision(3));
}

function sliderFromMass(mass) {
    return (Math.log10(Math.max(mass, 0.1)) + 1) * 1000 / 6;
}

function refreshBodyList() {
    const list = document.getElementById("bodyList");
    list.innerHTML = "";

    for (const body of bodies) {
        const item = document.createElement("div");
        item.className = "body-item" + (body === selectedBody ? " selected" : "");

        const dot = document.createElement("span");
        dot.className = "body-dot";
        dot.style.background = body.type === "blackhole" ? "#000" : body.color;
        if (body.type === "blackhole") dot.style.boxShadow = "0 0 0 2px #f97316";

        const name = document.createElement("span");
        name.textContent = body.name;

        const mass = document.createElement("span");
        mass.className = "mass";
        mass.textContent = "m " + formatMass(body.mass);

        item.append(dot, name, mass);
        item.onclick = () => selectBody(body);
        list.appendChild(item);
    }

    document.getElementById("bodyCount").textContent = "(" + bodies.length + ")";
}

function selectBody(body) {
    selectedBody = body;
    refreshBodyList();
    updateProperties();
}

function updateProperties() {
    const panel = document.getElementById("bodyProperties");
    const name = document.getElementById("selectedBodyName");

    if (!selectedBody || !bodies.includes(selectedBody)) {
        selectedBody = null;
        panel.classList.add("hidden");
        name.textContent = "Click a body to inspect it";
        name.classList.add("muted");
        return;
    }

    panel.classList.remove("hidden");
    name.textContent = selectedBody.name + " (" + BODY_TYPES[selectedBody.type].label + ")";
    name.classList.remove("muted");

    document.getElementById("massSlider").value = sliderFromMass(selectedBody.mass);
    document.getElementById("massValue").textContent = formatMass(selectedBody.mass);
    document.getElementById("radiusSlider").value = selectedBody.radius;
    document.getElementById("radiusValue").textContent = Math.round(selectedBody.radius);

    refreshLiveReadouts(true);
}

// Numbers that change every frame
function refreshLiveReadouts(force = false) {
    if (selectedBody) {
        const vxInput = document.getElementById("vxInput");
        const vyInput = document.getElementById("vyInput");
        if (force || document.activeElement !== vxInput) vxInput.value = selectedBody.vx.toFixed(2);
        if (force || document.activeElement !== vyInput) vyInput.value = selectedBody.vy.toFixed(2);
        document.getElementById("speedReadout").textContent =
            Math.hypot(selectedBody.vx, selectedBody.vy).toFixed(2);
    }

    const drift = energyDriftPercent();
    const driftEl = document.getElementById("driftValue");
    if (drift === null) {
        driftEl.textContent = "measuring…";
        driftEl.style.color = "";
    } else {
        driftEl.textContent = (drift >= 0 ? "+" : "") + drift.toFixed(3) + "%";
        const size = Math.abs(drift);
        driftEl.style.color = size < 0.1 ? "#4ade80" : size < 1 ? "#facc15" : "#f87171";
    }

    const integratorName = integrator === "verlet" ? "Velocity Verlet" : "Euler";
    document.getElementById("hud").textContent =
        (running ? "" : "PAUSED · ") +
        "t = " + simTime.toFixed(1) +
        " · " + bodies.length + " bodies · " + integratorName +
        " · " + simulationSpeed.toFixed(1) + "x";
}

function updatePlayButton() {
    document.getElementById("playPauseBtn").textContent = running ? "Pause" : "Play";
}

function togglePlay() {
    running = !running;
    updatePlayButton();
}

function setBrush(type) {
    brush = type;
    document.querySelectorAll(".brush").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.type === type);
    });
}

function deleteSelected() {
    if (!selectedBody) return;
    bodies = bodies.filter(b => b !== selectedBody);
    selectedBody = null;
    markSystemChanged();
    refreshBodyList();
    updateProperties();
}

function bodyAtScreen(sx, sy) {
    for (let i = bodies.length - 1; i >= 0; i--) {
        const b = bodies[i];
        const p = worldToScreen(b.x, b.y);
        const hitRadius = Math.max(b.radius * camera.zoom, 7) + 3;
        if (Math.hypot(sx - p.x, sy - p.y) <= hitRadius) return b;
    }
    return null;
}

function eventPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function setCameraFollow(mode) {
    camera.follow = mode;
    document.getElementById("cameraSelect").value = mode;
}

// ---------- Mouse / touch on the canvas ----------

canvas.addEventListener("pointerdown", event => {
    const screen = eventPosition(event);
    const world = screenToWorld(screen.x, screen.y);

    if (event.button === 1 || event.button === 2) {
        pointer = { mode: "pan", lastScreen: screen };
        setCameraFollow("free");
    } else if (event.button === 0) {
        const hit = bodyAtScreen(screen.x, screen.y);
        if (hit) {
            selectBody(hit);
            return;
        }
        pointer = {
            mode: "place",
            start: world,
            current: world,
            startScreen: screen,
            currentScreen: screen
        };
    }

    canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", event => {
    if (!pointer) return;
    const screen = eventPosition(event);

    if (pointer.mode === "pan") {
        camera.x -= (screen.x - pointer.lastScreen.x) / camera.zoom;
        camera.y -= (screen.y - pointer.lastScreen.y) / camera.zoom;
        pointer.lastScreen = screen;
    } else if (pointer.mode === "place") {
        pointer.currentScreen = screen;
        pointer.current = screenToWorld(screen.x, screen.y);
    }
});

canvas.addEventListener("pointerup", () => {
    if (pointer && pointer.mode === "place") {
        const velocity = placementVelocity(pointer);
        const body = createBody({
            type: brush,
            x: pointer.start.x,
            y: pointer.start.y,
            vx: velocity.vx,
            vy: velocity.vy
        });
        bodies.push(body);
        markSystemChanged();
        selectBody(body);
    }
    pointer = null;
});

canvas.addEventListener("pointercancel", () => {
    pointer = null;
});

canvas.addEventListener("contextmenu", event => event.preventDefault());

// Scroll to zoom toward the mouse cursor
canvas.addEventListener("wheel", event => {
    event.preventDefault();
    const screen = eventPosition(event);
    const before = screenToWorld(screen.x, screen.y);

    camera.zoom = clamp(camera.zoom * Math.exp(-event.deltaY * 0.0015), 0.03, 8);

    const after = screenToWorld(screen.x, screen.y);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
}, { passive: false });

// ---------- Buttons and inputs ----------

document.getElementById("playPauseBtn").onclick = togglePlay;

document.getElementById("resetBtn").onclick = () => loadScenario(currentScenario);

document.getElementById("clearTrailsBtn").onclick = () => {
    for (const b of bodies) b.trail = [];
};

document.getElementById("centerViewBtn").onclick = () => fitView();

document.getElementById("scenarioSelect").onchange = event => {
    loadScenario(event.target.value);
    event.target.blur();
};

document.getElementById("speedSlider").oninput = event => {
    simulationSpeed = Number(event.target.value);
    document.getElementById("speedValue").textContent = simulationSpeed.toFixed(1) + "x";
};

document.getElementById("cameraSelect").onchange = event => {
    camera.follow = event.target.value;
};

document.getElementById("integratorSelect").onchange = event => {
    integrator = event.target.value;
    markSystemChanged();
};

const toggles = {
    trailToggle: "trails",
    vectorToggle: "vectors",
    fieldToggle: "field",
    mergeToggle: "merge",
    labelToggle: "labels"
};

for (const [id, key] of Object.entries(toggles)) {
    document.getElementById(id).onchange = event => {
        options[key] = event.target.checked;
        if (key === "vectors") {
            document.getElementById("vectorLegend").classList.toggle("hidden", !options.vectors);
        }
        event.target.blur();
    };
}

document.querySelectorAll(".brush").forEach(btn => {
    btn.onclick = () => setBrush(btn.dataset.type);
});

document.getElementById("massSlider").oninput = event => {
    if (!selectedBody) return;
    selectedBody.mass = massFromSlider(Number(event.target.value));
    document.getElementById("massValue").textContent = formatMass(selectedBody.mass);
    markSystemChanged();
    refreshBodyList();
};

document.getElementById("radiusSlider").oninput = event => {
    if (!selectedBody) return;
    selectedBody.radius = Number(event.target.value);
    document.getElementById("radiusValue").textContent = selectedBody.radius;
};

for (const axis of ["x", "y"]) {
    document.getElementById("v" + axis + "Input").onchange = event => {
        if (!selectedBody) return;
        const value = Number(event.target.value);
        if (!Number.isFinite(value)) return;
        selectedBody["v" + axis] = value;
        markSystemChanged();
    };
}

document.getElementById("orbitBtn").onclick = () => {
    if (!selectedBody) return;
    const attractor = dominantAttractor(selectedBody.x, selectedBody.y, selectedBody);
    if (!attractor) return;
    const v = circularVelocity(selectedBody.x, selectedBody.y, selectedBody.mass, attractor);
    selectedBody.vx = v.vx;
    selectedBody.vy = v.vy;
    markSystemChanged();
    refreshLiveReadouts(true);
};

document.getElementById("deleteBodyBtn").onclick = deleteSelected;

// Buttons lose focus after a click so the Space key always means play/pause
document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (button) button.blur();
});

// ---------- Keyboard shortcuts ----------

window.addEventListener("keydown", event => {
    const target = event.target;
    const typing = target.tagName === "SELECT" ||
        (target.tagName === "INPUT" && target.type === "number");
    if (typing) return;

    if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
    } else if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelected();
    } else if (event.key === "Escape") {
        pointer = null;
        selectBody(null);
    } else if (event.key === "r" || event.key === "R") {
        loadScenario(currentScenario);
    } else if (event.key === "f" || event.key === "F") {
        fitView();
    } else if (["1", "2", "3", "4"].includes(event.key)) {
        setBrush(["planet", "star", "moon", "blackhole"][Number(event.key) - 1]);
    }
});


/* ==========================================================================
   7. MAIN LOOP
   ========================================================================== */

let lastFrameTime = null;
let frameCount = 0;

function frame(now) {
    // Real elapsed time, so the simulation runs the same speed on 60 Hz and 120 Hz screens
    const elapsed = lastFrameTime === null ? 16.7 : Math.min(now - lastFrameTime, 50);
    lastFrameTime = now;

    if (running) {
        stepAccumulator += simulationSpeed * STEPS_PER_SECOND * elapsed / 1000;
        let steps = Math.floor(stepAccumulator);
        stepAccumulator -= steps;

        if (steps > MAX_STEPS_PER_FRAME) {
            steps = MAX_STEPS_PER_FRAME;
            stepAccumulator = 0;
        }

        for (let i = 0; i < steps; i++) physicsStep();

        if (steps > 0) {
            recordTrails();
            recordEnergy();
        }
    }

    updateCameraFollow();
    render();

    frameCount++;
    if (frameCount % 3 === 0) {
        drawEnergyChart();
        refreshLiveReadouts();
    }

    requestAnimationFrame(frame);
}

// ---------- Start ----------

resizeCanvas();
resizeEnergyChart();

const resizeWatcher = new ResizeObserver(() => {
    resizeCanvas();
    resizeEnergyChart();
});
resizeWatcher.observe(canvas);
resizeWatcher.observe(energyCanvas);

loadScenario("solar");
requestAnimationFrame(frame);
