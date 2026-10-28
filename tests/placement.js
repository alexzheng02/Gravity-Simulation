/* Placement regressions. Run with Node and Playwright; optionally set BROWSER_CHANNEL=chrome. */
const { chromium } = require('playwright');
const path = require('path');
(async () => {
    const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
        const results = await page.evaluate(() => {
            const out = [];
            const check = (name, pass) => out.push({ name, pass });
            const reset = () => { loadScenario('empty'); running = false; };
            const click = (type, point) => {
                brush = type;
                const velocity = placementVelocity({ start: point, current: point, startScreen: { x: 0, y: 0 }, currentScreen: { x: 0, y: 0 } });
                return { body: placeNewBody(type, point, velocity), velocity };
            };
            const momentum = () => ['vx', 'vy', 'vz'].map(k => bodies.reduce((s, b) => s + b.mass * b[k], 0));
            const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
            reset();
            let planet = click('planet', { x: 150, y: 0, z: 0 }).body;
            const starPlacement = click('star', { x: 0, y: 0, z: 0 });
            let star = starPlacement.body;
            check('Star placed after planet has no smaller orbital host', !starPlacement.velocity.attractor);
            check('Automatic placement does not inject net momentum', momentum().every(p => Math.abs(p) < 1e-9));
            check('A new star is not assigned an artificial orbit around a lighter planet', !starPlacement.velocity.attractor && star.vx === 0 && star.vy === 0 && star.vz === 0);
            check('Existing planet keeps its original velocity when a star is added', planet.vx === 0 && planet.vy === 0 && planet.vz === 0);
            const initialDistance = distance(planet, star);
            for (let i = 0; i < 500; i++) physicsStep();
            check('Planet still falls inward under the newly added star’s gravity', bodies.length < 2 || distance(planet, star) < initialDistance * .9);

            reset();
            star = addBody({ type: 'star', x: 0, y: 0, mass: 1e6 });
            planet = addBody({ type: 'planet', x: 1000, y: 0, mass: 100, radius: 4 });
            const near = { x: 1000, y: 12, z: 0 };
            check('Moon snaps to a planet within its stable region even when the star pulls harder', dominantAttractor(near.x, near.y, 0, null) === star && placementAttractor(near, 'moon') === planet);
            check('Moon far from a planet falls back to the star', placementAttractor({ x: 1000, y: 100, z: 0 }, 'moon') === star);
            check('A planet selects the star rather than a nearby planet', placementAttractor({ x: 1000, y: 12, z: 0 }, 'planet') === star);
            reset();
            star = addBody({ type: 'star', x: 0, y: 0 });
            planet = addBody({ type: 'planet', x: 150, y: 0 });
            brush = 'moon';
            const nearPlanet = { x: 150, y: 22, z: 0 };
            const snap = placementVelocity({ start: nearPlanet, current: nearPlanet, startScreen: { x: 0, y: 0 }, currentScreen: { x: 0, y: 0 } });
            check('Nearby moon targets a default planet even when its Hill region is too small', snap.attractor === planet);
            check('Potentially unstable moon placement is flagged instead of prevented', snap.unstable === true);
            check('Overlapping host is excluded', placementAttractor({ x: 0, y: 0, z: 0 }, 'planet') !== star);

            reset();
            star = addBody({ type: 'star', x: 0, y: 0, vx: 4, vy: -3, vz: 2 });
            const oldMotion = ['vx', 'vy', 'vz'].map(k => star[k]);
            const placedPlanet = click('planet', { x: 150, y: 0, z: 0 }).body;
            check('Automatic planet placement leaves existing star motion unchanged', oldMotion.every((v, i) => star[['vx', 'vy', 'vz'][i]] === v));
            check('Automatic orbit inherits the moving host’s velocity', Math.abs(placedPlanet.vx - 4) < 1e-10 && placedPlanet.vy < -3 && placedPlanet.vz === 2);

            reset();
            star = addBody({ type: 'star', x: 0, y: 0, vx: 4, vy: -3, vz: 2 });
            const before = { ...star };
            brush = 'planet';
            const manual = placementVelocity({ start: { x: 150, y: 0, z: 0 }, current: { x: 180, y: 40, z: 10 }, startScreen: { x: 0, y: 0 }, currentScreen: { x: 30, y: 40 } });
            const thrown = placeNewBody('planet', { x: 150, y: 0, z: 0 }, manual);
            check('Drag-to-launch preserves manual velocity and leaves existing motion unchanged', !manual.auto && thrown.vx === 30 * LAUNCH_SCALE && thrown.vy === 40 * LAUNCH_SCALE && ['vx', 'vy', 'vz'].every(k => star[k] === before[k]));
            saveUndo('automatic placement');
            const snapshot = bodies.map(b => [b.id, b.vx, b.vy, b.vz]);
            click('planet', { x: -150, y: 0, z: 0 });
            undo();
            check('Undo removes placement and preserves existing velocities', JSON.stringify(bodies.map(b => [b.id, b.vx, b.vy, b.vz])) === JSON.stringify(snapshot));
            return out;
        });
        for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}`);
        if (results.some(r => !r.pass) || errors.length) throw new Error(JSON.stringify({ failed: results.filter(r => !r.pass), errors }));
    } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
