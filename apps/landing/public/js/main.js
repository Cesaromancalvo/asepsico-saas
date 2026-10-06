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
    // Estimación de tiempo: también vive en un <template> y solo se inserta si está encendida.
    var svSlot = document.querySelector('[data-slot="ahorro"]');
    var svTpl = document.getElementById('tpl-ahorro');
    if (svSlot && svTpl && features.savingsCalculator === true) {
      svSlot.replaceWith(svTpl.content.cloneNode(true));
      initSavings();
    } else if (svSlot) {
      svSlot.remove();
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

  /* 4. Narrativa con scroll ("Seguimiento entre sesiones") --------------- */
  // Solo en escritorio y sin "reducir movimiento". En el resto de casos (y sin JavaScript) queda la
  // pila estática: texto y pantalla de cada paso, uno detrás de otro.
  function initStory() {
    var root = document.querySelector('[data-story]');
    if (!root || !('IntersectionObserver' in window)) return;
    var steps = Array.prototype.slice.call(root.querySelectorAll('[data-step]'));
    var mq = window.matchMedia('(min-width: 960px) and (prefers-reduced-motion: no-preference)');
    var io = null;

    function setActive(n) {
      if (root.getAttribute('data-active') === n) return;
      root.setAttribute('data-active', n);
      steps.forEach(function (s) { s.classList.toggle('is-current', s.getAttribute('data-step') === n); });
    }
    function enable() {
      if (io) return;
      root.classList.add('is-live');
      setActive('0');
      // Franja estrecha en el centro de la pantalla: el paso que la cruza es el activo.
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) setActive(e.target.getAttribute('data-step')); });
      }, { rootMargin: '-48% 0px -48% 0px', threshold: 0 });
      steps.forEach(function (s) { io.observe(s); });
    }
    function disable() {
      if (io) { io.disconnect(); io = null; }
      root.classList.remove('is-live');
      root.removeAttribute('data-active');
      steps.forEach(function (s) { s.classList.remove('is-current'); });
    }
    function apply() { if (mq.matches) enable(); else disable(); }
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
    apply();
  }

  /* 5. Aparición progresiva de las secciones ------------------------------ */
  // Sin JavaScript, sin IntersectionObserver o con "reducir movimiento", todo se ve desde el principio.
  function initReveal() {
    if (!('IntersectionObserver' in window)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var items = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
    if (!items.length) return;
    document.documentElement.classList.add('js-reveal');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0 });
    items.forEach(function (el) { io.observe(el); });
    // Red de seguridad: lo que ya está por encima de la pantalla (p. ej. al entrar por un ancla) se muestra.
    window.addEventListener('load', function () {
      items.forEach(function (el) {
        if (el.getBoundingClientRect().bottom < 0) el.classList.add('is-in');
      });
    });
  }

  /* 6. Estimación de tiempo (solo si está encendida) ---------------------- */
  // Modelo de Vega: rango prudente–optimista. Todo ocurre en el navegador: no se envía, no se guarda
  // y no va a ninguna analítica.
  var SAVINGS = {
    WEEKS_PER_MONTH: 4.33,
    low: { prep: 0.15, perTask: 3, portal: 0.5, rem: 0.3 },
    high: { prep: 0.35, perTask: 7, portal: 0.8, rem: 0.6 },
    max: { s: 80, a: 120, t: 200, r: 600, v: 500 }
  };

  function initSavings() {
    var box = document.querySelector('[data-savings]');
    if (!box) return;
    var reminders = features.savingsReminders === true;
    var remField = box.querySelector('[data-sv-reminders]');
    var remRow = box.querySelector('[data-sv-row="rem"]');
    if (remField) { if (reminders) remField.hidden = false; else remField.remove(); }
    if (remRow && !reminders) remRow.remove();

    var inputs = {};
    box.querySelectorAll('[data-sv]').forEach(function (el) { inputs[el.getAttribute('data-sv')] = el; });
    var out = box.querySelector('[data-sv-out]');
    var eur = box.querySelector('[data-sv-eur]');
    var chart = box.querySelector('[data-sv-chart]');
    var form = box.querySelector('[data-savings-form]');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); });

    function read(key) {
      var el = inputs[key];
      if (!el) return 0;
      var v = parseFloat(String(el.value).replace(',', '.'));
      if (!isFinite(v) || v <= 0) return 0;
      return Math.min(v, SAVINGS.max[key]);
    }
    // Minutos a la semana de cada bloque con un juego de supuestos.
    function blocks(k, d) {
      return {
        prep: d.s * d.a * k.prep,
        tasks: k.portal * d.t * k.perTask,
        rem: reminders ? k.portal * d.r * k.rem : 0
      };
    }
    function hours(minWeek) { return minWeek * SAVINGS.WEEKS_PER_MONTH / 60; }
    function floorHalf(h) { return Math.floor(h * 2) / 2; }
    function fmtH(h) { return String(h).replace('.', ','); }
    function fmtRange(lo, hi) {
      var a = floorHalf(lo);
      var b = floorHalf(hi);
      if (b < 0.5) return 'Menos de media hora al mes';
      if (a < 0.5) return 'Hasta ' + fmtH(b) + (b === 1 ? ' hora' : ' horas') + ' al mes';
      if (a === b) return 'Unas ' + fmtH(a) + (a === 1 ? ' hora' : ' horas') + ' al mes';
      return 'Entre ' + fmtH(a) + ' y ' + fmtH(b) + ' horas al mes';
    }
    function fmtEur(n) {
      return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' €';
    }
    function shortRange(lo, hi) {
      var a = Math.round(lo * 10) / 10;
      var b = Math.round(hi * 10) / 10;
      return String(a).replace('.', ',') + '–' + String(b).replace('.', ',') + ' h';
    }
    function setBar(row, lo, hi, scale) {
      if (!row) return;
      var x1 = scale > 0 ? (lo / scale) * 100 : 0;
      var x2 = scale > 0 ? (hi / scale) * 100 : 0;
      var span = row.querySelector('[data-span]');
      var low = row.querySelector('[data-low]');
      span.setAttribute('width', String(Math.max(x2, 0)));
      low.setAttribute('width', String(Math.max(x1, 0)));
      row.querySelector('[data-val]').textContent = shortRange(lo, hi);
    }

    function update() {
      var d = { s: read('s'), a: read('a'), t: read('t'), r: reminders ? read('r') : 0 };
      var v = read('v');
      var lo = blocks(SAVINGS.low, d);
      var hi = blocks(SAVINGS.high, d);
      var loTotal = hours(lo.prep + lo.tasks + lo.rem);
      var hiTotal = hours(hi.prep + hi.tasks + hi.rem);

      if (hiTotal <= 0) {
        out.textContent = 'Rellena los campos para ver tu estimación.';
        eur.hidden = true;
        chart.hidden = true;
        return;
      }
      out.textContent = fmtRange(loTotal, hiTotal);
      chart.hidden = false;
      var scale = Math.max(hours(hi.prep), hours(hi.tasks), hours(hi.rem));
      setBar(box.querySelector('[data-sv-row="prep"]'), hours(lo.prep), hours(hi.prep), scale);
      setBar(box.querySelector('[data-sv-row="tasks"]'), hours(lo.tasks), hours(hi.tasks), scale);
      setBar(box.querySelector('[data-sv-row="rem"]'), hours(lo.rem), hours(hi.rem), scale);

      if (v > 0) {
        var eLo = floorHalf(loTotal) * v;
        var eHi = floorHalf(hiTotal) * v;
        eur.textContent = 'Con lo que vale tu hora, ese tiempo equivale a ' +
          (eLo === eHi ? fmtEur(eHi) : 'entre ' + fmtEur(eLo) + ' y ' + fmtEur(eHi)) + ' al mes.';
        eur.hidden = false;
      } else {
        eur.hidden = true;
      }
    }
    Object.keys(inputs).forEach(function (k) { inputs[k].addEventListener('input', update); });
    update();
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

  // Cada bloque va aislado: si uno falla, los demás siguen funcionando.
  function safe(fn) {
    try { fn(); } catch (e) { if (window.console) console.error(e); }
  }
  function init() {
    safe(applyFeatures);
    safe(applyLinks);
    safe(initFaq);
    safe(initStory);
    safe(initReveal);
    safe(initLeadPopup);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
