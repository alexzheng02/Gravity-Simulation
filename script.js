"use strict";

/* ==========================================================================
   lumi: an interactive 3D N-body gravity simulator

   How the code is organised:
     1. Settings and state
     2. Physics in 3D (gravity, octree, time stepping, collisions, energy, orbits)
     3. Scenarios (the presets in the dropdown)
     4. Camera (rotate / pan / zoom, and converting between 3D and screen positions)
     5. Drawing with Three.js (bodies, trails, orbits, gravity sheet, tree view),
        plus a flat overlay for labels and arrows, and the energy graph
     6. Mouse, keyboard and UI controls (tools, panels, Equations tab)
     7. The main loop

   Three.js (lib/three.min.js, MIT licence) only does the drawing; all the
   physics is our own code.
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
    field: "off",      // gravity field view: "off", "map" (contour map), "sheet" (rubber sheet) or "pull" (pull sheet)
    fieldArrows: false,
    grid: true,
    stars: true,       // the background stars
    perf: false,       // frames per second and timings in the readout
    spinView: false,
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
    pausedByEdit: false,
    undoSaved: false     // whether this edit has saved its undo step yet
};

// The body the selected body is compared with: what it orbits in the
// Equations tab, the predicted ellipse and "Make it orbit".
// null = automatic (whichever body pulls on it hardest).
let referenceId = null;

// Energy tracking
let energyHistory = [];
let energyBaseline = null;
let pendingEnergyEvent = false;

// View state. The 3D view is drawn on `canvas`; labels and arrows are drawn
// on a see-through `overlay` canvas on top of it.
const canvas = document.getElementById("universe");
const overlay = document.getElementById("overlay");
const ctx = overlay.getContext("2d");
const energyCanvas = document.getElementById("energyChart");
const energyCtx = energyCanvas.getContext("2d");

let viewWidth = 0;
let viewHeight = 0;
let pixelRatio = 1;

// The camera looks at (x, y, z) from `distance` away (see section 4).
// follow: "free", "com" (centre of mass), "selected", or "body" (follow `followed`)
const camera = {
    x: 0, y: 0, z: 0,
    distance: 800,
    yaw: -Math.PI / 2,
    pitch: 55 * Math.PI / 180,
    follow: "free",
    followed: null
};

let tool = "observe";   // what the mouse does: "observe", "move", or a body type to place
let brush = null;       // the body type being placed, or null (see setTool)
let pointer = null;     // what the mouse is currently doing (placing or panning)
let effects = [];       // collision flashes
let frameCount = 0;


/* ==========================================================================
   2. PHYSICS
   ========================================================================== */

function createBody({ type, name, x, y, z = 0, vx = 0, vy = 0, vz = 0, mass, radius, color, collisionless }) {
    const preset = BODY_TYPES[type];
    typeCounters[type] = (typeCounters[type] || 0) + 1;

    return {
        id: nextId++,
        type,
        name: name ?? preset.label + " " + typeCounters[type],
        x, y, z, vx, vy, vz,
        ax: 0, ay: 0, az: 0, phi: 0,
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
 * 2. Barnes-Hut: put the bodies in an "octree" (cubes split into eight
 *    smaller cubes, again and again, until each cube holds a few bodies).
 *    A far-away cube full of bodies pulls almost exactly like ONE body
 *    with their total mass sitting at their centre of mass. So for each
 *    body we walk the tree, and if a cube is small compared to its
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
        body.az = 0;
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
            const dz = b.z - a.z;
            const distSquared = dx * dx + dy * dy + dz * dz + eps2;

            // G / r^3. Multiplying by (dx, dy, dz), which has length r,
            // gives a vector of length G / r^2 pointing at the other body.
            const factor = G / (distSquared * Math.sqrt(distSquared));

            a.ax += dx * factor * b.mass;
            a.ay += dy * factor * b.mass;
            a.az += dz * factor * b.mass;
            b.ax -= dx * factor * a.mass;
            b.ay -= dy * factor * a.mass;
            b.az -= dz * factor * a.mass;

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

/* ---------- The octree ----------
 *
 * Stored in flat typed arrays (one slot per cube, or "node") because that
 * is much faster in JavaScript than thousands of small objects.
 * Each leaf holds up to LEAF_CAPACITY bodies before it splits into eight.
 * Children are always created after their parent, so walking the node list
 * backwards visits children before parents.
 */
// Measured (3,000-body galaxy): smaller leaves mean fewer pulls per body
// but more leaves to walk the tree for; 6 to 8 was fastest overall.
const LEAF_CAPACITY = 8;

const tree = {
    capacity: 0,
    count: 0,       // nodes in use
    list: null,     // the bodies the tree was built from
    cx: null,       // centre of the cube
    cy: null,
    cz: null,
    half: null,     // half the cube's width
    mass: null,     // total mass inside
    comX: null,     // centre of mass of everything inside
    comY: null,
    comZ: null,
    child: null,    // 8 children per node, -1 = none
    leaf: null,     // 1 if the node has no children
    first: null,    // leaf: first body inside (-1 = empty)
    leafCount: null,// leaf: how many bodies inside
    // Per body: position and mass copied into fast arrays, and the next
    // body in the same leaf (a linked list)
    bx: new Float64Array(0),
    by: new Float64Array(0),
    bz: new Float64Array(0),
    bm: new Float64Array(0),
    next: new Int32Array(0)
};

const NODE_ARRAYS = ["cx", "cy", "cz", "half", "mass", "comX", "comY", "comZ", "child", "leaf", "first", "leafCount"];

function allocateTree(capacity) {
    tree.capacity = capacity;
    tree.cx = new Float64Array(capacity);
    tree.cy = new Float64Array(capacity);
    tree.cz = new Float64Array(capacity);
    tree.half = new Float64Array(capacity);
    tree.mass = new Float64Array(capacity);
    tree.comX = new Float64Array(capacity);
    tree.comY = new Float64Array(capacity);
    tree.comZ = new Float64Array(capacity);
    tree.child = new Int32Array(capacity * 8);
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

function newNode(cx, cy, cz, half) {
    if (tree.count >= tree.capacity) growTree();
    const k = tree.count++;
    tree.cx[k] = cx;
    tree.cy[k] = cy;
    tree.cz[k] = cz;
    tree.half[k] = half;
    tree.mass[k] = 0;
    tree.child.fill(-1, 8 * k, 8 * k + 8);
    tree.leaf[k] = 1;
    tree.first[k] = -1;
    tree.leafCount[k] = 0;
    return k;
}

// Which eighth of node k is the point in? Each bit says which side:
// bit 1 = right half (x), bit 2 = y, bit 4 = z
function octant(k, x, y, z) {
    return (x >= tree.cx[k] ? 1 : 0) + (y >= tree.cy[k] ? 2 : 0) + (z >= tree.cz[k] ? 4 : 0);
}

function childFor(k, q) {
    const existing = tree.child[8 * k + q];
    if (existing !== -1) return existing;

    const h = tree.half[k] / 2;
    const c = newNode(
        tree.cx[k] + (q & 1 ? h : -h),
        tree.cy[k] + (q & 2 ? h : -h),
        tree.cz[k] + (q & 4 ? h : -h),
        h
    );
    tree.child[8 * k + q] = c;
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
    const z = tree.bz[i];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

    let k = 0;
    let depth = 0;

    for (;;) {
        if (tree.leaf[k]) {
            // Room in this leaf (or bodies piled on top of each other): add it
            if (tree.leafCount[k] < LEAF_CAPACITY || depth >= TREE_MAX_DEPTH) {
                addToLeaf(k, i);
                return;
            }

            // Full: split into eight, moving the bodies down one level
            let j = tree.first[k];
            tree.leaf[k] = 0;
            tree.first[k] = -1;
            tree.leafCount[k] = 0;
            while (j !== -1) {
                const nextJ = tree.next[j];
                addToLeaf(childFor(k, octant(k, tree.bx[j], tree.by[j], tree.bz[j])), j);
                j = nextJ;
            }
        }

        // Go down into the right eighth
        k = childFor(k, octant(k, x, y, z));
        depth++;
    }
}

/*
 * The tree is needed by the physics and also by the gravity field, the
 * arrows, the tree view and the launch preview. Building it takes time, so
 * `positionStamp` counts every change to the bodies' positions or masses:
 * if nothing has changed since the tree was built, it can be reused.
 */
let positionStamp = 0;

function ensureTree() {
    if (tree.list !== bodies || tree.stamp !== positionStamp) buildTree(bodies);
}

function buildTree(list) {
    const n = list.length;
    tree.list = list;
    tree.stamp = list === bodies ? positionStamp : -1;
    tree.count = 0;

    if (tree.next.length < n) {
        const size = Math.max(n, tree.next.length * 2);
        tree.next = new Int32Array(size);
        tree.bx = new Float64Array(size);
        tree.by = new Float64Array(size);
        tree.bz = new Float64Array(size);
        tree.bm = new Float64Array(size);
    }
    if (tree.capacity < n + 64) allocateTree(n + 64);
    if (n === 0) return;

    // Copy positions into fast arrays and find a root cube that fits them all
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
        const b = list[i];
        tree.bx[i] = b.x;
        tree.by[i] = b.y;
        tree.bz[i] = b.z;
        tree.bm[i] = b.mass;
        if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z)) continue;
        if (b.x < minX) minX = b.x;
        if (b.x > maxX) maxX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.y > maxY) maxY = b.y;
        if (b.z < minZ) minZ = b.z;
        if (b.z > maxZ) maxZ = b.z;
    }
    if (minX === Infinity) return;

    // The root cube's lowest corner sits at the lowest body (rather than
    // centring the cube). A flat system, like a disk of rocks, then stays on
    // one side of each split in z until the cubes are as small as the disk
    // is thick. Centred, every split would cut the disk into a top and a
    // bottom half: twice the cubes, and ~50% more work, for nothing.
    const half = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 1;
    newNode(minX + half, minY + half, minZ + half, half);

    for (let i = 0; i < n; i++) insertBody(i);

    // Total mass and centre of mass, from the smallest cubes up
    const { bx, by, bz, bm, next } = tree;
    for (let k = tree.count - 1; k >= 0; k--) {
        let m = 0, mx = 0, my = 0, mz = 0;

        if (tree.leaf[k]) {
            for (let j = tree.first[k]; j !== -1; j = next[j]) {
                m += bm[j];
                mx += bm[j] * bx[j];
                my += bm[j] * by[j];
                mz += bm[j] * bz[j];
            }
        } else {
            for (let q = 0; q < 8; q++) {
                const c = tree.child[8 * k + q];
                if (c === -1) continue;
                const cm = tree.mass[c];
                m += cm;
                mx += cm * tree.comX[c];
                my += cm * tree.comY[c];
                mz += cm * tree.comZ[c];
            }
        }

        tree.mass[k] = m;
        tree.comX[k] = m > 0 ? mx / m : tree.cx[k];
        tree.comY[k] = m > 0 ? my / m : tree.cy[k];
        tree.comZ[k] = m > 0 ? mz / m : tree.cz[k];
    }
}

/*
 * Walk the tree to find the pull at point (x, y, z).
 * `self` is the index of the body at that point (so it doesn't pull on
 * itself), or -1 for an empty point. Results go into the walk* variables.
 */
let walkAx = 0, walkAy = 0, walkAz = 0, walkPhi = 0;
const walkStack = new Int32Array(4096);

function walkTree(x, y, z, self, theta2, eps2) {
    const { cx, cy, cz, half, mass, comX, comY, comZ, child, leaf, first, next, bx, by, bz, bm } = tree;

    let ax = 0, ay = 0, az = 0, phi = 0;
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
                const dz = bz[j] - z;
                const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
                const gm = G * bm[j] * inv;
                ax += dx * gm * inv * inv;
                ay += dy * gm * inv * inv;
                az += dz * gm * inv * inv;
                phi -= gm;
            }
            continue;
        }

        const h = half[k];
        const dx = comX[k] - x;
        const dy = comY[k] - y;
        const dz = comZ[k] - z;
        const dist2 = dx * dx + dy * dy + dz * dz;

        // Far enough away (cube size / distance < theta), and the point
        // isn't inside this cube: treat everything in it as ONE mass
        // sitting at its centre of mass
        const outside = Math.abs(x - cx[k]) > h || Math.abs(y - cy[k]) > h || Math.abs(z - cz[k]) > h;

        if (outside && 4 * h * h < theta2 * dist2) {
            const inv = 1 / Math.sqrt(dist2 + eps2);
            const gm = G * m * inv;
            ax += dx * gm * inv * inv;
            ay += dy * gm * inv * inv;
            az += dz * gm * inv * inv;
            phi -= gm;
        } else {
            // Too close: open the cube and look at its eight children
            const base = 8 * k;
            for (let q = 0; q < 8; q++) {
                const c = child[base + q];
                if (c !== -1) walkStack[sp++] = c;
            }
        }
    }

    walkAx = ax;
    walkAy = ay;
    walkAz = az;
    walkPhi = phi;
}

/*
 * The main Barnes-Hut force calculation.
 *
 * Bodies in the same leaf are close together, so they need almost the same
 * list of "far cubes" and "nearby bodies". Instead of walking the tree for
 * every body, we walk it once per leaf (up to 8 bodies) and share the lists.
 * The test for "far enough" uses the leaf body CLOSEST to each cube, so
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

// Fill groupNodes (cubes used as one mass) and groupBodies (bodies used
// one by one) for every body in leaf `L`
function gatherInteractions(L, theta2) {
    const { cx, cy, cz, half, mass, comX, comY, comZ, child, leaf, first, next, bx, by, bz } = tree;

    // The box around the bodies in this leaf
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let j = first[L]; j !== -1; j = next[j]) {
        if (bx[j] < minX) minX = bx[j];
        if (bx[j] > maxX) maxX = bx[j];
        if (by[j] < minY) minY = by[j];
        if (by[j] > maxY) maxY = by[j];
        if (bz[j] < minZ) minZ = bz[j];
        if (bz[j] > maxZ) maxZ = bz[j];
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

        // Cubes that contain this leaf must always be opened
        const containsLeaf = Math.abs(cx[L] - cx[k]) < h && Math.abs(cy[L] - cy[k]) < h &&
            Math.abs(cz[L] - cz[k]) < h;

        // Distance from the cube's centre of mass to the nearest point of the box
        const dx = Math.max(minX - comX[k], 0, comX[k] - maxX);
        const dy = Math.max(minY - comY[k], 0, comY[k] - maxY);
        const dz = Math.max(minZ - comZ[k], 0, comZ[k] - maxZ);
        const dist2 = dx * dx + dy * dy + dz * dz;

        if (!containsLeaf && 4 * h * h < theta2 * dist2) {
            pushGroupNode(k);
        } else {
            const base = 8 * k;
            for (let q = 0; q < 8; q++) {
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
    const { leaf, leafCount, first, next, mass, comX, comY, comZ, bx, by, bz, bm } = tree;
    let total = 0;
    let groups = 0;

    for (let L = 0; L < tree.count; L++) {
        if (!leaf[L] || leafCount[L] === 0) continue;

        gatherInteractions(L, theta2);

        for (let i = first[L]; i !== -1; i = next[i]) {
            const x = bx[i];
            const y = by[i];
            const z = bz[i];
            let ax = 0, ay = 0, az = 0, phi = 0;

            // Far cubes, each as one mass at its centre of mass
            for (let n = 0; n < groupNodeCount; n++) {
                const k = groupNodes[n];
                const dx = comX[k] - x;
                const dy = comY[k] - y;
                const dz = comZ[k] - z;
                const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
                const gm = G * mass[k] * inv;
                ax += dx * gm * inv * inv;
                ay += dy * gm * inv * inv;
                az += dz * gm * inv * inv;
                phi -= gm;
            }

            // Nearby bodies, one by one
            for (let n = 0; n < groupBodyCount; n++) {
                const j = groupBodies[n];
                if (j === i) continue;
                const dx = bx[j] - x;
                const dy = by[j] - y;
                const dz = bz[j] - z;
                const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
                const gm = G * bm[j] * inv;
                ax += dx * gm * inv * inv;
                ay += dy * gm * inv * inv;
                az += dz * gm * inv * inv;
                phi -= gm;
            }

            const b = list[i];
            b.ax = ax;
            b.ay = ay;
            b.az = az;
            b.phi = phi;
            total += groupNodeCount + groupBodyCount - 1;
            groups += groupNodeCount;
        }
    }

    /*
     * Barnes-Hut pulls aren't exactly equal and opposite: a far cube pulls on
     * a body, but the body doesn't pull back on the cube in exactly the same
     * way. Left alone, the tiny leftover would slowly push the whole system
     * sideways (measured: the galaxies drift by 0.2% of their speed in 300
     * steps). Real forces inside a system always add up to zero (Newton's 3rd
     * law), so take the leftover total off every body equally: momentum then
     * stays exactly constant. Each pull changes by far less than the
     * Barnes-Hut error itself.
     */
    let fx = 0, fy = 0, fz = 0, totalMass = 0;
    for (const b of list) {
        fx += b.mass * b.ax;
        fy += b.mass * b.ay;
        fz += b.mass * b.az;
        totalMass += b.mass;
    }
    if (totalMass > 0) {
        for (const b of list) {
            b.ax -= fx / totalMass;
            b.ay -= fy / totalMass;
            b.az -= fz / totalMass;
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
// A body held by the mouse (`held`, see the Move tool) stays where it's held
// and keeps its velocity, but still pulls on everything else.
function stepVerlet(list, dt, isMain = false) {
    for (const b of list) {
        if (b.held) continue;
        b.vx += b.ax * dt / 2;
        b.vy += b.ay * dt / 2;
        b.vz += b.az * dt / 2;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
    }
    if (list === bodies) positionStamp++;

    computeForces(list, isMain);

    for (const b of list) {
        if (b.held) continue;
        b.vx += b.ax * dt / 2;
        b.vy += b.ay * dt / 2;
        b.vz += b.az * dt / 2;
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
        if (b.held) continue;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
        b.vx += b.ax * dt;
        b.vy += b.ay * dt;
        b.vz += b.az * dt;
    }
    if (list === bodies) positionStamp++;
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
 * sort the bodies left to right (by x), then each body only checks the
 * bodies to its right that are close enough in x to possibly touch it.
 */
// Collisionless bodies (galaxy stars, belt asteroids) never collide with anything
function canCollide(a, b) {
    return !a.collisionless && !b.collisionless;
}

let sweepOrder = new Int32Array(0);
let sweepLeft = new Float64Array(0);

function findTouchingPairs() {
    if (sweepOrder.length < bodies.length) {
        sweepOrder = new Int32Array(bodies.length * 2);
        sweepLeft = new Float64Array(bodies.length * 2);
    }

    // Only bodies that can collide take part (in a galaxy that's just the
    // two black holes, instead of sorting 3,000 stars every step)
    let n = 0;
    for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (b.collisionless) continue;
        sweepLeft[i] = b.x - b.radius;   // left edge of each body
        sweepOrder[n++] = i;
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
            const dz = b.z - a.z;
            const touch = a.radius + b.radius;
            if (dx * dx + dy * dy + dz * dz < touch * touch) pairs.push([a, b]);
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
    const dvz = a.vz - b.vz;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz + softening * softening);
    return -0.5 * mu * (dvx * dvx + dvy * dvy + dvz * dvz) + G * a.mass * b.mass / r;
}

function mergeBodies(a, b) {
    const big = a.mass >= b.mass ? a : b;
    const small = big === a ? b : a;
    const totalMass = a.mass + b.mass;
    const energyChange = mergeEnergyChange(a, b);

    // Centre of mass position and momentum-conserving velocity
    big.x = (a.x * a.mass + b.x * b.mass) / totalMass;
    big.y = (a.y * a.mass + b.y * b.mass) / totalMass;
    big.z = (a.z * a.mass + b.z * b.mass) / totalMass;
    big.vx = (a.vx * a.mass + b.vx * b.mass) / totalMass;
    big.vy = (a.vy * a.mass + b.vy * b.mass) / totalMass;
    big.vz = (a.vz * a.mass + b.vz * b.mass) / totalMass;
    big.mass = totalMass;

    // Volumes add, so the new radius is the cube root of the summed cubes
    big.radius = Math.min(60, Math.cbrt(a.radius ** 3 + b.radius ** 3));

    // Big systems: no flash for tiny bodies merging (there are hundreds)
    const notable = bodies.length <= 300 || !SMALL_TYPES.has(small.type);
    if (notable) effects.push({ x: big.x, y: big.y, z: big.z, radius: big.radius, age: 0, color: small.color });

    small.dead = true;
    if (selectedBody === small) selectedBody = big;
    if (camera.followed === small) camera.followed = big;
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
        kinetic += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
    }

    for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
            const a = list[i];
            const b = list[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dz = b.z - a.z;
            potential -= G * a.mass * b.mass / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
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
        kinetic += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
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
    positionStamp++;
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
    let mx = 0, my = 0, mz = 0, m = 0;
    for (const b of bodies) {
        mx += b.x * b.mass;
        my += b.y * b.mass;
        mz += b.z * b.mass;
        m += b.mass;
    }
    return m > 0 ? { x: mx / m, y: my / m, z: mz / m } : { x: 0, y: 0, z: 0 };
}

// Shift every velocity so total momentum is zero.
// Otherwise the whole system slowly drifts off screen.
function zeroMomentum() {
    let px = 0, py = 0, pz = 0, m = 0;
    for (const b of bodies) {
        px += b.mass * b.vx;
        py += b.mass * b.vy;
        pz += b.mass * b.vz;
        m += b.mass;
    }
    if (m === 0) return;
    for (const b of bodies) {
        b.vx -= px / m;
        b.vy -= py / m;
        b.vz -= pz / m;
    }
}

// Which body pulls hardest on the point (x, y, z)?
function dominantAttractor(x, y, z, exclude) {
    let best = null;
    let bestPull = 0;
    const eps2 = softening * softening;

    for (const b of bodies) {
        if (b === exclude) continue;
        const dx = b.x - x;
        const dy = b.y - y;
        const dz = b.z - z;
        const pull = b.mass / (dx * dx + dy * dy + dz * dz + eps2);
        if (pull > bestPull) {
            bestPull = pull;
            best = b;
        }
    }
    return best;
}

/*
 * Which way orbits go round. An orbit spins around an axis; by the
 * "right-hand rule", curl your right hand's fingers along the motion and your
 * thumb points along the axis. z points up (out of the flat x-y plane), so:
 *   axis pointing down (-z): clockwise when seen from above
 *   axis pointing up (+z):   anticlockwise when seen from above
 * The scenarios were all designed with clockwise orbits.
 */
const CLOCKWISE = { x: 0, y: 0, z: -1 };
const ANTICLOCKWISE = { x: 0, y: 0, z: 1 };

/*
 * Velocity for a circular orbit around `attractor`, for a body at `point`.
 * Circular motion needs  v^2 / r = gravity, so v = sqrt(G (M + m) / r).
 * (The extra factors account for softening so the orbit is truly circular.)
 * The direction is sideways to both the line joining the two bodies and the
 * orbit's axis: the "cross product"  axis x (point - attractor).
 */
function circularVelocity(point, mass, attractor, axis = CLOCKWISE) {
    const dx = point.x - attractor.x;
    const dy = point.y - attractor.y;
    const dz = point.z - attractor.z;
    const r = Math.hypot(dx, dy, dz);

    if (r < 1e-6) return { vx: attractor.vx, vy: attractor.vy, vz: attractor.vz };

    const totalMass = attractor.mass + mass;
    const speed = Math.sqrt(
        G * totalMass * r * r / Math.pow(r * r + softening * softening, 1.5)
    );

    let sx = axis.y * dz - axis.z * dy;
    let sy = axis.z * dx - axis.x * dz;
    let sz = axis.x * dy - axis.y * dx;
    let length = Math.hypot(sx, sy, sz);
    if (length < 1e-9) {
        // Straight above or below the attractor: any sideways direction works
        sx = 1; sy = 0; sz = 0; length = 1;
    }

    return {
        vx: attractor.vx + speed * sx / length,
        vy: attractor.vy + speed * sy / length,
        vz: attractor.vz + speed * sz / length
    };
}

// The body `body` is compared with: the one picked in the menu, or else
// whichever pulls on it hardest
function referenceBody(body) {
    if (referenceId !== null && referenceId !== body.id) {
        const chosen = bodies.find(b => b.id === referenceId);
        if (chosen) return chosen;
    }
    if (body.type === "moon") {
        const planet = placementAttractor(body, "moon", body.mass, body);
        if (planet) return planet;
    }
    return dominantAttractor(body.x, body.y, body.z, body);
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
 *   angular momentum       h = r x v
 *     points along the orbit's axis, so the orbit lies flat in the plane
 *     perpendicular to it (it's conserved, so the plane never changes).
 *
 * r and v are measured relative to `other`. This uses plain r, not the
 * softened r^2 + eps^2, because that's the textbook formula; far from the
 * other body (r much bigger than eps) the difference is tiny.
 */
function orbitAround(body, other) {
    const mu = G * (body.mass + other.mass);
    const rx = body.x - other.x;
    const ry = body.y - other.y;
    const rz = body.z - other.z;
    const vx = body.vx - other.vx;
    const vy = body.vy - other.vy;
    const vz = body.vz - other.vz;
    const r = Math.hypot(rx, ry, rz);
    const v = Math.hypot(vx, vy, vz);

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
        const rDotV = rx * vx + ry * vy + rz * vz;
        orbit.ex = ((v * v - mu / r) * rx - rDotV * vx) / mu;
        orbit.ey = ((v * v - mu / r) * ry - rDotV * vy) / mu;
        orbit.ez = ((v * v - mu / r) * rz - rDotV * vz) / mu;
        orbit.e = Math.hypot(orbit.ex, orbit.ey, orbit.ez);
        orbit.hx = ry * vz - rz * vy;
        orbit.hy = rz * vx - rx * vz;
        orbit.hz = rx * vy - ry * vx;
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
        x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz,
        ax: 0, ay: 0, az: 0, mass: b.mass, radius: b.radius, collisionless: b.collisionless
    }));

    const probe = {
        x: start.x, y: start.y, z: start.z,
        vx: velocity.vx, vy: velocity.vy, vz: velocity.vz,
        ax: 0, ay: 0, az: 0, mass: preset.mass, radius: preset.radius
    };
    sim.push(probe);

    const n = sim.length;
    const steps = Math.max(200, Math.min(1500, Math.floor(600000 / (n * n))));
    const points = [{ x: probe.x, y: probe.y, z: probe.z }];
    let hit = null;

    computeForces(sim);

    for (let s = 0; s < steps && !hit; s++) {
        if (integrator === "verlet") {
            stepVerlet(sim, timeStep);
        } else {
            stepEuler(sim, timeStep);
            computeForces(sim);
        }

        if (s % 3 === 0) points.push({ x: probe.x, y: probe.y, z: probe.z });

        if (options.merge) {
            for (let k = 0; k < n - 1; k++) {
                const o = sim[k];
                if (o.collisionless) continue;
                const dx = o.x - probe.x;
                const dy = o.y - probe.y;
                const dz = o.z - probe.z;
                const touch = o.radius + probe.radius;
                if (dx * dx + dy * dy + dz * dz < touch * touch) {
                    hit = { x: probe.x, y: probe.y, z: probe.z };
                    break;
                }
            }
        }
    }

    points.push({ x: probe.x, y: probe.y, z: probe.z });
    return { points, hit };
}

/*
 * Preview for big systems: simulating thousands of bodies hundreds of steps
 * ahead every frame would freeze the page. Instead, freeze everything where
 * it is, build one Barnes-Hut tree, and fly only the new body through it.
 * Good for short previews; less accurate the further ahead it looks.
 */
function predictPathFrozen(start, velocity) {
    ensureTree();

    const preset = BODY_TYPES[brush];
    const theta2 = 0.8 * 0.8;
    const eps2 = softening * softening;
    const obstacles = bodies.filter(b => b.radius >= 2 && !b.collisionless);

    let x = start.x, y = start.y, z = start.z;
    let vx = velocity.vx, vy = velocity.vy, vz = velocity.vz;
    walkTree(x, y, z, -1, theta2, eps2);
    let ax = walkAx, ay = walkAy, az = walkAz;

    const points = [{ x, y, z }];
    let hit = null;

    for (let s = 0; s < 600 && !hit; s++) {
        vx += ax * timeStep / 2;
        vy += ay * timeStep / 2;
        vz += az * timeStep / 2;
        x += vx * timeStep;
        y += vy * timeStep;
        z += vz * timeStep;
        walkTree(x, y, z, -1, theta2, eps2);
        ax = walkAx;
        ay = walkAy;
        az = walkAz;
        vx += ax * timeStep / 2;
        vy += ay * timeStep / 2;
        vz += az * timeStep / 2;

        if (s % 3 === 0) points.push({ x, y, z });

        if (options.merge) {
            for (const o of obstacles) {
                const dx = o.x - x;
                const dy = o.y - y;
                const dz = o.z - z;
                const touch = o.radius + preset.radius;
                if (dx * dx + dy * dy + dz * dz < touch * touch) {
                    hit = { x, y, z };
                    break;
                }
            }
        }
    }

    points.push({ x, y, z });
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

// Turn the vector (x, y, z) around the x axis by `angle` radians
function rotateAroundX(v, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c };
}

// Turn the vector (x, y, z) around the z axis (spinning it flat) by `angle` radians
function rotateAroundZ(v, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}

/*
 * Place a body on a circular orbit around `attractor`, `distance` away and
 * `angleDegrees` of the way round. `tiltDegrees` tips the orbit out of the
 * flat x-y plane, like the small tilts of the real planets' orbits. It tips
 * around a line through the attractor (the "line of nodes", where the orbit
 * crosses the flat plane), which points `nodeDegrees` round from the x axis.
 */
function addOrbiting(type, attractor, distance, angleDegrees, props = {}, tiltDegrees = 0, nodeDegrees = 0) {
    const angle = (angleDegrees - nodeDegrees) * Math.PI / 180;
    const tilt = tiltDegrees * Math.PI / 180;
    const node = nodeDegrees * Math.PI / 180;
    const flat = { x: distance * Math.cos(angle), y: distance * Math.sin(angle), z: 0 };
    const offset = rotateAroundZ(rotateAroundX(flat, tilt), node);
    const axis = rotateAroundZ(rotateAroundX(CLOCKWISE, tilt), node);
    const point = { x: attractor.x + offset.x, y: attractor.y + offset.y, z: attractor.z + offset.z };
    const mass = props.mass ?? BODY_TYPES[type].mass;
    const v = circularVelocity(point, mass, attractor, axis);

    return addBody({ type, ...point, vx: v.vx, vy: v.vy, vz: v.vz, ...props });
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
 * spin = 1 for anticlockwise seen from above, -1 for clockwise.
 * tilt (radians) tips the disk out of the x-y plane, around the x axis.
 */
function makeGalaxy({ name, x, y, vx, vy, spin, tilt, colors, blackHoleMass, starsPerGalaxy, random }) {
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

        // A little random motion (2%), like real stars, and a little
        // thickness: real disks are thin, but not perfectly flat
        const wobble = () => (random() - 0.5) * 0.04 * circular;
        const offset = rotateAroundX({ x: dx, y: dy, z: (random() - 0.5) * 0.04 * r }, tilt);
        const motion = rotateAroundX({
            x: -spin * circular * dy / r + wobble(),
            y: spin * circular * dx / r + wobble(),
            z: wobble()
        }, tilt);

        addBody({
            type: "galaxyStar",
            name: name + " star " + (i + 1),
            x: x + offset.x,
            y: y + offset.y,
            z: offset.z,
            vx: vx + motion.x,
            vy: vy + motion.y,
            vz: motion.z,
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
            // Orbits tilted by a few degrees, like the real planets' (Mercury: 7)
            const sun = addBody({ type: "star", name: "Sol", x: 0, y: 0 });
            addOrbiting("planet", sun, 70, 20, { name: "Cinder", mass: 3, radius: 5, color: "#fb923c" }, 7);
            addOrbiting("planet", sun, 110, 140, { name: "Rosa", mass: 6, radius: 7, color: "#f472b6" }, -3);
            addOrbiting("planet", sun, 155, 250, { name: "Azure", mass: 8, radius: 8, color: "#38bdf8" }, 1);
            addOrbiting("planet", sun, 215, 60, { name: "Frost", mass: 12, radius: 9, color: "#a5f3fc" }, -5);
            const giant = addOrbiting("planet", sun, 360, 330, { name: "Goliath", mass: 150, radius: 12, color: "#e7c59a" }, 4);
            addOrbiting("moon", giant, 22, 0, { name: "Pebble", mass: 0.5, radius: 3 }, 25);
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
            const pair = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, mass: 2 * each };
            addOrbiting("planet", pair, 450, 200, { name: "Duo", color: "#34d399" }, 8);
            addOrbiting("planet", pair, 600, 30, { name: "Far Duo", color: "#a78bfa" }, -12);
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

            const probeStart = { x: 110, y: 0, z: 0 };
            const circular = circularVelocity(probeStart, 0.01, sun);
            addBody({
                type: "moon", name: "Probe", ...probeStart,
                vx: circular.vx * 1.25, vy: circular.vy * 1.25, vz: 0,
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
            const tilts = seededRandom(8);   // separate, so the disk is the same as in 2D

            for (let i = 0; i < 40; i++) {
                const distance = 110 + random() * 190;
                addOrbiting("moon", hole, distance, random() * 360, {
                    name: "Moon " + (i + 1),
                    mass: 1,
                    radius: 3,
                    color: PLANET_COLORS[i % PLANET_COLORS.length]
                }, (tilts() - 0.5) * 8, tilts() * 360);
            }

            // Intruder star starts at the far point of an ellipse
            // whose closest approach skims the edge of the disk. Its orbit
            // is tilted 30 degrees, so it swoops through from above.
            const starMass = 8000;
            const start = 1000;
            const closest = 330;
            const semiMajor = (start + closest) / 2;
            const speed = Math.sqrt(G * (hole.mass + starMass) * (2 / start - 1 / semiMajor));
            const velocity = rotateAroundX({ x: 0, y: speed, z: 0 }, 30 * Math.PI / 180);
            addBody({
                type: "star", name: "Intruder", x: -start, y: 0,
                vx: velocity.x, vy: velocity.y, vz: velocity.z,
                mass: starMass, radius: 20, color: "#fca5a5"
            });
        }
    },

    cluster: {
        fit: 380,
        note: "Forty random planets in a slowly spinning ball. Gravity pulls them together, they collide and merge, and the survivors settle into orbits around the biggest. Rotate the view: the ball flattens as it spins.",
        build() {
            for (let i = 0; i < 40; i++) {
                // A random direction (an even spread over a sphere), and a
                // distance spread evenly through the ball's volume
                const z = Math.random() * 2 - 1;
                const angle = Math.random() * Math.PI * 2;
                const flat = Math.sqrt(1 - z * z);
                const distance = 40 + Math.cbrt(Math.random()) * 240;
                const x = distance * flat * Math.cos(angle);
                const y = distance * flat * Math.sin(angle);
                const mass = 20 + Math.random() * 180;

                addBody({
                    type: "planet", x, y, z: distance * z,
                    vx: y * 0.012 + (Math.random() - 0.5) * 0.6,
                    vy: -x * 0.012 + (Math.random() - 0.5) * 0.6,
                    vz: (Math.random() - 0.5) * 0.6,
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
            const heights = seededRandom(4);   // separate, so the disk is the same as in 2D
            const rockColors = ["#a8a29e", "#d6d3d1", "#c2410c", "#a16207", "#78716c"];

            for (let i = 0; i < 1500; i++) {
                // More rocks further out, since there's more room there
                const distance = 70 + Math.sqrt(random()) * 260;
                const angle = random() * Math.PI * 2;
                const x = distance * Math.cos(angle);
                const y = distance * Math.sin(angle);
                // A thin disk: rocks bob up to 1.5 above and below the middle
                const z = (heights() - 0.5) * 3;

                // Nearly circular orbits, with a 3% random wobble so orbits cross
                const v = circularVelocity({ x, y, z }, 0.1, sun);
                const speed = Math.hypot(v.vx, v.vy);
                addBody({
                    type: "rock",
                    name: "Rock " + (i + 1),
                    x, y, z,
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
        note: "Two spiral galaxies, each a black hole with 1,500 stars, swing past each other. The blue one spins the same way it's moving (prograde) and gets pulled into long tidal tails; the gold one spins the other way (retrograde) and stays mostly intact, as Toomre & Toomre showed in 1972. They're bound together, so they fall back through each other. The disks are tilted differently, as in real collisions: rotate the view to see the tails in 3D. Scroll out to follow them.",
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
                tilt: 0.25,
                colors: ["#93c5fd", "#e0f2fe", "#a5b4fc"],
                blackHoleMass, starsPerGalaxy, random
            });
            makeGalaxy({
                name: "Gold Galaxy",
                x: relPos.x / 2, y: relPos.y / 2,
                vx: relVel.x / 2, vy: relVel.y / 2,
                spin: -1,  // opposite direction: retrograde
                tilt: -0.9,
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
            const tilts = seededRandom(6);   // separate, so the belt is the same as in 2D
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
                }, (tilts() - 0.5) * 14, tilts() * 360);  // tilted up to 7 degrees (real ones: mostly under ~20)
            }

            // A comet's path can cross the planets', so it might hit one.
            // These starting angles were picked by testing so it lasts many laps.
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
            // Comets' orbits are often steeply tilted (Halley's: 162 degrees)
            const velocity = rotateAroundX({ x: 0, y: speed, z: 0 }, 25 * Math.PI / 180);
            addBody({
                type: "comet", name: "Comet Halley", x: -farthest, y: 0,
                vx: velocity.x, vy: velocity.y, vz: velocity.z
            });
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
    resetViewAngle();
    fitView(scenario.fit);

    running = true;
    updatePlayButton();
    refreshBodyList();
    updateProperties();

    showScenarioInfo(name);
    // Show the description each time a scenario starts (it can be closed again)
    setPanelOpen(document.getElementById("scenarioPanel"), true);
}

// The scenario's name and description, in the menu and the Scenario panel
function showScenarioInfo(name) {
    const select = document.getElementById("scenarioSelect");
    select.value = name;
    document.getElementById("scenarioName").textContent = select.selectedOptions[0].textContent;
    document.getElementById("scenarioNote").textContent = (SCENARIOS[name] || SCENARIOS.solar).note;
}


/* ==========================================================================
   4. CAMERA
   ========================================================================== */

/*
 * The 3D view is drawn with Three.js (see lib/three.min.js, MIT licence).
 * Our own code decides what goes where; Three.js turns that into triangles
 * and pixels on the graphics card (WebGL).
 *
 * The camera circles around the point it looks at (camera.x, y, z) like a
 * satellite: `distance` away, turned `yaw` around the vertical z axis, and
 * raised `pitch` above the flat x-y plane (90 degrees = looking straight down).
 */
const FOV = 45;                              // how wide the camera sees, top to bottom, in degrees
const DEFAULT_YAW = -Math.PI / 2;
const DEFAULT_PITCH = 55 * Math.PI / 180;
const MAX_PITCH = 89.5 * Math.PI / 180;      // exactly 90 would make "up" on screen undefined
const MIN_DISTANCE = 10;
const MAX_DISTANCE = 60000;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setClearColor(0x030305);
const scene = new THREE.Scene();
const view = new THREE.PerspectiveCamera(FOV, 1, 1, 1e6);
view.up.set(0, 0, 1); // z is up
const projectScreen = new THREE.Matrix4(); // turns world positions into screen positions

function resizeCanvas() {
    pixelRatio = window.devicePixelRatio || 1;
    viewWidth = canvas.clientWidth;
    viewHeight = canvas.clientHeight;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(viewWidth, viewHeight, false);
    view.aspect = viewWidth / Math.max(1, viewHeight);
    overlay.width = Math.round(viewWidth * pixelRatio);
    overlay.height = Math.round(viewHeight * pixelRatio);
}

function resizeEnergyChart() {
    energyCanvas.width = Math.round(energyCanvas.clientWidth * pixelRatio);
    energyCanvas.height = Math.round(energyCanvas.clientHeight * pixelRatio);
}

// Put the Three.js camera where our camera settings say
function updateView() {
    const flat = Math.cos(camera.pitch);
    view.position.set(
        camera.x + camera.distance * flat * Math.cos(camera.yaw),
        camera.y + camera.distance * flat * Math.sin(camera.yaw),
        camera.z + camera.distance * Math.sin(camera.pitch)
    );
    view.lookAt(camera.x, camera.y, camera.z);
    // Only things between `near` and `far` get drawn
    view.near = camera.distance / 200;
    view.far = camera.distance * 200 + 20000;
    view.updateProjectionMatrix();
    view.updateMatrixWorld();
    projectScreen.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
}

/*
 * Where a point appears on screen, in pixels. `scale` is how many pixels one
 * unit of length covers at that distance (far things look smaller).
 * Returns null for points behind the camera.
 */
function project(x, y, z) {
    const e = projectScreen.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15]; // distance in front of the camera
    if (w <= 1e-6) return null;
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    return {
        x: (cx / w + 1) / 2 * viewWidth,
        y: (1 - cy / w) / 2 * viewHeight,
        scale: view.projectionMatrix.elements[5] * viewHeight / 2 / w
    };
}

/*
 * The opposite: which point of a plane is under the pixel (sx, sy)?
 * Follows the ray from the camera through that pixel until it hits the plane
 * through `point` at right angles to `normal`. null if it never does (the
 * plane is behind the camera, or the ray runs along it).
 */
function screenToPlane(sx, sy, point, normal) {
    const ray = new THREE.Vector3(sx / viewWidth * 2 - 1, 1 - sy / viewHeight * 2, 0.5);
    ray.unproject(view).sub(view.position).normalize();
    const eye = view.position;
    const along = ray.x * normal.x + ray.y * normal.y + ray.z * normal.z;
    if (Math.abs(along) < 1e-6) return null;
    const t = ((point.x - eye.x) * normal.x + (point.y - eye.y) * normal.y + (point.z - eye.z) * normal.z) / along;
    if (t <= 0 || t > view.far) return null;
    return {
        x: eye.x + ray.x * t,
        y: eye.y + ray.y * t,
        // On a flat plane, use its height exactly (not with a rounding error)
        z: normal === UP ? point.z : eye.z + ray.z * t
    };
}

/*
 * THE WORKING PLANE
 * A flat plane through the point the camera looks at. New bodies are placed
 * on it, the grid and the gravity field are drawn on it, and the Move tool
 * slides bodies parallel to it. Moving the view up or down (Q / Z), Fit View
 * or following a body changes its height.
 * Seen almost edge-on, a click would land very far away (or nowhere), so then
 * an upright plane facing the camera is used instead.
 */
const UP = { x: 0, y: 0, z: 1 };
const EDGE_ON = Math.sin(10 * Math.PI / 180); // closer than 10 degrees to edge-on

function cameraFocus() {
    return { x: camera.x, y: camera.y, z: camera.z };
}

function workingNormal() {
    if (Math.abs(Math.sin(camera.pitch)) > EDGE_ON) return UP;
    const flat = Math.cos(camera.pitch);
    return { x: flat * Math.cos(camera.yaw), y: flat * Math.sin(camera.yaw), z: Math.sin(camera.pitch) };
}

// Length of one screen pixel, measured at the point the camera looks at
function worldPerPixel() {
    return 2 * camera.distance * Math.tan(FOV * Math.PI / 360) / Math.max(1, viewHeight);
}

// Dragging sideways spins the view around the vertical axis; up and down tips it
function rotateView(dx, dy) {
    camera.yaw -= dx * 0.006;
    camera.pitch = clamp(camera.pitch + dy * 0.006, -MAX_PITCH, MAX_PITCH);
}

/*
 * Move the point the camera looks at: `side` to the right (as seen on
 * screen), `ahead` away from the camera along the flat plane, and `lift` up.
 *   right, along the plane = (-sin yaw, cos yaw)
 *   ahead, along the plane = (-cos yaw, -sin yaw)   (the camera sits at +cos, +sin)
 */
function moveView(side, ahead, lift) {
    camera.x += -side * Math.sin(camera.yaw) - ahead * Math.cos(camera.yaw);
    camera.y += side * Math.cos(camera.yaw) - ahead * Math.sin(camera.yaw);
    camera.z += lift;
}

// Slide the view along the plane like dragging a map: the scene follows the
// mouse. Seen at a slant the plane looks squashed top to bottom, so up and
// down drags move further (but not wildly far when nearly edge-on).
function slideView(dx, dy) {
    const step = worldPerPixel();
    const slant = Math.sin(camera.pitch);
    const squash = (slant < 0 ? -1 : 1) * Math.max(Math.abs(slant), 0.3);
    moveView(-dx * step, dy * step / squash, 0);
}

/*
 * Moving the view by holding down a key (W A S D, Q / Z) or a button on the
 * canvas. `held` holds the moves in progress, and moveHeld() carries them out
 * every frame, so the speed doesn't depend on the keyboard's repeat rate.
 */
const held = new Set();

function moveHeld(elapsed) {
    if (held.size === 0) return;
    const seconds = elapsed / 1000;
    const amount = (plus, minus) => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);

    const side = amount("right", "left");
    const ahead = amount("forward", "back");
    const lift = amount("up", "down");
    if (side || ahead || lift) {
        // Moving the view by hand stops it following anything
        if (camera.follow !== "free") setCameraFollow("free");
        const step = camera.distance * 0.8 * seconds; // crosses the view in about 1.5 seconds
        moveView(side * step, ahead * step, lift * step);
    }
    camera.yaw += amount("turnLeft", "turnRight") * 1.2 * seconds;
    zoomView(amount("zoomOut", "zoomIn") * 1.2 * seconds);
}

function zoomView(amount) {
    camera.distance = clamp(camera.distance * Math.exp(amount), MIN_DISTANCE, MAX_DISTANCE);
}

function resetViewAngle() {
    camera.yaw = DEFAULT_YAW;
    camera.pitch = DEFAULT_PITCH;
}

// Straight down from above, like the old 2D view
function topView() {
    camera.yaw = DEFAULT_YAW;
    camera.pitch = MAX_PITCH;
}

function fitView(radius) {
    const center = centerOfMass();
    camera.x = center.x;
    camera.y = center.y;
    camera.z = center.z;

    let r = radius;
    if (!r) {
        // Fit 97% of the bodies, so a few that escaped far away don't
        // force the view to zoom all the way out
        const distances = bodies
            .map(b => Math.hypot(b.x - center.x, b.y - center.y, b.z - center.z) + b.radius)
            .sort((a, b) => a - b);
        const index = Math.min(distances.length - 1, Math.floor(distances.length * 0.97));
        r = distances.length > 20 ? distances[index] : (distances[distances.length - 1] || 0);
        r = Math.max(r * 1.15, 300);
    }

    // Far enough back that a ball of radius r fits across the narrower side
    // of the screen: the ball's edge is at angle `halfNarrow` from the centre
    // of view, so  sin(halfNarrow) = r / distance
    const halfHeight = Math.tan(FOV * Math.PI / 360);
    const halfNarrow = Math.atan(Math.min(halfHeight, halfHeight * viewWidth / Math.max(1, viewHeight)) || halfHeight);
    camera.distance = clamp(r / Math.sin(halfNarrow), MIN_DISTANCE, MAX_DISTANCE);
}

function updateCameraFollow() {
    let target = null;
    if (camera.follow === "com" && bodies.length > 0) {
        target = centerOfMass();
    } else if (camera.follow === "selected" && selectedBody) {
        target = selectedBody;
    } else if (camera.follow === "body") {
        // The followed body was deleted: stop following
        if (!camera.followed || !bodies.includes(camera.followed)) {
            setCameraFollow("free");
            return;
        }
        target = camera.followed;
    }
    if (target) {
        camera.x = target.x;
        camera.y = target.y;
        camera.z = target.z;
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
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

// The same colour as three numbers from 0 to 1, for the graphics card
const colorCache = new Map();
function rgbFloats(hex) {
    let rgb = colorCache.get(hex);
    if (!rgb) {
        rgb = hexToRgb(hex).map(c => c / 255);
        colorCache.set(hex, rgb);
    }
    return rgb;
}

// Black holes are drawn black, but their trails and flashes are orange
function visibleColor(hex) {
    return hex === "#111111" ? "#f97316" : hex;
}

// ---------- Textures (small pictures painted on a canvas) ----------

function makeTexture(size, paint) {
    const picture = document.createElement("canvas");
    picture.width = picture.height = size;
    paint(picture.getContext("2d"), size);
    return new THREE.CanvasTexture(picture);
}

// A soft round glow: white in the middle, fading to nothing
const glowTexture = makeTexture(128, (g, s) => {
    const fade = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    fade.addColorStop(0, "rgba(255,255,255,1)");
    fade.addColorStop(0.2, "rgba(255,255,255,0.55)");
    fade.addColorStop(0.5, "rgba(255,255,255,0.15)");
    fade.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = fade;
    g.fillRect(0, 0, s, s);
});

// A black hole's accretion disk: white-hot at the inner edge, cooling to orange
const diskTexture = makeTexture(256, (g, s) => {
    const fade = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    fade.addColorStop(0.3, "rgba(255,244,214,1)");
    fade.addColorStop(0.42, "rgba(253,186,116,0.9)");
    fade.addColorStop(0.65, "rgba(249,115,22,0.35)");
    fade.addColorStop(1, "rgba(249,115,22,0)");
    g.fillStyle = fade;
    g.fillRect(0, 0, s, s);
});

// Bright at the top, fading to nothing at the bottom (comet tails, pulsar beams)
const fadeTexture = makeTexture(64, (g, s) => {
    const fade = g.createLinearGradient(0, 0, 0, s);
    fade.addColorStop(0, "rgba(255,255,255,0.9)");
    fade.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = fade;
    g.fillRect(0, 0, s, s);
});

// ---------- Shapes, shared by every body (each body scales them to its size) ----------

const sphereGeometry = new THREE.SphereGeometry(1, 32, 20);
const ringGeometry = new THREE.RingGeometry(1.15, 3.6, 96, 1);
// A cone with its tip at the centre, opening out along -y (tails and beams)
const coneGeometry = new THREE.ConeGeometry(1, 1, 24, 1, true).translate(0, -0.5, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/*
 * Lumpy asteroid shapes: a ball with bumps. Each bump depends only on the
 * direction from the centre, so corners shared by neighbouring triangles
 * move together and the surface has no cracks. Six shapes are enough;
 * each asteroid also gets its own spin, so they don't look alike.
 */
const asteroidShapes = [];
for (let k = 0; k < 6; k++) {
    const random = seededRandom(100 + k);
    const phase = [random() * 6, random() * 6, random() * 6, random() * 6];
    const shape = new THREE.IcosahedronGeometry(1, 2);
    const p = shape.attributes.position;
    for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const bump = 0.82 +
            0.12 * Math.sin(3 * x + phase[0]) * Math.sin(2 * y + phase[1]) +
            0.1 * Math.sin(4 * z + phase[2]) +
            0.06 * Math.sin(5 * (x + y) + phase[3]);
        p.setXYZ(i, x * bump * 1.2, y * bump, z * bump * 0.85);
    }
    shape.computeVertexNormals();
    asteroidShapes.push(shape);
}

// ---------- Background stars ----------

// Points on a huge sphere that moves with the camera, so they never get closer
const starfield = (() => {
    const random = seededRandom(42);
    const count = 1800;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const z = random() * 2 - 1;
        const angle = random() * Math.PI * 2;
        const flat = Math.sqrt(1 - z * z);
        positions.set([flat * Math.cos(angle), flat * Math.sin(angle), z], i * 3);
        const tint = random();
        const rgb = tint < 0.15 ? [0.75, 0.86, 1] : tint < 0.25 ? [1, 0.94, 0.54] : [1, 1, 1];
        const brightness = 0.25 + random() * 0.6;
        colors.set(rgb.map(c => c * brightness), i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({
        size: 1.4, sizeAttenuation: false, vertexColors: true, depthWrite: false
    }));
    points.frustumCulled = false;
    points.renderOrder = -1;
    scene.add(points);
    return points;
})();

// ---------- Lights ----------

// Stars light up the planets around them. Lights are slow to add and remove,
// so there's a fixed set of four, given to the four heaviest stars.
scene.add(new THREE.AmbientLight(0xffffff, 0.16));
const fillLight = new THREE.DirectionalLight(0xffffff, 0); // for systems with no stars
fillLight.position.set(-1, -1, 2);
scene.add(fillLight);
const starLights = [];
for (let i = 0; i < 4; i++) {
    const light = new THREE.PointLight(0xffffff, 0, 0, 0); // reaches forever
    scene.add(light);
    starLights.push(light);
}
const WHITE3 = new THREE.Color(1, 1, 1);

// The stars, collected once per frame in render()
let lightSources = [];

function updateLights() {
    const brightest = lightSources.slice().sort((a, b) => b.mass - a.mass).slice(0, starLights.length);
    starLights.forEach((light, i) => {
        const star = brightest[i];
        light.intensity = star ? 1.4 : 0;
        if (star) {
            light.position.set(star.x, star.y, star.z);
            light.color.set(star.color).lerp(WHITE3, 0.6);
        }
    });
    fillLight.intensity = brightest.length ? 0.06 : 0.75;
}

// The star that shines brightest on `body` (null if there are no stars)
function brightestStar(body) {
    let best = null;
    let bestValue = 0;

    for (const b of lightSources) {
        if (b === body) continue;
        const d2 = (b.x - body.x) ** 2 + (b.y - body.y) ** 2 + (b.z - body.z) ** 2 + 1;
        const value = b.mass / d2;
        if (value > bestValue) {
            bestValue = value;
            best = b;
        }
    }
    return best;
}

// ---------- Bodies ----------

/*
 * Galaxy stars and small rocks come in thousands, so they're drawn as
 * "points" (one dot each, all in a single draw call) instead of 3D balls.
 */
function isDot(b) {
    return b.type === "galaxyStar" || (b.type === "rock" && b.radius < 3);
}

// body -> its 3D object. (Not keyed by id: ids start again from 1 when a
// scenario loads, and a new body must never pick up an old body's look.)
const visuals = new Map();

function glowSprite(color, size, opacity) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture, color, opacity, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false
    }));
    sprite.scale.setScalar(size); // in body radii (the whole body is scaled to its radius)
    return sprite;
}

function fadingCone(color, opacity) {
    return new THREE.Mesh(coneGeometry, new THREE.MeshBasicMaterial({
        map: fadeTexture, color, opacity, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
    }));
}

// Build the 3D object for a body. It's a group of parts, scaled to the body's radius.
function makeVisual(b) {
    const group = new THREE.Group();
    const color = new THREE.Color(b.color);

    if (b.type === "star") {
        group.add(new THREE.Mesh(sphereGeometry, new THREE.MeshBasicMaterial({ color: color.clone().lerp(WHITE3, 0.35) })));
        group.add(glowSprite(b.color, 7, 0.9));

    } else if (b.type === "blackhole") {
        // Black ball, a flat glowing disk of gas spiralling in, and a faint glow
        group.add(new THREE.Mesh(sphereGeometry, new THREE.MeshBasicMaterial({ color: 0x000000 })));
        group.add(new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({
            map: diskTexture, transparent: true, blending: THREE.AdditiveBlending,
            depthWrite: false, side: THREE.DoubleSide
        })));
        group.add(glowSprite("#f97316", 6, 0.3));

    } else if (b.type === "neutronstar") {
        // A tiny hot ball with two beams, sweeping round like a lighthouse (a pulsar)
        group.add(new THREE.Mesh(sphereGeometry, new THREE.MeshBasicMaterial({ color: 0xf5f3ff })));
        group.add(glowSprite(b.color, 6, 0.8));
        const beams = new THREE.Group();
        beams.name = "beams";
        beams.rotation.order = "ZXY"; // tilt first, then spin around z
        for (const side of [1, -1]) {
            const beam = fadingCone("#ede9fe", 0.6);
            beam.rotation.x = -side * Math.PI / 2; // point it along +z or -z
            beam.scale.set(1.1, 10, 1.1);
            beams.add(beam);
        }
        group.add(beams);

    } else if (b.type === "comet") {
        // An icy core in a glowing cloud (the coma), and two tails
        group.add(new THREE.Mesh(sphereGeometry, new THREE.MeshStandardMaterial({ color: 0xe0f2fe, roughness: 0.6 })));
        group.add(glowSprite(b.color, 5, 0.9));
        const dust = fadingCone("#fde68a", 0.55);
        dust.name = "dustTail";
        const ion = fadingCone("#7dd3fc", 0.8);
        ion.name = "ionTail";
        group.add(dust, ion);

    } else if (b.type === "asteroid") {
        group.add(new THREE.Mesh(asteroidShapes[b.id % asteroidShapes.length],
            new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true })));
        const random = seededRandom(b.id);
        group.userData.tumble = [random() - 0.5, random() - 0.5, random() - 0.5];

    } else {
        // Planets, moons and big rocks: lit by the stars. A little "emissive"
        // light of their own stops the night side being pure black.
        group.add(new THREE.Mesh(sphereGeometry, new THREE.MeshStandardMaterial({
            color, roughness: 0.85, metalness: 0, emissive: color.clone().multiplyScalar(0.07)
        })));
    }

    scene.add(group);
    return group;
}

function removeVisual(object) {
    scene.remove(object);
    // Free the materials (shapes and textures are shared, so they stay)
    object.traverse(part => {
        if (part.material) part.material.dispose();
    });
}

/*
 * A comet's tails point AWAY from the star, not behind the comet:
 * starlight and the stellar wind push its gas and dust outward.
 * The closer (hotter) the comet, the more ice boils off: longer tails.
 *   - Gas (ion) tail: blue, straight away from the star
 *   - Dust tail: yellowish, bends back along the path a little, because
 *     heavier dust is pushed less and lags behind
 * Far from any star the comet is frozen and has no tail.
 */
function updateCometTails(b, group) {
    const ion = group.getObjectByName("ionTail");
    const dust = group.getObjectByName("dustTail");
    const star = brightestStar(b);
    const away = star ? new THREE.Vector3(b.x - star.x, b.y - star.y, b.z - star.z) : null;
    const distance = away ? away.length() : 0;
    const length = star ? Math.min(260, 6000 * (star.mass / 10000) / Math.max(distance, 1)) : 0;

    ion.visible = dust.visible = length > b.radius;
    if (!ion.visible) return;

    away.divideScalar(distance);
    const motion = new THREE.Vector3(b.vx - star.vx, b.vy - star.vy, b.vz - star.vz);
    const behind = away.clone().addScaledVector(motion.normalize(), -0.5).normalize();

    // Sizes are in comet radii, because the whole group is scaled to the radius
    const r = b.radius;
    ion.quaternion.setFromUnitVectors(DOWN, away);
    ion.scale.set(Math.max(0.7 * r, length * 0.06) / r, length / r, Math.max(0.7 * r, length * 0.06) / r);
    dust.quaternion.setFromUnitVectors(DOWN, behind);
    dust.scale.set(Math.max(r, length * 0.12) / r, length * 0.8 / r, Math.max(r, length * 0.12) / r);
}

function updateBodies() {
    const seen = new Set();

    for (const b of bodies) {
        if (isDot(b)) continue;
        seen.add(b);

        let group = visuals.get(b);
        if (!group) {
            group = makeVisual(b);
            visuals.set(b, group);
        }
        group.position.set(b.x, b.y, b.z);
        group.scale.setScalar(b.radius);

        if (b.type === "asteroid") {
            const t = group.userData.tumble;
            group.rotation.set(simTime * t[0] * 0.1, simTime * t[1] * 0.1, simTime * t[2] * 0.1);
        } else if (b.type === "neutronstar") {
            group.getObjectByName("beams").rotation.set(0.5, 0, simTime * 0.7 + b.id);
        } else if (b.type === "comet") {
            updateCometTails(b, group);
        }
    }

    for (const [b, group] of visuals) {
        if (!seen.has(b)) {
            removeVisual(group);
            visuals.delete(b);
        }
    }
}

// ---------- Dots (galaxy stars and rocks) ----------

/*
 * A tiny program for the graphics card that draws each dot as a round spot.
 * Its size shrinks with distance like a real ball would, but never below a
 * pixel or two, so faraway stars stay visible.
 */
const dotVertexShader = `
    attribute float size;
    attribute vec3 tint;
    uniform float pixelScale;
    uniform float minSize;
    varying vec3 vTint;
    void main() {
        vTint = tint;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(minSize, size * pixelScale / -viewPosition.z);
        gl_Position = projectionMatrix * viewPosition;
    }
`;
const dotFragmentShader = `
    uniform float glow;
    varying vec3 vTint;
    void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float d = dot(p, p);
        if (d > 1.0) discard;
        float alpha = glow > 0.5 ? 1.0 - d * d : smoothstep(1.0, 0.6, d);
        gl_FragColor = vec4(vTint * (1.0 - 0.3 * d * (1.0 - glow)), alpha);
    }
`;

function makeDotLayer(glow) {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.ShaderMaterial({
        uniforms: {
            pixelScale: { value: 1 },
            minSize: { value: 1.5 },
            glow: { value: glow ? 1 : 0 }
        },
        vertexShader: dotVertexShader,
        fragmentShader: dotFragmentShader,
        transparent: true,
        // Glowing dots add their light together where they overlap, so the
        // crowded centre of a galaxy shines brighter, like real photos
        blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite: !glow
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.userData.capacity = 0;
    scene.add(points);
    return points;
}

const glowDots = makeDotLayer(true);
const plainDots = makeDotLayer(false);

function fillDots(points, list) {
    const geometry = points.geometry;
    if (points.userData.capacity === 0 || points.userData.capacity < list.length) {
        const capacity = Math.max(64, list.length * 2);
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
        geometry.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
        geometry.setAttribute("size", new THREE.BufferAttribute(new Float32Array(capacity), 1));
        points.userData.capacity = capacity;
    }
    const position = geometry.attributes.position.array;
    const tint = geometry.attributes.tint.array;
    const size = geometry.attributes.size.array;

    list.forEach((b, i) => {
        position[i * 3] = b.x;
        position[i * 3 + 1] = b.y;
        position[i * 3 + 2] = b.z;
        const rgb = rgbFloats(b.color);
        tint[i * 3] = rgb[0];
        tint[i * 3 + 1] = rgb[1];
        tint[i * 3 + 2] = rgb[2];
        size[i] = b.radius * 2;
    });
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.tint.needsUpdate = true;
    geometry.attributes.size.needsUpdate = true;
    geometry.setDrawRange(0, list.length);

    // Pixels per unit of size, one unit away from the camera
    points.material.uniforms.pixelScale.value =
        view.projectionMatrix.elements[5] * viewHeight * pixelRatio / 2;
    points.material.uniforms.minSize.value = (points === glowDots ? 2.6 : 1.6) * pixelRatio;
}

function updateDots() {
    const glow = [];
    const plain = [];
    for (const b of bodies) {
        if (!isDot(b)) continue;
        if (b.type === "galaxyStar") glow.push(b);
        else plain.push(b);
    }
    fillDots(glowDots, glow);
    fillDots(plainDots, plain);
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
        b.trail.push({ x: b.x, y: b.y, z: b.z });
        while (b.trail.length > limit) b.trail.shift();
    }
}

const trailLines = new Map(); // body -> its trail line

/*
 * Each trail is a line through the body's last few hundred positions.
 * It fades out toward the old end: the lines are "additive" (their colour
 * adds to what's behind), so a darker colour looks more see-through.
 */
function updateTrails() {
    const seen = new Set();

    if (options.trails) {
        for (const b of bodies) {
            const trail = b.trail;
            if (trail.length < 2) continue;
            seen.add(b);

            let line = trailLines.get(b);
            if (!line || line.userData.capacity < trail.length) {
                if (line) removeVisual(line);
                const capacity = Math.max(trail.length, TRAIL_LENGTH);
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
                geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
                line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
                    vertexColors: true, transparent: true,
                    blending: THREE.AdditiveBlending, depthWrite: false
                }));
                line.frustumCulled = false;
                line.userData.capacity = capacity;
                scene.add(line);
                trailLines.set(b, line);
            }

            const position = line.geometry.attributes.position.array;
            const color = line.geometry.attributes.color.array;
            const rgb = rgbFloats(visibleColor(b.color));
            const n = trail.length;
            for (let i = 0; i < n; i++) {
                const p = trail[i];
                position[i * 3] = p.x;
                position[i * 3 + 1] = p.y;
                position[i * 3 + 2] = p.z;
                const fade = 0.08 + 0.7 * i / (n - 1);
                color[i * 3] = rgb[0] * fade;
                color[i * 3 + 1] = rgb[1] * fade;
                color[i * 3 + 2] = rgb[2] * fade;
            }
            line.geometry.attributes.position.needsUpdate = true;
            line.geometry.attributes.color.needsUpdate = true;
            line.geometry.setDrawRange(0, n);
        }
    }

    for (const [b, line] of trailLines) {
        if (!seen.has(b)) {
            removeVisual(line);
            trailLines.delete(b);
        }
    }
}

// ---------- Predicted orbit (Kepler ellipse) ----------

const ORBIT_POINTS = 128;
const orbitLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({
    transparent: true, opacity: 0.65, depthWrite: false
}));
orbitLine.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array((ORBIT_POINTS + 1) * 3), 3));
orbitLine.frustumCulled = false;
scene.add(orbitLine);
let orbitMarkers = null; // closest and farthest points, marked on the overlay

/*
 * The ellipse Kepler's laws predict for the selected body (see orbitAround).
 * It lies flat in the plane at right angles to the angular momentum h, with
 * the other body at one focus. Measuring the angle (nu) from the closest point:
 *   distance r = a (1 - e^2) / (1 + e cos(nu))
 * P points to the closest point, Q is 90 degrees further round (the way it moves).
 */
function updatePredictedOrbit() {
    orbitLine.visible = false;
    orbitMarkers = null;

    const b = selectedBody;
    if (!options.orbit || !b || !bodies.includes(b)) return;
    const other = referenceBody(b);
    if (!other) return;

    const orbit = orbitAround(b, other);
    if (!orbit.bound || orbit.e >= 0.999 || orbit.a > 1e6) return;

    const h = new THREE.Vector3(orbit.hx, orbit.hy, orbit.hz);
    if (h.lengthSq() < 1e-12) return;
    h.normalize();
    const P = orbit.e > 1e-6
        ? new THREE.Vector3(orbit.ex, orbit.ey, orbit.ez).divideScalar(orbit.e)
        : new THREE.Vector3(b.x - other.x, b.y - other.y, b.z - other.z).normalize();
    const Q = new THREE.Vector3().crossVectors(h, P);

    const position = orbitLine.geometry.attributes.position;
    for (let k = 0; k <= ORBIT_POINTS; k++) {
        const nu = k / ORBIT_POINTS * Math.PI * 2;
        const r = orbit.a * (1 - orbit.e * orbit.e) / (1 + orbit.e * Math.cos(nu));
        const c = r * Math.cos(nu);
        const s = r * Math.sin(nu);
        position.setXYZ(k,
            other.x + c * P.x + s * Q.x,
            other.y + c * P.y + s * Q.y,
            other.z + c * P.z + s * Q.z);
    }
    position.needsUpdate = true;
    orbitLine.computeLineDistances();
    orbitLine.material.color.set(visibleColor(b.color));
    orbitLine.material.dashSize = camera.distance * 0.012;
    orbitLine.material.gapSize = camera.distance * 0.009;
    orbitLine.visible = true;

    if (orbit.e > 0.02) {
        const closest = orbit.a * (1 - orbit.e);
        const farthest = orbit.a * (1 + orbit.e);
        orbitMarkers = [
            { x: other.x + P.x * closest, y: other.y + P.y * closest, z: other.z + P.z * closest },
            { x: other.x - P.x * farthest, y: other.y - P.y * farthest, z: other.z - P.z * farthest }
        ];
    }
}

// ---------- Reference grid on the working plane ----------

/*
 * Faint squares on the working plane (see section 4), so you can tell how
 * far above or below it things are. New bodies are placed on this plane.
 * The squares are a power of 10 in size, picked to suit how far away the
 * camera is, and the lines fade out toward the edge. (Each line is split
 * into short pieces, because colours can only change from one end of a
 * piece to the other.)
 */
const grid = (() => {
    const half = 20;   // lines from -20 to +20 squares
    const pieces = 40; // pieces per line
    const positions = [];
    const colors = [];
    const shade = (x, y) => {
        const fade = Math.max(0, 1 - Math.hypot(x, y) / half) ** 2;
        const bright = (x === 0 || y === 0) ? 0.5 : 0.3; // the axes through the middle are brighter
        return [0.45 * bright * fade, 0.55 * bright * fade, 0.75 * bright * fade];
    };
    for (let k = -half; k <= half; k++) {
        for (let i = 0; i < pieces; i++) {
            const a = -half + 2 * half * i / pieces;
            const b = -half + 2 * half * (i + 1) / pieces;
            // A piece of the line at x = k, and of the line at y = k
            positions.push(k, a, 0, k, b, 0, a, k, 0, b, k, 0);
            colors.push(...shade(k, a), ...shade(k, b), ...shade(a, k), ...shade(b, k));
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    lines.frustumCulled = false;
    scene.add(lines);
    return lines;
})();

function updateGrid() {
    grid.visible = options.grid && options.field === "off";
    if (!grid.visible) return;
    const spacing = 10 ** Math.floor(Math.log10(camera.distance / 3));
    grid.scale.setScalar(spacing);
    grid.position.set(Math.round(camera.x / spacing) * spacing, Math.round(camera.y / spacing) * spacing, camera.z);
}

// ---------- Height lines ----------

/*
 * A thin line from each body straight down (or up) to the working plane,
 * like the radar in a space game: you can see at a glance which bodies are
 * above the plane and which are below, and how far. Only for the bigger
 * bodies (lines for thousands of galaxy stars would just be a blur).
 */
const HEIGHT_LINE_LIMIT = 200;
const heightLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
}));
heightLines.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(HEIGHT_LINE_LIMIT * 6), 3));
heightLines.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(HEIGHT_LINE_LIMIT * 6), 3));
heightLines.frustumCulled = false;
scene.add(heightLines);

function updateHeightLines() {
    heightLines.visible = options.grid;
    if (!heightLines.visible) return;

    const position = heightLines.geometry.attributes.position;
    const color = heightLines.geometry.attributes.color;
    let count = 0;
    for (const b of bodies) {
        if (count >= HEIGHT_LINE_LIMIT) break;
        if (b !== selectedBody && (SMALL_TYPES.has(b.type) || isDot(b))) continue;
        if (Math.abs(b.z - camera.z) < b.radius) continue; // already on the plane
        const rgb = rgbFloats(visibleColor(b.color));
        // Brighter at the body, fading toward the plane
        position.setXYZ(count * 2, b.x, b.y, b.z);
        color.setXYZ(count * 2, rgb[0] * 0.45, rgb[1] * 0.45, rgb[2] * 0.45);
        position.setXYZ(count * 2 + 1, b.x, b.y, camera.z);
        color.setXYZ(count * 2 + 1, rgb[0] * 0.12, rgb[1] * 0.12, rgb[2] * 0.12);
        count++;
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    heightLines.geometry.setDrawRange(0, count * 2);
}

// ---------- Gravity field: contour map and rubber sheet ----------

/*
 * The gravity field, as a slice through space along the working plane: for
 * a grid of points on the plane, add up the gravitational potential
 * (G * M / r) from every body.
 *
 *   Contour map: bright = deep gravity well. The rings are lines of equal
 *   potential ("equipotentials"); a body released at rest falls straight
 *   across them, downhill. In 3D, every body is wrapped in nested shells of
 *   equal potential, like the layers of an onion. Drawing all the shells
 *   would hide everything, so we show a slice: around a single star, the
 *   slice through its shells is a set of circles. Move the view up and down
 *   (Q / Z) to slide the slice through the field.
 *
 *   Rubber sheet: the same picture, with each point pushed down by the depth
 *   of the well. A body circling a funnel is like a planet orbiting. But
 *   "down" here isn't a real direction: the sheet shows how DEEP the well
 *   is, not which way gravity PULLS.
 *
 *   Pull sheet: the same depth, but each point is pushed the way gravity
 *   really pulls there (the field g, see gravityAt). Slice above a planet and
 *   the sheet sags down to it; below it, the sheet bulges up to it; level
 *   with it, the lines are drawn in sideways.
 *
 * Gravity has no edge: it reaches forever and just gets weaker, so the
 * picture fades out smoothly instead of stopping. Depth uses a logarithmic
 * scale (each level is a doubling of well depth), otherwise the wells under
 * stars would be far too deep to see anything else.
 */
const SHEET_CELLS = 64;     // squares across the sheet's shape
const RINGS_PER_LEVEL = 2;  // equipotential rings per doubling of well depth

function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

const field = (() => {
    const n = SHEET_CELLS + 1;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
    // Where each corner sits on the picture (0 to 1 across, 0 to 1 up)
    const uv = new Float32Array(n * n * 2);
    // Two triangles per square for the surface, and the squares' edges for the sheet's lines
    const triangles = [];
    const edges = [];
    for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
            const k = row * n + col;
            uv[k * 2] = col / (n - 1);
            uv[k * 2 + 1] = row / (n - 1);
            if (col < n - 1) edges.push(k, k + 1);
            if (row < n - 1) edges.push(k, k + n);
            if (col < n - 1 && row < n - 1) triangles.push(k, k + 1, k + n, k + 1, k + n + 1, k + n);
        }
    }
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(triangles);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", geometry.getAttribute("position"));
    lineGeometry.setIndex(edges);

    const picture = document.createElement("canvas");
    const surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        transparent: true, side: THREE.DoubleSide, depthWrite: false
    }));
    const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({
        color: 0x8b7cf6, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    surface.frustumCulled = lines.frustumCulled = false;

    const group = new THREE.Group();
    group.add(surface, lines);
    group.visible = false;
    scene.add(group);
    return {
        group, geometry, surface, lines, picture,
        context: picture.getContext("2d"),
        image: null, texture: null,
        levels: new Float32Array(0),
        ready: false, mode: "off"
    };
})();

/*
 * The pull of gravity (the field g: acceleration per unit mass) at point
 * (x, y, z), using the same softening as the field picture. Big systems use
 * the Barnes-Hut tree, which must already be built.
 */
function gravityAt(x, y, z, eps2, useTree) {
    if (useTree) {
        walkTree(x, y, z, -1, 1.69, eps2);
        return { x: walkAx, y: walkAy, z: walkAz };
    }
    let gx = 0, gy = 0, gz = 0;
    for (const b of bodies) {
        const dx = b.x - x;
        const dy = b.y - y;
        const dz = b.z - z;
        const d2 = dx * dx + dy * dy + dz * dz + eps2;
        const pull = G * b.mass / (d2 * Math.sqrt(d2));
        gx += dx * pull;
        gy += dy * pull;
        gz += dz * pull;
    }
    return { x: gx, y: gy, z: gz };
}

// Distance from (x, y, z) to whichever of `heavy` pulls hardest there
function distanceToStrongest(x, y, z, heavy) {
    let best = Infinity;
    let bestPull = 0;
    for (const b of heavy) {
        const d2 = (b.x - x) ** 2 + (b.y - y) ** 2 + (b.z - z) ** 2;
        const pull = b.mass / (d2 + 1);
        if (pull > bestPull) {
            bestPull = pull;
            best = Math.sqrt(d2);
        }
    }
    return best;
}

// The level at a point between grid points (blending the four around it)
function fieldLevelAt(levels, points, gx, gy) {
    const x0 = Math.min(Math.floor(gx), points - 2);
    const y0 = Math.min(Math.floor(gy), points - 2);
    const fx = gx - x0;
    const fy = gy - y0;
    const k = y0 * points + x0;
    return (levels[k] * (1 - fx) + levels[k + 1] * fx) * (1 - fy) +
        (levels[k + points] * (1 - fx) + levels[k + points + 1] * fx) * fy;
}

// Colour each point of the picture: glow for depth, plus soft equipotential rings
function paintField(points) {
    const levels = field.levels;

    if (field.picture.width !== points) {
        field.picture.width = field.picture.height = points;
        field.image = field.context.createImageData(points, points);
        // A new picture size needs a new texture on the graphics card
        if (field.texture) field.texture.dispose();
        field.texture = new THREE.CanvasTexture(field.picture);
        field.texture.flipY = false;               // picture row 0 = the bottom (lowest y) of the plane
        field.texture.generateMipmaps = false;
        field.texture.minFilter = THREE.LinearFilter;
        field.surface.material.map = field.texture;
        field.surface.material.needsUpdate = true;
    }
    const data = field.image.data;

    for (let row = 0; row < points; row++) {
        for (let col = 0; col < points; col++) {
            const k = row * points + col;
            const level = levels[k];

            // How fast the level changes from one point to the next
            const left = levels[col > 0 ? k - 1 : k];
            const right = levels[col < points - 1 ? k + 1 : k];
            const down = levels[row > 0 ? k - points : k];
            const up = levels[row < points - 1 ? k + points : k];
            const ringsPerPoint = Math.hypot(right - left, up - down) / 2 * RINGS_PER_LEVEL + 1e-6;

            // Distance to the nearest ring, measured in points, so every
            // ring is drawn with the same soft width wherever it is
            const ringPosition = level * RINGS_PER_LEVEL;
            const fraction = ringPosition - Math.floor(ringPosition);
            const distance = Math.min(fraction, 1 - fraction) / ringsPerPoint;

            let line = clamp(1 - distance / 1.2, 0, 1);
            // Fade out rings packed too tightly to see (e.g. right next to a star)
            line *= smoothstep(2.5, 6, 1 / ringsPerPoint);
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

    field.context.putImageData(field.image, 0, 0);
    field.texture.needsUpdate = true;
}

function updateField() {
    const mode = options.field;
    field.group.visible = mode !== "off" && bodies.length > 0;
    if (!field.group.visible) {
        field.ready = false;
        return;
    }

    // Nothing moved and the camera's still (e.g. paused): the picture from
    // last time is still right. (Turning the camera doesn't change it.)
    const n = bodies.length;
    const key = [mode, positionStamp, n, camera.x, camera.y, camera.z, camera.distance].join("/");
    if (field.ready && key === field.key) return;
    // Otherwise recalculate every 2nd frame (3rd for big systems): the field
    // changes slowly. Big systems use the Barnes-Hut tree here too (about 60
    // pulls per point instead of n).
    const useTreeForField = n > FIELD_TREE_LIMIT;
    const every = useTreeForField ? 3 : 2;
    if (field.ready && field.mode === mode && frameCount % every !== 0) return;
    field.key = key;
    field.mode = mode;
    if (useTreeForField) ensureTree();

    // Points across the picture: as many as possible while keeping the
    // total work (points x pulls per point) about the same
    const work = useTreeForField ? 60 : n;
    const points = clamp(Math.floor(Math.sqrt(500000 / work)), SHEET_CELLS + 1, 161);
    const size = camera.distance * 2.2;
    const cell = size / (points - 1);
    const planeZ = camera.z;
    // Snap to whole sheet squares, so the picture doesn't shimmer as the camera pans
    const snap = size / SHEET_CELLS;
    const left = Math.round(camera.x / snap) * snap - size / 2;
    const bottom = Math.round(camera.y / snap) * snap - size / 2;
    const eps2 = 15 * 15;

    if (field.levels.length !== points * points) field.levels = new Float32Array(points * points);
    const levels = field.levels;
    let lowest = Infinity;

    for (let row = 0; row < points; row++) {
        const wy = bottom + row * cell;
        for (let col = 0; col < points; col++) {
            const wx = left + col * cell;
            let potential = 0;
            if (useTreeForField) {
                // A rough tree setting is fine for a background picture
                walkTree(wx, wy, planeZ, -1, 1.69, eps2);
                potential = -walkPhi / G;
            } else {
                for (let j = 0; j < n; j++) {
                    const b = bodies[j];
                    const dx = wx - b.x;
                    const dy = wy - b.y;
                    const dz = planeZ - b.z;
                    potential += b.mass / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
                }
            }
            const level = Math.log2(1 + G * potential);
            levels[row * points + col] = level;
            if (level < lowest) lowest = level;
        }
    }

    paintField(points);

    // Shape the surface: flat for the contour map, pushed down for the
    // rubber sheet, pushed the way gravity pulls for the pull sheet
    const corners = SHEET_CELLS + 1;
    const position = field.geometry.attributes.position;
    const depthPerLevel = mode === "map" ? 0 : size * 0.025;
    const scale = (points - 1) / SHEET_CELLS; // grid points per sheet square
    // The heaviest bodies, to make sure the pull sheet never reaches past one
    const heavy = mode === "pull" ? menuBodies() : null;

    for (let row = 0; row < corners; row++) {
        for (let col = 0; col < corners; col++) {
            const x = left + col * size / SHEET_CELLS;
            const y = bottom + row * size / SHEET_CELLS;
            const depth = (fieldLevelAt(levels, points, col * scale, row * scale) - lowest) * depthPerLevel;

            if (mode === "pull") {
                const g = gravityAt(x, y, planeZ, eps2, useTreeForField);
                const strength = Math.hypot(g.x, g.y, g.z);
                // Same depth as the rubber sheet, but along the pull, and
                // stopping short of the body doing the pulling
                const reach = strength > 0 ? Math.min(depth, 0.8 * distanceToStrongest(x, y, planeZ, heavy)) / strength : 0;
                position.setXYZ(row * corners + col, x + g.x * reach, y + g.y * reach, planeZ + g.z * reach);
            } else {
                position.setXYZ(row * corners + col, x, y, planeZ - depth);
            }
        }
    }
    position.needsUpdate = true;
    field.lines.visible = mode !== "map";
    field.ready = true;
}

// ---------- Gravity arrows ----------

/*
 * A 3D lattice of arrows around the point the camera looks at, each one
 * pointing the way gravity pulls there (the field g, from gravityAt).
 * Unlike the sheets, this shows the pull from every side at once: above a
 * planet the arrows point down at it, below it they point up.
 * Longer and brighter = stronger. Gravity's strength covers a huge range
 * (it falls as 1 / r^2), so lengths use a logarithmic scale: the full length
 * covers a strength range of 1,000 times.
 * All the arrows are one "instanced" shape, drawn in a single call.
 */
const ARROWS_ACROSS = 9;  // arrows along x and along y
const ARROW_LAYERS = 5;   // layers stacked up in z
const ARROW_COUNT = ARROWS_ACROSS * ARROWS_ACROSS * ARROW_LAYERS;

// One arrow, from its tail (0) to its point (1) along +y: a thin shaft plus
// a cone for the head, joined into one shape by putting their triangles together
const arrowShape = (() => {
    const shaft = new THREE.CylinderGeometry(0.018, 0.018, 0.72, 6).translate(0, 0.36, 0).toNonIndexed();
    const head = new THREE.ConeGeometry(0.07, 0.28, 8).translate(0, 0.86, 0).toNonIndexed();
    const a = shaft.attributes.position.array;
    const b = head.attributes.position.array;
    const joined = new Float32Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    const shape = new THREE.BufferGeometry();
    shape.setAttribute("position", new THREE.BufferAttribute(joined, 3));
    return shape;
})();
const arrows = new THREE.InstancedMesh(arrowShape, new THREE.MeshBasicMaterial({
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
}), ARROW_COUNT);
arrows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
arrows.setColorAt(0, new THREE.Color()); // gives every arrow its own colour
arrows.frustumCulled = false;
arrows.visible = false;
scene.add(arrows);

const POINTING_UP = new THREE.Vector3(0, 1, 0);
const WEAK_ARROW = new THREE.Color(0.2, 0.3, 0.6);
const STRONG_ARROW = new THREE.Color(1, 0.75, 0.35);

function updateArrows() {
    arrows.visible = options.fieldArrows && bodies.length > 0;
    if (!arrows.visible) {
        arrows.userData.ready = false;
        return;
    }
    // Same rules as the gravity field: skip when nothing changed, and
    // recalculate big systems every 3rd frame
    const useTree = bodies.length > FIELD_TREE_LIMIT;
    const key = [positionStamp, bodies.length, camera.x, camera.y, camera.z, camera.distance].join("/");
    if (arrows.userData.ready && key === arrows.userData.key) return;
    if (useTree && arrows.userData.ready && frameCount % 3 !== 0) return;
    arrows.userData.key = key;
    if (useTree) ensureTree();

    // Spaced to suit the zoom, and snapped so they don't slide as the view
    // pans. Layers are closer together in z, so the top layer stays well
    // below the camera.
    const spacing = camera.distance * 0.16;
    const layerSpacing = spacing * 0.6;
    const centerX = Math.round(camera.x / spacing) * spacing;
    const centerY = Math.round(camera.y / spacing) * spacing;
    const centerZ = Math.round(camera.z / layerSpacing) * layerSpacing;
    const halfAcross = (ARROWS_ACROSS - 1) / 2;
    const halfUp = (ARROW_LAYERS - 1) / 2;

    // First work out every arrow's pull, to find the strongest
    const samples = [];
    let strongest = 0;
    for (let k = 0; k < ARROW_LAYERS; k++) {
        for (let j = 0; j < ARROWS_ACROSS; j++) {
            for (let i = 0; i < ARROWS_ACROSS; i++) {
                const p = {
                    x: centerX + (i - halfAcross) * spacing,
                    y: centerY + (j - halfAcross) * spacing,
                    z: centerZ + (k - halfUp) * layerSpacing
                };
                const g = gravityAt(p.x, p.y, p.z, 15 * 15, useTree);
                const strength = Math.hypot(g.x, g.y, g.z);
                // Arrows further from the middle are fainter
                const edge = Math.hypot((i - halfAcross) / halfAcross, (j - halfAcross) / halfAcross, (k - halfUp) / Math.max(halfUp, 1));
                samples.push({ p, g, strength, fade: 1 - 0.8 * Math.min(edge / 1.7, 1) });
                if (strength > strongest) strongest = strength;
            }
        }
    }

    const matrix = new THREE.Matrix4();
    const turn = new THREE.Quaternion();
    const color = new THREE.Color();
    const direction = new THREE.Vector3();
    samples.forEach(({ p, g, strength, fade }, n) => {
        // 0 = 1,000 times weaker than the strongest, 1 = the strongest
        const t = strength > 0 ? clamp(Math.log(strength / strongest * 1000) / Math.log(1000), 0, 1) : 0;
        const length = t > 0 ? spacing * (0.2 + 0.5 * t) : 0;
        direction.set(g.x, g.y, g.z).normalize();
        turn.setFromUnitVectors(POINTING_UP, direction);
        // Centre each arrow on its lattice point
        matrix.compose(
            new THREE.Vector3(p.x - direction.x * length / 2, p.y - direction.y * length / 2, p.z - direction.z * length / 2),
            turn,
            new THREE.Vector3(length, length, length)
        );
        arrows.setMatrixAt(n, matrix);
        color.copy(WEAK_ARROW).lerp(STRONG_ARROW, t).multiplyScalar(fade * (0.3 + 0.6 * t));
        arrows.setColorAt(n, color);
    });
    arrows.instanceMatrix.needsUpdate = true;
    arrows.instanceColor.needsUpdate = true;
    arrows.userData.ready = true;
}

// ---------- Barnes-Hut tree view ----------

// What the selected body's group used last time the tree was drawn
let treeView = null;

const treeLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
}));
treeLines.frustumCulled = false;
treeLines.userData.capacity = 0;
scene.add(treeLines);

// The 12 edges of a cube, as pairs of corners (corner bits: 1 = +x, 2 = +y, 4 = +z)
const CUBE_EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];

function updateTreeOverlay() {
    treeLines.visible = options.tree && bodies.length > 0;
    if (!treeLines.visible) {
        treeView = null;
        return;
    }

    // Nothing moved and nothing else changed: the lines from last time are still right
    const key = positionStamp + "/" + bodies.length + "/" + (selectedBody ? selectedBody.id : "-") + "/" + theta;
    if (key === treeLines.userData.key) return;
    treeLines.userData.key = key;

    ensureTree();
    const i = selectedBody ? bodies.indexOf(selectedBody) : -1;
    const L = i >= 0 ? leafOfBody(i) : -1;
    if (L >= 0) gatherInteractions(L, theta * theta);
    const farCount = L >= 0 ? groupNodeCount : 0;
    const nearCount = L >= 0 ? groupBodyCount : 0;

    // Room for every line end: 24 per cube (12 edges), 2 per straight line
    const needed = (tree.count + farCount + 1) * 24 + (farCount + nearCount) * 2;
    const geometry = treeLines.geometry;
    if (treeLines.userData.capacity < needed) {
        const capacity = Math.max(1024, needed * 2);
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
        treeLines.userData.capacity = capacity;
    }
    // Written straight into the graphics card's arrays (no small objects
    // created per line, which matters with thousands of cubes every frame)
    const position = geometry.attributes.position.array;
    const color = geometry.attributes.color.array;
    let v = 0;
    const point = (x, y, z, r, g, b) => {
        position[v * 3] = x;
        position[v * 3 + 1] = y;
        position[v * 3 + 2] = z;
        color[v * 3] = r;
        color[v * 3 + 1] = g;
        color[v * 3 + 2] = b;
        v++;
    };
    const box = (k, r, g, b) => {
        const h = tree.half[k];
        for (let e = 0; e < CUBE_EDGES.length; e++) {
            const c = CUBE_EDGES[e]; // corner bits: 1 = +x, 2 = +y, 4 = +z
            point(tree.cx[k] + (c & 1 ? h : -h), tree.cy[k] + (c & 2 ? h : -h), tree.cz[k] + (c & 4 ? h : -h), r, g, b);
        }
    };

    // Every cube in the tree, faintly
    for (let k = 0; k < tree.count; k++) box(k, 0.05, 0.065, 0.085);

    treeView = null;
    if (L >= 0) {
        const s = selectedBody;
        // Far cubes (faint orange), with a line to the point where their mass is counted
        for (let n = 0; n < farCount; n++) {
            const k = groupNodes[n];
            box(k, 0.45, 0.26, 0.1);
            point(s.x, s.y, s.z, 0.98, 0.57, 0.24);
            point(tree.comX[k], tree.comY[k], tree.comZ[k], 0.98, 0.57, 0.24);
        }
        // Nearby bodies, one by one (cyan lines)
        for (let n = 0; n < nearCount; n++) {
            const b = bodies[groupBodies[n]];
            if (b === s) continue;
            point(s.x, s.y, s.z, 0.06, 0.38, 0.43);
            point(b.x, b.y, b.z, 0.06, 0.38, 0.43);
        }
        // The selected body's own cube
        box(L, 0.13, 0.83, 0.93);

        treeView = { groups: farCount, singles: nearCount - 1, n: bodies.length };
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.setDrawRange(0, v);
}

// ---------- Placing new bodies ----------

// A conservative guide for moon stability, not an enforced physics constraint.
function moonStableRadius(planet, exclude = null) {
    let hill = Infinity;
    for (const other of bodies) {
        if (other === exclude || other.mass <= planet.mass) continue;
        const distance = Math.hypot(planet.x - other.x, planet.y - other.y, planet.z - other.z);
        hill = Math.min(hill, distance * Math.cbrt(planet.mass / (3 * other.mass)));
    }
    return 0.4 * hill;
}

// Only snap to a host at least as massive as the new body, outside contact.
// Moons near a planet target that planet; stability is a warning, not a gate.
function placementAttractor(point, type, mass = BODY_TYPES[type].mass, exclude = null) {
    const candidates = bodies.filter(b => b !== exclude && b.mass >= mass &&
        Math.hypot(point.x - b.x, point.y - b.y, point.z - b.z) >
            b.radius + (exclude ? exclude.radius : BODY_TYPES[type].radius));
    const pull = b => b.mass / ((point.x - b.x) ** 2 + (point.y - b.y) ** 2 +
        (point.z - b.z) ** 2 + softening ** 2);
    const strongest = list => list.reduce((best, b) => !best || pull(b) > pull(best) ? b : best, null);
    if (type === "moon") {
        const planets = candidates.filter(b => b.type === "planet" && b.mass > mass);
        // Nearby clicks express intent, even if stellar tides may disrupt the orbit.
        // Keep the capture region finite for an isolated planet as well.
        const nearby = planets.filter(planet => {
            const distance = Math.hypot(point.x - planet.x, point.y - planet.y, point.z - planet.z);
            const stable = moonStableRadius(planet, exclude);
            return distance < Math.max(6 * planet.radius, Number.isFinite(stable) ? stable : 0);
        });
        if (nearby.length) return nearby.reduce((best, b) => {
            const distance = host => Math.hypot(point.x - host.x, point.y - host.y, point.z - host.z);
            return !best || distance(b) < distance(best) ? b : best;
        }, null);
        // Away from a planet, use a stellar host instead.
        const stellar = candidates.filter(b => ["star", "neutronstar", "blackhole"].includes(b.type));
        return strongest(stellar);
    }
    if (type === "planet") {
        const stellar = candidates.filter(b => ["star", "neutronstar", "blackhole"].includes(b.type));
        if (stellar.length) return strongest(stellar);
    }
    return strongest(candidates);
}

function placementFrame() {
    const total = bodies.reduce((sum, b) => sum + b.mass, 0);
    const frame = { vx: 0, vy: 0, vz: 0 };
    if (total) for (const b of bodies) for (const key of ["vx", "vy", "vz"]) frame[key] += b.mass * b[key] / total;
    return { ...frame, mass: total };
}

// Placement assigns only the new body's velocity. Existing bodies retain
// their motion: any disruption from the added mass is handled by real gravity.
function placeNewBody(type, point, velocity) {
    const body = createBody({ type, ...point, vx: velocity.vx, vy: velocity.vy, vz: velocity.vz });
    bodies.push(body);
    markSystemChanged();
    return body;
}

function placementVelocity(p) {
    const dragPixels = Math.hypot(
        p.currentScreen.x - p.startScreen.x,
        p.currentScreen.y - p.startScreen.y
    );

    // Just a click: choose a physically plausible host and inherit its motion.
    if (dragPixels < 6) {
        const attractor = placementAttractor(p.start, brush);
        if (attractor) {
            const unstable = brush === "moon" && attractor.type === "planet" &&
                Math.hypot(p.start.x - attractor.x, p.start.y - attractor.y, p.start.z - attractor.z) >= moonStableRadius(attractor);
            return { ...circularVelocity(p.start, BODY_TYPES[brush].mass, attractor), auto: true, attractor, unstable };
        }
        const frame = placementFrame();
        return { vx: frame.vx, vy: frame.vy, vz: frame.vz, auto: true, attractor: null };
    }

    // A drag: velocity follows the drag direction and length, along the plane
    return {
        vx: (p.current.x - p.start.x) * LAUNCH_SCALE,
        vy: (p.current.y - p.start.y) * LAUNCH_SCALE,
        vz: (p.current.z - p.start.z) * LAUNCH_SCALE,
        auto: false
    };
}

const placementPath = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({
    color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false
}));
placementPath.frustumCulled = false;
const placementGhost = new THREE.Mesh(sphereGeometry, new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.5, depthWrite: false
}));
scene.add(placementPath, placementGhost);
let placementPreview = null; // what the overlay needs: velocity and predicted crash

function updatePlacement() {
    placementPreview = null;
    placementPath.visible = placementGhost.visible = false;
    if (!pointer || pointer.mode !== "place") return;

    const preset = BODY_TYPES[brush];
    const velocity = placementVelocity(pointer);
    const prediction = predictPath(pointer.start, velocity);
    placementPreview = { velocity, hit: prediction.hit };

    placementPath.geometry.setFromPoints(prediction.points.map(p => new THREE.Vector3(p.x, p.y, p.z)));
    placementPath.computeLineDistances();
    placementPath.material.dashSize = camera.distance * 0.01;
    placementPath.material.gapSize = camera.distance * 0.008;
    placementPath.visible = true;

    placementGhost.position.set(pointer.start.x, pointer.start.y, pointer.start.z);
    placementGhost.scale.setScalar(preset.radius);
    placementGhost.material.color.set(visibleColor(preset.color ?? nextPlanetColor()));
    placementGhost.visible = true;
}

// ---------- Overlay: flat drawings on top of the 3D view ----------
// (labels, arrows, the selection ring, collision flashes)

function drawArrow(x1, y1, x2, y2, color, width) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;

    const head = Math.min(len * 0.4, 9);
    const ux = dx / len;
    const uy = dy / len;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;

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

// An arrow from the body's edge, `length` long in direction (ux, uy, uz), seen in 3D
function drawArrow3D(b, ux, uy, uz, length, color) {
    const start = project(b.x + ux * b.radius, b.y + uy * b.radius, b.z + uz * b.radius);
    const reach = b.radius + length;
    const end = project(b.x + ux * reach, b.y + uy * reach, b.z + uz * reach);
    if (start && end) drawArrow(start.x, start.y, end.x, end.y, color, 2);
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

        const speed = Math.hypot(b.vx, b.vy, b.vz);
        if (speed > 1e-3) {
            drawArrow3D(b, b.vx / speed, b.vy / speed, b.vz / speed, Math.min(speed * 6, 220), "#4ade80");
        }

        // Square-root scaling keeps arrows readable near a star and far from it
        const accel = Math.hypot(b.ax, b.ay, b.az);
        if (accel > 1e-4) {
            drawArrow3D(b, b.ax / accel, b.ay / accel, b.az / accel, Math.min(Math.sqrt(accel) * 45, 90), "#fb923c");
        }
    }
}

function drawSelectionRing() {
    const b = selectedBody;
    if (!b || !bodies.includes(b)) return;
    const p = project(b.x, b.y, b.z);
    if (!p) return;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -performance.now() / 60;
    ctx.beginPath();
    ctx.arc(p.x, p.y, b.radius * p.scale + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
}

// The closest and farthest points of the predicted orbit
function drawOrbitMarkers() {
    if (!orbitMarkers) return;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (const m of orbitMarkers) {
        const p = project(m.x, m.y, m.z);
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawEffects() {
    for (const e of effects) {
        const p = project(e.x, e.y, e.z);
        if (!p) continue;
        const t = e.age / 40;
        ctx.strokeStyle = rgba(visibleColor(e.color), 1 - t);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (e.radius + t * 40) * p.scale, 0, Math.PI * 2);
        ctx.stroke();
    }
    effects.forEach(e => e.age++);
    effects = effects.filter(e => e.age < 40);
}

function drawLabels() {
    if (!options.labels) return;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";

    const crowded = bodies.length > 14;
    const veryCrowded = bodies.length > 60;

    for (const b of bodies) {
        if (b !== selectedBody) {
            if (crowded && SMALL_TYPES.has(b.type)) continue;
            if (veryCrowded && b.type === "planet") continue;
        }
        const p = project(b.x, b.y, b.z);
        if (!p || p.x < -50 || p.y < -50 || p.x > viewWidth + 50 || p.y > viewHeight + 50) continue;

        ctx.fillStyle = b === selectedBody ? "#ffffff" : "rgba(203,213,225,0.7)";
        ctx.fillText(b.name, p.x, p.y + b.radius * p.scale + 14);
    }
}

function drawPlacementOverlay() {
    if (!placementPreview) return;
    const { velocity, hit } = placementPreview;

    if (hit) {
        const p = project(hit.x, hit.y, hit.z);
        if (p) {
            ctx.strokeStyle = "#f87171";
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(p.x - 7, p.y - 7);
            ctx.lineTo(p.x + 7, p.y + 7);
            ctx.moveTo(p.x + 7, p.y - 7);
            ctx.lineTo(p.x - 7, p.y + 7);
            ctx.stroke();
        }
    }

    // Launch arrow
    if (!velocity.auto) {
        const a = project(pointer.start.x, pointer.start.y, pointer.start.z);
        const b = project(pointer.current.x, pointer.current.y, pointer.current.z);
        if (a && b) drawArrow(a.x, a.y, b.x, b.y, "#f8fafc", 2);
    }

    // Text near the cursor
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#e2e8f0";
    const speed = Math.hypot(velocity.vx, velocity.vy, velocity.vz);
    const text = velocity.auto
        ? (velocity.attractor ? "Orbit " + velocity.attractor.name + (velocity.unstable ? " — may be unstable: stellar tides" : " — release to place")

            : "Release to place in the system's reference frame")
        : "Speed " + speed.toFixed(2);
    ctx.fillText(text, pointer.currentScreen.x + 14, pointer.currentScreen.y - 12);
}

function drawOverlay() {
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.clearRect(0, 0, viewWidth, viewHeight);
    if (options.vectors) drawVectors();
    drawOrbitMarkers();
    drawEffects();
    drawSelectionRing();
    drawPlacementOverlay();
    drawLabels();
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
    // (all in one path: Planet Formation can have hundreds of them)
    c.strokeStyle = "rgba(250,204,21,0.45)";
    c.beginPath();
    energyHistory.forEach((e, i) => {
        if (!e.event) return;
        c.moveTo(xFor(i), 0);
        c.lineTo(xFor(i), h);
    });
    c.stroke();
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
    updateView();

    // The background stars sit on a huge ball around the camera
    starfield.visible = options.stars;
    starfield.position.copy(view.position);
    starfield.scale.setScalar(view.far * 0.8);

    lightSources = bodies.filter(b => b.type === "star");
    updateLights();
    updateBodies();
    updateDots();
    updateTrails();
    updatePredictedOrbit();
    updateGrid();
    updateHeightLines();
    updateField();
    updateArrows();
    updateTreeOverlay();
    updatePlacement();

    renderer.render(scene, view);
    drawOverlay();
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
const vzInput = document.getElementById("vzInput");
const xInput = document.getElementById("xInput");
const yInput = document.getElementById("yInput");
const zInput = document.getElementById("zInput");
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
    return camera.follow === "body" && camera.followed ? "body:" + camera.followed.id : camera.follow;
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

    const followed = camera.follow === "body" ? camera.followed : null;
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
        if (n > 1000) {
            html += "<br><span class=\"warning\">That's a lot for Direct, so expect it to run slowly. " +
                "\"Auto\" switches to Barnes-Hut above " + AUTO_TREE_THRESHOLD + " bodies.</span>";
        }
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
        html += "<br>Selected body's group: <b>" + treeView.groups + "</b> far cubes + <b>" +
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
        if (force || document.activeElement !== vzInput) vzInput.value = selectedBody.vz.toFixed(2);
        if (force || document.activeElement !== xInput) xInput.value = selectedBody.x.toFixed(1);
        if (force || document.activeElement !== yInput) yInput.value = selectedBody.y.toFixed(1);
        if (force || document.activeElement !== zInput) zInput.value = selectedBody.z.toFixed(1);
        document.getElementById("speedReadout").textContent =
            Math.hypot(selectedBody.vx, selectedBody.vy, selectedBody.vz).toFixed(2);
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
        : !editState.pausedByEdit ? "PAUSED · "
        : pointer && pointer.mode === "drag" ? "PAUSED while moving a body · "
        : pointer && pointer.mode === "place" ? "PAUSED while placing · "
        : "PAUSED while editing · ";
    const slowText = running && speedRatio < 0.85
        ? " (computer keeping up at " + (simulationSpeed * speedRatio).toFixed(1) + "x)"
        : "";
    const perfText = options.perf
        ? " · " + Math.round(perf.fps) + " fps (physics " + perf.physicsMs.toFixed(1) +
          " ms, drawing " + perf.drawMs.toFixed(1) + " ms)"
        : "";
    document.getElementById("hud").textContent =
        pauseText +
        "t = " + simTime.toFixed(1) +
        " · " + bodies.length.toLocaleString() + " bodies · " + integratorName +
        " · " + solverName +
        " · " + simulationSpeed.toFixed(1) + "x" + slowText + perfText;

    document.getElementById("planeHeight").textContent = "z " + Math.round(camera.z);

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
        const selected = btn.dataset.tab === name;
        btn.classList.toggle("active", selected);
        btn.setAttribute("aria-selected", String(selected));
        btn.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll(".tab-page").forEach(page => {
        page.classList.toggle("hidden", page.id !== "tab-" + name);
    });
    document.querySelector(".control-panel").scrollTop = 0;
    equationsKey = null;
    refreshEquations();
    document.dispatchEvent(new CustomEvent("paneltabchange", { detail: name }));
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
            eqLine("<i>F</i> = " + frac("<i>G</i> · <i>M</i> · <i>m</i>", "<i>r</i>²")) +
            eqSub("= " + frac(G + " × " + num("M") + " × " + num("m"), num("r") + "²") +
                " = " + num("F", true)) +
            eqNote("The pull between " + name + " (mass <i>m</i>) and " + otherName +
                " (mass <i>M</i>), a distance <i>r</i> apart. <i>G</i> = 1 in simulation units.") +
            eqRow("Softened, as the simulation uses it", num("Fsoft")) +
            eqNote("The simulation uses <i>F</i> = <i>G·M·m·r</i> / (<i>r</i>² + <i>ε</i>²)<sup>3/2</sup> " +
                "with <i>ε</i> = " + num("eps") + ", so very close passes don't give infinite kicks " +
                "(How it works §4). Far away (<i>r</i> much bigger than <i>ε</i>) it's the same as Newton's."));

        html += eqCard("Acceleration: Newton's 2nd law",
            eqLine("<i>a</i> = " + frac("<i>F</i>", "<i>m</i>") + " = " +
                frac("<i>G</i> · <i>M</i>", "<i>r</i>²")) +
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
            eqLine("<i>v</i> = √(<i>v<sub>x</sub></i>² + <i>v<sub>y</sub></i>² + <i>v<sub>z</sub></i>²)") +
            eqSub("= √((" + num("vx") + ")² + (" + num("vy") + ")² + (" + num("vz") + ")²) = " + num("v", true)) +
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
            eqLine("<i>U</i> = −" + frac("<i>G</i> · <i>M</i> · <i>m</i>", "<i>r</i>")) +
            eqSub("= −" + frac(G + " × " + num("M") + " × " + num("m"), num("r")) +
                " = " + num("Upair", true)) +
            eqRow("Softened: −<i>G·M·m</i> / √(<i>r</i>² + <i>ε</i>²)", num("Usoft")) +
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
                "The dashed ellipse on the canvas is this predicted orbit.") +
            eqNote("Kepler's laws are exact for real gravity (<i>ε</i> = 0). With softening, orbits " +
                "that dive close to the other body take slightly longer: about 1.5% for one that " +
                "comes within 80 when <i>ε</i> = 5."));
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
    let px = 0, py = 0, pz = 0;
    for (const body of bodies) {
        px += body.mass * body.vx;
        py += body.mass * body.vy;
        pz += body.mass * body.vz;
    }

    const values = {
        n: bodies.length,
        sysKE: system.kinetic,
        sysU: system.potential,
        sysE: system.total,
        sysP: Math.hypot(px, py, pz)
    };
    if (!b) return values;

    // measureEnergyFast() made sure ax, ay and phi are up to date
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    const accel = Math.hypot(b.ax, b.ay, b.az);
    Object.assign(values, {
        m: b.mass,
        vx: b.vx,
        vy: b.vy,
        vz: b.vz,
        v: speed,
        p: b.mass * speed,
        KE: 0.5 * b.mass * speed * speed,
        aNet: accel,
        Fnet: b.mass * accel,
        U: b.mass * b.phi
    });
    if (!other) return values;

    // Newton's textbook values use r; the "softened" ones are exactly what
    // the simulation computes (see computeForcesDirect)
    const r = Math.hypot(other.x - b.x, other.y - b.y, other.z - b.z);
    const softened = r * r + softening * softening;
    const force = G * other.mass * b.mass / (r * r);
    const orbit = orbitAround(b, other);

    Object.assign(values, {
        M: other.mass,
        r,
        eps: softening,
        F: force,
        Fsoft: G * other.mass * b.mass * r / (softened * Math.sqrt(softened)),
        aOther: force / b.mass,
        aBack: force / other.mass,
        Upair: -G * other.mass * b.mass / r,
        Usoft: -G * other.mass * b.mass / Math.sqrt(softened),
        vRel: orbit.v,
        vCirc: orbit.circularSpeed,
        vEsc: orbit.escapeSpeed,
        mu: orbit.mu,
        energy: orbit.energy,
        status: orbit.bound ? "Bound: E < 0, it stays in orbit" : "Escaping: E ≥ 0, it won't come back"
    });

    if (orbit.bound) {
        // Steps per lap, divided by steps per second (on a slow computer
        // the simulation manages only `speedRatio` of the speed asked for)
        const seconds = orbit.period / timeStep / (STEPS_PER_SECOND * simulationSpeed * Math.min(1, speedRatio));
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

// ---------- Undo and redo ----------

/*
 * Before every edit (placing, deleting or moving a body, changing its mass,
 * size or velocity, "Make it orbit", Reset, switching scenario) the whole
 * system is saved as a "snapshot". Undo puts the last snapshot back, which
 * also rewinds time to just before that edit; Redo goes forward again.
 * Time passing on its own isn't an edit, so it's never undone by itself.
 */
const UNDO_LIMIT = 30;
const undoStack = [];
const redoStack = [];

function takeSnapshot(label) {
    return {
        label,
        // Copies of every body (trails aren't kept: time jumps on undo anyway)
        bodies: bodies.map(b => ({ ...b, trail: [] })),
        scenario: currentScenario,
        timeStep,
        softening,
        simTime,
        nextId,
        typeCounters: { ...typeCounters },
        selectedId: selectedBody ? selectedBody.id : null,
        referenceId
    };
}

// Call just BEFORE changing the system. `label` says what's about to happen,
// e.g. "delete Rosa", for the Undo button's tooltip.
function saveUndo(label) {
    undoStack.push(takeSnapshot(label));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0; // a new edit replaces anything that could be redone
    refreshUndoButtons();
}

// For sliders and number boxes: a whole drag or typing session is one undo step
function saveUndoForEdit(label) {
    if (editState.sources.size > 0) {
        if (editState.undoSaved) return;
        editState.undoSaved = true;
    }
    saveUndo(label);
}

function restoreSnapshot(snapshot) {
    cancelPointer();
    const followedId = camera.follow === "body" && camera.followed ? camera.followed.id : null;

    bodies = snapshot.bodies.map(b => ({ ...b, trail: [] }));
    timeStep = snapshot.timeStep;
    softening = snapshot.softening;
    simTime = snapshot.simTime;
    nextId = snapshot.nextId;
    typeCounters = { ...snapshot.typeCounters };
    referenceId = snapshot.referenceId;
    selectedBody = bodies.find(b => b.id === snapshot.selectedId) ?? null;
    // Keep following the same body if it exists in the restored system
    if (followedId !== null) camera.followed = bodies.find(b => b.id === followedId) ?? null;

    if (snapshot.scenario !== currentScenario) {
        currentScenario = snapshot.scenario;
        showScenarioInfo(currentScenario);
    }

    stepAccumulator = 0;
    effects = [];
    energyHistory = [];
    markSystemChanged();
    refreshBodyList();
    updateProperties();
}

function undo() {
    const snapshot = undoStack.pop();
    if (!snapshot) return;
    redoStack.push(takeSnapshot(snapshot.label));
    restoreSnapshot(snapshot);
    refreshUndoButtons();
    showToast("Undone: " + snapshot.label);
}

function redo() {
    const snapshot = redoStack.pop();
    if (!snapshot) return;
    undoStack.push(takeSnapshot(snapshot.label));
    restoreSnapshot(snapshot);
    refreshUndoButtons();
    showToast("Redone: " + snapshot.label);
}

function refreshUndoButtons() {
    const undoBtn = document.getElementById("undoBtn");
    const redoBtn = document.getElementById("redoBtn");
    const lastUndo = undoStack[undoStack.length - 1];
    const lastRedo = redoStack[redoStack.length - 1];
    undoBtn.disabled = !lastUndo;
    redoBtn.disabled = !lastRedo;
    undoBtn.title = lastUndo ? "Undo: " + lastUndo.label + " (Ctrl+Z)" : "Nothing to undo";
    redoBtn.title = lastRedo ? "Redo: " + lastRedo.label + " (Ctrl+Shift+Z)" : "Nothing to redo";
}

// A short message in the middle of the canvas, fading after a moment
let toastTimer = null;
function showToast(text) {
    const toast = document.getElementById("toast");
    toast.textContent = text;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 1600);
}

// Load a scenario as an edit that can be undone (Reset, or picking another one)
function startScenario(name, label) {
    saveUndo(label);
    loadScenario(name);
}

// ---------- Auto-pause while editing ----------

function beginEdit(source) {
    if (editState.sources.size === 0) {
        editState.target = selectedBody;
        editState.undoSaved = false;
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

// ---------- Tools ----------

/*
 * The tool decides what the left mouse button does on the canvas:
 *   "observe": look around. Drag to rotate the view, click a body to select
 *              it. It never moves anything, so you can't wreck a system by
 *              accident.
 *   "move":    drag a body to move it (Shift + drag moves it up and down)
 *   a body type ("planet", "star", ...): drag to throw a new one, click to
 *              place it on an orbit
 * Picking the active tool again goes back to Observe.
 */
function setTool(name) {
    tool = name === tool ? "observe" : name;
    brush = BODY_TYPES[tool] ? tool : null;

    document.querySelectorAll(".brush").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.type === tool);
    });

    if (pointer && pointer.mode === "place") cancelPointer();
    updateCursor();
    updateHint();
}

function updateHint() {
    const hint = document.getElementById("canvasHint");
    // The View controls tab says which tool is on, even when it's closed
    document.getElementById("toolBadge").textContent =
        brush ? " · Placing " + BODY_TYPES[brush].label.toLowerCase()
        : tool === "move" ? " · Move tool" : "";
    if (brush) {
        hint.innerHTML =
            "<b>Drag</b> on the grid to throw a " + BODY_TYPES[brush].label.toLowerCase() + " &middot; " +
            "<b>Click</b> for an automatic orbit &middot; " +
            "<b>Q / Z</b> raise or lower the grid &middot; " +
            "<b>Esc</b> to stop placing";
    } else if (tool === "move") {
        hint.innerHTML =
            "<b>Drag a body</b> to move it &middot; " +
            "<b>Shift + drag</b> to move it up or down &middot; " +
            "<b>Esc</b> to stop moving";
    } else {
        hint.innerHTML =
            "<b>Drag</b> to rotate &middot; " +
            "<b>Right-drag</b> or <b>W A S D</b> to slide &middot; " +
            "<b>Q / Z</b> up and down &middot; " +
            "<b>Scroll</b> to zoom";
    }
}

function updateCursor(hovering = false) {
    if (pointer && pointer.moved) {
        canvas.style.cursor = "grabbing";
    } else if (hovering) {
        canvas.style.cursor = tool === "move" ? "move" : "pointer";
    } else {
        canvas.style.cursor = brush ? "crosshair" : "grab";
    }
}

function deleteSelected() {
    if (!selectedBody) return;
    saveUndo("delete " + selectedBody.name);
    if (camera.followed === selectedBody) setCameraFollow("free");
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
        const p = project(b.x, b.y, b.z);
        if (!p) continue;
        const radius = b.radius * p.scale;
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
    camera.followed = target;
    cameraSelect.value = cameraMenuValue();
}

// Teleport a body. Its old trail would draw a line across the jump, so it's cleared.
function moveBody(body, x, y, z) {
    body.x = x;
    body.y = y;
    body.z = z;
    body.trail = [];
    markSystemChanged();
}

// Let go of whatever the mouse was doing (placing, rotating, panning or dragging)
function cancelPointer() {
    if (pointer && pointer.mode === "drag") finishDrag();
    if (pointer && pointer.mode === "place") endEdit("place");
    pointer = null;
    updateCursor();
}

/*
 * Placing a body and dragging one with the Move tool count as editing, like
 * the sliders: with "Auto-pause while editing" on, the simulation waits
 * until you let go. With it off, everything keeps moving, and a dragged body
 * is held still under the mouse (see stepVerlet), keeping its velocity.
 */
function finishDrag() {
    if (!pointer.moved) return;
    pointer.body.held = false;
    markSystemChanged(); // holding a body pushed on the system, so measure energy afresh
    endEdit("drag");
}

// ---------- Mouse / touch on the canvas ----------

/*
 * Left button, depending on the tool:
 *   - Observe: drag to rotate the view, click a body to select it,
 *     click empty space to deselect
 *   - Move: drag a body to move it (empty space still rotates the view)
 *   - a body type: drag to throw, click for an automatic orbit
 * Right or middle button (or Shift + left, except with Move): pan
 * Touch screens: one finger works like the left button; two fingers pinch
 * to zoom and move together to pan.
 */
// Keep receiving this pointer's moves even if it leaves the canvas.
// (The browser refuses if the pointer is already gone, which is harmless.)
function capturePointer(event) {
    try {
        canvas.setPointerCapture(event.pointerId);
    } catch (error) {
        // nothing to capture
    }
}

const touches = new Map(); // finger id -> where it is now
let pinch = null;          // the two fingers' distance apart and middle point, last time

function measurePinch() {
    const [a, b] = [...touches.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), middle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

canvas.addEventListener("pointerdown", event => {
    const screen = eventPosition(event);

    if (event.pointerType === "touch") {
        touches.set(event.pointerId, screen);
        if (touches.size === 2) {
            // A second finger: stop what the first one started, and pinch instead
            cancelPointer();
            pinch = measurePinch();
            capturePointer(event);
            return;
        }
        if (touches.size > 2) return;
    }
    const pan = event.button === 1 || event.button === 2 ||
        (event.button === 0 && event.shiftKey && tool !== "move");

    if (pan) {
        pointer = { mode: "pan", startScreen: screen, lastScreen: screen, moved: false };
    } else if (event.button === 0) {
        const hit = bodyAtScreen(screen.x, screen.y);
        if (hit && tool === "move") {
            selectBody(hit);
            pointer = {
                mode: "drag", body: hit, normal: workingNormal(),
                startScreen: screen, lastScreen: screen, moved: false
            };
        } else if (hit && brush) {
            selectBody(hit);
            return;
        } else if (brush) {
            // New bodies go on the working plane (where the grid is)
            const normal = workingNormal();
            const start = screenToPlane(screen.x, screen.y, cameraFocus(), normal);
            if (!start) return;
            pointer = { mode: "place", start, current: start, normal, startScreen: screen, currentScreen: screen };
            beginEdit("place");
        } else {
            pointer = { mode: "rotate", startScreen: screen, lastScreen: screen, moved: false, clicked: hit };
        }
    } else {
        return;
    }

    capturePointer(event);
});

canvas.addEventListener("pointermove", event => {
    const screen = eventPosition(event);

    if (touches.has(event.pointerId)) touches.set(event.pointerId, screen);
    if (pinch) {
        if (touches.size < 2) return;
        const now = measurePinch();
        zoomView(Math.log(pinch.distance / Math.max(now.distance, 1)));
        if (camera.follow !== "free") setCameraFollow("free");
        slideView(now.middle.x - pinch.middle.x, now.middle.y - pinch.middle.y);
        pinch = now;
        return;
    }

    if (!pointer) {
        updateCursor(bodyAtScreen(screen.x, screen.y) !== null);
        return;
    }

    if (pointer.mode === "place") {
        pointer.currentScreen = screen;
        pointer.current = screenToPlane(screen.x, screen.y, pointer.start, pointer.normal) ?? pointer.current;
        return;
    }

    // Only count it as a drag once the mouse has moved a few pixels,
    // so a plain click doesn't nudge anything
    if (!pointer.moved) {
        if (Math.hypot(screen.x - pointer.startScreen.x, screen.y - pointer.startScreen.y) < 4) return;
        pointer.moved = true;
        if (pointer.mode === "pan") setCameraFollow("free");
        if (pointer.mode === "drag") {
            saveUndo("move " + pointer.body.name);
            pointer.body.held = true;
            beginEdit("drag");
        }
        updateCursor();
    }

    const dx = screen.x - pointer.lastScreen.x;
    const dy = screen.y - pointer.lastScreen.y;

    if (pointer.mode === "pan") {
        slideView(dx, dy);
    } else if (pointer.mode === "rotate") {
        rotateView(dx, dy);
    } else if (pointer.mode === "drag" && bodies.includes(pointer.body)) {
        const body = pointer.body;
        if (event.shiftKey) {
            // Up and down: one pixel is 1 / scale units at the body's distance
            const p = project(body.x, body.y, body.z);
            const step = p ? 1 / p.scale : worldPerPixel();
            moveBody(body, body.x, body.y, body.z - dy * step);
        } else {
            // Slide parallel to the working plane, through the body, following
            // the mouse. Moving by the change in mouse position (not jumping
            // to it) also works while the camera follows the body.
            const from = screenToPlane(pointer.lastScreen.x, pointer.lastScreen.y, body, pointer.normal);
            const to = screenToPlane(screen.x, screen.y, body, pointer.normal);
            if (from && to) moveBody(body, body.x + to.x - from.x, body.y + to.y - from.y, body.z + to.z - from.z);
        }
    }
    pointer.lastScreen = screen;
});

canvas.addEventListener("pointerup", event => {
    touches.delete(event.pointerId);
    if (pinch) {
        // A pinch ends when a finger lifts; the other finger then does nothing until lifted
        if (touches.size < 2) pinch = null;
        return;
    }

    if (pointer && pointer.mode === "place") {
        saveUndo("place a " + BODY_TYPES[brush].label.toLowerCase());
        const velocity = placementVelocity(pointer);
        const body = placeNewBody(brush, pointer.start, velocity);
        selectBody(body);
    } else if (pointer && pointer.mode === "rotate" && !pointer.moved) {
        // A click, not a drag: select what was clicked (or nothing)
        selectBody(pointer.clicked);
    }
    cancelPointer();
});

canvas.addEventListener("pointercancel", event => {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinch = null;
    cancelPointer();
});

canvas.addEventListener("contextmenu", event => event.preventDefault());

// Scroll to zoom in and out
canvas.addEventListener("wheel", event => {
    event.preventDefault();
    zoomView(event.deltaY * 0.0015);
}, { passive: false });

// ---------- Buttons and inputs ----------

document.getElementById("playPauseBtn").onclick = togglePlay;

document.getElementById("resetBtn").onclick = () => startScenario(currentScenario, "reset");
document.getElementById("undoBtn").onclick = undo;
document.getElementById("redoBtn").onclick = redo;

document.getElementById("clearTrailsBtn").onclick = () => {
    for (const b of bodies) b.trail = [];
};

document.getElementById("centerViewBtn").onclick = () => fitView();

document.getElementById("scenarioSelect").onchange = event => {
    startScenario(event.target.value, "switch to " + event.target.selectedOptions[0].textContent);
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
    gridToggle: "grid",
    starsToggle: "stars",
    arrowsToggle: "fieldArrows",
    perfToggle: "perf",
    spinToggle: "spinView",
    mergeToggle: "merge",
    labelToggle: "labels"
};

// ---------- Options menu (saved in this browser) ----------

/*
 * The checkboxes live in the Options menu in the top bar. Choices are saved
 * in this browser (if it allows), so they're the same next visit;
 * "Reset to defaults" goes back to how the page first starts.
 */
const OPTIONS_KEY = "gravitylab.options";
const DEFAULT_OPTIONS = { ...options };
const optionsBtn = document.getElementById("optionsBtn");
const optionsPanel = document.getElementById("optionsPanel");

// Make the checkboxes and legends match `options`
function showOptions() {
    for (const [id, key] of Object.entries(toggles)) document.getElementById(id).checked = options[key];
    document.getElementById("vectorLegend").classList.toggle("hidden", !options.vectors);
    document.getElementById("treeLegend").classList.toggle("hidden", !options.tree);
}

function saveOptions() {
    const saved = {};
    for (const key of Object.values(toggles)) saved[key] = options[key];
    try {
        localStorage.setItem(OPTIONS_KEY, JSON.stringify(saved));
    } catch (error) {
        // storage not available (private window etc.): just don't remember
    }
}

function loadOptions() {
    try {
        const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY));
        for (const key of Object.values(toggles)) {
            if (saved && typeof saved[key] === "boolean") options[key] = saved[key];
        }
    } catch (error) {
        // nothing saved, or storage not available
    }
    showOptions();
}

for (const [id, key] of Object.entries(toggles)) {
    document.getElementById(id).onchange = event => {
        options[key] = event.target.checked;
        showOptions();
        saveOptions();
        event.target.blur(); // so Space still means play / pause
    };
}

document.getElementById("resetOptionsBtn").onclick = () => {
    for (const key of Object.values(toggles)) options[key] = DEFAULT_OPTIONS[key];
    showOptions();
    saveOptions();
};

function setOptionsOpen(open) {
    optionsPanel.classList.toggle("hidden", !open);
    optionsBtn.setAttribute("aria-expanded", String(open));
}

optionsBtn.addEventListener("click", () => setOptionsOpen(optionsPanel.classList.contains("hidden")));
document.getElementById("closeOptionsBtn").addEventListener("click", () => setOptionsOpen(false));

// Clicking anywhere outside the menu closes it
document.addEventListener("pointerdown", event => {
    if (!optionsPanel.classList.contains("hidden") && !event.target.closest(".options-menu")) {
        setOptionsOpen(false);
    }
});

loadOptions();

// ---------- Side panel sections that fold away ----------

// Which sections are folded is remembered in this browser, like the options
const FOLDED_KEY = "gravitylab.foldedSections";
(() => {
    let folded = [];
    try {
        folded = JSON.parse(localStorage.getItem(FOLDED_KEY)) || [];
    } catch (error) {
        // nothing saved
    }
    for (const section of document.querySelectorAll(".foldable")) {
        if (folded.includes(section.id)) section.open = false;
        section.addEventListener("toggle", () => {
            const closed = [...document.querySelectorAll(".foldable:not([open])")].map(s => s.id);
            try {
                localStorage.setItem(FOLDED_KEY, JSON.stringify(closed));
            } catch (error) {
                // storage not available
            }
        });
    }
})();

document.querySelectorAll(".brush").forEach(btn => {
    btn.onclick = () => setTool(btn.dataset.type);
});

// Switch between looking straight down (like a map) and the tilted 3D view
function toggleTopView() {
    if (camera.pitch > 80 * Math.PI / 180) resetViewAngle();
    else topView();
}

document.getElementById("topViewBtn").onclick = toggleTopView;

document.getElementById("fieldSelect").onchange = event => {
    options.field = event.target.value;
    event.target.blur();
};

// ---------- Mass, radius and velocity editing ----------

const MIN_MASS = 0.01;
const MAX_MASS = 1000000;
const MIN_RADIUS = 1;
const MAX_RADIUS = 60;

function setMass(body, mass, from) {
    saveUndoForEdit("change the mass of " + body.name);
    body.mass = clamp(mass, MIN_MASS, MAX_MASS);
    if (from !== "slider") massSlider.value = sliderFromMass(body.mass);
    if (from !== "box") massInput.value = formatNumber(body.mass);
    markSystemChanged();
    refreshBodyList();
}

function setRadius(body, radius, from) {
    saveUndoForEdit("change the radius of " + body.name);
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
for (const axis of ["x", "y", "z"]) {
    document.getElementById(axis + "Input").addEventListener("change", event => {
        const body = editableBody();
        const value = Number(event.target.value);
        if (!body || event.target.value === "" || !Number.isFinite(value)) return;
        const position = { x: body.x, y: body.y, z: body.z };
        position[axis] = value;
        saveUndoForEdit("move " + body.name);
        moveBody(body, position.x, position.y, position.z);
    });
}

for (const axis of ["x", "y", "z"]) {
    document.getElementById("v" + axis + "Input").addEventListener("change", event => {
        const body = editableBody();
        const value = Number(event.target.value);
        if (!body || event.target.value === "" || !Number.isFinite(value)) return;
        saveUndoForEdit("change the velocity of " + body.name);
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
for (const input of [massInput, radiusInput, xInput, yInput, zInput, vxInput, vyInput, vzInput]) {
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
    saveUndo("make " + selectedBody.name + " orbit");
    const direction = document.getElementById("orbitDirection").value;
    const v = circularVelocity(selectedBody, selectedBody.mass, attractor,
        direction === "anticlockwise" ? ANTICLOCKWISE : CLOCKWISE);
    selectedBody.vx = v.vx;
    selectedBody.vy = v.vy;
    selectedBody.vz = v.vz;
    markSystemChanged();
    refreshLiveReadouts(true);
};

document.getElementById("deleteBodyBtn").onclick = deleteSelected;

// Buttons lose focus after a click so the Space key always means play/pause
document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (button && !button.matches(".panel-tab, .help-demo-button")) button.blur();
});

// ---------- Panels on the canvas ----------

/*
 * The Scenario and View controls panels fold away to a small labeled tab.
 * The arrow on the tab points the way the panel will go when clicked.
 * Whether View controls is open is remembered in this browser (if it allows).
 */
function setPanelOpen(panel, open) {
    panel.classList.toggle("collapsed", !open);
    const tab = panel.querySelector(".canvas-panel-tab");
    tab.setAttribute("aria-expanded", String(open));
    const opensUp = panel.classList.contains("opens-up");
    tab.querySelector(".chevron").textContent = open === opensUp ? "\u25BE" : "\u25B4"; // ▾ or ▴
}

const CONTROLS_OPEN_KEY = "gravitylab.controlsOpen";

for (const panel of document.querySelectorAll(".canvas-panel")) {
    panel.querySelector(".canvas-panel-tab").addEventListener("click", () => {
        const open = panel.classList.contains("collapsed");
        setPanelOpen(panel, open);
        if (panel.id === "controlsPanel") {
            try {
                localStorage.setItem(CONTROLS_OPEN_KEY, open ? "1" : "0");
            } catch (error) {
                // storage not available (private window etc.): just don't remember
            }
        }
    });
}

// View controls start open on big screens and closed on phones, unless the
// visitor chose before
(() => {
    let saved = null;
    try {
        saved = localStorage.getItem(CONTROLS_OPEN_KEY);
    } catch (error) {
        // storage not available
    }
    setPanelOpen(document.getElementById("controlsPanel"),
        saved === null ? window.innerWidth > 600 : saved === "1");
})();

// ---------- Keyboard shortcuts ----------

const MOVE_KEYS = { w: "forward", a: "left", s: "back", d: "right", q: "up", z: "down" };

window.addEventListener("keyup", event => {
    const move = MOVE_KEYS[event.key.toLowerCase()];
    if (move) held.delete(move);
});

// Switching to another window: let go of every held key
window.addEventListener("blur", () => held.clear());

// The buttons on the canvas: hold one down to keep moving
document.querySelectorAll("#navPad button[data-move]").forEach(btn => {
    const move = btn.dataset.move;
    const stop = () => {
        held.delete(move);
        btn.classList.remove("held");
    };
    btn.addEventListener("pointerdown", event => {
        held.add(move);
        btn.classList.add("held");
        try {
            btn.setPointerCapture(event.pointerId);
        } catch (error) {
            // already gone
        }
    });
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointercancel", stop);
    btn.addEventListener("lostpointercapture", stop);
});

document.getElementById("navFit").onclick = () => fitView();

window.addEventListener("keydown", event => {
    const target = event.target;
    // Typing in a box or using a menu: leave the keys alone
    const typing = target.tagName === "SELECT" ||
        (target.tagName === "INPUT" && target.type === "number");
    if (typing) return;
    // A slider uses the arrow keys (and Page Up/Down, Home, End) itself;
    // every other shortcut still works after dragging one
    const sliderKey = event.key.startsWith("Arrow") || ["PageUp", "PageDown", "Home", "End"].includes(event.key);
    if (target.tagName === "INPUT" && target.type === "range" && sliderKey) return;

    // Ctrl+Z undo; Ctrl+Shift+Z or Ctrl+Y redo (Cmd instead of Ctrl on a Mac)
    if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase();
        if (key === "z" || key === "y") {
            event.preventDefault();
            if (key === "y" || event.shiftKey) redo();
            else undo();
        }
        return;
    }

    // W A S D slide the view, Q / Z move it up and down, for as long as they're held
    const move = MOVE_KEYS[event.key.toLowerCase()];
    if (move && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        held.add(move);
        return;
    }

    // Arrow keys turn the view (handy while placing bodies, when dragging throws them)
    const turn = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
    if (turn) {
        event.preventDefault();
        rotateView(...turn);
        return;
    }

    if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
    } else if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelected();
    } else if (event.key === "Escape" && !optionsPanel.classList.contains("hidden")) {
        // Esc closes the Options menu first
        setOptionsOpen(false);
    } else if (event.key === "Escape") {
        cancelPointer();
        setTool("observe");
        selectBody(null);
    } else if (event.key === "m" || event.key === "M") {
        setTool("move");
    } else if (event.key === "t" || event.key === "T") {
        toggleTopView();
    } else if (event.key === "r" || event.key === "R") {
        startScenario(currentScenario, "reset");
    } else if (event.key === "f" || event.key === "F") {
        fitView();
    } else if (event.key === "e" || event.key === "E") {
        showPanelTab(activeTab === "equations" ? "controls" : "equations");
    } else if (/^[1-9]$/.test(event.key) && Number(event.key) <= BRUSH_KEYS.length) {
        // Pressing the key of the active tool again goes back to Observe
        setTool(BRUSH_KEYS[Number(event.key) - 1]);
    }
});


/* ==========================================================================
   7. MAIN LOOP
   ========================================================================== */

let lastFrameTime = null;

// Smoothed timings for the performance readout (milliseconds per frame)
const perf = { fps: 60, physicsMs: 0, drawMs: 0 };

function frame(now) {
    // Real elapsed time, so the simulation runs the same speed on 60 Hz and 120 Hz screens
    const realElapsed = lastFrameTime === null ? 16.7 : now - lastFrameTime;
    const elapsed = Math.min(realElapsed, 50);
    lastFrameTime = now;
    perf.fps = perf.fps * 0.95 + 1000 / Math.max(realElapsed, 1) * 0.05;

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
        perf.physicsMs = perf.physicsMs * 0.9 + (performance.now() - physicsStart) * 0.1;

        // Smoothed "how much of the requested speed are we managing?"
        const expected = simulationSpeed * STEPS_PER_SECOND * elapsed / 1000;
        if (expected > 0) speedRatio = speedRatio * 0.95 + Math.min(1, done / expected) * 0.05;

        if (done > 0) {
            recordTrails();
            recordEnergy();
            // A body held by the mouse isn't free, so energy isn't conserved
            // while it's held: start measuring the drift again after it's let go
            if (pointer && pointer.mode === "drag" && pointer.body.held) energyBaseline = null;
        }
    }

    moveHeld(elapsed);

    // "Slowly turn the view": the camera drifts round, for showing off
    if (options.spinView && !pointer) camera.yaw += elapsed * 0.00006;

    updateCameraFollow();
    const drawStart = performance.now();
    render();
    perf.drawMs = perf.drawMs * 0.9 + (performance.now() - drawStart) * 0.1;
    if (!running) perf.physicsMs *= 0.9;

    frameCount++;
    // Merges change the body list; rebuilding it is slow-ish, so a few times a second is plenty
    if (frameCount % 15 === 0 && bodyListDirty) {
        refreshBodyList();
        updateProperties();
    }
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
updateHint();
updateCursor();
requestAnimationFrame(frame);
