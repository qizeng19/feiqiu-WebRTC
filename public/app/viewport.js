if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

export function resetViewportScroll() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

export function updateViewportHeight() {
  const viewportHeight = window.visualViewport
    ? window.visualViewport.height
    : window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${viewportHeight}px`);
}

export function initViewport() {
  resetViewportScroll();
  updateViewportHeight();
  window.addEventListener('load', resetViewportScroll);
  window.addEventListener('pageshow', resetViewportScroll);
  window.addEventListener('resize', updateViewportHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateViewportHeight);
  }
}
