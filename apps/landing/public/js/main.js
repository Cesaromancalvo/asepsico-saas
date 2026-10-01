/*
 * AsePsico · landing. JavaScript mínimo, sin dependencias ni peticiones de red.
 * La página funciona sin él: los enlaces llevan su href y las respuestas se ven abiertas.
 * No toca la URL (las UTM se quedan tal cual para que Plausible las lea).
 */
(function () {
  'use strict';

  var cfg = window.ASEPSICO_CONFIG || {};
  var features = cfg.FEATURES || {};

  /* 1. Interruptores de bloques ---------------------------------------- */
  function applyFeatures() {
    // Bloques presentes en el HTML: se quitan si su interruptor está apagado.
    document.querySelectorAll('[data-feature]').forEach(function (el) {
      if (features[el.getAttribute('data-feature')] !== true) el.remove();
    });
    // Calculadora: vive en un <template> y solo se inserta si está encendida.
    var slot = document.querySelector('[data-slot="calculadora"]');
    var tpl = document.getElementById('tpl-calculadora');
    if (slot && tpl && features.calculadora === true) {
      slot.replaceWith(tpl.content.cloneNode(true));
      initCalculator();
    }
  }

  /* 2. Enlaces a la lista de espera y contacto -------------------------- */
  function applyLinks() {
    if (cfg.FORM_URL) {
      document.querySelectorAll('a[data-cta]').forEach(function (a) {
        a.href = cfg.FORM_URL;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      });
    }
    var email = (cfg.CONTACT_EMAIL || '').trim();
    if (email) {
      document.querySelectorAll('[data-contact]').forEach(function (li) { li.hidden = false; });
      document.querySelectorAll('[data-contact-link]').forEach(function (a) { a.href = 'mailto:' + email; });
      document.querySelectorAll('[data-contact-text]').forEach(function (el) { el.textContent = email; });
    }
  }

  /* 3. Preguntas frecuentes (acordeón) ---------------------------------- */
  function initFaq() {
    document.querySelectorAll('[data-faq] .faq__q').forEach(function (btn) {
      var panel = document.getElementById(btn.getAttribute('aria-controls'));
      if (!panel) return;
      btn.setAttribute('aria-expanded', 'false');
      panel.hidden = true;
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!open));
        panel.hidden = open;
      });
    });
  }

  /* 4. Mockup animado del hero ------------------------------------------ */
  function initMock() {
    var mock = document.querySelector('[data-mock]');
    if (!mock) return;
    var screens = Array.prototype.slice.call(mock.querySelectorAll('[data-screen]'));
    var steps = Array.prototype.slice.call(mock.querySelectorAll('[data-step]'));
    var toggle = mock.querySelector('[data-mock-toggle]');
    var toggleLabel = mock.querySelector('[data-mock-toggle-label]');
    var appName = mock.querySelector('[data-mock-app]');
    var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    var STATIC_INDEX = 1; // C2 (ficha con la tarea) cuando no hay animación
    var DURATION = 3000;
    var index = STATIC_INDEX;
    var timer = null;
    var userPaused = false;

    function show(i) {
      index = (i + screens.length) % screens.length;
      screens.forEach(function (s, n) { s.classList.toggle('is-active', n === index); });
      steps.forEach(function (s, n) { s.classList.toggle('is-on', n === index); });
      if (appName) appName.textContent = screens[index].getAttribute('data-app') || 'AsePsico';
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function start() {
      stop();
      if (motion.matches || userPaused || document.hidden) return;
      timer = setInterval(function () { show(index + 1); }, DURATION);
    }
    function setPaused(paused) {
      userPaused = paused;
      mock.classList.toggle('is-paused', paused);
      toggle.setAttribute('aria-pressed', String(paused));
      toggleLabel.textContent = paused ? 'Reanudar la animación' : 'Pausar la animación';
      if (paused) stop(); else start();
    }
    function applyMotionPreference() {
      if (motion.matches) {
        stop();
        toggle.hidden = true;
        show(STATIC_INDEX);
      } else {
        toggle.hidden = false;
        if (!userPaused) show(0);
        start();
      }
    }

    toggle.addEventListener('click', function () { setPaused(!userPaused); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
    if (motion.addEventListener) motion.addEventListener('change', applyMotionPreference);
    else if (motion.addListener) motion.addListener(applyMotionPreference);
    applyMotionPreference();
  }

  /* 5. Calculadora (solo si está encendida) ----------------------------- */
  // Todo ocurre en el navegador: no se envía, no se guarda y no va a la analítica.
  function initCalculator() {
    var inputs = document.querySelectorAll('[data-calc]');
    var out = document.querySelector('[data-calc-out]');
    if (!inputs.length || !out) return;
    function update() {
      var weekly = 0;
      inputs.forEach(function (input) {
        var v = parseFloat(String(input.value).replace(',', '.'));
        if (isFinite(v) && v > 0) weekly += Math.min(v, 80);
      });
      if (weekly <= 0) { out.textContent = ''; return; }
      var monthly = Math.round(weekly * 4.3);
      out.textContent = 'Unas ' + monthly + (monthly === 1 ? ' hora' : ' horas') +
        ' al mes en tareas que no salen en la agenda.';
    }
    inputs.forEach(function (input) { input.addEventListener('input', update); });
  }

  function init() {
    applyFeatures();
    applyLinks();
    initFaq();
    initMock();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
