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
const PHYSICS_BUDGET_MS = 11;   // max time per frame spent on physics, so drawing stays smooth

// Barnes-Hut settings
const AUTO_TREE_THRESHOLD = 200;  // "Auto" solver uses Barnes-Hut above this many bodies
const TREE_MAX_DEPTH = 32;        // stop splitting squares after this many levels
const PREDICT_DIRECT_LIMIT = 150; // above this, the launch preview uses a frozen tree
const FIELD_TREE_LIMIT = 80;      // above this, the gravity field view uses the tree

const TRAIL_LENGTH = 450;       // how many points each trail remembers
const LAUNCH_SCALE = 0.05;      // how much velocity one unit of mouse drag gives
const ENERGY_HISTORY = 360;     // how many samples the energy graph shows

// The kinds of body you can place.
const BODY_TYPES = {
    planet:    { label: "Planet",     mass: 10,    radius: 8,  color: null },
    star:      { label: "Star",       mass: 10000, radius: 22, color: "#fbbf24" },
    moon:      { label: "Moon",       mass: 1,     radius: 4,  color: "#cbd5e1" },
    blackhole: { label: "Black Hole", mass: 40000, radius: 10, color: "#111111" },
    rock:      { label: "Rock",       mass: 0.1,   radius: 1.2, color: "#a8a29e" }
};

// Small, numerous body types that get simplified drawing in big systems
const SMALL_TYPES = new Set(["moon", "rock"]);

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

let solverMode = "auto"; // "auto", "direct" or "bh" (Barnes-Hut)
let theta = 0.6;         // Barnes-Hut opening angle: smaller = more accurate, slower

// How the last gravity calculation went, for the stats readout
const solverStats = { method: "direct", n: 0, interactions: 0, groups: 0 };
let speedRatio = 1;      // how close to the requested speed the computer keeps up
let bodyListDirty = false;

const options = {
    autoPause: false,
    trails: true,
    vectors: false,
    field: false,
    tree: false,
    merge: true,
    labels: true
};

/*
 * Editing state, for "Auto-pause while editing".
 * `sources` holds whatever is being edited right now (a slider being dragged,
 * a number box with the cursor in it). The simulation pauses when the first
 * edit starts and resumes when the last one ends, but only if the auto-pause
 * is what paused it.
 */
const editState = {
    sources: new Set(),
    target: null,        // the body the edit started on
    pausedByEdit: false
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

let brush = null;       // null = Select / Pan tool; otherwise the body type being placed
let pointer = null;     // what the mouse is currently doing (placing or panning)
let effects = [];       // collision flashes
let starfieldPattern = null;

const fieldCanvas = document.createElement("canvas");
const fieldCtx = fieldCanvas.getContext("2d");
let fieldImage = null;
let fieldLevels = new Float32Array(0);


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
        ax: 0, ay: 0, phi: 0,
        dead: false,
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
 * GRAVITY
 *
 * Two ways to calculate it, picked by the "Gravity solver" setting:
 *
 * 1. Direct: Newton's law for every pair of bodies.
 *      a = G * M / r^2, pointing toward the other body
 *    We loop over each PAIR once and apply equal and opposite pulls to both
 *    bodies (Newton's third law). Exact, but the work grows with n^2:
 *    1,000 bodies = ~500,000 pairs every step.
 *
 * 2. Barnes-Hut: put the bodies in a "quadtree" (squares split into four
 *    smaller squares, again and again, until each square holds one body).
 *    A far-away square full of bodies pulls almost exactly like ONE body
 *    with their total mass sitting at their centre of mass. So for each
 *    body we walk the tree, and if a square is small compared to its
 *    distance (size / distance < theta), we use that single combined pull
 *    instead of visiting every body inside it. The work grows like
 *    n * log(n) instead of n^2.
 *
 * Both also compute each body's potential (phi), used for the energy graph.
 *
 * Softening: instead of r^2 we use r^2 + epsilon^2, so two bodies passing
 * extremely close don't get an infinite kick.
 */

function usesTree(n) {
    if (solverMode === "bh") return n > 1;
    if (solverMode === "direct") return false;
    return n > AUTO_TREE_THRESHOLD;
}

// `isMain` is true for the real simulation (not the launch preview),
// so only the real simulation updates the stats readout.
function computeForces(list, isMain = false) {
    if (usesTree(list.length)) {
        computeForcesTree(list, isMain);
    } else {
        computeForcesDirect(list, isMain);
    }
}

function computeForcesDirect(list, isMain) {
    for (const body of list) {
        body.ax = 0;
        body.ay = 0;
        body.phi = 0;
    }

    const eps2 = SOFTENING * SOFTENING;
    const n = list.length;

    for (let i = 0; i < n; i++) {
        const a = list[i];

        for (let j = i + 1; j < n; j++) {
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

            // Potential: -G * M / r
            const inverseDist = 1 / Math.sqrt(distSquared);
            a.phi -= G * b.mass * inverseDist;
            b.phi -= G * a.mass * inverseDist;
        }
    }

    if (isMain) {
        solverStats.method = "direct";
        solverStats.n = n;
        solverStats.interactions = n * (n - 1) / 2;
    }
}

/* ---------- The quadtree ----------
 *
 * Stored in flat typed arrays (one slot per square, or "node") because that
 * is much faster in JavaScript than thousands of small objects.
 * Each leaf holds up to LEAF_CAPACITY bodies before it splits into four.
 * Children are always created after their parent, so walking the node list
 * backwards visits children before parents.
 */
const LEAF_CAPACITY = 16;

const tree = {
    capacity: 0,
    count: 0,       // nodes in use
    list: null,     // the bodies the tree was built from
    cx: null,       // centre of the square
    cy: null,
    half: null,     // half the square's width
    mass: null,     // total mass inside
    comX: null,     // centre of mass of everything inside
    comY: null,
    child: null,    // 4 children per node, -1 = none
    leaf: null,     // 1 if the node has no children
    first: null,    // leaf: first body inside (-1 = empty)
    leafCount: null,// leaf: how many bodies inside
    // Per body: position and mass copied into fast arrays, and the next
    // body in the same leaf (a linked list)
    bx: new Float64Array(0),
    by: new Float64Array(0),
    bm: new Float64Array(0),
    next: new Int32Array(0)
};

const NODE_ARRAYS = ["cx", "cy", "half", "mass", "comX", "comY", "child", "leaf", "first", "leafCount"];

function allocateTree(capacity) {
    tree.capacity = capacity;
    tree.cx = new Float64Array(capacity);
    tree.cy = new Float64Array(capacity);
    tree.half = new Float64Array(capacity);
    tree.mass = new Float64Array(capacity);
    tree.comX = new Float64Array(capacity);
    tree.comY = new Float64Array(capacity);
    tree.child = new Int32Array(capacity * 4);
    tree.leaf = new Uint8Array(capacity);
    tree.first = new Int32Array(capacity);
    tree.leafCount = new Int32Array(capacity);
}

// Double the space if bodies are bunched up and need more nodes than expected
function growTree() {
    const old = {};
    for (const key of NODE_ARRAYS) old[key] = tree[key];
    allocateTree(tree.capacity * 2);
    for (const key of NODE_ARRAYS) tree[key].set(old[key]);
}

function newNode(cx, cy, half) {
    if (tree.count >= tree.capacity) growTree();
    const k = tree.count++;
    tree.cx[k] = cx;
    tree.cy[k] = cy;
    tree.half[k] = half;
    tree.mass[k] = 0;
    tree.child[4 * k] = -1;
    tree.child[4 * k + 1] = -1;
    tree.child[4 * k + 2] = -1;
    tree.child[4 * k + 3] = -1;
    tree.leaf[k] = 1;
    tree.first[k] = -1;
    tree.leafCount[k] = 0;
    return k;
}

// Which quarter of node k is the point in? 0 = top-left ... 3 = bottom-right
function quadrant(k, x, y) {
    return (x >= tree.cx[k] ? 1 : 0) + (y >= tree.cy[k] ? 2 : 0);
}

function childFor(k, q) {
    const existing = tree.child[4 * k + q];
    if (existing !== -1) return existing;

    const h = tree.half[k] / 2;
    const c = newNode(
        tree.cx[k] + (q & 1 ? h : -h),
        tree.cy[k] + (q & 2 ? h : -h),
        h
    );
    tree.child[4 * k + q] = c;
    return c;
}

function addToLeaf(k, i) {
    tree.next[i] = tree.first[k];
    tree.first[k] = i;
    tree.leafCount[k]++;
}

function insertBody(i) {
    const x = tree.bx[i];
    const y = tree.by[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    let k = 0;
    let depth = 0;

    for (;;) {
        if (tree.leaf[k]) {
            // Room in this leaf (or bodies piled on top of each other): add it
            if (tree.leafCount[k] < LEAF_CAPACITY || depth >= TREE_MAX_DEPTH) {
                addToLeaf(k, i);
                return;
            }

            // Full: split into four, moving the bodies down one level
            let j = tree.first[k];
            tree.leaf[k] = 0;
            tree.first[k] = -1;
            tree.leafCount[k] = 0;
            while (j !== -1) {
                const nextJ = tree.next[j];
                addToLeaf(childFor(k, quadrant(k, tree.bx[j], tree.by[j])), j);
                j = nextJ;
            }
        }

        // Go down into the right quarter
        k = childFor(k, quadrant(k, x, y));
        depth++;
    }
}

function buildTree(list) {
    const n = list.length;
    tree.list = list;
    tree.count = 0;

    if (tree.next.length < n) {
        const size = Math.max(n, tree.next.length * 2);
        tree.next = new Int32Array(size);
        tree.bx = new Float64Array(size);
        tree.by = new Float64Array(size);
        tree.bm = new Float64Array(size);
    }
    if (tree.capacity < n + 64) allocateTree(n + 64);
    if (n === 0) return;

    // Copy positions into fast arrays and find a root square that fits them all
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        const b = list[i];
        tree.bx[i] = b.x;
        tree.by[i] = b.y;
        tree.bm[i] = b.mass;
        if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
        if (b.x < minX) minX = b.x;
        if (b.x > maxX) maxX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.y > maxY) maxY = b.y;
    }
    if (minX === Infinity) return;

    const half = Math.max(maxX - minX, maxY - minY) / 2 + 1;
    newNode((minX + maxX) / 2, (minY + maxY) / 2, half);

    for (let i = 0; i < n; i++) insertBody(i);

    // Total mass and centre of mass, from the smallest squares up
    const { bx, by, bm, next } = tree;
    for (let k = tree.count - 1; k >= 0; k--) {
        let m = 0, mx = 0, my = 0;

        if (tree.leaf[k]) {
            for (let j = tree.first[k]; j !== -1; j = next[j]) {
                m += bm[j];
                mx += bm[j] * bx[j];
                my += bm[j] * by[j];
            }
        } else {
            for (let q = 0; q < 4; q++) {
                const c = tree.child[4 * k + q];
                if (c === -1) continue;
                const cm = tree.mass[c];
                m += cm;
                mx += cm * tree.comX[c];
                my += cm * tree.comY[c];
            }
        }

        tree.mass[k] = m;
        tree.comX[k] = m > 0 ? mx / m : tree.cx[k];
        tree.comY[k] = m > 0 ? my / m : tree.cy[k];
    }
}

/*
 * Walk the tree to find the pull at point (x, y).
 * `self` is the index of the body at that point (so it doesn't pull on
 * itself), or -1 for an empty point. Results go into the walk* variables.
 * If `record` is given, the squares used as single masses and the bodies
 * visited one by one are saved into it (for the tree visualisation).
 */
let walkAx = 0, walkAy = 0, walkPhi = 0, walkCount = 0, walkGroups = 0;
const walkStack = new Int32Array(1024);

function walkTree(x, y, self, theta2, eps2, record = null) {
    const { cx, cy, half, mass, comX, comY, child, leaf, first, next, bx, by, bm } = tree;

    let ax = 0, ay = 0, phi = 0, count = 0, groups = 0;
    let sp = 0;
    if (tree.count > 0) walkStack[sp++] = 0;

    while (sp > 0) {
        const k = walkStack[--sp];
        const m = mass[k];
        if (m === 0) continue;

        if (leaf[k]) {
            // A leaf: add each body inside exactly
            for (let j = first[k]; j !== -1; j = next[j]) {
                if (j === self) continue;
                const dx = bx[j] - x;
                const dy = by[j] - y;
                const d2 = dx * dx + dy * dy + eps2;
                const inv = 1 / Math.sqrt(d2);
                const gm = G * bm[j] * inv;
                ax += dx * gm * inv * inv;
                ay += dy * gm * inv * inv;
                phi -= gm;
                count++;
                if (record) record.singles.push(j);
            }
            continue;
        }

        const h = half[k];
        const dx = comX[k] - x;
        const dy = comY[k] - y;
        const dist2 = dx * dx + dy * dy;

        // Far enough away (square size / distance < theta), and the point
        // isn't inside this square: treat everything in it as ONE mass
        // sitting at its centre of mass
        const outside = x < cx[k] - h || x > cx[k] + h || y < cy[k] - h || y > cy[k] + h;

        if (outside && 4 * h * h < theta2 * dist2) {
            const d2 = dist2 + eps2;
            const inv = 1 / Math.sqrt(d2);
            const gm = G * m * inv;
            ax += dx * gm * inv * inv;
            ay += dy * gm * inv * inv;
            phi -= gm;
            count++;
            groups++;
            if (record) record.groups.push(k);
        } else {
            // Too close: open the square and look at its four children
            const base = 4 * k;
            for (let q = 0; q < 4; q++) {
                const c = child[base + q];
                if (c !== -1) walkStack[sp++] = c;
            }
        }
    }

    walkAx = ax;
    walkAy = ay;
    walkPhi = phi;
    walkCount = count;
    walkGroups = groups;
}

/*
 * The main Barnes-Hut force calculation.
 *
 * Bodies in the same leaf are close together, so they need almost the same
 * list of "far squares" and "nearby bodies". Instead of walking the tree for
 * every body, we walk it once per leaf (up to 16 bodies) and share the lists.
 * The test for "far enough" uses the leaf body CLOSEST to each square, so
 * it is at least as accurate as walking separately for each body.
 */
let groupNodes = new Int32Array(256);
let groupBodies = new Int32Array(256);
let groupNodeCount = 0;
let groupBodyCount = 0;

function pushGroupNode(k) {
    if (groupNodeCount >= groupNodes.length) {
        const bigger = new Int32Array(groupNodes.length * 2);
        bigger.set(groupNodes);
        groupNodes = bigger;
    }
    groupNodes[groupNodeCount++] = k;
}

function pushGroupBody(j) {
    if (groupBodyCount >= groupBodies.length) {
        const bigger = new Int32Array(groupBodies.length * 2);
        bigger.set(groupBodies);
        groupBodies = bigger;
    }
    groupBodies[groupBodyCount++] = j;
}

// Fill groupNodes (squares used as one mass) and groupBodies (bodies used
// one by one) for every body in leaf `L`
function gatherInteractions(L, theta2) {
    const { cx, cy, half, mass, comX, comY, child, leaf, first, next, bx, by } = tree;

    // The box around the bodies in this leaf
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let j = first[L]; j !== -1; j = next[j]) {
        if (bx[j] < minX) minX = bx[j];
        if (bx[j] > maxX) maxX = bx[j];
        if (by[j] < minY) minY = by[j];
        if (by[j] > maxY) maxY = by[j];
    }

    groupNodeCount = 0;
    groupBodyCount = 0;

    let sp = 0;
    walkStack[sp++] = 0;

    while (sp > 0) {
        const k = walkStack[--sp];
        if (mass[k] === 0) continue;

        if (leaf[k]) {
            for (let j = first[k]; j !== -1; j = next[j]) pushGroupBody(j);
            continue;
        }

        const h = half[k];

        // Squares that contain this leaf must always be opened
        const containsLeaf = Math.abs(cx[L] - cx[k]) < h && Math.abs(cy[L] - cy[k]) < h;

        // Distance from the square's centre of mass to the nearest point of the box
        const dx = Math.max(minX - comX[k], 0, comX[k] - maxX);
        const dy = Math.max(minY - comY[k], 0, comY[k] - maxY);
        const dist2 = dx * dx + dy * dy;

        if (!containsLeaf && 4 * h * h < theta2 * dist2) {
            pushGroupNode(k);
        } else {
            const base = 4 * k;
            for (let q = 0; q < 4; q++) {
                const c = child[base + q];
                if (c !== -1) walkStack[sp++] = c;
            }
        }
    }
}

function computeForcesTree(list, isMain) {
    buildTree(list);

    const theta2 = theta * theta;
    const eps2 = SOFTENING * SOFTENING;
    const { leaf, leafCount, first, next, mass, comX, comY, bx, by, bm } = tree;
    let total = 0;
    let groups = 0;

    for (let L = 0; L < tree.count; L++) {
        if (!leaf[L] || leafCount[L] === 0) continue;

        gatherInteractions(L, theta2);

        for (let i = first[L]; i !== -1; i = next[i]) {
            const x = bx[i];
            const y = by[i];
            let ax = 0, ay = 0, phi = 0;

            // Far squares, each as one mass at its centre of mass
            for (let n = 0; n < groupNodeCount; n++) {
                const k = groupNodes[n];
                const dx = comX[k] - x;
                const dy = comY[k] - y;
                const inv = 1 / Math.sqrt(dx * dx + dy * dy + eps2);
                const gm = G * mass[k] * inv;
                ax += dx * gm * inv * inv;
                ay += dy * gm * inv * inv;
                phi -= gm;
            }

            // Nearby bodies, one by one
            for (let n = 0; n < groupBodyCount; n++) {
                const j = groupBodies[n];
                if (j === i) continue;
                const dx = bx[j] - x;
                const dy = by[j] - y;
                const inv = 1 / Math.sqrt(dx * dx + dy * dy + eps2);
                const gm = G * bm[j] * inv;
                ax += dx * gm * inv * inv;
                ay += dy * gm * inv * inv;
                phi -= gm;
            }

            const b = list[i];
            b.ax = ax;
            b.ay = ay;
            b.phi = phi;
            total += groupNodeCount + groupBodyCount - 1;
            groups += groupNodeCount;
        }
    }

    if (isMain) {
        solverStats.method = "bh";
        solverStats.n = list.length;
        solverStats.interactions = total;
        solverStats.groups = groups;
    }
}

// The leaf that body i ended up in (used by the tree visualisation)
function leafOfBody(i) {
    for (let L = 0; L < tree.count; L++) {
        if (!tree.leaf[L]) continue;
        for (let j = tree.first[L]; j !== -1; j = tree.next[j]) {
            if (j === i) return L;
        }
    }
    return -1;
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
function stepVerlet(list, dt, isMain = false) {
    for (const b of list) {
        b.vx += b.ax * dt / 2;
        b.vy += b.ay * dt / 2;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
    }

    computeForces(list, isMain);

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
 * Needs accelerations to already be correct for the current positions.
 */
function stepEuler(list, dt) {
    for (const b of list) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.vx += b.ax * dt;
        b.vy += b.ay * dt;
    }
}

function physicsStep() {
    // Both methods start from gravity at the current positions. Verlet's last
    // half-kick already computed it, so usually it's reused for free.
    if (!accelerationsFresh) computeForces(bodies, true);

    if (integrator === "verlet") {
        stepVerlet(bodies, DT, true);
        accelerationsFresh = true;
    } else {
        stepEuler(bodies, DT);
        accelerationsFresh = false;
    }

    simTime += DT;

    if (options.merge) handleCollisions();
}

/*
 * COLLISIONS
 *
 * Perfectly inelastic: two touching bodies become one.
 * Mass and momentum are conserved exactly. Kinetic energy is not:
 * in reality it becomes heat.
 *
 * Checking every pair would be n^2 again. Instead we "sweep and prune":
 * sort the bodies left to right, then each body only checks the bodies to
 * its right that are close enough horizontally to possibly touch it.
 */
function canCollide(a, b) {
    return true;
}

let sweepOrder = new Int32Array(0);
let sweepLeft = new Float64Array(0);

function findTouchingPairs() {
    const n = bodies.length;
    if (sweepOrder.length < n) {
        sweepOrder = new Int32Array(n * 2);
        sweepLeft = new Float64Array(n * 2);
    }

    let maxRadius = 0;
    for (let i = 0; i < n; i++) {
        const b = bodies[i];
        sweepLeft[i] = b.x - b.radius;   // left edge of each body
        sweepOrder[i] = i;
        if (b.radius > maxRadius) maxRadius = b.radius;
    }

    const order = sweepOrder.subarray(0, n);
    order.sort((a, b) => sweepLeft[a] - sweepLeft[b]);

    const pairs = [];

    for (let s = 0; s < n; s++) {
        const a = bodies[order[s]];
        const right = a.x + a.radius; // right edge

        for (let t = s + 1; t < n; t++) {
            const j = order[t];
            if (sweepLeft[j] > right) break; // everything further right is too far
            const b = bodies[j];
            if (!canCollide(a, b)) continue;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const touch = a.radius + b.radius;
            if (dx * dx + dy * dy < touch * touch) pairs.push([a, b]);
        }
    }

    return pairs;
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

    small.dead = true;
    if (selectedBody === small) selectedBody = big;
    return small;
}

function handleCollisions() {
    let merged = false;

    // A merge can create a new overlap, so check again (a few rounds at most)
    for (let round = 0; round < 4; round++) {
        const pairs = findTouchingPairs();
        if (pairs.length === 0) break;

        for (const [a, b] of pairs) {
            if (a.dead || b.dead) continue;
            mergeBodies(a, b);
            merged = true;
        }

        bodies = bodies.filter(b => !b.dead);
    }

    if (merged) {
        markSystemChanged();
        bodyListDirty = true;
    }
}

/*
 * ENERGY
 *   Kinetic   = sum of (1/2) m v^2
 *   Potential = sum over pairs of  -G m1 m2 / r   (softened the same way as the force)
 * With no outside forces the total should stay constant.
 *
 * measureEnergy checks every pair (exact, but slow for big systems).
 * The live graph instead reuses the potential (phi) each body got during
 * the gravity calculation: potential energy = 1/2 * sum of m * phi
 * (the 1/2 is because each pair is counted from both ends).
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

function measureEnergyFast() {
    if (!accelerationsFresh) {
        computeForces(bodies, true);
        accelerationsFresh = true;
    }

    let kinetic = 0;
    let potential = 0;
    for (const b of bodies) {
        kinetic += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy);
        potential += 0.5 * b.mass * b.phi;
    }
    return { kinetic, potential, total: kinetic + potential };
}

function recordEnergy() {
    const e = measureEnergyFast();

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
    if (bodies.length > PREDICT_DIRECT_LIMIT) return predictPathFrozen(start, velocity);

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

    computeForces(sim);

    for (let s = 0; s < steps && !hit; s++) {
        if (integrator === "verlet") {
            stepVerlet(sim, DT);
        } else {
            stepEuler(sim, DT);
            computeForces(sim);
        }

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

/*
 * Preview for big systems: simulating thousands of bodies hundreds of steps
 * ahead every frame would freeze the page. Instead, freeze everything where
 * it is, build one Barnes-Hut tree, and fly only the new body through it.
 * Good for short previews; less accurate the further ahead it looks.
 */
function predictPathFrozen(start, velocity) {
    buildTree(bodies);

    const preset = BODY_TYPES[brush];
    const theta2 = 0.8 * 0.8;
    const eps2 = SOFTENING * SOFTENING;
    const obstacles = bodies.filter(b => b.radius >= 2);

    let x = start.x, y = start.y, vx = velocity.vx, vy = velocity.vy;
    walkTree(x, y, -1, theta2, eps2);
    let ax = walkAx, ay = walkAy;

    const points = [{ x, y }];
    let hit = null;

    for (let s = 0; s < 600 && !hit; s++) {
        vx += ax * DT / 2;
        vy += ay * DT / 2;
        x += vx * DT;
        y += vy * DT;
        walkTree(x, y, -1, theta2, eps2);
        ax = walkAx;
        ay = walkAy;
        vx += ax * DT / 2;
        vy += ay * DT / 2;

        if (s % 3 === 0) points.push({ x, y });

        if (options.merge) {
            for (const o of obstacles) {
                const dx = o.x - x;
                const dy = o.y - y;
                const touch = o.radius + preset.radius;
                if (dx * dx + dy * dy < touch * touch) {
                    hit = { x, y };
                    break;
                }
            }
        }
    }

    points.push({ x, y });
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

    planetFormation: {
        fit: 360,
        note: "1,500 rocks orbit a young star. Rocks that touch merge, slowly growing into planets, roughly how real planets formed. Far too many bodies to check every pair, so the Barnes-Hut solver takes over.",
        build() {
            const sun = addBody({ type: "star", name: "Young Sun", x: 0, y: 0, radius: 18 });
            const random = seededRandom(3);
            const rockColors = ["#a8a29e", "#d6d3d1", "#c2410c", "#a16207", "#78716c"];

            for (let i = 0; i < 1500; i++) {
                // More rocks further out, since there's more room there
                const distance = 70 + Math.sqrt(random()) * 260;
                const angle = random() * Math.PI * 2;
                const x = distance * Math.cos(angle);
                const y = distance * Math.sin(angle);

                // Nearly circular orbits, with a 3% random wobble so orbits cross
                const v = circularVelocity(x, y, 0.1, sun);
                const speed = Math.hypot(v.vx, v.vy);
                addBody({
                    type: "rock",
                    name: "Rock " + (i + 1),
                    x, y,
                    vx: v.vx + (random() - 0.5) * 0.06 * speed,
                    vy: v.vy + (random() - 0.5) * 0.06 * speed,
                    color: rockColors[i % rockColors.length]
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
    editState.sources.clear();
    editState.target = null;
    editState.pausedByEdit = false;
    speedRatio = 1;
    bodyListDirty = false;

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
        // Fit 97% of the bodies, so a few that escaped far away don't
        // force the view to zoom all the way out
        const distances = bodies
            .map(b => Math.hypot(b.x - center.x, b.y - center.y) + b.radius)
            .sort((a, b) => a - b);
        const index = Math.min(distances.length - 1, Math.floor(distances.length * 0.97));
        r = distances.length > 20 ? distances[index] : (distances[distances.length - 1] || 0);
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

function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

/*
 * Gravity field: for a grid of points, add up the gravitational potential
 * (G * M / r) from every body. Bright = deep gravity well.
 * The rings are equipotential lines (points with equal potential).
 *
 * Gravity has no edge: it reaches forever and just gets weaker. To keep it
 * fast we calculate one value per small square of pixels, then let the
 * browser blend the squares together smoothly.
 */
const RINGS_PER_LEVEL = 2;

function drawField() {
    const n = bodies.length;

    // Big systems use the Barnes-Hut tree here too (about 50 pulls per
    // square instead of n)
    const useTreeForField = n > FIELD_TREE_LIMIT;
    if (useTreeForField) buildTree(bodies);

    // Square size is chosen so the total work (squares x bodies) stays about
    // the same: small squares with few bodies, bigger ones with many.
    const work = useTreeForField ? 50 : n;
    const cell = clamp(Math.ceil(Math.sqrt(viewWidth * viewHeight * work / 300000)), 3, 8);
    const cols = Math.ceil(viewWidth / cell);
    const rows = Math.ceil(viewHeight / cell);

    if (fieldCanvas.width !== cols || fieldCanvas.height !== rows) {
        fieldCanvas.width = cols;
        fieldCanvas.height = rows;
        fieldImage = fieldCtx.createImageData(cols, rows);
    }
    if (fieldLevels.length !== cols * rows) fieldLevels = new Float32Array(cols * rows);

    const eps2 = 15 * 15;

    // Pass 1: how deep is the gravity well at each square?
    // Logarithmic scale: each level up is a doubling of well depth.
    for (let row = 0; row < rows; row++) {
        const wy = ((row + 0.5) * cell - viewHeight / 2) / camera.zoom + camera.y;

        for (let col = 0; col < cols; col++) {
            const wx = ((col + 0.5) * cell - viewWidth / 2) / camera.zoom + camera.x;

            let potential = 0;
            if (useTreeForField) {
                walkTree(wx, wy, -1, 1.0, eps2);
                potential = -walkPhi / G;
            } else {
                for (let k = 0; k < n; k++) {
                    const b = bodies[k];
                    const dx = wx - b.x;
                    const dy = wy - b.y;
                    potential += b.mass / Math.sqrt(dx * dx + dy * dy + eps2);
                }
            }

            fieldLevels[row * cols + col] = Math.log2(1 + G * potential);
        }
    }

    // Pass 2: colour, plus smooth (anti-aliased) equipotential rings
    const data = fieldImage.data;

    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const k = row * cols + col;
            const level = fieldLevels[k];

            // How fast the level changes from one square to the next
            const left = fieldLevels[col > 0 ? k - 1 : k];
            const right = fieldLevels[col < cols - 1 ? k + 1 : k];
            const up = fieldLevels[row > 0 ? k - cols : k];
            const down = fieldLevels[row < rows - 1 ? k + cols : k];
            const ringsPerSquare = Math.hypot(right - left, down - up) / 2 * RINGS_PER_LEVEL + 1e-6;

            // Distance to the nearest ring, measured in squares, so every
            // ring is drawn with the same soft width wherever it is
            const ringPosition = level * RINGS_PER_LEVEL;
            const fraction = ringPosition - Math.floor(ringPosition);
            const distance = Math.min(fraction, 1 - fraction) / ringsPerSquare;

            let line = clamp(1 - distance / 0.8, 0, 1);
            // Fade out rings that would be packed too tightly to see (e.g. zoomed out near a star)
            line *= smoothstep(2.5, 6, 1 / ringsPerSquare);
            // Fade out the faint outermost rings
            line *= smoothstep(3.2, 4, level) * 0.75;

            const t = clamp((level - 3) / 8, 0, 1);

            const i = k * 4;
            data[i] = 40 + 160 * t * t + line * 90;
            data[i + 1] = 25 + 70 * t * t * t + line * 90;
            data[i + 2] = 90 + 160 * t + line * 70;
            data[i + 3] = Math.min(255, 200 * t + line * 110);
        }
    }

    fieldCtx.putImageData(fieldImage, 0, 0);
    useScreenTransform();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(fieldCanvas, 0, 0, cols * cell, rows * cell);
}

// ---------- Trails ----------

// Big systems get short trails: thousands of long trails would be slow
// to draw and would cover the screen
function trailLimit() {
    return bodies.length > 300 ? 30 : TRAIL_LENGTH;
}

function recordTrails() {
    const limit = trailLimit();
    for (const b of bodies) {
        b.trail.push({ x: b.x, y: b.y });
        while (b.trail.length > limit) b.trail.shift();
    }
}

function drawTrails() {
    useWorldTransform();
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.lineJoin = "round";

    const chunks = bodies.length > 300 ? 2 : 6;

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

// Direction toward the brightest nearby star, so planets are lit on that side.
// `lightSources` is the list of stars, collected once per frame in render().
let lightSources = [];

function lightDirection(body) {
    let best = null;
    let bestValue = 0;

    for (const b of lightSources) {
        if (b === body) continue;
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

    // Tiny rocks and moons: a plain dot is much faster than a shaded sphere,
    // and looks the same at a few pixels wide
    if (SMALL_TYPES.has(b.type) && r * camera.zoom < 3) {
        const size = Math.max(r, 0.9 / camera.zoom);
        ctx.fillStyle = b.color;
        ctx.fillRect(x - size, y - size, size * 2, size * 2);
        if (b === selectedBody) drawSelectionRing(b);
        return;
    }

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

    if (b === selectedBody) drawSelectionRing(b);
}

function drawSelectionRing(b) {
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([4 / camera.zoom, 4 / camera.zoom]);
    ctx.lineDashOffset = -performance.now() / 60 / camera.zoom;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius + 6 / camera.zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
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
    if (!accelerationsFresh) {
        computeForces(bodies, true);
        accelerationsFresh = true;
    }

    // In big systems, only the selected body and big bodies get arrows
    const crowded = bodies.length > 200;

    for (const b of bodies) {
        if (crowded && b !== selectedBody && SMALL_TYPES.has(b.type)) continue;
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
    const veryCrowded = bodies.length > 60;

    for (const b of bodies) {
        if (b !== selectedBody) {
            if (crowded && SMALL_TYPES.has(b.type)) continue;
            if (veryCrowded && b.type === "planet") continue;
        }
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

// ---------- Barnes-Hut tree view ----------

// What the selected body's group used last time the tree was drawn
let treeView = null;

function drawTreeOverlay() {
    treeView = null;
    if (bodies.length === 0) return;

    buildTree(bodies);
    useWorldTransform();

    // Every square in the tree
    ctx.lineWidth = 1 / camera.zoom;
    ctx.strokeStyle = "rgba(148,163,184,0.22)";
    ctx.beginPath();
    for (let k = 0; k < tree.count; k++) {
        const h = tree.half[k];
        ctx.rect(tree.cx[k] - h, tree.cy[k] - h, 2 * h, 2 * h);
    }
    ctx.stroke();

    // What the selected body's group uses
    if (!selectedBody) return;
    const i = bodies.indexOf(selectedBody);
    const L = i >= 0 ? leafOfBody(i) : -1;
    if (L < 0) return;

    gatherInteractions(L, theta * theta);
    const sx = selectedBody.x;
    const sy = selectedBody.y;

    // Far squares: shaded, with a line to the dot where their mass is counted
    ctx.fillStyle = "rgba(251,146,60,0.10)";
    ctx.strokeStyle = "rgba(251,146,60,0.75)";
    ctx.lineWidth = 1.2 / camera.zoom;
    for (let n = 0; n < groupNodeCount; n++) {
        const k = groupNodes[n];
        const h = tree.half[k];
        ctx.fillRect(tree.cx[k] - h, tree.cy[k] - h, 2 * h, 2 * h);
        ctx.strokeRect(tree.cx[k] - h, tree.cy[k] - h, 2 * h, 2 * h);
    }

    ctx.strokeStyle = "rgba(251,146,60,0.35)";
    ctx.beginPath();
    for (let n = 0; n < groupNodeCount; n++) {
        const k = groupNodes[n];
        ctx.moveTo(sx, sy);
        ctx.lineTo(tree.comX[k], tree.comY[k]);
    }
    ctx.stroke();

    ctx.fillStyle = "#fb923c";
    for (let n = 0; n < groupNodeCount; n++) {
        const k = groupNodes[n];
        ctx.beginPath();
        ctx.arc(tree.comX[k], tree.comY[k], 3 / camera.zoom, 0, Math.PI * 2);
        ctx.fill();
    }

    // Nearby bodies: lines to each one
    ctx.strokeStyle = "rgba(34,211,238,0.45)";
    ctx.beginPath();
    for (let n = 0; n < groupBodyCount; n++) {
        const b = bodies[groupBodies[n]];
        if (b === selectedBody) continue;
        ctx.moveTo(sx, sy);
        ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    // The selected body's own square
    const h = tree.half[L];
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 2 / camera.zoom;
    ctx.strokeRect(tree.cx[L] - h, tree.cy[L] - h, 2 * h, 2 * h);

    treeView = { groups: groupNodeCount, singles: groupBodyCount - 1, n: bodies.length };
}

function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#02040b";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawStarfield();

    if (options.field && bodies.length > 0) drawField();

    if (options.trails) drawTrails();

    if (options.tree) drawTreeOverlay();

    lightSources = bodies.filter(b => b.type === "star");
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

const massSlider = document.getElementById("massSlider");
const massInput = document.getElementById("massInput");
const radiusSlider = document.getElementById("radiusSlider");
const radiusInput = document.getElementById("radiusInput");
const vxInput = document.getElementById("vxInput");
const vyInput = document.getElementById("vyInput");

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

// Show at most this many rows: thousands of rows would slow the page down
const BODY_LIST_LIMIT = 60;

function refreshBodyList() {
    bodyListDirty = false;
    const list = document.getElementById("bodyList");
    list.innerHTML = "";

    // Big systems: list the heaviest bodies (plus the selected one)
    let shown = bodies;
    if (bodies.length > BODY_LIST_LIMIT) {
        shown = [...bodies].sort((a, b) => b.mass - a.mass).slice(0, BODY_LIST_LIMIT);
        if (selectedBody && !shown.includes(selectedBody)) shown.push(selectedBody);
    }

    for (const body of shown) {
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

    if (shown.length < bodies.length) {
        const more = document.createElement("div");
        more.className = "body-item more";
        more.textContent = "+ " + (bodies.length - shown.length).toLocaleString() +
            " smaller bodies (click them on the canvas)";
        list.appendChild(more);
    }

    document.getElementById("bodyCount").textContent = "(" + bodies.length.toLocaleString() + ")";
}

// 1234 -> "1,234", 45678 -> "46k", 1234567 -> "1.2M"
function formatCount(value) {
    if (value >= 1e6) return (value / 1e6).toFixed(1) + "M";
    if (value >= 1e4) return Math.round(value / 1e3) + "k";
    return Math.round(value).toLocaleString();
}

let lastStatsHtml = "";

function refreshSolverStats() {
    const n = solverStats.n;
    const pairs = n * (n - 1) / 2;
    let html;

    if (n < 2) {
        html = "Add some bodies to see the gravity calculation.";
    } else if (solverStats.method === "direct") {
        html = "<b>Direct</b>: every pair is checked, <b>" + formatCount(pairs) +
            "</b> pair calculations per step.";
    } else {
        const ratio = pairs / Math.max(1, solverStats.interactions);
        html = "<b>Barnes-Hut</b>: <b>" + formatCount(solverStats.interactions) +
            "</b> calculations per step (about " + formatCount(solverStats.interactions / n) +
            " per body). Direct would need <b>" + formatCount(pairs) + "</b> pairs";
        html += ratio >= 1.05
            ? ", <span class=\"speedup\">" + ratio.toFixed(1) + "&times; more work</span>."
            : ". With this few bodies the tree doesn't save work yet.";
    }

    if (options.tree && treeView) {
        html += "<br>Selected body's group: <b>" + treeView.groups + "</b> far squares + <b>" +
            treeView.singles + "</b> nearby bodies, instead of " +
            formatCount(treeView.n - 1) + " separate bodies.";
    }

    if (html !== lastStatsHtml) {
        document.getElementById("solverStats").innerHTML = html;
        lastStatsHtml = html;
    }
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

    // Don't overwrite a box the user is typing in
    const focused = document.activeElement;
    massSlider.value = sliderFromMass(selectedBody.mass);
    radiusSlider.value = selectedBody.radius;
    if (focused !== massInput) massInput.value = formatNumber(selectedBody.mass);
    if (focused !== radiusInput) radiusInput.value = formatNumber(selectedBody.radius);

    refreshLiveReadouts(true);
}

// Short readable number for the input boxes, e.g. 10000, 3.5, 0.25
function formatNumber(value) {
    return String(Number(value.toPrecision(4)));
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
    const solverName = solverStats.method === "bh" ? "Barnes-Hut" : "Direct";
    const pauseText = running ? "" : editState.pausedByEdit ? "PAUSED while editing · " : "PAUSED · ";
    const slowText = running && speedRatio < 0.85
        ? " (computer keeping up at " + (simulationSpeed * speedRatio).toFixed(1) + "x)"
        : "";
    document.getElementById("hud").textContent =
        pauseText +
        "t = " + simTime.toFixed(1) +
        " · " + bodies.length.toLocaleString() + " bodies · " + integratorName +
        " · " + solverName +
        " · " + simulationSpeed.toFixed(1) + "x" + slowText;

    refreshSolverStats();
}

function updatePlayButton() {
    document.getElementById("playPauseBtn").textContent = running ? "Pause" : "Play";
}

function togglePlay() {
    running = !running;
    // The user took control, so an edit ending shouldn't resume on its own
    editState.pausedByEdit = false;
    updatePlayButton();
}

// ---------- Auto-pause while editing ----------

function beginEdit(source) {
    if (editState.sources.size === 0) {
        editState.target = selectedBody;
        if (options.autoPause && running) {
            running = false;
            editState.pausedByEdit = true;
            updatePlayButton();
        }
    }
    editState.sources.add(source);
}

function endEdit(source) {
    if (!editState.sources.delete(source)) return;
    if (editState.sources.size > 0) return;

    editState.target = null;
    if (editState.pausedByEdit && !running) {
        running = true;
        updatePlayButton();
    }
    editState.pausedByEdit = false;
}

/*
 * The body that edits should apply to. If the body you started editing
 * merged into another one mid-edit, edits are ignored, so you can never
 * accidentally change a different body (e.g. the star it crashed into).
 */
function editableBody() {
    if (!selectedBody || !bodies.includes(selectedBody)) return null;
    if (editState.sources.size > 0 && editState.target !== selectedBody) return null;
    return selectedBody;
}

// ---------- Tools (Select / Pan, or placing a body type) ----------

// Picking the active tool again, or "select", goes back to Select / Pan
function setBrush(type) {
    brush = type === "select" || type === brush ? null : type;

    document.querySelectorAll(".brush").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.type === (brush ?? "select"));
    });

    if (pointer && pointer.mode === "place") pointer = null;
    updateCursor();
    updateHint();
}

function updateHint() {
    const hint = document.getElementById("canvasHint");
    if (brush) {
        hint.innerHTML =
            "<b>Drag</b> to throw a " + BODY_TYPES[brush].label.toLowerCase() + " &middot; " +
            "<b>Click</b> for an automatic orbit &middot; " +
            "<b>Right-drag</b> to pan &middot; " +
            "<b>Esc</b> to stop placing";
    } else {
        hint.innerHTML =
            "<b>Drag</b> to pan &middot; " +
            "<b>Click</b> a body to inspect it &middot; " +
            "<b>Scroll</b> to zoom &middot; " +
            "Pick a body type below to start placing";
    }
}

function updateCursor(hovering = false) {
    if (pointer && pointer.mode === "pan" && pointer.moved) {
        canvas.style.cursor = "grabbing";
    } else if (hovering) {
        canvas.style.cursor = "pointer";
    } else {
        canvas.style.cursor = brush ? "crosshair" : "grab";
    }
}

function deleteSelected() {
    if (!selectedBody) return;
    bodies = bodies.filter(b => b !== selectedBody);
    selectedBody = null;
    markSystemChanged();
    refreshBodyList();
    updateProperties();
}

// The body under the mouse. If several are close, pick the one whose edge
// is nearest, so clicking on a big star picks the star, not a rock near it.
function bodyAtScreen(sx, sy) {
    let best = null;
    let bestScore = Infinity;

    for (let i = bodies.length - 1; i >= 0; i--) {
        const b = bodies[i];
        const p = worldToScreen(b.x, b.y);
        const radius = b.radius * camera.zoom;
        const distance = Math.hypot(sx - p.x, sy - p.y);
        if (distance > Math.max(radius, 7) + 3) continue;

        const score = distance - radius;
        if (score < bestScore) {
            bestScore = score;
            best = b;
        }
    }
    return best;
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

/*
 * Left button:
 *   - on a body: select it
 *   - Select / Pan tool: drag to pan, click empty space to deselect
 *   - a body type chosen: drag to throw, click for an automatic orbit
 * Right or middle button: always pans
 */
function startPan(screen, clickDeselects) {
    pointer = { mode: "pan", startScreen: screen, lastScreen: screen, moved: false, clickDeselects };
}

canvas.addEventListener("pointerdown", event => {
    const screen = eventPosition(event);

    if (event.button === 1 || event.button === 2) {
        startPan(screen, false);
    } else if (event.button === 0) {
        const hit = bodyAtScreen(screen.x, screen.y);
        if (hit) {
            selectBody(hit);
            return;
        }

        if (brush) {
            const world = screenToWorld(screen.x, screen.y);
            pointer = {
                mode: "place",
                start: world,
                current: world,
                startScreen: screen,
                currentScreen: screen
            };
        } else {
            startPan(screen, true);
        }
    } else {
        return;
    }

    canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", event => {
    const screen = eventPosition(event);

    if (!pointer) {
        updateCursor(bodyAtScreen(screen.x, screen.y) !== null);
        return;
    }

    if (pointer.mode === "pan") {
        // Only count it as a pan once the mouse has moved a few pixels,
        // so a plain click doesn't count as a pan
        if (!pointer.moved) {
            const distance = Math.hypot(screen.x - pointer.startScreen.x, screen.y - pointer.startScreen.y);
            if (distance < 4) return;
            pointer.moved = true;
            setCameraFollow("free");
            updateCursor();
        }
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
    } else if (pointer && pointer.mode === "pan" && pointer.clickDeselects && !pointer.moved) {
        selectBody(null);
    }
    pointer = null;
    updateCursor();
});

canvas.addEventListener("pointercancel", () => {
    pointer = null;
    updateCursor();
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

document.getElementById("solverSelect").onchange = event => {
    solverMode = event.target.value;
    markSystemChanged();
    event.target.blur();
};

document.getElementById("thetaSlider").oninput = event => {
    theta = Number(event.target.value);
    document.getElementById("thetaValue").textContent = theta.toFixed(2);
    markSystemChanged();
};

const toggles = {
    treeToggle: "tree",
    autoPauseToggle: "autoPause",
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
        if (key === "tree") {
            document.getElementById("treeLegend").classList.toggle("hidden", !options.tree);
        }
        event.target.blur();
    };
}

document.querySelectorAll(".brush").forEach(btn => {
    btn.onclick = () => setBrush(btn.dataset.type);
});

// ---------- Mass, radius and velocity editing ----------

const MIN_MASS = 0.01;
const MAX_MASS = 1000000;
const MIN_RADIUS = 1;
const MAX_RADIUS = 60;

function setMass(body, mass, from) {
    body.mass = clamp(mass, MIN_MASS, MAX_MASS);
    if (from !== "slider") massSlider.value = sliderFromMass(body.mass);
    if (from !== "box") massInput.value = formatNumber(body.mass);
    markSystemChanged();
    refreshBodyList();
}

function setRadius(body, radius, from) {
    body.radius = clamp(radius, MIN_RADIUS, MAX_RADIUS);
    if (from !== "slider") radiusSlider.value = body.radius;
    if (from !== "box") radiusInput.value = formatNumber(body.radius);
}

massSlider.addEventListener("input", () => {
    const body = editableBody();
    if (body) setMass(body, massFromSlider(Number(massSlider.value)), "slider");
});

radiusSlider.addEventListener("input", () => {
    const body = editableBody();
    if (body) setRadius(body, Number(radiusSlider.value), "slider");
});

// Typing in a box applies the value live, as long as it's a valid number
massInput.addEventListener("input", () => {
    const body = editableBody();
    const value = Number(massInput.value);
    if (body && massInput.value !== "" && Number.isFinite(value) && value > 0) {
        setMass(body, value, "box");
    }
});

radiusInput.addEventListener("input", () => {
    const body = editableBody();
    const value = Number(radiusInput.value);
    if (body && radiusInput.value !== "" && Number.isFinite(value) && value > 0) {
        setRadius(body, value, "box");
    }
});

// When you leave a box, tidy it up to show the value actually used
massInput.addEventListener("change", () => {
    if (selectedBody) massInput.value = formatNumber(selectedBody.mass);
});

radiusInput.addEventListener("change", () => {
    if (selectedBody) radiusInput.value = formatNumber(selectedBody.radius);
});

for (const axis of ["x", "y"]) {
    document.getElementById("v" + axis + "Input").addEventListener("change", event => {
        const body = editableBody();
        const value = Number(event.target.value);
        if (!body || event.target.value === "" || !Number.isFinite(value)) return;
        body["v" + axis] = value;
        markSystemChanged();
    });
}

// Sliders: editing lasts from pressing the mouse until releasing it anywhere
let draggingSlider = false;

for (const slider of [massSlider, radiusSlider]) {
    slider.addEventListener("pointerdown", () => {
        draggingSlider = true;
        beginEdit("slider");
    });

    // Arrow keys also adjust a focused slider
    slider.addEventListener("keydown", event => {
        if (event.key.startsWith("Arrow") || ["PageUp", "PageDown", "Home", "End"].includes(event.key)) {
            beginEdit("slider-keys");
        }
    });
    slider.addEventListener("keyup", () => endEdit("slider-keys"));
    slider.addEventListener("blur", () => endEdit("slider-keys"));
}

function stopSliderDrag() {
    if (!draggingSlider) return;
    draggingSlider = false;
    endEdit("slider");
}

window.addEventListener("pointerup", stopSliderDrag);
window.addEventListener("pointercancel", stopSliderDrag);

// Number boxes: editing lasts while the cursor is in the box. Enter finishes.
for (const input of [massInput, radiusInput, vxInput, vyInput]) {
    input.addEventListener("focus", () => beginEdit(input.id));
    input.addEventListener("blur", () => endEdit(input.id));
    input.addEventListener("keydown", event => {
        if (event.key === "Enter") input.blur();
    });
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
        setBrush("select");
        selectBody(null);
    } else if (event.key === "r" || event.key === "R") {
        loadScenario(currentScenario);
    } else if (event.key === "f" || event.key === "F") {
        fitView();
    } else if (["1", "2", "3", "4"].includes(event.key)) {
        // Pressing the key of the active tool again goes back to Select / Pan
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

        // Run the steps, but stop if physics has used up this frame's time
        // budget, so the page stays smooth with thousands of bodies.
        // Then the simulation just runs slower than asked.
        const wanted = steps;
        const physicsStart = performance.now();
        let done = 0;
        while (done < steps) {
            physicsStep();
            done++;
            if (performance.now() - physicsStart > PHYSICS_BUDGET_MS) break;
        }
        if (done < wanted) stepAccumulator = 0;

        // Smoothed "how much of the requested speed are we managing?"
        const expected = simulationSpeed * STEPS_PER_SECOND * elapsed / 1000;
        if (expected > 0) speedRatio = speedRatio * 0.95 + Math.min(1, done / expected) * 0.05;

        if (done > 0) {
            recordTrails();
            recordEnergy();
        }
    }

    updateCameraFollow();
    render();

    frameCount++;
    if (frameCount % 3 === 0) {
        if (bodyListDirty) {
            refreshBodyList();
            updateProperties();
        }
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
updateHint();
updateCursor();
requestAnimationFrame(frame);
