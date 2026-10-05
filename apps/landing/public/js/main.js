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
    // Bloques presentes en el HTML: se muestran si su interruptor está encendido y se quitan si no.
    // Los que van apagados por defecto llevan `hidden` en el HTML (respaldo sin JavaScript).
    var pricing = (cfg.PRICING_TEXT || '').trim();
    document.querySelectorAll('[data-pricing-text]').forEach(function (el) { el.textContent = pricing; });
    document.querySelectorAll('[data-feature]').forEach(function (el) {
      var name = el.getAttribute('data-feature');
      var on = features[name] === true && (name !== 'pricingDetails' || pricing !== '');
      if (on) el.hidden = false;
      else el.remove();
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
    }
    // Política de privacidad del formulario (ruta de la propia web o URL https).
    var policy = (cfg.FORM_PRIVACY_URL || '').trim();
    if (/^(\/|https:\/\/)/.test(policy)) {
      document.querySelectorAll('[data-form-privacy]').forEach(function (a) { a.href = policy; });
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

  /* 6. Aviso al entrar ---------------------------------------------------- */
  // Aparece una vez por visita a los 8 s o al 50 % del scroll (lo que ocurra antes).
  // Sin cookies ni almacenamiento: si se recarga la página, puede volver a salir.
  function initLeadPopup() {
    var root = document.querySelector('[data-lead]');
    if (!root) return;
    var title = (cfg.POPUP_TITLE || '').trim();
    if (features.leadPopup !== true || !title) { root.remove(); return; }
    root.querySelector('[data-lead-title]').textContent = title;
    var card = root.querySelector('[data-lead-card]');
    var DELAY = 8000;
    var shown = false;
    var lastFocus = null;
    var timer = null;

    function focusables() {
      return Array.prototype.filter.call(
        card.querySelectorAll('a[href], button:not([disabled])'),
        function (el) { return el.offsetParent !== null; }
      );
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      var items = focusables();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === card)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
    function onPointer(e) {
      if (!card.contains(e.target)) close();
    }
    function onFocusIn(e) {
      if (!card.contains(e.target)) card.focus();
    }
    function cleanupTriggers() {
      if (timer) { clearTimeout(timer); timer = null; }
      window.removeEventListener('scroll', onScroll);
    }
    function open() {
      if (shown) return;
      shown = true;
      cleanupTriggers();
      lastFocus = document.activeElement;
      root.hidden = false;
      card.focus();
      document.addEventListener('keydown', onKey);
      document.addEventListener('pointerdown', onPointer);
      document.addEventListener('focusin', onFocusIn);
    }
    function close() {
      if (root.hidden) return;
      root.hidden = true;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('focusin', onFocusIn);
      if (lastFocus && typeof lastFocus.focus === 'function' && lastFocus !== document.body) {
        lastFocus.focus();
      }
    }
    function onScroll() {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (max > 0 && window.scrollY / max >= 0.5) open();
    }

    root.querySelectorAll('[data-lead-close]').forEach(function (b) { b.addEventListener('click', close); });
    // Al pulsar "Apuntarme" se abre el formulario en otra pestaña y el aviso se cierra.
    var cta = root.querySelector('[data-lead-cta]');
    if (cta) cta.addEventListener('click', function () { setTimeout(close, 0); });
    // Si la persona ya ha ido al formulario desde otro botón, no se le vuelve a ofrecer.
    document.querySelectorAll('a[data-cta]').forEach(function (a) {
      if (a !== cta) a.addEventListener('click', function () { shown = true; cleanupTriggers(); });
    });

    timer = setTimeout(open, DELAY);
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function init() {
    applyFeatures();
    applyLinks();
    initFaq();
    initMock();
    initLeadPopup();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
