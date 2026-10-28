// Manual playback avoids distracting motion while reading the guide.
document.querySelectorAll('.help-demo-button').forEach(button => {
    button.addEventListener('click', () => {
        const playing = button.getAttribute('aria-pressed') !== 'true';
        document.getElementById(button.dataset.demoImage).src = playing ? button.dataset.demoSrc : button.dataset.demoPoster;
        button.setAttribute('aria-pressed', String(playing));
        button.textContent = playing ? 'Stop demonstration ⏹' : 'Play demonstration ↗';
    });
});
// Standard tab navigation for keyboard users, without consuming canvas shortcuts.
document.querySelector('.panel-tabs').addEventListener('keydown', event => {
    if (event.code === 'Space') { event.stopPropagation(); return; }
    const tabs = [...document.querySelectorAll('.panel-tab')];
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    let next;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    tabs[next].click();
    tabs[next].focus();
});
// Reading controls use Space normally without starting or stopping the universe.
document.getElementById('tab-help').addEventListener('keydown', event => {
    if (event.code === 'Space') event.stopPropagation();
});
// Stop demos whenever the guide is closed, including the E shortcut.
document.addEventListener('paneltabchange', event => {
    if (event.detail === 'help') return;
    document.querySelectorAll('.help-demo-button[aria-pressed="true"]').forEach(button => button.click());
});
// A shareable local link can open the guide directly.
if (window.location.hash === '#help') showPanelTab('help');
