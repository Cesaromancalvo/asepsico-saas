/*
 * AsePsico · landing. JavaScript mínimo, sin dependencias.
 * La única petición de red es la del formulario de la lista de espera (bloque 8) a la API propia
 * (cfg.WAITLIST_API_URL), y solo cuando alguien lo usa. Sin cookies ni almacenamiento.
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
  // Con FEATURES.ownWaitlistForm encendido, los botones llevan a la sección #apuntate (es su href en
  // el HTML). Apagado (red de seguridad), vuelven al Google Form en una pestaña nueva, con la política v1.
  function ownForm() {
    return features.ownWaitlistForm === true && !!document.getElementById('apuntate');
  }
  function applyLinks() {
    var own = ownForm();
    if (!own && /^https:\/\//.test(cfg.FORM_URL || '')) {
      document.querySelectorAll('a[data-cta]').forEach(function (a) {
        a.href = cfg.FORM_URL;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        var hint = document.createElement('span');
        hint.className = 'visually-hidden';
        hint.textContent = ' (se abre en una pestaña nueva)';
        a.appendChild(hint);
      });
    }
    var email = (cfg.CONTACT_EMAIL || '').trim();
    if (email) {
      document.querySelectorAll('[data-contact]').forEach(function (li) { li.hidden = false; });
      document.querySelectorAll('[data-contact-link]').forEach(function (a) { a.href = 'mailto:' + email; });
    }
    // Política de privacidad del formulario (ruta de la propia web o URL https).
    var policy = ((own ? cfg.FORM_PRIVACY_URL : cfg.FORM_PRIVACY_URL_FALLBACK) || '').trim();
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
  // pila estática: texto y pantalla de cada paso, uno detrás de otro (en móvil, con una aparición
  // suave hecha solo con CSS si el navegador la admite).
  // Dos capas: (a) IntersectionObserver decide el paso activo; (b) un lector de scroll (rAF, pasivo,
  // solo mientras la sección está en pantalla) escribe tres variables CSS que mueven, con transform
  // y opacity, la anatomía (--open), la barra de progreso (--prog) y un ligero desplazamiento (--drift).
  function initStory() {
    var root = document.querySelector('[data-story]');
    if (!root || !('IntersectionObserver' in window)) return;
    var steps = Array.prototype.slice.call(root.querySelectorAll('[data-step]'));
    var dots = Array.prototype.slice.call(root.querySelectorAll('[data-dot]'));
    var mq = window.matchMedia('(min-width: 960px) and (prefers-reduced-motion: no-preference)');
    var io = null;
    var ticking = false;
    var current = '0';

    function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    function setActive(n) {
      if (root.getAttribute('data-active') === n) return;
      current = n;
      root.setAttribute('data-active', n);
      steps.forEach(function (s) { s.classList.toggle('is-current', s.getAttribute('data-step') === n); });
      dots.forEach(function (d) { d.classList.toggle('is-done', Number(d.getAttribute('data-dot')) <= Number(n)); });
    }
    function measure() {
      ticking = false;
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var box = root.getBoundingClientRect();
      if (box.bottom < -vh || box.top > vh * 2) return; // fuera de pantalla: no se toca nada
      var mid = vh / 2;
      var first = steps[1].getBoundingClientRect();
      var last = steps[steps.length - 1].getBoundingClientRect();
      // La anatomía se cierra mientras el paso 01 sube desde el pie de la pantalla hasta el centro.
      var open = clamp((first.top - mid) / (vh * 0.55));
      var prog = clamp((mid - first.top) / Math.max(last.bottom - first.top, 1));
      var drift = 0;
      if (current !== '0') {
        var cur = root.querySelector('[data-step="' + current + '"]');
        if (cur) {
          var r = cur.getBoundingClientRect();
          drift = (clamp((mid - r.top) / Math.max(r.height, 1)) - 0.5) * 2;
        }
      }
      root.style.setProperty('--open', open.toFixed(3));
      root.style.setProperty('--prog', prog.toFixed(3));
      root.style.setProperty('--drift', drift.toFixed(3));
    }
    function onScroll() {
      if (!ticking) { ticking = true; window.requestAnimationFrame(measure); }
    }
    function enable() {
      if (io) return;
      root.classList.add('is-live');
      setActive('0');
      // Franja estrecha en el centro de la pantalla: el paso que la cruza es el activo.
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) { setActive(e.target.getAttribute('data-step')); onScroll(); }
        });
      }, { rootMargin: '-48% 0px -48% 0px', threshold: 0 });
      steps.forEach(function (s) { io.observe(s); });
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
      measure();
    }
    function disable() {
      if (io) { io.disconnect(); io = null; }
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      root.classList.remove('is-live');
      root.removeAttribute('data-active');
      ['--open', '--prog', '--drift'].forEach(function (p) { root.style.removeProperty(p); });
      steps.forEach(function (s) { s.classList.remove('is-current'); });
      dots.forEach(function (d) { d.classList.remove('is-done'); });
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

  /* 6. Lo que te cuesta hoy (solo si está encendida) ---------------------- */
  // Sin ahorro de AsePsico. Suma las horas a la semana que escribe la
  // persona, las pasa al mes y, si escribe el valor de su hora, a euros. Todo ocurre en el navegador:
  // no se envía, no se guarda y no va a ninguna analítica. Las tareas viven en SAVINGS.TASKS (config.js).
  var SAVINGS = cfg.SAVINGS || {};

  function initSavings() {
    var box = document.querySelector('[data-savings]');
    var tasks = Array.isArray(SAVINGS.TASKS) ? SAVINGS.TASKS : [];
    if (!box || !tasks.length) return;
    var WEEKS_PER_MONTH = (SAVINGS.WEEKS_PER_YEAR || 46) / 12;
    var MAX_H = SAVINGS.MAX_HOURS || 40;
    var MAX_V = SAVINGS.MAX_VALUE || 500;

    var list = box.querySelector('[data-sv-tasks]');
    var legend = box.querySelector('[data-sv-legend]');
    var donut = box.querySelector('[data-sv-donut]');
    var inputs = [];

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      return n;
    }
    // Un campo, un trozo del gráfico y una línea de la leyenda por tarea.
    tasks.forEach(function (t, i) {
      var id = 'sv-' + t.id;
      var field = el('div', 'sfield');
      var label = el('label', '', t.label);
      label.htmlFor = id;
      field.appendChild(label);
      var described = [];
      if (t.help) {
        var help = el('p', 'sfield__help', t.help);
        help.id = id + '-help';
        field.appendChild(help);
        described.push(help.id);
      }
      var input = el('input');
      input.id = id; input.type = 'number'; input.inputMode = 'decimal';
      input.min = '0'; input.max = String(MAX_H); input.step = '0.5'; input.autocomplete = 'off';
      // Placeholder en gris: es solo un ejemplo y no cuenta (el campo empieza vacío).
      if (t.placeholder) input.placeholder = 'p. ej. ' + t.placeholder;
      var err = el('p', 'sfield__err');
      err.id = id + '-err'; err.hidden = true; err.setAttribute('data-sv-err', '');
      described.push(err.id);
      input.setAttribute('aria-describedby', described.join(' '));
      field.appendChild(input);
      field.appendChild(err);
      list.appendChild(field);

      var seg = document.createElementNS(donut.namespaceURI, 'circle');
      seg.setAttribute('class', 'donut__seg donut__seg--' + (i % 9));
      seg.setAttribute('cx', '60'); seg.setAttribute('cy', '60'); seg.setAttribute('r', '44');
      seg.setAttribute('pathLength', '100'); seg.setAttribute('stroke-dasharray', '0 100');
      donut.appendChild(seg);

      var li = el('li');
      li.appendChild(el('span', 'donut__key donut__key--' + (i % 9)));
      li.firstChild.setAttribute('aria-hidden', 'true');
      li.appendChild(el('span', 'donut__name', t.label));
      var pct = el('span', 'donut__val');
      li.appendChild(pct);
      legend.appendChild(li);

      inputs.push({ input: input, err: err, seg: seg, li: li, pct: pct, name: t.label, max: MAX_H });
    });

    var value = { input: box.querySelector('[data-sv-value]'), max: MAX_V };
    value.err = value.input ? value.input.parentNode.querySelector('[data-sv-err]') : null;

    var out = box.querySelector('[data-sv-out]');
    var week = box.querySelector('[data-sv-week]');
    var month = box.querySelector('[data-sv-month]');
    var eurBox = box.querySelector('[data-sv-eur]');
    var eurWeek = box.querySelector('[data-sv-eur-week]');
    var eurMonth = box.querySelector('[data-sv-eur-month]');
    var eurHint = box.querySelector('[data-sv-eur-hint]');
    var chart = box.querySelector('[data-sv-chart]');
    var form = box.querySelector('[data-savings-form]');
    if (form) form.addEventListener('submit', function (e) { e.preventDefault(); });

    // Vacío cuenta 0 sin error; texto no numérico, negativo o por encima del máximo se marca
    // (aria-invalid + mensaje) y el cálculo usa el valor acotado. Nunca NaN ni negativos.
    function setErr(input, err, msg) {
      if (msg) {
        input.setAttribute('aria-invalid', 'true');
        if (err) { err.textContent = msg; err.hidden = false; }
      } else {
        input.removeAttribute('aria-invalid');
        if (err) { err.textContent = ''; err.hidden = true; }
      }
    }
    function read(f) {
      if (!f.input) return 0;
      var raw = String(f.input.value).trim();
      var badInput = f.input.validity && f.input.validity.badInput;
      var v = raw === '' ? 0 : parseFloat(raw.replace(',', '.'));
      var bad = badInput || !isFinite(v) || v < 0 || v > f.max;
      setErr(f.input, f.err, bad ? 'Escribe un número entre 0 y ' + f.max + '.' : '');
      if (!isFinite(v) || v <= 0) return 0;
      return Math.min(v, f.max);
    }
    function floorHalf(h) { return Math.floor(h * 2 + 1e-9) / 2; }
    function oneDecimal(h) { return Math.round(h * 10) / 10; }
    function fmtN(n) {
      var parts = String(n).split('.');
      return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (parts[1] ? ',' + parts[1] : '');
    }
    function hoursText(h) { return fmtN(h) + (h === 1 ? ' hora' : ' horas'); }
    // Porcentajes enteros que suman 100 (método del mayor resto).
    function percents(values) {
      var sum = values.reduce(function (s, v) { return s + v; }, 0);
      if (sum <= 0) return values.map(function () { return 0; });
      var raw = values.map(function (v) { return (v / sum) * 100; });
      var base = raw.map(Math.floor);
      var left = 100 - base.reduce(function (s, v) { return s + v; }, 0);
      raw.map(function (v, i) { return { i: i, r: v - base[i] }; })
        .sort(function (x, y) { return y.r - x.r; })
        .slice(0, left).forEach(function (o) { base[o.i] += 1; });
      return base;
    }

    function update() {
      var hrs = inputs.map(read);
      var v = Math.floor(read(value));
      var w = oneDecimal(hrs.reduce(function (s, h) { return s + h; }, 0));
      var m = floorHalf(w * WEEKS_PER_MONTH);

      if (w <= 0) {
        week.textContent = '0 h';
        month.textContent = '0 h';
        eurBox.hidden = true;
        eurHint.hidden = false;
        chart.hidden = true;
        out.textContent = 'Escribe tus horas para ver el resultado.';
        return;
      }
      week.textContent = fmtN(w) + ' h';
      month.textContent = fmtN(m) + ' h';
      var summary = 'A la semana, ' + hoursText(w) + '; al mes, ' + hoursText(m) + '.';

      if (v > 0) {
        eurWeek.textContent = 'Equivale a ' + fmtN(Math.floor(w * v)) + ' € a la semana';
        eurMonth.textContent = 'y ' + fmtN(Math.floor(m * v)) + ' € al mes.';
        eurBox.hidden = false;
        eurHint.hidden = true;
        summary += ' Equivale a ' + fmtN(Math.floor(w * v)) + ' euros a la semana y ' + fmtN(Math.floor(m * v)) + ' euros al mes.';
      } else {
        eurBox.hidden = true;
        eurHint.hidden = false;
      }

      // Gráfico: cada parte es un arco del círculo (pathLength = 100); un pequeño hueco las separa.
      var shares = percents(hrs);
      var visible = shares.filter(function (p) { return p > 0; }).length;
      var gap = visible > 1 ? 1 : 0;
      var start = 0;
      var parts = [];
      inputs.forEach(function (f, i) {
        var len = Math.max(shares[i] - gap, 0);
        f.seg.setAttribute('stroke-dasharray', len + ' ' + (100 - len));
        f.seg.setAttribute('stroke-dashoffset', String(-start));
        start += shares[i];
        f.pct.textContent = shares[i] + ' %';
        f.li.hidden = hrs[i] <= 0;
        if (hrs[i] > 0) parts.push(f.name + ', ' + shares[i] + ' %');
      });
      chart.hidden = false;
      out.textContent = summary + ' Reparto: ' + parts.join('; ') + '.';
    }
    inputs.forEach(function (f) { f.input.addEventListener('input', update); });
    if (value.input) value.input.addEventListener('input', update);
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

  /* 7. Aviso de la lista de espera ------------------------------------------ */
  // Sale una vez por visita, solo al pasar el 50 % del scroll (sin temporizador: nunca tapa el
  // contenido al entrar, criterio de intersticial intrusivo de Google). No es modal: no roba el foco
  // ni bloquea la página; en móvil es una barra pequeña abajo. Se cierra con la X, "Ahora no" o Esc.
  // Sin cookies ni almacenamiento: si se recarga la página, puede volver a salir.
  function initLeadPopup() {
    var root = document.querySelector('[data-lead]');
    if (!root) return;
    var title = (cfg.POPUP_TITLE || '').trim();
    if (features.leadPopup !== true || !title) { root.remove(); return; }
    root.querySelector('[data-lead-title]').textContent = title;
    var card = root.querySelector('[data-lead-card]');
    var shown = false;

    function onKey(e) {
      if (e.key === 'Escape' && card.contains(document.activeElement)) { e.preventDefault(); close(true); }
    }
    function open() {
      if (shown) return;
      shown = true;
      window.removeEventListener('scroll', onScroll);
      root.hidden = false;
      document.body.classList.add('has-leadbar');
      document.addEventListener('keydown', onKey);
    }
    function close(fromKeyboard) {
      if (root.hidden) return;
      var hadFocus = card.contains(document.activeElement);
      root.hidden = true;
      document.body.classList.remove('has-leadbar');
      document.removeEventListener('keydown', onKey);
      // Si el foco estaba en el aviso, se lleva al contenido principal para no perderlo.
      if (hadFocus || fromKeyboard) {
        var main = document.getElementById('contenido');
        if (main) { main.setAttribute('tabindex', '-1'); main.focus({ preventScroll: true }); }
      }
    }
    function onScroll() {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (max > 0 && window.scrollY / max >= 0.5) open();
    }

    root.querySelectorAll('[data-lead-close]').forEach(function (b) { b.addEventListener('click', function () { close(false); }); });
    // Al pulsar "Apuntarme" se va al formulario (sección #apuntate o Google Form) y el aviso se cierra.
    var cta = root.querySelector('[data-lead-cta]');
    if (cta) cta.addEventListener('click', function () { setTimeout(function () { close(false); }, 0); });
    // Si la persona ya ha ido al formulario desde otro botón, no se le vuelve a ofrecer.
    document.querySelectorAll('a[data-cta]').forEach(function (a) {
      if (a !== cta) a.addEventListener('click', function () { shown = true; window.removeEventListener('scroll', onScroll); });
    });

    // Mientras la calculadora está en pantalla, el aviso se aparta (sin cerrarse) para no tapar las
    // cifras ni la salvedad de los euros. Al salir de ella, vuelve si no se había cerrado.
    // Lo mismo con el formulario de la lista de espera: no tiene sentido ofrecerlo encima de él.
    var away = ['estimacion', 'apuntate'].map(function (id) { return document.getElementById(id); })
      .filter(Boolean);
    if (away.length && 'IntersectionObserver' in window) {
      var inView = {};
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { inView[e.target.id] = e.isIntersecting; });
        root.classList.toggle('is-away', Object.keys(inView).some(function (k) { return inView[k]; }));
      }, { threshold: 0 });
      away.forEach(function (el) { obs.observe(el); });
    }

    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* 8. Formulario propio de la lista de espera ------------------------------- */
  // Contrato: docs/WAITLIST_API.md. Todo con fetch (CSP: connect-src a la API y form-action 'none'),
  // sin cookies (credentials: 'omit') y sin guardar nada en el navegador. El token se pide la primera
  // vez que se enfoca el formulario (no al cargar la página) y no se envía antes de minSeconds.
  // Tras el 202 se muestra siempre el mismo mensaje: nunca se dice si el email ya estaba apuntado.
  function initWaitlist() {
    var section = document.getElementById('apuntate');
    if (!section || features.ownWaitlistForm !== true) return;
    var form = section.querySelector('[data-waitlist-form]');
    var fields = section.querySelector('[data-waitlist-fields]');
    var nojs = section.querySelector('[data-waitlist-nojs]');
    var done = section.querySelector('[data-wl-done]');
    var status = section.querySelector('[data-wl-status]');
    var submit = section.querySelector('[data-wl-submit]');
    var countWrap = section.querySelector('[data-wl-count-wrap]');
    if (!form || !fields || !done || !status || !submit) return;

    var api = String(cfg.WAITLIST_API_URL || '').trim().replace(/\/+$/, '');
    var version = String(cfg.WAITLIST_POLICY_VERSION || '').trim();
    // Solo https (o http a localhost para probar en local con la API de desarrollo).
    var apiOk = /^https:\/\/[a-z0-9.-]+(:\d+)?(\/|$)/i.test(api) ||
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(api);
    if (!apiOk || !version || !window.fetch || !window.Promise || !window.JSON) return; // queda el aviso sin JS

    var email = String(cfg.CONTACT_EMAIL || '').trim() || 'asepsico1@gmail.com';
    var TIMEOUT_MS = 30000;            // Render puede tardar en despertar
    var TOKEN_MAX_AGE_MS = 110 * 60000; // el token caduca a las 2 h: se renueva antes
    var MSG = {
      sending: 'Enviando tus datos…',
      slow: 'Enviando tus datos… El servidor puede tardar unos segundos en responder.',
      invalid: 'Revisa los campos marcados.',
      rejected: 'No hemos podido apuntarte con esos datos. Revisa el formulario e inténtalo de nuevo.',
      tooMany: 'Has hecho demasiados intentos. Prueba de nuevo en unos minutos.',
      network: 'No hemos podido conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo en unos segundos. Si sigue sin funcionar, escríbenos a ' + email + '.',
      generic: 'Algo ha fallado al enviar el formulario. Inténtalo de nuevo más tarde o escríbenos a ' + email + '.'
    };

    var token = null;
    var tokenAt = 0;
    var minMs = 3000;
    var tokenPromise = null;
    var busy = false;

    function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

    // Petición JSON con timeout. Devuelve { status, body } o rechaza con un error de red.
    function request(path, opts) {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
      var init = {
        method: opts.method,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: opts.headers,
        body: opts.body
      };
      if (ctrl) init.signal = ctrl.signal;
      function clear() { if (timer) clearTimeout(timer); }
      return fetch(api + path, init).then(function (res) {
        return res.text().then(function (txt) {
          clear();
          var body = null;
          try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = null; }
          return { status: res.status, body: body };
        });
      }, function (err) { clear(); throw err; });
    }

    function getToken(force) {
      if (!force && token && Date.now() - tokenAt < TOKEN_MAX_AGE_MS) return Promise.resolve();
      if (tokenPromise) return tokenPromise;
      tokenPromise = request('/public/waitlist/form-token', { method: 'GET', headers: { Accept: 'application/json' } })
        .then(function (r) {
          tokenPromise = null;
          if (r.status === 200 && r.body && typeof r.body.formToken === 'string' && r.body.formToken) {
            token = r.body.formToken;
            tokenAt = Date.now();
            var s = Number(r.body.minSeconds);
            minMs = (isFinite(s) && s >= 0 && s <= 60 ? s : 3) * 1000;
            return;
          }
          var e = new Error('form-token'); e.httpStatus = r.status; throw e;
        }, function (err) { tokenPromise = null; throw err; });
      return tokenPromise;
    }

    // Espera lo que falte para cumplir minSeconds desde que se emitió el token (con un margen).
    function waitMin() {
      var left = tokenAt + minMs + 300 - Date.now();
      return left > 0 ? delay(left) : Promise.resolve();
    }

    function post(payload, retried) {
      return getToken(false).then(waitMin).then(function () {
        payload.formToken = token;
        return request('/public/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload)
        });
      }).then(function (r) {
        var code = r.status === 400 && r.body && r.body.code;
        if (!retried && code === 'WAITLIST_FORM_TOO_FAST') {
          return delay(minMs + 300).then(function () { return post(payload, true); });
        }
        if (!retried && code === 'WAITLIST_FORM_TOKEN_INVALID') {
          token = null;
          return getToken(true).then(function () { return post(payload, true); });
        }
        // Respuesta final (202, 400, 403, 413, 415, 429, 5xx): el token no se reutiliza nunca; el
        // siguiente envío pide otro (y vuelve a esperar minSeconds). Solo un fallo de red lo conserva.
        token = null;
        tokenAt = 0;
        return r;
      });
    }

    /* Validación en el navegador, con las mismas reglas que la API. */
    function q(sel) { return form.querySelector(sel); }
    var inName = q('#wl-name');
    var inEmail = q('#wl-email');
    var inCount = q('#wl-count');
    var inTools = q('#wl-tools');
    var inSource = q('#wl-source');
    var inHp = q('#wl-website');
    var inPrivacy = q('#wl-privacy');
    var inCommercial = q('#wl-commercial');
    var situationGroup = q('[data-wl-group="situation"]');
    var radios = Array.prototype.slice.call(form.querySelectorAll('input[name="situation"]'));

    function errEl(id) { return document.getElementById(id); }
    function setError(target, errId, msg) {
      var err = errEl(errId);
      if (err) { err.textContent = msg || ''; err.hidden = !msg; }
      var list = target === situationGroup ? radios : [target];
      list.forEach(function (el) {
        if (msg) el.setAttribute('aria-invalid', 'true');
        else el.removeAttribute('aria-invalid');
      });
      if (target === situationGroup) situationGroup.classList.toggle('is-invalid', !!msg);
    }
    function situation() {
      for (var i = 0; i < radios.length; i++) if (radios[i].checked) return radios[i].value;
      return '';
    }
    function syncCount() {
      if (!countWrap) return;
      var show = situation() === 'PRACTICE';
      countWrap.hidden = !show;
      if (!show && inCount) { inCount.value = ''; setError(inCount, 'wl-count-err', ''); }
    }

    function validate() {
      var bad = [];
      var name = inName.value.trim().replace(/\s+/g, ' ');
      var mail = inEmail.value.trim();
      var sit = situation();
      var tools = inTools.value.trim();
      var countRaw = inCount && !countWrap.hidden ? inCount.value.trim() : '';

      var nameMsg = name.length < 2 ? 'Escribe tu nombre (al menos 2 letras).' :
        name.length > 120 ? 'El nombre puede tener como máximo 120 caracteres.' : '';
      setError(inName, 'wl-name-err', nameMsg); if (nameMsg) bad.push(inName);

      var mailMsg = !mail ? 'Escribe tu email.' :
        (mail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(mail)) ? 'Escribe un email válido, por ejemplo nombre@dominio.es.' : '';
      setError(inEmail, 'wl-email-err', mailMsg); if (mailMsg) bad.push(inEmail);

      var sitMsg = sit ? '' : 'Elige tu situación.';
      setError(situationGroup, 'wl-situation-err', sitMsg); if (sitMsg) bad.push(radios[0]);

      var count = null;
      var countMsg = '';
      if (countRaw) {
        count = Number(countRaw);
        if (!/^\d+$/.test(countRaw) || count < 1 || count > 500) countMsg = 'Escribe un número entero entre 1 y 500, o déjalo vacío.';
      }
      if (inCount) { setError(inCount, 'wl-count-err', countMsg); if (countMsg) bad.push(inCount); }

      var toolsMsg = tools.length > 500 ? 'Puedes escribir como máximo 500 caracteres.' : '';
      setError(inTools, 'wl-tools-err', toolsMsg); if (toolsMsg) bad.push(inTools);

      var privMsg = inPrivacy.checked ? '' : 'Para apuntarte, marca la casilla de privacidad: es obligatoria.';
      setError(inPrivacy, 'wl-privacy-err', privMsg); if (privMsg) bad.push(inPrivacy);

      if (bad.length) { bad[0].focus(); return null; }

      var payload = {
        name: name,
        email: mail,
        situation: sit,
        privacyAccepted: true,
        privacyPolicyVersion: version,
        commercialConsentRequested: inCommercial.checked === true,
        website: inHp ? inHp.value : ''
      };
      if (tools) payload.tools = tools;
      if (count !== null && !countMsg) payload.professionalsCount = count;
      if (inSource && inSource.value) payload.source = inSource.value;
      return payload;
    }

    function say(msg, kind) {
      status.textContent = msg || '';
      status.className = 'wl-status' + (kind ? ' wl-status--' + kind : '');
    }
    function setBusy(on) {
      busy = on;
      form.setAttribute('aria-busy', on ? 'true' : 'false');
      submit.setAttribute('aria-disabled', on ? 'true' : 'false');
      submit.textContent = on ? 'Enviando…' : 'Apuntarme a la lista de espera';
    }
    function showDone(commercial) {
      var c = done.querySelector('[data-wl-done-commercial]');
      if (c) c.hidden = !commercial;
      form.reset();
      form.hidden = true;
      done.hidden = false;
      done.focus();
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      say('');
      var payload = validate();
      if (!payload) { say(MSG.invalid, 'error'); return; }
      setBusy(true);
      say(MSG.sending);
      var slowTimer = setTimeout(function () { if (busy) say(MSG.slow); }, 6000);
      post(payload, false).then(function (r) {
        if (r.status === 202) { say(''); showDone(payload.commercialConsentRequested); return; }
        if (r.status === 429) { say(MSG.tooMany, 'error'); return; }
        if (r.status === 400) { say(MSG.rejected, 'error'); return; }
        say(MSG.generic, 'error');
      }, function (err) {
        if (err && err.httpStatus === 429) say(MSG.tooMany, 'error');
        else if (err && err.httpStatus) say(MSG.generic, 'error');
        else say(MSG.network, 'error');
      }).then(function () {
        clearTimeout(slowTimer);
        setBusy(false);
      });
    });

    // Primer foco en el formulario: se pide el token (si falla, se reintenta al enviar).
    form.addEventListener('focusin', function () {
      getToken(false).then(null, function () { /* se reintenta al enviar */ });
    });

    radios.forEach(function (r) {
      r.addEventListener('change', function () { syncCount(); setError(situationGroup, 'wl-situation-err', ''); });
    });
    [inName, inEmail, inCount, inTools].forEach(function (el) {
      if (el) el.addEventListener('input', function () {
        if (el.getAttribute('aria-invalid') === 'true') setError(el, el.getAttribute('aria-describedby').split(' ').pop(), '');
      });
    });
    inPrivacy.addEventListener('change', function () { if (inPrivacy.checked) setError(inPrivacy, 'wl-privacy-err', ''); });

    // Los botones "Apúntate" llevan aquí y ponen el foco en el primer campo (o en el mensaje final).
    document.querySelectorAll('a[data-cta]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        var target = done.hidden ? inName : done;
        try { target.focus({ preventScroll: true }); } catch (err) { target.focus(); }
      });
    });

    // Listo: se activa el formulario y se quita el aviso para navegadores sin JavaScript.
    syncCount();
    if (nojs) nojs.hidden = true;
    fields.disabled = false;
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
    safe(initWaitlist);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
