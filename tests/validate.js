/*
 * lumi physics validation
 *
 * Every check compares the simulator against an answer worked out
 * independently (textbook formulas or published results). The results are
 * explained in VALIDATION.md.
 *
 * How to run (needs Node.js 18 or newer):
 *     npm install playwright
 *     npx playwright install chromium
 *     node tests/validate.js
 * It opens index.html in a hidden browser and takes a few minutes.
 */
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.stack));
  await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
  await page.waitForTimeout(400);
  page.setDefaultTimeout(0);

  const results = await page.evaluate(() => {
    const out = [];
    const add = (group, name, expected, measured, tolerance, pass, note = '') => out.push({ group, name, expected, measured, tolerance, pass, note });
    const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
    const parse = t => Number(t.replace(/−/g, '-').replace(/,/g, '').replace(/×10([⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+)/, (_, e) => 'e' + e.replace(/./g, c => ({ '⁻': '-', '⁰': 0, '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9 })[c])));
    // Fresh empty system with exactly these bodies
    const setup = list => { loadScenario('empty'); running = false; for (const b of list) addBody(b); markSystemChanged(); };
    // Angle swept by b around c in b's orbital plane, to measure periods
    const lapTime = (b, c, laps = 1, maxT = 1e5) => {
      const h = orbitAround(b, c); const hn = Math.hypot(h.hx, h.hy, h.hz) || 1;
      const nx = (h.hx ?? 0) / hn, ny = (h.hy ?? 0) / hn, nz = (h.hz ?? 1) / hn;
      const rel0 = [b.x - c.x, b.y - c.y, b.z - c.z];
      const ux = rel0.map(v => v / Math.hypot(...rel0));
      const uy = [ny * ux[2] - nz * ux[1], nz * ux[0] - nx * ux[2], nx * ux[1] - ny * ux[0]];
      const ang = () => { const r = [b.x - c.x, b.y - c.y, b.z - c.z]; return Math.atan2(r[0] * uy[0] + r[1] * uy[1] + r[2] * uy[2], r[0] * ux[0] + r[1] * ux[1] + r[2] * ux[2]); };
      let prev = ang(), total = 0; const t0 = simTime;
      while (Math.abs(total) < laps * 2 * Math.PI && simTime - t0 < maxT) {
        physicsStep(); const a = ang(); let d = a - prev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; total += d; prev = a;
      }
      return (simTime - t0) / laps;
    };

    // ===== 1. Equations tab numbers vs independent calculation
    loadScenario('solar'); running = false;
    for (let i = 0; i < 200; i++) physicsStep();
    for (const name of ['Cinder', 'Frost', 'Goliath', 'Pebble']) {
      const b = bodies.find(x => x.name === name);
      selectBody(b); referenceId = null; showPanelTab('equations'); equationsKey = null; refreshEquations();
      const other = referenceBody(b);
      const get = k => parse(document.querySelector(`#equationCards [data-v="${k}"]`).textContent);
      const dx = other.x - b.x, dy = other.y - b.y, dz = other.z - b.z, r = Math.hypot(dx, dy, dz), e2 = softening ** 2;
      let ax = 0, ay = 0, az = 0, phi = 0;
      for (const o of bodies) if (o !== b) { const d = [o.x - b.x, o.y - b.y, o.z - b.z]; const s2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 + e2; const f = G * o.mass / (s2 * Math.sqrt(s2)); ax += d[0] * f; ay += d[1] * f; az += d[2] * f; phi -= G * o.mass / Math.sqrt(s2); }
      const v = Math.hypot(b.vx, b.vy, b.vz), mu = G * (b.mass + other.mass);
      const vr = Math.hypot(b.vx - other.vx, b.vy - other.vy, b.vz - other.vz), E = vr * vr / 2 - mu / r, a = -mu / (2 * E);
      const expect = {
        F: G * other.mass * b.mass / r ** 2, Fsoft: G * other.mass * b.mass * r / (r * r + e2) ** 1.5,
        aOther: G * other.mass / r ** 2, aBack: G * b.mass / r ** 2, aNet: Math.hypot(ax, ay, az), Fnet: b.mass * Math.hypot(ax, ay, az),
        v, p: b.mass * v, KE: 0.5 * b.mass * v * v, Upair: -G * other.mass * b.mass / r, Usoft: -G * other.mass * b.mass / Math.sqrt(r * r + e2),
        U: b.mass * phi, vCirc: Math.sqrt(mu / r), vEsc: Math.sqrt(2 * mu / r), energy: E, axis: a, period: 2 * Math.PI * Math.sqrt(a ** 3 / mu)
      };
      let worst = 0, worstKey = '';
      for (const [k, val] of Object.entries(expect)) { const e = rel(get(k), val); if (e > worst) { worst = e; worstKey = k; } }
      // Values are shown to 3 significant figures, so they can be up to 0.5% off by rounding
      add('Equations tab', `All ${Object.keys(expect).length} numbers for ${name} (vs ${other.name})`, 'independent calculation', `worst ${(worst * 100).toFixed(2)}% (${worstKey})`, '< 0.5% (3 significant figures)', worst < 0.005);
    }
    showPanelTab('controls');

    // ===== 2. Kepler's laws: predicted period vs simulated
    // With real gravity (softening turned almost off) the period must match Kepler exactly
    for (const [label, e, tilt] of [['circle', 0, 0], ['ellipse, e = 0.6', 0.6, 0], ['ellipse, e = 0.6, tilted 40°', 0.6, 40]]) {
      const a = 200, M = 10000, rp = a * (1 - e);
      const vp = Math.sqrt(G * M * (2 / rp - 1 / a)); // vis-viva at the closest point
      const t = tilt * Math.PI / 180;
      setup([{ type: 'star', name: 'Sun', x: 0, y: 0, mass: M }, { type: 'moon', name: 'Test', x: rp, y: 0, z: 0, vx: 0, vy: vp * Math.cos(t), vz: vp * Math.sin(t), mass: 0.001, radius: 1 }]);
      softening = 0.01; timeStep = 0.02; markSystemChanged();
      const [sun, test] = bodies;
      const predicted = orbitAround(test, sun).period;
      const measured = lapTime(test, sun, 1);
      add("Kepler's laws", `Period, real gravity (ε ≈ 0): ${label}`, predicted.toFixed(2), measured.toFixed(2), '< 0.1%', rel(measured, predicted) < 0.001, `${(rel(measured, predicted) * 100).toFixed(3)}% off`);
    }
    // With the simulator's softening (ε = 5) a close-diving orbit is slower, by an amount we can predict
    {
      const a = 200, M = 10000, e = 0.6, rp = a * (1 - e), vp = Math.sqrt(G * M * (2 / rp - 1 / a));
      setup([{ type: 'star', name: 'Sun', x: 0, y: 0, mass: M }, { type: 'moon', name: 'Test', x: rp, y: 0, vx: 0, vy: vp, mass: 0.001, radius: 1 }]);
      const [sun, test] = bodies;
      const mu = G * (M + 0.001);
      const kepler = orbitAround(test, sun).period;
      // Same launch, but with the softened potential energy -mu / sqrt(r^2 + eps^2)
      const energy = vp * vp / 2 - mu / Math.sqrt(rp * rp + softening * softening);
      const aSoft = -mu / (2 * energy), predicted = 2 * Math.PI * Math.sqrt(aSoft ** 3 / mu);
      const measured = lapTime(test, sun, 1);
      add("Kepler's laws", 'Period with softening ε = 5 (e = 0.6, comes within 80)', `${predicted.toFixed(2)} (Kepler with softened energy; plain Kepler says ${kepler.toFixed(2)})`, measured.toFixed(2), '< 0.5%', rel(measured, predicted) < 0.005,
        `${(rel(measured, kepler) * 100).toFixed(2)}% slower than plain Kepler, as softening predicts`);
    }
    // 3rd law: T^2 / a^3 is the same for every orbit (four light planets, nothing else pulling)
    {
      const M = 10000;
      const radii = [70, 120, 200, 320];
      setup([{ type: 'star', name: 'Sun', x: 0, y: 0, mass: M }, ...radii.map((r, i) => ({ type: 'moon', name: 'P' + i, x: r, y: 0, vx: 0, vy: -Math.sqrt(G * M / r), mass: 1e-6, radius: 0.5 }))]);
      softening = 0.01; timeStep = 0.05; markSystemChanged();
      const ratios = radii.map((r, i) => { const p = bodies[i + 1], s = bodies[0]; const o = orbitAround(p, s); const snapshot = bodies.map(b => ({ ...b })); const T = lapTime(p, s, 1); bodies = snapshot.map(b => ({ ...b, trail: [] })); markSystemChanged(); return T * T / o.a ** 3; });
      const ideal = 4 * Math.PI ** 2 / (G * M);
      const worst = Math.max(...ratios.map(x => rel(x, ideal)));
      add("Kepler's laws", 'T² / a³ is the same for orbits of radius 70, 120, 200 and 320', `4π² / GM = ${ideal.toFixed(6)}`, ratios.map(x => x.toFixed(6)).join(', '), '< 0.2%', worst < 0.002, `worst ${(worst * 100).toFixed(3)}% off`);
    }
    // The real Solar System scenario, with every planet pulling on every other
    loadScenario('solar'); running = false;
    {
      const rows = ['Cinder', 'Rosa', 'Azure', 'Frost'].map(n => {
        loadScenario('solar'); running = false;
        const p = bodies.find(b => b.name === n), s = bodies.find(b => b.name === 'Sol');
        const o = orbitAround(p, s); const T = lapTime(p, s, 1);
        return `${n} ${(rel(T, o.period) * 100).toFixed(1)}%`;
      });
      add("Kepler's laws", 'Solar System scenario: measured laps vs two-body Kepler', 'close, but not exact', rows.join(', '), 'info: other planets pull too', true, 'Frost is most affected: it is the closest planet to the giant Goliath');
    }

    // ===== 3. Escape speed: just below stays bound and turns back at the predicted farthest point; just above escapes
    for (const f of [0.95, 1.02]) {
      const M = 10000, r0 = 200, vEsc = Math.sqrt(2 * G * M / r0);
      setup([{ type: 'star', name: 'Sun', x: 0, y: 0, mass: M }, { type: 'moon', name: 'Probe', x: r0, y: 0, vx: 0, vy: f * vEsc, mass: 0.001, radius: 1 }]);
      const [sun, probe] = bodies;
      const o = orbitAround(probe, sun);
      let rMax = 0, turned = false, prevR = r0;
      for (let i = 0; i < 400000 && !turned; i++) { physicsStep(); const r = Math.hypot(probe.x - sun.x, probe.y - sun.y); if (r > rMax) rMax = r; if (r < prevR && r > r0 * 2) turned = true; prevR = r; if (r > 30000) break; }
      if (f < 1) {
        const apo = o.a * (1 + o.e);
        add('Escape speed', `Launched at ${f} × escape speed`, `bound, turns back at ${apo.toFixed(0)}`, turned ? `turned back at ${rMax.toFixed(0)}` : 'did not turn back', 'farthest point < 1% off', turned && rel(rMax, apo) < 0.01);
      } else {
        add('Escape speed', `Launched at ${f} × escape speed`, 'escapes (never turns back)', turned ? 'turned back' : `still leaving at r = ${rMax.toFixed(0)}`, 'never turns back', !turned && o.energy > 0);
      }
    }

    // ===== 4. "Make it orbit" gives a circle
    setup([{ type: 'star', name: 'Sun', x: 0, y: 0 }, { type: 'planet', name: 'P', x: 0, y: 150, z: 40 }]);
    selectBody(bodies[1]); document.getElementById('orbitDirection').value = 'clockwise'; document.getElementById('orbitBtn').click();
    { const [sun, p] = bodies; const r0 = Math.hypot(p.x - sun.x, p.y - sun.y, p.z - sun.z); let worst = 0; const T = orbitAround(p, sun).period; const t0 = simTime; while (simTime - t0 < T) { physicsStep(); worst = Math.max(worst, rel(Math.hypot(p.x - sun.x, p.y - sun.y, p.z - sun.z), r0)); }
      add('Circular orbits', '"Make it orbit" keeps the same distance for a whole lap', 'constant distance', `varies by ${(worst * 100).toFixed(3)}%`, '< 0.5%', worst < 0.005); }

    // ===== 5. Conservation laws
    loadScenario('sunPlanet'); running = false;
    { const E0 = measureEnergy(bodies).total; const T = orbitAround(bodies[1], bodies[0]).period; const t0 = simTime; let worst = 0;
      while (simTime - t0 < 10 * T) { physicsStep(); worst = Math.max(worst, rel(measureEnergy(bodies).total, E0)); }
      add('Energy', 'Velocity Verlet: energy over 10 laps (Star & Planet)', 'constant', `max change ${(worst * 100).toExponential(1)}%`, '< 0.01%', worst < 1e-4); }
    loadScenario('sunPlanet'); running = false; integrator = 'euler';
    { const p = bodies[1], s = bodies[0]; const r0 = Math.hypot(p.x - s.x, p.y - s.y); const E0 = measureEnergy(bodies).total; const T = orbitAround(p, s).period; const t0 = simTime; while (simTime - t0 < 10 * T) physicsStep();
      const r1 = Math.hypot(p.x - s.x, p.y - s.y), E1 = measureEnergy(bodies).total;
      add('Energy', 'Euler: the planet spirals outward (as "How it works" says)', 'distance and energy grow', `distance ${r0.toFixed(1)} → ${r1.toFixed(1)}, energy ${E0.toFixed(1)} → ${E1.toFixed(1)}`, 'both increase', r1 > r0 * 1.01 && E1 > E0); }
    integrator = 'verlet';
    for (const [sc, steps, solver] of [['figure8', 3000, 'Direct'], ['binary', 3000, 'Direct'], ['galaxies', 600, 'Barnes-Hut']]) {
      loadScenario(sc); running = false;
      const mom = () => { let px = 0, py = 0, pz = 0, s = 0; for (const b of bodies) { px += b.mass * b.vx; py += b.mass * b.vy; pz += b.mass * b.vz; s += b.mass * Math.hypot(b.vx, b.vy, b.vz); } return Math.hypot(px, py, pz) / s; };
      const E0 = measureEnergy(bodies);
      for (let i = 0; i < steps; i++) physicsStep();
      const E1 = measureEnergy(bodies);
      const drift = Math.abs(E1.total - E0.total) / (E0.kinetic + Math.abs(E0.potential));
      add('Energy', `${sc} (${solver}), ${steps} steps`, 'constant', `changed by ${(drift * 100).toFixed(4)}%`, sc === 'galaxies' ? '< 0.5%' : '< 0.01%', drift < (sc === 'galaxies' ? 5e-3 : 1e-4));
      add('Momentum', `${sc} (${solver}), ${steps} steps`, '0 (starts at 0)', `${mom().toExponential(1)} of the total`, '< 1e-12 (rounding only)', mom() < 1e-12,
        solver === 'Direct' ? 'Each pair pulls equally both ways (3rd law), so momentum is exact' : 'Barnes-Hut alone is not exact (3e-3 before the fix); the leftover total force is now removed every step');
    }

    // ===== 6. Collisions: mass and momentum exact, energy bookkeeping right
    setup([{ type: 'planet', name: 'A', x: -30, y: 0, vx: 1.5, vy: 0.3, mass: 20, radius: 6 }, { type: 'planet', name: 'B', x: 30, y: 5, vx: -1, vy: 0, mass: 12, radius: 5 }]);
    { const m0 = 32, p0 = [20 * 1.5 + 12 * -1, 20 * 0.3, 0]; const E0 = measureEnergy(bodies).total;
      recordEnergy(); const base0 = energyBaseline.total;
      let i = 0; while (bodies.length === 2 && i++ < 10000) physicsStep();
      const b = bodies[0]; const p1 = [b.mass * b.vx, b.mass * b.vy, b.mass * b.vz];
      const E1 = measureEnergy(bodies).total;
      add('Collisions', 'Mass after merging', '32', String(b.mass), 'exact', b.mass === m0);
      add('Collisions', 'Momentum after merging', p0.map(x => x.toFixed(4)).join(', '), p1.map(x => x.toFixed(4)).join(', '), '< 1e-9', Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) < 1e-9);
      const accounted = Math.abs(E1 - energyBaseline.total) / Math.abs(E0);
      add('Collisions', 'Energy lost as heat is fully accounted for in the drift readout', 'drift ≈ 0 after a merge', `${(accounted * 100).toFixed(4)}% unexplained`, '< 0.1%', accounted < 1e-3, `heat: ${(base0 - energyBaseline.total).toFixed(2)} energy units`); }

    // ===== 7. Figure-8: known period
    loadScenario('figure8'); running = false;
    { const L = 150, M = 1000, T = 6.32591398 * Math.sqrt(L ** 3 / (G * M));
      const start = bodies.map(b => [b.x, b.y]); const t0 = simTime; let best = Infinity, bestT = 0;
      while (simTime - t0 < 1.1 * T) { physicsStep(); if (simTime - t0 > 0.9 * T) { const d = bodies.reduce((s, b, i) => s + Math.hypot(b.x - start[i][0], b.y - start[i][1]), 0); if (d < best) { best = d; bestT = simTime - t0; } } }
      add('Known solutions', 'Figure-8 three-body orbit: time to come back to the start', `${T.toFixed(1)} (Chenciner & Montgomery 2000)`, bestT.toFixed(1), '< 1%', rel(bestT, T) < 0.01, `${(rel(bestT, T) * 100).toFixed(2)}% off; returns within ${(best / 3).toFixed(1)} units of the start`); }

    // ===== 8. Barnes-Hut accuracy vs the exact Direct method
    for (const sc of ['galaxies', 'planetFormation']) {
      loadScenario(sc); running = false;
      computeForcesDirect(bodies, false); const exact = bodies.map(b => [b.ax, b.ay, b.az]);
      for (const th of [0.3, 0.6, 1.0]) {
        theta = th; computeForcesTree(bodies, false);
        const errs = bodies.map((b, i) => Math.hypot(b.ax - exact[i][0], b.ay - exact[i][1], b.az - exact[i][2]) / Math.hypot(...exact[i])).sort((a, b) => a - b);
        const mean = errs.reduce((s, x) => s + x, 0) / errs.length, p99 = errs[Math.floor(errs.length * 0.99)];
        add('Barnes-Hut', `${sc}, θ = ${th}: force error vs Direct`, 'small, growing with θ', `mean ${(mean * 100).toFixed(3)}%, 99% of bodies under ${(p99 * 100).toFixed(2)}%`, th <= 0.6 ? 'mean < 0.5%' : 'mean < 2%', mean < (th <= 0.6 ? 0.005 : 0.02));
      }
      theta = 0.6;
    }

    // ===== 9. Scenario claims
    loadScenario('slingshot'); running = false;
    { const sun = bodies.find(b => b.name === 'Sun'), probe = bodies.find(b => b.name === 'Probe'); const e0 = orbitAround(probe, sun).energy; let tEsc = null;
      for (let i = 0; i < 60000 && tEsc === null && bodies.includes(probe); i++) { physicsStep(); if (orbitAround(probe, sun).energy > 0 && Math.hypot(probe.x - sun.x, probe.y - sun.y) > 500) tEsc = simTime; }
      add('Scenarios', 'Gravity Assist: the probe starts trapped, then gains energy and escapes', 'energy goes from negative to positive', tEsc ? `from ${e0.toFixed(1)} to positive by t = ${tEsc.toFixed(0)}` : 'did not escape', 'escapes', tEsc !== null); }
    loadScenario('galaxies'); running = false;
    { const cores = bodies.filter(b => b.type === 'blackhole'); const blue = bodies.filter(b => b.name.startsWith('Blue') && b.type === 'galaxyStar'), gold = bodies.filter(b => b.name.startsWith('Gold') && b.type === 'galaxyStar');
      const E0 = measureEnergy(bodies); while (simTime < 450) physicsStep(); const E1 = measureEnergy(bodies);
      const far = (stars, core) => stars.filter(s => Math.hypot(s.x - core.x, s.y - core.y, s.z - core.z) > 300).length / stars.length;
      const fb = far(blue, cores[0]), fg = far(gold, cores[1]);
      add('Scenarios', 'Galaxy Collision: prograde (blue) galaxy throws out more stars into tails than retrograde (gold)', 'blue > gold', `stars beyond 300: blue ${(fb * 100).toFixed(0)}%, gold ${(fg * 100).toFixed(0)}%`, 'blue clearly more', fb > fg * 1.5);
      const drift = Math.abs(E1.total - E0.total) / (E0.kinetic + Math.abs(E0.potential));
      add('Scenarios', 'Galaxy Collision: energy drift through the first close pass', '~0.1–0.4% (stated in the scenario)', `${(drift * 100).toFixed(2)}%`, '< 0.5%', drift < 0.005); }
    return out;
  });
  let failures = 0, group = '';
  for (const r of results) {
    if (r.group !== group) { group = r.group; console.log('\n## ' + group); }
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      expected: ${r.expected} | measured: ${r.measured} | tolerance: ${r.tolerance}${r.note ? ' | ' + r.note : ''}`);
    if (!r.pass) failures++;
  }
  console.log(`\n${results.length} checks, ${failures} failed.${errors.length ? ' Page errors: ' + errors.join(' | ') : ''}`);
  await browser.close();
  process.exit(failures || errors.length ? 1 : 0);
})();
