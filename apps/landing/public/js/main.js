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
  // Decisión del Jefe (07/10): sin ahorro de AsePsico. Suma las horas a la semana que escribe la
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
      input.id = id; input.name = t.id; input.type = 'number'; input.inputMode = 'decimal';
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

      inputs.push({ input: input, err: err, seg: seg, li: li, pct: pct, nameEl: li.childNodes[1], name: t.label, max: MAX_H });
    });

    // Filas opcionales "Otra tarea" (hasta SAVINGS.OTHER_TASKS): nombre de la actividad + horas.
    // El nombre solo se pinta en la leyenda, con textContent y como mucho OTHER_NAME_MAX caracteres.
    var othersBox = box.querySelector('[data-sv-others]');
    var othersList = box.querySelector('[data-sv-others-list]');
    var addBtn = box.querySelector('[data-sv-add]');
    var MAX_OTHERS = typeof SAVINGS.OTHER_TASKS === 'number' ? SAVINGS.OTHER_TASKS : 3;
    var NAME_MAX = SAVINGS.OTHER_NAME_MAX || 40;
    var others = [];
    function addOther() {
      if (others.length >= MAX_OTHERS) return null;
      var n = others.length + 1;
      var id = 'sv-o' + n;
      var row = el('div', 'sfield sfield--other');
      row.setAttribute('role', 'group');
      var title = el('p', 'sfield__title', 'Otra tarea' + (MAX_OTHERS > 1 ? ' ' + n : '') + ' (opcional)');
      title.id = id + '-title';
      row.setAttribute('aria-labelledby', title.id);
      row.appendChild(title);
      var pair = el('div', 'sfield__pair');
      function sub(labelText, input, errId) {
        var wrap = el('div', 'sfield__sub');
        var lab = el('label', '', labelText);
        lab.htmlFor = input.id;
        wrap.appendChild(lab);
        wrap.appendChild(input);
        var err = el('p', 'sfield__err');
        err.id = errId; err.hidden = true;
        wrap.appendChild(err);
        input.setAttribute('aria-describedby', 'sv-o-help ' + errId);
        pair.appendChild(wrap);
        return err;
      }
      var name = el('input');
      name.id = id + '-name'; name.type = 'text'; name.maxLength = NAME_MAX; name.autocomplete = 'off';
      name.spellcheck = false; name.placeholder = 'p. ej. redes sociales';
      var hours = el('input');
      hours.id = id + '-h'; hours.type = 'number'; hours.inputMode = 'decimal'; hours.min = '0';
      hours.max = String(MAX_H); hours.step = '0.5'; hours.autocomplete = 'off';
      var nameErr = sub('Qué tarea es', name, id + '-name-err');
      var hoursErr = sub('Horas a la semana', hours, id + '-h-err');
      row.appendChild(pair);
      othersList.appendChild(row);

      var seg = document.createElementNS(donut.namespaceURI, 'circle');
      seg.setAttribute('class', 'donut__seg donut__seg--other' + n);
      seg.setAttribute('cx', '60'); seg.setAttribute('cy', '60'); seg.setAttribute('r', '44');
      seg.setAttribute('pathLength', '100'); seg.setAttribute('stroke-dasharray', '0 100');
      donut.appendChild(seg);
      var li = el('li');
      li.hidden = true;
      li.appendChild(el('span', 'donut__key donut__key--other' + n));
      li.firstChild.setAttribute('aria-hidden', 'true');
      var nameEl = el('span', 'donut__name');
      li.appendChild(nameEl);
      var pct = el('span', 'donut__val');
      li.appendChild(pct);
      legend.appendChild(li);

      var f = { input: hours, err: hoursErr, nameInput: name, nameErr: nameErr, seg: seg, li: li, pct: pct,
        nameEl: nameEl, name: '', max: MAX_H, other: true };
      inputs.push(f);
      others.push(f);
      name.addEventListener('input', update);
      hours.addEventListener('input', update);
      if (addBtn) addBtn.hidden = others.length >= MAX_OTHERS;
      return f;
    }
    if (othersBox && MAX_OTHERS > 0 && othersList) {
      addOther();
      if (addBtn) addBtn.addEventListener('click', function () {
        var f = addOther();
        if (f) { f.nameInput.focus(); update(); }
      });
    } else if (othersBox) {
      othersBox.remove();
    }
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
      if (f.other) {
        // Si se rellena uno de los dos campos, el otro es obligatorio; mientras falte, la fila no suma.
        var nm = f.nameInput.value.trim().slice(0, NAME_MAX);
        var hasHours = raw !== '' || badInput;
        f.name = nm;
        setErr(f.nameInput, f.nameErr, hasHours && !nm ? 'Escribe qué tarea es.' : '');
        if (!hasHours) { setErr(f.input, f.err, nm ? 'Escribe las horas a la semana.' : ''); return 0; }
        setErr(f.input, f.err, bad ? 'Escribe un número entre 0 y ' + f.max + '.' : '');
        if (!nm || !isFinite(v) || v <= 0) return 0;
        return Math.min(v, f.max);
      }
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
        if (f.other) f.nameEl.textContent = f.name;
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
    inputs.forEach(function (f) { if (f.input && !f.other) f.input.addEventListener('input', update); });
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
      document.addEventListener('keydown', onKey);
    }
    function close(fromKeyboard) {
      if (root.hidden) return;
      var hadFocus = card.contains(document.activeElement);
      root.hidden = true;
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
    // Al pulsar "Apuntarme" se abre el formulario en otra pestaña y el aviso se cierra.
    var cta = root.querySelector('[data-lead-cta]');
    if (cta) cta.addEventListener('click', function () { setTimeout(function () { close(false); }, 0); });
    // Si la persona ya ha ido al formulario desde otro botón, no se le vuelve a ofrecer.
    document.querySelectorAll('a[data-cta]').forEach(function (a) {
      if (a !== cta) a.addEventListener('click', function () { shown = true; window.removeEventListener('scroll', onScroll); });
    });

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
