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
const DEFAULT_TIME_STEP = 0.1;  // length of one time step (dt)
const DEFAULT_SOFTENING = 5;    // epsilon: stops gravity going to infinity at r = 0
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
    asteroid:  { label: "Asteroid",   mass: 0.3,   radius: 3,  color: "#9ca3af" },
    comet:     { label: "Comet",      mass: 0.2,   radius: 3,  color: "#bae6fd" },
    // The collapsed core of a giant star: a star's mass in a tiny ball
    neutronstar: { label: "Neutron Star", mass: 20000, radius: 5, color: "#c4b5fd" },
    rock:      { label: "Rock",       mass: 0.1,   radius: 1.2, color: "#a8a29e" },
    // Stars inside a galaxy. Each one stands for a whole crowd of real stars.
    // Real stars are so far apart that they practically never hit anything,
    // so galaxy stars pass through everything ("collisionless").
    galaxyStar: { label: "Galaxy star", mass: 2, radius: 1.2, color: "#e0f2fe", collisionless: true }
};

// Small, numerous body types that get simplified drawing in big systems
const SMALL_TYPES = new Set(["moon", "rock", "asteroid", "galaxyStar"]);

// Body types you can place, in the order of their number keys (1 to 7)
const BRUSH_KEYS = ["planet", "star", "moon", "blackhole", "asteroid", "comet", "neutronstar"];

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

let timeStep = DEFAULT_TIME_STEP; // scenarios with slow motion (galaxies) use bigger steps
let softening = DEFAULT_SOFTENING; // galaxies use more, see the galaxy scenario
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
    orbit: true,
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

// The body the selected body is compared with: what it orbits in the
// Equations tab, the predicted ellipse and "Make it orbit".
// null = automatic (whichever body pulls on it hardest).
let referenceId = null;

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

// follow: "free", "com" (centre of mass), "selected", or "body" (follow `target`)
const camera = { x: 0, y: 0, zoom: 1, follow: "free", target: null };

let brush = null;       // null = Select / Pan tool; otherwise the body type being placed
let pointer = null;     // what the mouse is currently doing (placing or panning)
let effects = [];       // collision flashes
let starfieldPattern = null;

const fieldCanvas = document.createElement("canvas");
const fieldCtx = fieldCanvas.getContext("2d");
let fieldImage = null;
let fieldLevels = new Float32Array(0);
let lastFieldCell = 4;


/* ==========================================================================
   2. PHYSICS
   ========================================================================== */

function createBody({ type, name, x, y, vx = 0, vy = 0, mass, radius, color, collisionless }) {
    const preset = BODY_TYPES[type];
    typeCounters[type] = (typeCounters[type] || 0) + 1;

    return {
        id: nextId++,
        type,
        name: name ?? preset.label + " " + typeCounters[type],
        x, y, vx, vy,
        ax: 0, ay: 0, phi: 0,
        dead: false,
        // Passes through everything (galaxy stars, and the asteroid belt's asteroids)
        collisionless: collisionless ?? preset.collisionless ?? false,
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

    const eps2 = softening * softening;
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
const LEAF_CAPACITY = 8;

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
 * every body, we walk it once per leaf (up to 8 bodies) and share the lists.
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
    const eps2 = softening * softening;
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
        stepVerlet(bodies, timeStep, true);
        accelerationsFresh = true;
    } else {
        stepEuler(bodies, timeStep);
        accelerationsFresh = false;
    }

    simTime += timeStep;

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
// Collisionless bodies (galaxy stars, belt asteroids) never collide with anything
function canCollide(a, b) {
    return !a.collisionless && !b.collisionless;
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

/*
 * How much the system's energy changes when a and b merge:
 *  - kinetic energy lost to heat: 1/2 * mu * (relative speed)^2,
 *    where mu = ma * mb / (ma + mb)
 *  - their potential energy with each other disappears: + G ma mb / r
 */
function mergeEnergyChange(a, b) {
    const mu = a.mass * b.mass / (a.mass + b.mass);
    const dvx = a.vx - b.vx;
    const dvy = a.vy - b.vy;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const r = Math.sqrt(dx * dx + dy * dy + softening * softening);
    return -0.5 * mu * (dvx * dvx + dvy * dvy) + G * a.mass * b.mass / r;
}

function mergeBodies(a, b) {
    const big = a.mass >= b.mass ? a : b;
    const small = big === a ? b : a;
    const totalMass = a.mass + b.mass;
    const energyChange = mergeEnergyChange(a, b);

    // Centre of mass position and momentum-conserving velocity
    big.x = (a.x * a.mass + b.x * b.mass) / totalMass;
    big.y = (a.y * a.mass + b.y * b.mass) / totalMass;
    big.vx = (a.vx * a.mass + b.vx * b.mass) / totalMass;
    big.vy = (a.vy * a.mass + b.vy * b.mass) / totalMass;
    big.mass = totalMass;

    // Volumes add, so the new radius is the cube root of the summed cubes
    big.radius = Math.min(60, Math.cbrt(a.radius ** 3 + b.radius ** 3));

    // Big systems: no flash for tiny bodies merging (there are hundreds)
    const notable = bodies.length <= 300 || !SMALL_TYPES.has(small.type);
    if (notable) effects.push({ x: big.x, y: big.y, radius: big.radius, age: 0, color: small.color });

    small.dead = true;
    if (selectedBody === small) selectedBody = big;
    if (camera.target === small) camera.target = big;
    if (referenceId === small.id) referenceId = big.id;
    return { energyChange, notable };
}

function handleCollisions() {
    const selectedBefore = selectedBody;
    let merged = false;
    let notable = false;
    let energyChange = 0;

    // A merge can create a new overlap, so check again (a few rounds at most)
    for (let round = 0; round < 4; round++) {
        const pairs = findTouchingPairs();
        if (pairs.length === 0) break;

        for (const [a, b] of pairs) {
            if (a.dead || b.dead) continue;
            const result = mergeBodies(a, b);
            energyChange += result.energyChange;
            notable = notable || result.notable;
            merged = true;
        }

        bodies = bodies.filter(b => !b.dead);
    }

    if (merged) {
        // The energy really changes in a merge (heat), so the drift readout
        // allows for exactly that change instead of counting it as an error
        if (energyBaseline) energyBaseline.total += energyChange;
        accelerationsFresh = false;
        if (notable) pendingEnergyEvent = true;
        bodyListDirty = true;

        // If the selected body was swallowed, show the body it merged into
        // straight away, so the panel never shows the wrong body
        if (selectedBody !== selectedBefore) {
            refreshBodyList();
            updateProperties();
        }
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
    const eps2 = softening * softening;

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
    const eps2 = softening * softening;

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
 * The direction is perpendicular to the line joining the two bodies:
 * direction = 1 goes anticlockwise on screen, -1 clockwise.
 */
function circularVelocity(x, y, mass, attractor, direction = 1) {
    const dx = x - attractor.x;
    const dy = y - attractor.y;
    const r = Math.hypot(dx, dy);

    if (r < 1e-6) return { vx: attractor.vx, vy: attractor.vy };

    const totalMass = attractor.mass + mass;
    const speed = Math.sqrt(
        G * totalMass * r * r / Math.pow(r * r + softening * softening, 1.5)
    );

    return {
        vx: attractor.vx + direction * speed * dy / r,
        vy: attractor.vy - direction * speed * dx / r
    };
}

// The body `body` is compared with: the one picked in the menu, or else
// whichever pulls on it hardest
function referenceBody(body) {
    if (referenceId !== null && referenceId !== body.id) {
        const chosen = bodies.find(b => b.id === referenceId);
        if (chosen) return chosen;
    }
    return dominantAttractor(body.x, body.y, body);
}

/*
 * KEPLER ORBIT
 *
 * Pretend `body` and `other` are alone in the universe (the "two-body
 * problem"). Then there's an exact answer: `body` moves on an ellipse with
 * `other` at one focus (if it's bound), or flies off forever (if not).
 *
 *   mu = G (M + m)
 *   energy per unit mass   E = v^2 / 2 - mu / r       (negative = bound)
 *   semi-major axis        a = -mu / (2E)             (half the ellipse's length)
 *   period                 T = 2 pi sqrt(a^3 / mu)    (Kepler's 3rd law)
 *   eccentricity vector    e = ((v^2 - mu/r) r - (r . v) v) / mu
 *     its length is how stretched the ellipse is (0 = circle, near 1 = very
 *     long), and it points from `other` to the closest point of the orbit.
 *
 * r and v are measured relative to `other`. This uses plain r, not the
 * softened r^2 + eps^2, because that's the textbook formula; far from the
 * other body (r much bigger than eps) the difference is tiny.
 */
function orbitAround(body, other) {
    const mu = G * (body.mass + other.mass);
    const rx = body.x - other.x;
    const ry = body.y - other.y;
    const vx = body.vx - other.vx;
    const vy = body.vy - other.vy;
    const r = Math.hypot(rx, ry);
    const v = Math.hypot(vx, vy);

    const energy = v * v / 2 - mu / r;
    const orbit = {
        mu, r, v,
        energy,
        circularSpeed: Math.sqrt(mu / r),
        escapeSpeed: Math.sqrt(2 * mu / r),
        bound: energy < 0
    };

    if (orbit.bound) {
        orbit.a = -mu / (2 * energy);
        orbit.period = 2 * Math.PI * Math.sqrt(orbit.a ** 3 / mu);
        const rDotV = rx * vx + ry * vy;
        orbit.ex = ((v * v - mu / r) * rx - rDotV * vx) / mu;
        orbit.ey = ((v * v - mu / r) * ry - rDotV * vy) / mu;
        orbit.e = Math.hypot(orbit.ex, orbit.ey);
    }
    return orbit;
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
            stepVerlet(sim, timeStep);
        } else {
            stepEuler(sim, timeStep);
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
    const eps2 = softening * softening;
    const obstacles = bodies.filter(b => b.radius >= 2);

    let x = start.x, y = start.y, vx = velocity.vx, vy = velocity.vy;
    walkTree(x, y, -1, theta2, eps2);
    let ax = walkAx, ay = walkAy;

    const points = [{ x, y }];
    let hit = null;

    for (let s = 0; s < 600 && !hit; s++) {
        vx += ax * timeStep / 2;
        vy += ay * timeStep / 2;
        x += vx * timeStep;
        y += vy * timeStep;
        walkTree(x, y, -1, theta2, eps2);
        ax = walkAx;
        ay = walkAy;
        vx += ax * timeStep / 2;
        vy += ay * timeStep / 2;

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

/*
 * A disk galaxy: a central black hole and a spinning disk of stars.
 * Each star gets the speed for a circular orbit around everything closer to
 * the centre than it is (the black hole plus the inner stars).
 * spin = 1 for counter-clockwise (in maths terms), -1 for clockwise.
 */
function makeGalaxy({ name, x, y, vx, vy, spin, colors, blackHoleMass, starsPerGalaxy, random }) {
    addBody({ type: "blackhole", name: name + " core", x, y, vx, vy, mass: blackHoleMass, radius: 6 });

    const starMass = BODY_TYPES.galaxyStar.mass;
    const inner = 35;
    const outer = 200;

    // Distances from the centre: more stars near the middle, thinning out
    // (an "exponential disk", like real spiral galaxies). Kept fairly flat,
    // because the outer stars are the ones that form tidal tails.
    const scale = (outer - inner) / 1.2;
    const span = 1 - Math.exp(-(outer - inner) / scale);
    const distances = [];
    for (let i = 0; i < starsPerGalaxy; i++) {
        distances.push(inner - scale * Math.log(1 - random() * span));
    }
    distances.sort((a, b) => a - b);

    distances.forEach((r, i) => {
        const angle = random() * Math.PI * 2;
        const dx = r * Math.cos(angle);
        const dy = r * Math.sin(angle);

        // Mass inside this star's orbit
        const enclosed = blackHoleMass + i * starMass;
        const circular = Math.sqrt(
            G * enclosed * r * r / Math.pow(r * r + softening * softening, 1.5)
        );

        // A little random motion (2%), like real stars
        const wobble = () => (random() - 0.5) * 0.04 * circular;

        addBody({
            type: "galaxyStar",
            name: name + " star " + (i + 1),
            x: x + dx,
            y: y + dy,
            vx: vx - spin * circular * dy / r + wobble(),
            vy: vy + spin * circular * dx / r + wobble(),
            color: colors[i % colors.length]
        });
    });
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
                G * 2 * each * r * r / Math.pow(r * r + softening * softening, 1.5)
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

    galaxies: {
        fit: 700,
        timeStep: 0.3,  // galaxies change slowly, so bigger time steps are fine
        // More softening: a galaxy's centre isn't a point, it's a black hole
        // inside a dense ball of stars. Without this, stars skimming the
        // black holes get kicks too sharp for the time step, and energy drifts
        // by ~5% instead of ~0.4%.
        softening: 15,
        note: "Two spiral galaxies, each a black hole with 1,500 stars, swing past each other. The blue one spins the same way it's moving (prograde) and gets pulled into long tidal tails; the gold one spins the other way (retrograde) and stays mostly intact, as Toomre & Toomre showed in 1972. They're bound together, so they fall back through each other. Scroll out to follow the tails.",
        build() {
            const random = seededRandom(11);
            const blackHoleMass = 12000;
            const starsPerGalaxy = 1500;
            const starMass = BODY_TYPES.galaxyStar.mass;
            const totalMass = 2 * (blackHoleMass + starsPerGalaxy * starMass);

            /*
             * The galaxies' path around each other: an ellipse (they're
             * gravitationally bound, so they'll come back and eventually
             * merge). They start at their farthest point, 600 apart, moving
             * sideways, and swing past each other at 200 apart.
             *   semi-major axis a = (600 + 200) / 2 = 400
             *   eccentricity    e = (600 - 200) / (600 + 200) = 0.5
             *   speed at the farthest point = sqrt(G M / a * (1 - e) / (1 + e))
             */
            const farthest = 600;
            const closest = 200;
            const a = (farthest + closest) / 2;
            const e = (farthest - closest) / (farthest + closest);
            const speed = Math.sqrt(G * totalMass / a * (1 - e) / (1 + e));

            // Tilt the whole picture a little so it fills the screen nicely
            const tilt = -0.45;
            const rotate = (x, y) => ({
                x: x * Math.cos(tilt) - y * Math.sin(tilt),
                y: x * Math.sin(tilt) + y * Math.cos(tilt)
            });

            // Relative position and velocity of galaxy B as seen from A
            const relPos = rotate(farthest, 0);
            const relVel = rotate(0, speed);

            makeGalaxy({
                name: "Blue Galaxy",
                x: -relPos.x / 2, y: -relPos.y / 2,
                vx: -relVel.x / 2, vy: -relVel.y / 2,
                spin: 1,   // same direction as the orbit: prograde
                colors: ["#93c5fd", "#e0f2fe", "#a5b4fc"],
                blackHoleMass, starsPerGalaxy, random
            });
            makeGalaxy({
                name: "Gold Galaxy",
                x: relPos.x / 2, y: relPos.y / 2,
                vx: relVel.x / 2, vy: relVel.y / 2,
                spin: -1,  // opposite direction: retrograde
                colors: ["#fcd34d", "#fdba74", "#fef3c7"],
                blackHoleMass, starsPerGalaxy, random
            });
        }
    },

    asteroidBelt: {
        fit: 540,
        note: "A belt of asteroids between the inner planets and a giant, plus a comet on a long, stretched orbit. Watch the comet speed up as it dives past the star (Kepler's 2nd law) while its tail grows and points away from the star. Select the comet and open the Equations tab.",
        build() {
            const sun = addBody({ type: "star", name: "Sol", x: 0, y: 0 });
            addOrbiting("planet", sun, 75, 120, { name: "Cinder", mass: 3, radius: 5, color: "#fb923c" });
            addOrbiting("planet", sun, 120, 300, { name: "Azure", mass: 8, radius: 8, color: "#38bdf8" });
            addOrbiting("planet", sun, 165, 60, { name: "Rosa", mass: 6, radius: 7, color: "#f472b6" });

            /*
             * The belt sits well inside the giant's orbit. A giant planet
             * scatters everything in a "chaotic zone" around its orbit,
             * about 1.3 * (m / M)^(2/7) * r wide on each side (Wisdom 1980),
             * which here starts at ~307, safely outside the belt. Real belt asteroids are
             * around a million km apart and almost never hit anything, but
             * squashed into a thin ring on screen, half of them would merge
             * in one orbit. So, like galaxy stars, these pass through
             * everything. (Asteroids you place yourself do collide.)
             */
            const random = seededRandom(5);
            const asteroidColors = ["#9ca3af", "#a8a29e", "#78716c", "#b8a48c"];
            for (let i = 0; i < 180; i++) {
                addOrbiting("asteroid", sun, 215 + random() * 50, random() * 360, {
                    name: "Asteroid " + (i + 1),
                    // Very light, like real asteroids (the whole real belt
                    // weighs 3% of our Moon). Heavier ones would tug each
                    // other onto messy orbits as they slowly drift past.
                    mass: 0.001 + random() * 0.01,
                    radius: 1.2 + random() * 1.6,
                    color: asteroidColors[i % asteroidColors.length],
                    collisionless: true
                });
            }

            // A comet crosses every planet's path twice per lap, so sooner or
            // later it hits one. These starting angles were picked by testing:
            // the comet survives 20+ laps (over 3 minutes at 1x).
            addOrbiting("planet", sun, 420, 20, { name: "Goliath", mass: 40, radius: 11, color: "#e7c59a" });

            /*
             * The comet starts at its farthest point (aphelion), 520 from
             * the star, on an ellipse that comes within 55 of it.
             * Speed there, from the "vis-viva" equation:
             *   v = sqrt(G M (2 / r - 1 / a)),  a = (520 + 55) / 2
             * M is everything inside its path (star, planets and belt), which
             * pulls roughly like one mass at the centre.
             */
            const farthest = 520;
            const closest = 55;
            const a = (farthest + closest) / 2;
            const inside = bodies.reduce((total, b) => total + b.mass, 0);
            const speed = Math.sqrt(G * inside * (2 / farthest - 1 / a));
            addBody({ type: "comet", name: "Comet Halley", x: -farthest, y: 0, vx: 0, vy: speed });
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
    referenceId = null;
    if (camera.follow === "body") setCameraFollow("free");
    timeStep = scenario.timeStep ?? DEFAULT_TIME_STEP;
    softening = scenario.softening ?? DEFAULT_SOFTENING;

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
    } else if (camera.follow === "body") {
        // The followed body was deleted: stop following
        if (!camera.target || !bodies.includes(camera.target)) {
            setCameraFollow("free");
            return;
        }
        camera.x = camera.target.x;
        camera.y = camera.target.y;
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

    // Big systems: the glow changes slowly, so only recalculate it every
    // other frame and reuse the last picture in between
    if (useTreeForField && frameCount % 2 === 1 && fieldImage) {
        useScreenTransform();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(fieldCanvas, 0, 0, fieldCanvas.width * lastFieldCell, fieldCanvas.height * lastFieldCell);
        return;
    }
    if (useTreeForField) buildTree(bodies);

    // Square size is chosen so the total work (squares x bodies) stays about
    // the same: small squares with few bodies, bigger ones with many.
    const work = useTreeForField ? 50 : n;
    const cell = clamp(Math.ceil(Math.sqrt(viewWidth * viewHeight * work / 300000)), 3, 8);
    lastFieldCell = cell;
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
                // A rough tree setting is fine for a background glow
                walkTree(wx, wy, -1, 1.3, eps2);
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

            let line = clamp(1 - distance / 1.2, 0, 1);
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
    ctx.imageSmoothingQuality = "low"; // "low" is already smooth when enlarging, and much faster
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
    // Big systems: no trails for tiny bodies, only for the bigger ones
    const skipSmall = bodies.length > 300;
    for (const b of bodies) {
        if (skipSmall && SMALL_TYPES.has(b.type)) {
            if (b.trail.length) b.trail = [];
            continue;
        }
        b.trail.push({ x: b.x, y: b.y });
        while (b.trail.length > limit) b.trail.shift();
    }
}

function drawTrails() {
    useWorldTransform();
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.lineJoin = "round";

    // Big systems: draw all trails of the same colour in one go (much faster)
    if (bodies.length > 300) {
        drawTrailsBatched();
        return;
    }

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

// Group bodies by colour, so each colour can be drawn with one canvas call
function groupByColor(list) {
    const groups = new Map();
    for (const b of list) {
        const group = groups.get(b.color);
        if (group) group.push(b);
        else groups.set(b.color, [b]);
    }
    return groups;
}

function drawTrailsBatched() {
    for (const [color, group] of groupByColor(bodies)) {
        ctx.beginPath();
        for (const b of group) {
            const trail = b.trail;
            if (trail.length < 2) continue;
            ctx.moveTo(trail[0].x, trail[0].y);
            for (let i = 1; i < trail.length; i++) ctx.lineTo(trail[i].x, trail[i].y);
        }
        ctx.strokeStyle = rgba(color === "#111111" ? "#f97316" : color, 0.4);
        ctx.stroke();
    }
}

// ---------- Bodies ----------

// Tiny rocks and moons are drawn as plain dots, one canvas call per colour
function isTinyDot(b) {
    return b.type === "galaxyStar" || (SMALL_TYPES.has(b.type) && b.radius * camera.zoom < 3);
}

// `glow`: colours add up where dots overlap ("lighter" blending), so the
// crowded centre of a galaxy glows brighter, like real photos
function drawDots(list, glow = false) {
    if (glow) ctx.globalCompositeOperation = "lighter";

    for (const [color, group] of groupByColor(list)) {
        ctx.beginPath();
        for (const b of group) {
            // Galaxy stars stay visible when zoomed out
            const size = Math.max(b.radius, (glow ? 1.3 : 0.9) / camera.zoom);
            ctx.rect(b.x - size, b.y - size, size * 2, size * 2);
        }
        ctx.fillStyle = glow ? rgba(color, 0.85) : color;
        ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";
}

// Direction toward the brightest nearby star, so planets are lit on that side.
// `lightSources` is the list of stars, collected once per frame in render().
let lightSources = [];

// The star that shines brightest on `body` (null if there are no stars)
function brightestStar(body) {
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
    return best;
}

function lightDirection(body) {
    const best = brightestStar(body);
    if (!best) return { x: -0.6, y: -0.6 };
    const dx = best.x - body.x;
    const dy = best.y - body.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
}

// Planet-style shading: bright on the side facing the star, dark behind
function shadedFill(b, r) {
    const light = lightDirection(b);
    const shade = ctx.createRadialGradient(
        b.x + light.x * r * 0.45, b.y + light.y * r * 0.45, r * 0.05,
        b.x, b.y, r * 1.1
    );
    shade.addColorStop(0, mixColor(b.color, WHITE, 0.45));
    shade.addColorStop(0.5, b.color);
    shade.addColorStop(1, mixColor(b.color, BLACK, 0.75));
    return shade;
}

// A lumpy rock: a circle with a bumpy edge. The bumps come from a random
// generator seeded with the body's id, so each asteroid keeps its own shape
// every frame. It tumbles slowly as time passes.
function drawAsteroid(b) {
    const random = seededRandom(b.id || 1);
    const tumble = simTime * (random() - 0.5) * 0.06;
    const corners = 9;

    ctx.beginPath();
    for (let i = 0; i < corners; i++) {
        const angle = tumble + i / corners * Math.PI * 2;
        const bump = b.radius * (0.75 + random() * 0.4);
        ctx.lineTo(b.x + bump * Math.cos(angle), b.y + bump * Math.sin(angle));
    }
    ctx.closePath();
    ctx.fillStyle = shadedFill(b, b.radius);
    ctx.fill();
}

// One comet tail: a fading wedge from the comet in direction (ux, uy)
function drawTail(b, ux, uy, length, width, color) {
    const tx = b.x + ux * length;
    const ty = b.y + uy * length;
    const fade = ctx.createLinearGradient(b.x, b.y, tx, ty);
    fade.addColorStop(0, rgba(color, 0.75));
    fade.addColorStop(1, rgba(color, 0));

    // (-uy, ux) is sideways to the tail
    ctx.fillStyle = fade;
    ctx.beginPath();
    ctx.moveTo(b.x - uy * width * 0.5, b.y + ux * width * 0.5);
    ctx.lineTo(tx - uy * width * 2.5, ty + ux * width * 2.5);
    ctx.lineTo(tx + uy * width * 2.5, ty - ux * width * 2.5);
    ctx.lineTo(b.x + uy * width * 0.5, b.y - ux * width * 0.5);
    ctx.closePath();
    ctx.fill();
}

/*
 * A comet's tail points AWAY from the star, not behind the comet:
 * starlight and the stellar wind push its gas and dust outward.
 * The closer (hotter) the comet, the more ice boils off: longer tail.
 *   - Gas (ion) tail: blue, straight away from the star
 *   - Dust tail: yellowish, bends back along the path a little, because
 *     heavier dust is pushed less and lags behind
 * Far from any star the comet is frozen and has no tail.
 */
function drawComet(b) {
    const { x, y, radius: r } = b;
    const star = brightestStar(b);

    if (star) {
        const dx = x - star.x;
        const dy = y - star.y;
        const distance = Math.hypot(dx, dy) || 1;
        const length = Math.min(260, 6000 * (star.mass / 10000) / distance);

        if (length > r) {
            const ux = dx / distance;
            const uy = dy / distance;
            const speed = Math.hypot(b.vx - star.vx, b.vy - star.vy) || 1;
            let dustX = ux - 0.5 * (b.vx - star.vx) / speed;
            let dustY = uy - 0.5 * (b.vy - star.vy) / speed;
            const dustLength = Math.hypot(dustX, dustY) || 1;
            dustX /= dustLength;
            dustY /= dustLength;

            ctx.globalCompositeOperation = "lighter";
            drawTail(b, dustX, dustY, length * 0.8, Math.max(r, length * 0.09), "#fde68a");
            drawTail(b, ux, uy, length, Math.max(r * 0.7, length * 0.05), "#7dd3fc");
            ctx.globalCompositeOperation = "source-over";
        }
    }

    // Glowing cloud of gas (the coma) around a small icy core
    const coma = ctx.createRadialGradient(x, y, 0, x, y, r * 2.5);
    coma.addColorStop(0, "rgba(255,255,255,0.95)");
    coma.addColorStop(0.3, rgba(b.color, 0.6));
    coma.addColorStop(1, rgba(b.color, 0));
    ctx.fillStyle = coma;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.5, 0, Math.PI * 2);
    ctx.fill();
}

// A pulsar: a tiny, hot core sweeping two beams around like a lighthouse
function drawNeutronStar(b) {
    const { x, y, radius: r } = b;

    const glow = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * 3.5);
    glow.addColorStop(0, rgba(b.color, 0.8));
    glow.addColorStop(1, rgba(b.color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 3.5, 0, Math.PI * 2);
    ctx.fill();

    const angle = simTime * 0.7 + b.id;
    const beamLength = r * 9;
    ctx.globalCompositeOperation = "lighter";
    for (const side of [1, -1]) {
        const ux = side * Math.cos(angle);
        const uy = side * Math.sin(angle);
        const beam = ctx.createLinearGradient(x, y, x + ux * beamLength, y + uy * beamLength);
        beam.addColorStop(0, "rgba(237,233,254,0.8)");
        beam.addColorStop(1, "rgba(167,139,250,0)");
        ctx.fillStyle = beam;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + ux * beamLength - uy * r * 1.2, y + uy * beamLength + ux * r * 1.2);
        ctx.lineTo(x + ux * beamLength + uy * r * 1.2, y + uy * beamLength - ux * r * 1.2);
        ctx.closePath();
        ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";

    ctx.fillStyle = "#f5f3ff";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
}

function drawBody(b) {
    const { x, y, radius: r } = b;

    // Tiny rocks and moons: a plain dot looks the same at a few pixels wide
    if (isTinyDot(b)) {
        drawDots([b]);
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

    } else if (b.type === "asteroid") {
        drawAsteroid(b);

    } else if (b.type === "comet") {
        drawComet(b);

    } else if (b.type === "neutronstar") {
        drawNeutronStar(b);

    } else {
        ctx.fillStyle = shadedFill(b, r);
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

/*
 * The ellipse Kepler's laws predict for the selected body (see orbitAround).
 * The ellipse's centre is a distance a * e from the focus (the other body),
 * on the opposite side from the closest point.
 */
function drawPredictedOrbit() {
    const b = selectedBody;
    if (!b || !bodies.includes(b)) return;
    const other = referenceBody(b);
    if (!other) return;

    const orbit = orbitAround(b, other);
    if (!orbit.bound || orbit.e >= 0.999 || orbit.a > 1e6) return;

    const centerX = other.x - orbit.a * orbit.ex;
    const centerY = other.y - orbit.a * orbit.ey;
    const semiMinor = orbit.a * Math.sqrt(1 - orbit.e * orbit.e);
    const tilt = Math.atan2(orbit.ey, orbit.ex);

    ctx.strokeStyle = rgba(b.color === "#111111" ? "#f97316" : b.color, 0.55);
    ctx.lineWidth = 1.5 / camera.zoom;
    ctx.setLineDash([8 / camera.zoom, 6 / camera.zoom]);
    ctx.beginPath();
    ctx.ellipse(centerX, centerY, orbit.a, semiMinor, tilt, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Mark the closest and farthest points
    if (orbit.e > 0.02) {
        const ux = orbit.ex / orbit.e;
        const uy = orbit.ey / orbit.e;
        const size = 3 / camera.zoom;
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        for (const distance of [orbit.a * (1 - orbit.e), -orbit.a * (1 + orbit.e)]) {
            ctx.beginPath();
            ctx.arc(other.x + ux * distance, other.y + uy * distance, size, 0, Math.PI * 2);
            ctx.fill();
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
    drawBody({
        ...preset, id: 0, type: brush, x: pointer.start.x, y: pointer.start.y,
        vx: velocity.vx, vy: velocity.vy, color, radius: preset.radius
    });
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
    if (options.orbit) drawPredictedOrbit();
    const dots = [];
    const glowDots = [];
    for (const b of bodies) {
        if (b === selectedBody || !isTinyDot(b)) continue;
        if (b.type === "galaxyStar") glowDots.push(b);
        else dots.push(b);
    }
    drawDots(glowDots, true);
    drawDots(dots);
    // Bigger bodies (and the selected one) on top
    for (const b of bodies) {
        if (b === selectedBody || !isTinyDot(b)) drawBody(b);
    }

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
const xInput = document.getElementById("xInput");
const yInput = document.getElementById("yInput");
const cameraSelect = document.getElementById("cameraSelect");
const referenceSelects = document.querySelectorAll(".reference-select");

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
        shown = bodies
            .filter(b => b.type !== "galaxyStar")
            .sort((a, b) => b.mass - a.mass)
            .slice(0, BODY_LIST_LIMIT);
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
    refreshBodyMenus();
}

// ---------- Body menus ("Orbit around", "Compared with" and the camera) ----------

// The heaviest bodies: a galaxy's 3,000 stars would make the menus useless
const MENU_LIMIT = 30;

function menuBodies() {
    return bodies
        .filter(b => b.type !== "galaxyStar")
        .sort((a, b) => b.mass - a.mass)
        .slice(0, MENU_LIMIT);
}

// Rebuild a menu, but only if the bodies in it changed
// (rebuilding a menu while it's open would close it)
function fillBodyMenu(select, fixedOptions, list, prefix, groupLabel) {
    const signature = list.map(b => b.id).join(",");
    if (select.dataset.bodies === signature) return;
    select.dataset.bodies = signature;

    select.innerHTML = "";
    for (const [value, text] of fixedOptions) select.add(new Option(text, value));
    if (list.length === 0) return;

    const group = document.createElement("optgroup");
    group.label = groupLabel;
    for (const b of list) group.appendChild(new Option(b.name, prefix + b.id));
    select.appendChild(group);
}

function cameraMenuValue() {
    return camera.follow === "body" && camera.target ? "body:" + camera.target.id : camera.follow;
}

function refreshBodyMenus() {
    const heavy = menuBodies();

    // Always list the body currently chosen, even if it isn't one of the heaviest
    const chosen = referenceId === null ? null : bodies.find(b => b.id === referenceId);
    const others = heavy.filter(b => b !== selectedBody);
    if (chosen && chosen !== selectedBody && !others.includes(chosen)) others.push(chosen);

    for (const select of referenceSelects) {
        fillBodyMenu(select, [["auto", "Strongest pull"]], others, "", "Bodies");
        select.value = chosen && chosen !== selectedBody ? String(chosen.id) : "auto";
    }

    const followed = camera.follow === "body" ? camera.target : null;
    const cameraList = followed && !heavy.includes(followed) ? [...heavy, followed] : heavy;
    fillBodyMenu(cameraSelect, [
        ["free", "Free"],
        ["com", "Follow center of mass"],
        ["selected", "Follow selected body"]
    ], cameraList, "body:", "Follow a body");
    cameraSelect.value = cameraMenuValue();
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
    equationsKey = null;
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
        if (force || document.activeElement !== xInput) xInput.value = selectedBody.x.toFixed(1);
        if (force || document.activeElement !== yInput) yInput.value = selectedBody.y.toFixed(1);
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
    const pauseText = running ? ""
        : editState.pausedByEdit ? "PAUSED while editing · "
        : pointer && pointer.mode === "drag" && pointer.resume ? "PAUSED while moving a body · "
        : "PAUSED · ";
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
    refreshEquations();
}

// ---------- Equations tab ----------

/*
 * Live equations for the selected body. The cards are built once, whenever
 * the selected body (or the body it's compared with) changes. After that only
 * the numbers inside them are updated, a few times a second: each number sits
 * in a <b data-v="name"> tag, and equationValues() works out every name.
 */

let activeTab = "controls";
let equationsKey = null;   // which bodies the current cards were built for

function showPanelTab(name) {
    activeTab = name;
    document.querySelectorAll(".panel-tab").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tab === name);
    });
    document.getElementById("tab-controls").classList.toggle("hidden", name !== "controls");
    document.getElementById("tab-equations").classList.toggle("hidden", name !== "equations");
    document.querySelector(".control-panel").scrollTop = 0;
    equationsKey = null;
    refreshEquations();
}

const SUPERSCRIPTS = {
    "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³",
    "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹"
};

// Readable numbers: 1234.5 -> "1,235", 0.5 -> "0.5", 0.000123 -> "1.23×10⁻⁴"
function formatSci(value) {
    if (!Number.isFinite(value)) return "∞";
    const size = Math.abs(value);
    let text;
    if (size === 0) {
        text = "0";
    } else if (size >= 1e6 || size < 1e-3) {
        const [mantissa, exponent] = value.toExponential(2).split("e");
        text = mantissa + "×10" + String(Number(exponent)).replace(/./g, c => SUPERSCRIPTS[c]);
    } else if (size >= 1000) {
        text = Math.round(value).toLocaleString();
    } else {
        text = String(Number(value.toPrecision(3)));
    }
    return text.replace("-", "−"); // a proper minus sign
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// Small helpers that build the HTML for the cards
const num = (name, isResult = false) =>
    "<b data-v=\"" + name + "\"" + (isResult ? " class=\"result\"" : "") + ">…</b>";
const frac = (top, bottom) => "<span class=\"frac\"><span>" + top + "</span><span>" + bottom + "</span></span>";
const eqCard = (title, html) => "<div class=\"eq-card\"><h3>" + title + "</h3>" + html + "</div>";
const eqLine = html => "<div class=\"eq\">" + html + "</div>";
const eqSub = html => "<div class=\"eq-sub\">" + html + "</div>";
const eqRow = (label, html) => "<div class=\"eq-row\"><span>" + label + "</span><span>" + html + "</span></div>";
const eqNote = html => "<p class=\"eq-note\">" + html + "</p>";

// `b` is the selected body (or null), `other` the body it's compared with (or null)
function equationCardsHtml(b, other) {
    let html = "";

    if (b && other) {
        const name = escapeHtml(b.name);
        const otherName = escapeHtml(other.name);

        html += eqCard("Newton's law of gravity",
            eqLine("<i>F</i> = " + frac("<i>G</i> · <i>M</i> · <i>m</i>", "<i>r</i>² + <i>ε</i>²")) +
            eqSub("= " + frac(G + " × " + num("M") + " × " + num("m"), num("r") + "² + " + num("eps") + "²") +
                " = " + num("F", true)) +
            eqNote("The pull between " + name + " (mass <i>m</i>) and " + otherName +
                " (mass <i>M</i>), a distance <i>r</i> apart. <i>G</i> = 1 in simulation units. " +
                "<i>ε</i> is softening (How it works §4); real gravity has <i>ε</i> = 0."));

        html += eqCard("Acceleration: Newton's 2nd law",
            eqLine("<i>a</i> = " + frac("<i>F</i>", "<i>m</i>") + " = " +
                frac("<i>G</i> · <i>M</i>", "<i>r</i>² + <i>ε</i>²")) +
            eqSub("= " + frac(num("F"), num("m")) + " = " + num("aOther", true)) +
            eqNote("<i>m</i> cancels out, so a pebble and a planet in the same spot fall exactly the same way.") +
            eqRow("All " + num("n") + " bodies together", "|<i>a</i>| = " + num("aNet")) +
            eqRow("Net force <i>F</i> = <i>m</i> · |<i>a</i>|", num("Fnet")) +
            eqNote("Every other body pulls too. This total is the orange arrow (Force &amp; velocity arrows)."));

        html += eqCard("Newton's 3rd law",
            eqNote(otherName + " is pulled toward " + name + " exactly as hard, <i>F</i> = " + num("F") +
                ". Same force, very different accelerations:") +
            eqRow(name + ": <i>a</i> = <i>F</i> / <i>m</i>", num("aOther")) +
            eqRow(otherName + ": <i>a</i> = <i>F</i> / <i>M</i>", num("aBack")) +
            eqNote("That's why the heavier body barely moves."));
    }

    if (b) {
        html += eqCard("Velocity and momentum",
            eqLine("<i>v</i> = √(<i>v<sub>x</sub></i>² + <i>v<sub>y</sub></i>²)") +
            eqSub("= √((" + num("vx") + ")² + (" + num("vy") + ")²) = " + num("v", true)) +
            eqLine("<i>p</i> = <i>m</i> · <i>v</i>") +
            eqSub("= " + num("m") + " × " + num("v") + " = " + num("p", true)) +
            eqNote("Momentum is how hard something is to stop. Collisions keep the total momentum the same."));

        html += eqCard("Kinetic energy",
            eqLine("<i>KE</i> = ½ <i>m v</i>²") +
            eqSub("= ½ × " + num("m") + " × " + num("v") + "² = " + num("KE", true)) +
            eqNote("Energy of motion. Twice the speed means four times the energy."));
    }

    if (b && other) {
        const name = escapeHtml(b.name);
        const otherName = escapeHtml(other.name);

        html += eqCard("Gravitational potential energy",
            eqLine("<i>U</i> = −" + frac("<i>G</i> · <i>M</i> · <i>m</i>", "√(<i>r</i>² + <i>ε</i>²)")) +
            eqSub("= −" + frac(G + " × " + num("M") + " × " + num("m"), "√(" + num("r") + "² + " + num("eps") + "²)") +
                " = " + num("Upair", true)) +
            eqRow("With every body: <i>U</i> = <i>m</i> · <i>φ</i>", num("U")) +
            eqNote("Negative, because you'd have to <em>add</em> energy to pull them apart. " +
                "<i>φ</i> is the gravitational potential here: how deep in the well it sits (Gravity field view)."));

        html += eqCard("Orbit around " + otherName,
            eqNote("Treating " + name + " and " + otherName + " as if they were alone (the two-body problem):") +
            eqRow("Speed relative to " + otherName, num("vRel")) +
            eqRow("Circular orbit speed √(<i>G</i>(<i>M</i>+<i>m</i>) / <i>r</i>)", num("vCirc")) +
            eqRow("Escape speed √(2<i>G</i>(<i>M</i>+<i>m</i>) / <i>r</i>)", num("vEsc")) +
            eqLine("<i>E</i> = " + frac("<i>v</i>²", "2") + " − " + frac("<i>G</i>(<i>M</i> + <i>m</i>)", "<i>r</i>")) +
            eqSub("= " + frac(num("vRel") + "²", "2") + " − " + frac(num("mu"), num("r")) + " = " + num("energy", true)) +
            "<span class=\"orbit-status\" data-v=\"status\"></span>" +
            eqNote("Orbital energy per unit of mass. Below zero it can't get away: it's bound. " +
                "Moving faster than escape speed makes <i>E</i> positive, and it leaves for good."));

        html += eqCard("Kepler's 3rd law",
            eqLine("<i>a</i> = −" + frac("<i>G</i>(<i>M</i> + <i>m</i>)", "2<i>E</i>")) +
            eqSub("= " + num("axis", true)) +
            eqLine("<i>T</i> = 2π √(<i>a</i>³ / <i>G</i>(<i>M</i> + <i>m</i>))") +
            eqSub("= 2π √(" + num("axis") + "³ / " + num("mu") + ") = " + num("period", true)) +
            eqRow("Eccentricity <i>e</i> (0 = circle)", num("ecc")) +
            eqRow("One lap in real time", num("realTime")) +
            eqNote("<i>a</i> is the semi-major axis, half the orbit's longest width. " +
                "<i>T</i>² grows like <i>a</i>³, so an orbit twice as big takes 2.8× as long. " +
                "The dashed ellipse on the canvas is this predicted orbit."));
    }

    html += eqCard("Whole system (" + num("n") + " bodies)",
        eqRow("Kinetic <i>KE</i> = Σ ½<i>mv</i>²", num("sysKE")) +
        eqRow("Potential <i>U</i> = Σ −<i>G m</i>₁<i>m</i>₂ / <i>r</i>", num("sysU")) +
        eqRow("Total <i>E</i> = <i>KE</i> + <i>U</i>", num("sysE")) +
        eqRow("Total momentum |Σ <i>m</i><b>v</b>|", num("sysP")) +
        eqNote("With nothing outside pushing on the system, the total energy and momentum stay " +
            "constant (conservation laws), however wildly the bodies move. Merges turn a little " +
            "energy into heat."));

    return html;
}

function equationValues(b, other) {
    const system = measureEnergyFast();
    let px = 0, py = 0;
    for (const body of bodies) {
        px += body.mass * body.vx;
        py += body.mass * body.vy;
    }

    const values = {
        n: bodies.length,
        sysKE: system.kinetic,
        sysU: system.potential,
        sysE: system.total,
        sysP: Math.hypot(px, py)
    };
    if (!b) return values;

    // measureEnergyFast() made sure ax, ay and phi are up to date
    const speed = Math.hypot(b.vx, b.vy);
    const accel = Math.hypot(b.ax, b.ay);
    Object.assign(values, {
        m: b.mass,
        vx: b.vx,
        vy: b.vy,
        v: speed,
        p: b.mass * speed,
        KE: 0.5 * b.mass * speed * speed,
        aNet: accel,
        Fnet: b.mass * accel,
        U: b.mass * b.phi
    });
    if (!other) return values;

    const r = Math.hypot(other.x - b.x, other.y - b.y);
    const softened = r * r + softening * softening;
    const force = G * other.mass * b.mass / softened;
    const orbit = orbitAround(b, other);

    Object.assign(values, {
        M: other.mass,
        r,
        eps: softening,
        F: force,
        aOther: force / b.mass,
        aBack: force / other.mass,
        Upair: -G * other.mass * b.mass / Math.sqrt(softened),
        vRel: orbit.v,
        vCirc: orbit.circularSpeed,
        vEsc: orbit.escapeSpeed,
        mu: orbit.mu,
        energy: orbit.energy,
        status: orbit.bound ? "Bound: E < 0, it stays in orbit" : "Escaping: E ≥ 0, it won't come back"
    });

    if (orbit.bound) {
        const seconds = orbit.period / timeStep / (STEPS_PER_SECOND * simulationSpeed);
        Object.assign(values, {
            axis: orbit.a,
            period: orbit.period,
            ecc: orbit.e,
            realTime: "about " + formatSci(seconds) + " s at " + simulationSpeed.toFixed(1) + "x"
        });
    } else {
        Object.assign(values, { axis: "none", period: "never returns", ecc: "1 or more (open path)", realTime: "never" });
    }
    return values;
}

function refreshEquations() {
    if (activeTab !== "equations") return;

    const b = selectedBody && bodies.includes(selectedBody) ? selectedBody : null;
    const other = b ? referenceBody(b) : null;
    const container = document.getElementById("equationCards");

    // Rebuild the cards only when the bodies involved change
    const key = (b ? b.id : "-") + "/" + (other ? other.id : "-");
    if (key !== equationsKey) {
        equationsKey = key;
        container.innerHTML = equationCardsHtml(b, other);
        document.getElementById("equationsIntro").textContent = b
            ? "The forces and energy of " + b.name + " right now. Every number updates live, in simulation units."
            : "Click a body on the canvas to see the equations acting on it, with live numbers.";
        document.getElementById("equationsReference").classList.toggle("hidden", !b);
    }

    const values = equationValues(b, other);
    for (const el of container.querySelectorAll("[data-v]")) {
        const value = values[el.dataset.v];
        el.textContent = typeof value === "number" ? formatSci(value) : value ?? "";
    }

    const status = container.querySelector(".orbit-status");
    if (status) status.classList.toggle("escaping", values.energy >= 0);
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
            "<b>Drag a body</b> to move it &middot; " +
            "<b>Scroll</b> to zoom";
    }
}

function updateCursor(hovering = false) {
    if (pointer && (pointer.mode === "pan" || pointer.mode === "drag") && pointer.moved) {
        canvas.style.cursor = "grabbing";
    } else if (hovering) {
        canvas.style.cursor = brush ? "pointer" : "move";
    } else {
        canvas.style.cursor = brush ? "crosshair" : "grab";
    }
}

function deleteSelected() {
    if (!selectedBody) return;
    if (camera.target === selectedBody) setCameraFollow("free");
    if (referenceId === selectedBody.id) referenceId = null;
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

function setCameraFollow(mode, target = null) {
    camera.follow = mode;
    camera.target = target;
    cameraSelect.value = cameraMenuValue();
}

// Teleport a body. Its old trail would draw a line across the jump, so it's cleared.
function moveBody(body, x, y) {
    body.x = x;
    body.y = y;
    body.trail = [];
    markSystemChanged();
}

// Let go of whatever the mouse was doing (placing, panning or dragging)
function cancelPointer() {
    if (pointer && pointer.mode === "drag") finishDrag();
    pointer = null;
    updateCursor();
}

// Dragging a body pauses the simulation; carry on once it's let go
function finishDrag() {
    if (pointer.resume && !running) {
        running = true;
        updatePlayButton();
    }
}

// ---------- Mouse / touch on the canvas ----------

/*
 * Left button:
 *   - on a body: select it (and with the Select / Pan tool, drag to move it)
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
            if (brush) return;
            pointer = { mode: "drag", body: hit, startScreen: screen, lastScreen: screen, moved: false, resume: false };
        } else if (brush) {
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
    } else if (pointer.mode === "drag") {
        if (!pointer.moved) {
            const distance = Math.hypot(screen.x - pointer.startScreen.x, screen.y - pointer.startScreen.y);
            if (distance < 4) return;
            pointer.moved = true;
            // Gravity can't act normally on a body held by the mouse, so the
            // simulation waits while you drag, then carries on
            if (running) {
                running = false;
                pointer.resume = true;
                updatePlayButton();
            }
            updateCursor();
        }
        // Move by how far the mouse moved (this also works while the camera follows the body)
        const body = pointer.body;
        if (bodies.includes(body)) {
            moveBody(body,
                body.x + (screen.x - pointer.lastScreen.x) / camera.zoom,
                body.y + (screen.y - pointer.lastScreen.y) / camera.zoom);
        }
        pointer.lastScreen = screen;
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
    cancelPointer();
});

canvas.addEventListener("pointercancel", cancelPointer);

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

cameraSelect.onchange = event => {
    const value = event.target.value;
    if (value.startsWith("body:")) {
        const id = Number(value.slice(5));
        setCameraFollow("body", bodies.find(b => b.id === id) ?? null);
    } else {
        setCameraFollow(value);
    }
    event.target.blur();
};

for (const select of referenceSelects) {
    select.onchange = event => {
        referenceId = event.target.value === "auto" ? null : Number(event.target.value);
        refreshBodyMenus();     // keeps both menus showing the same choice
        refreshEquations();
        event.target.blur();
    };
}

document.querySelectorAll(".panel-tab").forEach(btn => {
    btn.onclick = () => showPanelTab(btn.dataset.tab);
});

document.getElementById("showEquationsBtn").onclick = () => showPanelTab("equations");

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
    orbitToggle: "orbit",
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

// Position boxes move the body when you press Enter or leave the box
for (const axis of ["x", "y"]) {
    document.getElementById(axis + "Input").addEventListener("change", event => {
        const body = editableBody();
        const value = Number(event.target.value);
        if (!body || event.target.value === "" || !Number.isFinite(value)) return;
        moveBody(body, axis === "x" ? value : body.x, axis === "y" ? value : body.y);
    });
}

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
for (const input of [massInput, radiusInput, xInput, yInput, vxInput, vyInput]) {
    input.addEventListener("focus", () => beginEdit(input.id));
    input.addEventListener("blur", () => endEdit(input.id));
    input.addEventListener("keydown", event => {
        if (event.key === "Enter") input.blur();
    });
}

document.getElementById("orbitBtn").onclick = () => {
    if (!selectedBody) return;
    const attractor = referenceBody(selectedBody);
    if (!attractor) return;
    const direction = Number(document.getElementById("orbitDirection").value);
    const v = circularVelocity(selectedBody.x, selectedBody.y, selectedBody.mass, attractor, direction);
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
        cancelPointer();
        setBrush("select");
        selectBody(null);
    } else if (event.key === "r" || event.key === "R") {
        loadScenario(currentScenario);
    } else if (event.key === "f" || event.key === "F") {
        fitView();
    } else if (event.key === "e" || event.key === "E") {
        showPanelTab(activeTab === "equations" ? "controls" : "equations");
    } else if (/^[1-9]$/.test(event.key) && Number(event.key) <= BRUSH_KEYS.length) {
        // Pressing the key of the active tool again goes back to Select / Pan
        setBrush(BRUSH_KEYS[Number(event.key) - 1]);
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
