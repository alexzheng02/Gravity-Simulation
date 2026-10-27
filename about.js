/* Reveal once as each section enters the viewport. No simulator code runs here. */
(() => {
    const sections = document.querySelectorAll('.reveal');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reducedMotion.matches || !('IntersectionObserver' in window)) return;

    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
        }
    }, { threshold: 0.08, rootMargin: '0px 0px -35px 0px' });

    for (const section of sections) {
        section.classList.add('reveal-pending');
        observer.observe(section);
    }
    // Keyboard focus must never land inside invisible content.
    document.addEventListener('focusin', event => {
        event.target.closest('.reveal-pending')?.classList.add('is-visible');
    });
    reducedMotion.addEventListener('change', event => {
        if (!event.matches) return;
        observer.disconnect();
        sections.forEach(section => section.classList.add('is-visible'));
    });
})();
