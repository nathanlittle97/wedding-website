(function () {
  "use strict";

  const cfg = window.WEDDING_CONFIG || {};
  const page = document.body.dataset.page;
  const root = document.getElementById("root");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  const TOKEN_KEY = "wedding-token";
  const NAV = [
    ["index.html", "Home", "home"],
    ["schedule.html", "Schedule", "schedule"],
    ["accommodation.html", "Accommodation", "accommodation"],
    ["faqs.html", "FAQs", "faqs"],
    ["rsvp.html", "RSVP", "rsvp"]
  ];

  // ---------- small helpers ----------

  // Builds DOM safely: all text goes through text nodes, never innerHTML.
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    kids.flat().forEach((c) => {
      if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(c));
    });
    return node;
  }

  function setStatus(el, state, text) {
    el.dataset.state = state;
    el.textContent = text;
  }

  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);

  let token = "";
  try { token = localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { /* storage unavailable */ }

  function setToken(value) {
    token = value;
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* keep the in-memory copy */ }
  }

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function api(path, options) {
    const { method = "GET", body } = options || {};
    if (!cfg.apiUrl) throw new ApiError("The site isn't connected to its server yet.", 0);
    const headers = {};
    if (token) headers.Authorization = "Bearer " + token;
    if (body) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(cfg.apiUrl.replace(/\/$/, "") + path, {
        method, headers, signal: controller.signal,
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(data.error || "Something went wrong. Please try again.", res.status);
      return data;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(err.name === "AbortError"
        ? "The request timed out. Please try again."
        : "We couldn't reach the server. Check your connection and try again.", 0);
    } finally {
      clearTimeout(timer);
    }
  }

  const cleanups = [];

  // ---------- sign-in ----------

  function showGate() {
    cleanups.splice(0).forEach((fn) => fn());
    const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
    const first = h("input", { id: "g-first", type: "text", autocomplete: "given-name", maxlength: "60", required: true });
    const last = h("input", { id: "g-last", type: "text", autocomplete: "family-name", maxlength: "60", required: true });
    const pass = h("input", { id: "g-pass", type: "password", autocomplete: "current-password", required: true });
    const button = h("button", { type: "submit", class: "primary" }, "Enter");

    const form = h("form", { novalidate: true },
      h("p", { class: "lead" }, "Enter your name as it appears on your invitation, and the password we sent you."),
      h("div", { class: "names-row" },
        h("div", { class: "field" }, h("label", { for: "g-first" }, "First name"), first),
        h("div", { class: "field" }, h("label", { for: "g-last" }, "Last name"), last)),
      h("div", { class: "field" }, h("label", { for: "g-pass" }, "Password"), pass),
      button, status);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!first.value.trim() || !last.value.trim() || !pass.value) {
        setStatus(status, "error", "Please fill in your first name, last name and the password.");
        return;
      }
      button.disabled = true;
      setStatus(status, "", "Checking...");
      try {
        const res = await api("/login", {
          method: "POST",
          body: { firstName: first.value, lastName: last.value, password: pass.value }
        });
        setToken(res.token);
        await boot();
      } catch (err) {
        setStatus(status, "error", err.message);
        button.disabled = false;
      }
    });

    root.replaceChildren(h("main", { class: "gate" },
      h("h1", {}, h("span", {}, "Nathan"), h("span", {}, "& Ashling")), form));
    first.focus();
  }

  async function signOut() {
    setToken("");
    showGate();
  }

  async function switchGuest(firstName, lastName) {
    const res = await api("/login", { method: "POST", body: { firstName, lastName } });
    setToken(res.token);
    await boot();
    window.scrollTo(0, 0);
  }

  // ---------- shared layout ----------

  function layout(data, main) {
    const name = data.guest.firstName + " " + data.guest.lastName;
    return [
      h("header", { class: "site-header" },
        h("a", { class: "brand", href: "index.html" }, "Nathan & Ashling"),
        h("nav", { "aria-label": "Main" },
          NAV.map(([href, label, id]) => h("a", { href, "aria-current": id === page ? "page" : false }, label)))),
      main,
      h("footer", { class: "foot" },
        h("p", {}, "Signed in as " + name + ". ", h("button", { type: "button", class: "text-button", onclick: signOut }, "Sign out")))
    ];
  }

  const pageHead = (title) => h("div", { class: "page-head" }, h("h1", {}, title));

  // ---------- home and slideshow ----------

  function slideshow(slides) {
    const track = h("div", { class: "slides", tabindex: "0", role: "region", "aria-label": "Photo slideshow" },
      slides.map((s) => h("figure", { class: "slide" }, h("img", { src: s.src, alt: s.alt || "", loading: "lazy" }))));

    let timer = null;
    let playing = !reduceMotion;

    const go = (dir) => {
      const w = track.firstElementChild.offsetWidth + (parseFloat(getComputedStyle(track).columnGap) || 0);
      const atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
      let i = Math.round(track.scrollLeft / w) + dir;
      if (dir > 0 && atEnd) i = 0;
      if (i < 0) i = slides.length - 1;
      track.scrollTo({ left: i * w, behavior: reduceMotion ? "auto" : "smooth" });
    };
    const stop = () => { clearInterval(timer); timer = null; };
    const start = () => { stop(); if (playing) timer = setInterval(() => go(1), 4500); };

    const playBtn = h("button", { type: "button", class: "text-button" }, playing ? "Pause slideshow" : "Play slideshow");
    playBtn.addEventListener("click", () => {
      playing = !playing;
      playBtn.textContent = playing ? "Pause slideshow" : "Play slideshow";
      start();
    });

    const wrap = h("section", { class: "slideshow", "aria-label": "Photos" }, track,
      h("div", { class: "slide-controls" },
        h("button", { type: "button", class: "text-button", onclick: () => go(-1) }, "Previous"),
        h("button", { type: "button", class: "text-button", onclick: () => go(1) }, "Next"),
        playBtn));

    wrap.addEventListener("pointerenter", stop);
    wrap.addEventListener("pointerleave", start);
    wrap.addEventListener("focusin", stop);
    wrap.addEventListener("focusout", start);
    cleanups.push(stop);
    start();
    return wrap;
  }

  function renderHome(data) {
    const home = data.home;
    return h("main", {},
      h("section", { class: "hero", "aria-labelledby": "names" },
        h("h1", { id: "names" }, home.names.map((n) => h("span", {}, n))),
        h("div", { class: "hero-meta" }, h("p", {}, home.date), h("p", {}, home.place))),
      home.slides && home.slides.length ? slideshow(home.slides) : null);
  }

  // ---------- schedule ----------

  function renderSchedule(data) {
    const events = data.events;
    return h("main", {}, pageHead("Schedule"),
      h("div", { class: "page-body" },
        events.length
          ? events.map((ev) => h("article", { class: "row-block" },
              h("h2", {}, ev.name),
              h("div", { class: "row-body" },
                h("p", { class: "first" }, ev.date || "Date to follow"),
                h("p", {}, ev.time || "Time to follow"),
                h("p", {}, ev.place || "Venue to follow"),
                ev.description ? h("p", { class: "muted" }, ev.description) : null)))
          : h("p", {}, "You haven't been invited to any events yet. If that looks wrong, please get in touch with us.")));
  }

  // ---------- accommodation ----------

  function item(it) {
    const url = safeUrl(it.url);
    const phone = (it.phone || "").replace(/[^\d+]/g, "");
    return h("li", {},
      h("span", { class: "name" }, it.name),
      it.note ? h("span", { class: "muted" }, it.note) : null,
      phone ? h("span", {}, h("a", { class: "text-link", href: "tel:" + phone }, it.phone)) : null,
      url ? h("span", {}, h("a", { class: "text-link", href: url, target: "_blank", rel: "noopener noreferrer" }, "Website")) : null);
  }

  function renderAccommodation(data) {
    const a = data.accommodation;
    const v = a.venue;
    const maps = safeUrl(v.mapsUrl);
    const lines = (v.address || []).concat(v.postcode ? [v.postcode] : []);
    return h("main", {}, pageHead("Accommodation"),
      h("div", { class: "page-body" },
        h("section", { class: "row-block" },
          h("h2", {}, "The venue"),
          h("div", { class: "row-body" },
            lines.map((l, i) => h("p", { class: i === 0 ? "first" : "" }, l)),
            maps ? h("p", {}, h("a", { class: "text-link", href: maps, target: "_blank", rel: "noopener noreferrer" }, "Open in Google Maps")) : null)),
        a.sections.map((s) => h("section", { class: "row-block" },
          h("h2", {}, s.title),
          h("div", { class: "row-body" },
            (s.paragraphs || []).map((p) => h("p", {}, p)),
            s.items && s.items.length ? h("ul", { class: "items" }, s.items.map(item)) : null)))));
  }

  // ---------- FAQs ----------

  function renderFaqs(data) {
    return h("main", {}, pageHead("FAQs"),
      h("div", { class: "page-body" },
        h("dl", { class: "faq" }, data.faqs.map((f) => [h("dt", {}, f.q), h("dd", {}, f.a)]))));
  }

  // ---------- RSVP ----------

  function renderRsvp(data) {
    const guest = data.guest;
    const prev = data.rsvp || {};
    const answers = prev.responses || {};
    const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
    const button = h("button", { type: "submit", class: "primary" }, "Send RSVP");

    const email = h("input", { id: "email", name: "email", type: "email", autocomplete: "email", maxlength: "254", required: true, value: prev.email || "" });
    const dietary = h("textarea", { id: "dietary", name: "dietary", rows: "3", maxlength: "500" }, prev.dietary || "");
    const notes = h("textarea", { id: "notes", name: "notes", rows: "3", maxlength: "1000" }, prev.notes || "");

    const eventFields = data.events.map((ev) => h("fieldset", { class: "field choice" },
      h("legend", {}, ev.name),
      h("label", { class: "radio" }, h("input", { type: "radio", name: "ev-" + ev.id, value: "yes", required: true, checked: answers[ev.id] === true }), "Yes, I'll be there"),
      h("label", { class: "radio" }, h("input", { type: "radio", name: "ev-" + ev.id, value: "no", checked: answers[ev.id] === false }), "No, I can't make it")));

    const form = h("form", { novalidate: true },
      h("div", { class: "field" },
        h("label", { for: "email" }, "Email address"),
        email),
      eventFields,
      h("div", { class: "field" },
        h("label", { for: "dietary" }, "Dietary requirements"),
        h("p", { class: "hint" }, "Allergies, intolerances or preferences, for you only."),
        dietary),
      h("div", { class: "field" },
        h("label", { for: "notes" }, "Anything else we should know?"),
        h("p", { class: "hint" }, "For example, accessibility needs."),
        notes),
      button, status);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const address = email.value.trim();
      if (!EMAIL_RE.test(address)) {
        setStatus(status, "error", "Please enter a valid email address.");
        email.focus();
        return;
      }
      const responses = {};
      for (const ev of data.events) {
        const value = form.elements["ev-" + ev.id].value;
        if (!value) {
          setStatus(status, "error", "Please say whether you can come to: " + ev.name + ".");
          return;
        }
        responses[ev.id] = value === "yes";
      }
      button.disabled = true;
      setStatus(status, "", "Sending your reply...");
      try {
        await api("/rsvp", {
          method: "POST",
          body: { email: address, responses, dietary: dietary.value.trim(), notes: notes.value.trim() }
        });
        setStatus(status, "ok", "Thank you, " + guest.firstName + ". We've saved your reply. To change it, send this form again.");
      } catch (err) {
        if (err.status === 401) { setToken(""); showGate(); return; }
        setStatus(status, "error", err.message);
      }
      button.disabled = false;
    });

    const swStatus = h("p", { class: "status", role: "status", "aria-live": "polite" });
    const swFirst = h("input", { id: "s-first", type: "text", maxlength: "60", required: true });
    const swLast = h("input", { id: "s-last", type: "text", maxlength: "60", required: true });
    const swBtn = h("button", { type: "submit", class: "primary" }, "Switch to this guest");
    const swap = h("form", { novalidate: true },
      h("div", { class: "names-row" },
        h("div", { class: "field" }, h("label", { for: "s-first" }, "First name"), swFirst),
        h("div", { class: "field" }, h("label", { for: "s-last" }, "Last name"), swLast)),
      swBtn, swStatus);

    swap.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!swFirst.value.trim() || !swLast.value.trim()) {
        setStatus(swStatus, "error", "Please enter their first and last name.");
        return;
      }
      swBtn.disabled = true;
      setStatus(swStatus, "", "Looking them up...");
      try {
        await switchGuest(swFirst.value, swLast.value);
      } catch (err) {
        if (err.status === 401) { setToken(""); showGate(); return; }
        setStatus(swStatus, "error", err.message);
        swBtn.disabled = false;
      }
    });

    return h("main", {}, pageHead("RSVP"),
      h("div", { class: "page-body" },
        h("div", { class: "form-wrap" },
          h("p", { class: "lead" }, "Replying for " + guest.firstName + " " + guest.lastName + "."),
          data.events.length
            ? form
            : h("p", {}, "You haven't been invited to any events yet. If that looks wrong, please get in touch with us."),
          h("section", { class: "switch", "aria-labelledby": "switch-title" },
            h("h2", { id: "switch-title" }, "RSVP for another guest"),
            h("p", { class: "hint" }, "Replying for a partner or family member too? Each person replies separately. Enter their name to fill in the form again for them."),
            swap))));
  }

  // ---------- start-up ----------

  const PAGES = { home: renderHome, schedule: renderSchedule, accommodation: renderAccommodation, faqs: renderFaqs, rsvp: renderRsvp };

  async function boot() {
    cleanups.splice(0).forEach((fn) => fn());
    if (!token) { showGate(); return; }
    root.replaceChildren(h("p", { class: "loading" }, "Loading..."));
    try {
      const data = await api("/content");
      root.replaceChildren(...layout(data, PAGES[page](data)));
    } catch (err) {
      if (err.status === 401) { setToken(""); showGate(); return; }
      root.replaceChildren(h("p", { class: "loading" }, err.message + " "), h("button", { type: "button", class: "text-button", onclick: boot }, "Try again"));
    }
  }

  boot();
})();
