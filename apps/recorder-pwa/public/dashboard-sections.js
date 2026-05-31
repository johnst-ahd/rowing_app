/**
 * Collapsible dashboard sections + fleet map fullscreen.
 */
(function () {
  const LS_SECTIONS = 'rnz_dashboard_sections';

  const $ = (sel) => document.querySelector(sel);

  function loadSectionState() {
    try {
      const raw = localStorage.getItem(LS_SECTIONS);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveSectionState(state) {
    localStorage.setItem(LS_SECTIONS, JSON.stringify(state));
  }

  function invalidateMap() {
    const map = window.dashboardFleetMap;
    if (!map) return;
    setTimeout(() => map.invalidateSize(), 80);
    setTimeout(() => map.invalidateSize(), 320);
  }

  function setSectionOpen(section, open, persist = true) {
    const id = section.dataset.sectionId;
    if (!id) return;
    const body = section.querySelector('.dashboard-section__body');
    const toggle = section.querySelector('.dashboard-section__toggle');
    section.classList.toggle('dashboard-section--open', open);
    if (body) body.hidden = !open;
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (persist) {
      const state = loadSectionState();
      state[id] = open;
      saveSectionState(state);
    }
    if (id === 'map' && open) invalidateMap();
  }

  function initSections() {
    const saved = loadSectionState();
    document.querySelectorAll('.dashboard-section[data-section-id]').forEach((section) => {
      const id = section.dataset.sectionId;
      const defaultOpen = section.dataset.defaultOpen === 'true';
      const open = Object.prototype.hasOwnProperty.call(saved, id)
        ? Boolean(saved[id])
        : defaultOpen;
      setSectionOpen(section, open, false);
    });

    document.querySelectorAll('.dashboard-section__toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const section = btn.closest('.dashboard-section');
        if (!section) return;
        const open = !section.classList.contains('dashboard-section--open');
        setSectionOpen(section, open);
      });
    });
  }

  function isMapFullscreen() {
    const stage = $('#mapStage');
    if (!stage) return false;
    return (
      document.fullscreenElement === stage ||
      stage.classList.contains('map-stage--fullscreen')
    );
  }

  function setMapFullscreen(on) {
    const stage = $('#mapStage');
    if (!stage) return;
    const bar = stage.querySelector('.map-fs-bar');
    if (on) {
      stage.classList.add('map-stage--fullscreen');
      if (bar) bar.removeAttribute('hidden');
      if (stage.requestFullscreen) {
        void stage.requestFullscreen().catch(() => {});
      }
    } else {
      stage.classList.remove('map-stage--fullscreen');
      if (bar) bar.setAttribute('hidden', '');
      if (document.fullscreenElement === stage) {
        void document.exitFullscreen().catch(() => {});
      }
    }
    invalidateMap();
  }

  function initMapFullscreen() {
    const stage = $('#mapStage');
    if (!stage) return;

    $('#mapFullscreenBtn')?.addEventListener('click', () => {
      setMapFullscreen(true);
    });
    $('#mapFullscreenExitBtn')?.addEventListener('click', () => {
      setMapFullscreen(false);
    });

    document.addEventListener('fullscreenchange', () => {
      if (!stage) return;
      if (document.fullscreenElement === stage) {
        stage.classList.add('map-stage--fullscreen');
        stage.querySelector('.map-fs-bar')?.removeAttribute('hidden');
      } else {
        stage.classList.remove('map-stage--fullscreen');
        stage.querySelector('.map-fs-bar')?.setAttribute('hidden', '');
      }
      invalidateMap();
    });
  }

  window.dashboardInitSections = function () {
    initSections();
    initMapFullscreen();
  };

  window.dashboardInvalidateMap = invalidateMap;
})();
