
const canvas = document.getElementById("universe");
const ctx = canvas.getContext("2d");

const G = 1;
const dt = 0.1;

let bodies = [];
let selectedBody = null;
let running = true;
let simulationSpeed = 1;
let showTrails = true;
let nextId = 1;

// Resize canvas
function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
}

resizeCanvas();

// Create a celestial body
function createBody(name, x, y, mass, radius, vx, vy, color) {
    return {
        id: nextId++,
        name,
        x,
        y,
        mass,
        radius,
        vx,
        vy,
        color,
        trail: []
    };
}

// Initialize our solar system
function initializeUniverse() {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    nextId = 1;

    bodies = [
        createBody(
            "Star", cx, cy,
            10000, 25,
            0, 0, "#fbbf24"
        ),
        createBody(
            "Planet", cx + 150, cy,
            10, 10,
            0, -Math.sqrt(G * 10000 / 150),
            "#38bdf8"
        )
    ];

    selectedBody = null;
    running = true;

    updateBodyList();
    updateProperties();
    updatePlayButton();
}

// Calculate gravity between every body

function calculateAccelerations() {
    return bodies.map(body => {
        let ax = 0;
        let ay = 0;

        for (const other of bodies) {
            if (body.id === other.id) continue;

            const dx = other.x - body.x;
            const dy = other.y - body.y;

            const softening = 5;

            const distanceSquared =
                dx * dx + dy * dy +
                softening * softening;

            const distance = Math.sqrt(distanceSquared);

            const factor =
                G * other.mass /
                (distanceSquared * distance);

            ax += factor * dx;
            ay += factor * dy;
        }

        return { ax, ay };
    });
}

function updatePhysics() {

    // Step 1: Calculate acceleration at current positions
    const oldAccelerations = calculateAccelerations();

    // Step 2: Half-step velocity, then full-step position
    bodies.forEach((body, i) => {
        body.vx += oldAccelerations[i].ax * dt / 2;
        body.vy += oldAccelerations[i].ay * dt / 2;

        body.x += body.vx * dt;
        body.y += body.vy * dt;
    });

    // Step 3: Recalculate acceleration at new positions
    const newAccelerations = calculateAccelerations();

    // Step 4: Complete the velocity update
    bodies.forEach((body, i) => {
        body.vx += newAccelerations[i].ax * dt / 2;
        body.vy += newAccelerations[i].ay * dt / 2;

        body.trail.push({
            x: body.x,
            y: body.y
        });

        if (body.trail.length > 1000) {
            body.trail.shift();
        }
    });
}

// Draw a celestial body
function drawBody(body) {
    ctx.beginPath();

    ctx.arc(
        body.x,
        body.y,
        body.radius,
        0,
        Math.PI * 2
    );

    ctx.fillStyle = body.color;
    ctx.fill();

    if (selectedBody === body) {
        ctx.strokeStyle = "white";
        ctx.lineWidth = 2;
        ctx.stroke();
    }
}

// Draw orbital trails
function drawTrails() {
    if (!showTrails) return;

    for (const body of bodies) {
        if (body.trail.length < 2) continue;

        ctx.beginPath();
        ctx.moveTo(body.trail[0].x, body.trail[0].y);

        for (const point of body.trail) {
            ctx.lineTo(point.x, point.y);
        }

        ctx.strokeStyle = body.color;
        ctx.lineWidth = 1;
        ctx.stroke();
    }
}

// Main animation loop
function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (running) {
        // Multiple physics steps per frame
        const steps = Math.max(
            1,
            Math.round(simulationSpeed * 5)
        );

        for (let i = 0; i < steps; i++) {
            updatePhysics();
        }
    }

    drawTrails();

    for (const body of bodies) {
        drawBody(body);
    }

    requestAnimationFrame(animate);
}

// Update the sidebar list
function updateBodyList() {
    const list = document.getElementById("bodyList");
    list.innerHTML = "";

    for (const body of bodies) {
        const item = document.createElement("div");

        item.className = "body-item";
        item.textContent = body.name;

        if (selectedBody === body) {
            item.classList.add("selected");
        }

        item.onclick = () => selectBody(body);

        list.appendChild(item);
    }
}

// Select a body

function selectBody(body) {
    selectedBody = body;

    // Automatically pause when selecting a body
    running = false;
    updatePlayButton();

    updateBodyList();
    updateProperties();
}

// Update the properties panel
function updateProperties() {
    const panel = document.getElementById("bodyProperties");
    const name = document.getElementById("selectedBodyName");

    if (!selectedBody) {
        panel.classList.add("hidden");
        name.textContent = "Select a celestial body";
        return;
    }

    panel.classList.remove("hidden");
    name.textContent = selectedBody.name;

    document.getElementById("massSlider").value =
        selectedBody.mass;

    document.getElementById("radiusSlider").value =
        selectedBody.radius;

    document.getElementById("vxInput").value =
        selectedBody.vx.toFixed(2);

    document.getElementById("vyInput").value =
        selectedBody.vy.toFixed(2);

    document.getElementById("massValue").textContent =
        selectedBody.mass;

    document.getElementById("radiusValue").textContent =
        selectedBody.radius;
}

// Add a new planet

document.getElementById("addBodyBtn").onclick = () => {

    const star = bodies.find(body => body.name === "Star");

    if (!star) {
        alert("A star is required to create an orbit.");
        return;
    }

    // Spawn the planet 200 units to the right of the star
    const x = star.x + 200;
    const y = star.y;

    // Calculate distance from star
    const dx = x - star.x;
    const dy = y - star.y;

    const distance = Math.sqrt(dx * dx + dy * dy);

    // Calculate circular orbital speed
    const orbitalSpeed = Math.sqrt(
        G * star.mass / distance
    );

    // Tangential velocity (perpendicular to radius)
    const vx = star.vx + orbitalSpeed * dy / distance;
    const vy = star.vy - orbitalSpeed * dx / distance;

    const body = createBody(
        "Planet " + nextId,
        x,
        y,
        10,
        8,
        vx,
        vy,
        "#a78bfa"
    );

    bodies.push(body);
    selectBody(body);
};

// Mass slider
document.getElementById("massSlider").oninput = event => {
    if (!selectedBody) return;

    selectedBody.mass = Number(event.target.value);

    document.getElementById("massValue").textContent =
        selectedBody.mass;
};

// Radius slider
document.getElementById("radiusSlider").oninput = event => {
    if (!selectedBody) return;

    selectedBody.radius = Number(event.target.value);

    document.getElementById("radiusValue").textContent =
        selectedBody.radius;
};

// Velocity inputs
document.getElementById("vxInput").onchange = event => {
    if (!selectedBody) return;

    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;

    selectedBody.vx = value;
};

document.getElementById("vyInput").onchange = event => {
    if (!selectedBody) return;

    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;

    selectedBody.vy = value;
};

// Delete selected body
document.getElementById("deleteBodyBtn").onclick = () => {
    if (!selectedBody) return;

    bodies = bodies.filter(body => body !== selectedBody);

    selectedBody = null;

    updateBodyList();
    updateProperties();
};

// Play / pause
function updatePlayButton() {
    document.getElementById("playPauseBtn").textContent =
        running ? "Pause" : "Play";
}

document.getElementById("playPauseBtn").onclick = () => {
    running = !running;
    updatePlayButton();
};

// Reset simulation
document.getElementById("resetBtn").onclick = () => {
    initializeUniverse();
};

// Simulation speed
document.getElementById("speedSlider").oninput = event => {
    simulationSpeed = Number(event.target.value);

    document.getElementById("speedValue").textContent =
        simulationSpeed.toFixed(1) + "x";
};

// Toggle trails
document.getElementById("trailToggle").onchange = event => {
    showTrails = event.target.checked;
};

// Click a body on the canvas to select it
canvas.addEventListener("click", event => {
    const rect = canvas.getBoundingClientRect();

    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Search in reverse drawing order
    const clickedBody = [...bodies].reverse().find(body => {
        const dx = x - body.x;
        const dy = y - body.y;

        return Math.sqrt(dx * dx + dy * dy) <= body.radius;
    });

    if (clickedBody) {
        selectBody(clickedBody);
    }
});

// Start everything
initializeUniverse();
animate();
