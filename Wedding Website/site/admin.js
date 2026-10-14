(function () {
  "use strict";

  const cfg = window.WEDDING_CONFIG || {};
  const root = document.getElementById("root");
  const tokenKey = "wedding-admin-token";
  const redirectUri = window.location.origin + window.location.pathname;
  const authUrl = (cfg.adminAuthUrl || "").replace(/\/$/, "");
  let idToken = "";

  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null) continue;
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    kids.flat(Infinity).forEach((child) => {
      if (child != null) node.append(child.nodeType ? child : document.createTextNode(child));
    });
    return node;
  }

  function message(text, isError) {
    root.replaceChildren(h("main", { class: "page-body" },
      h("h1", {}, "RSVP dashboard"),
      h("p", { class: isError ? "status" : "loading", "data-state": isError ? "error" : "" }, text)));
  }

  function randomString() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function base64Url(bytes) {
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function signIn() {
    if (!authUrl || !cfg.adminClientId || !cfg.adminApiUrl) {
      message("Admin sign-in has not been configured. Check the deployment outputs and site/config.js.", true);
      return;
    }
    const verifier = randomString();
    const state = randomString();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    sessionStorage.setItem("wedding-admin-verifier", verifier);
    sessionStorage.setItem("wedding-admin-state", state);
    const params = new URLSearchParams({
      client_id: cfg.adminClientId,
      response_type: "code",
      scope: "openid email",
      redirect_uri: redirectUri,
      state,
      code_challenge_method: "S256",
      code_challenge: base64Url(new Uint8Array(digest))
    });
    window.location.assign(authUrl + "/oauth2/authorize?" + params.toString());
  }

  async function exchangeCode(code, state) {
    const expectedState = sessionStorage.getItem("wedding-admin-state");
    const verifier = sessionStorage.getItem("wedding-admin-verifier");
    sessionStorage.removeItem("wedding-admin-state");
    sessionStorage.removeItem("wedding-admin-verifier");
    window.history.replaceState({}, "", redirectUri);
    if (!expectedState || state !== expectedState || !verifier) {
      throw new Error("Sign-in could not be verified. Please try again.");
    }
    const response = await fetch(authUrl + "/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: cfg.adminClientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier
      })
    });
    const data = await response.json();
    if (!response.ok || !data.id_token) throw new Error("Cognito sign-in failed. Please try again.");
    return data.id_token;
  }

  function signOut() {
    sessionStorage.removeItem(tokenKey);
    if (!authUrl || !cfg.adminClientId) {
      window.location.assign("index.html");
      return;
    }
    const params = new URLSearchParams({ client_id: cfg.adminClientId, logout_uri: redirectUri });
    window.location.assign(authUrl + "/logout?" + params.toString());
  }

  function renderDashboard(data) {
    const replied = data.guests.filter((guest) => guest.replied).length;
    const eventStats = data.events.map((event) => {
      const invited = data.guests.filter((guest) => guest.events.includes(event.id));
      const attending = invited.filter((guest) => guest.responses[event.id] === true).length;
      const declined = invited.filter((guest) => guest.responses[event.id] === false).length;
      return { event, invited: invited.length, attending, declined, pending: invited.length - attending - declined };
    });

    const search = h("input", { type: "text", placeholder: "Filter guests", "aria-label": "Filter guests" });
    const body = h("tbody", {});
    const table = h("table", { class: "admin-table" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Guest"), h("th", {}, "Status"),
        ...data.events.map((event) => h("th", {}, event.name)),
        h("th", {}, "Email"), h("th", {}, "Dietary"), h("th", {}, "Other notes"), h("th", {}, "Updated"))),
      body);

    function populate(filter) {
      const query = filter.trim().toLocaleLowerCase();
      body.replaceChildren(...data.guests.filter((guest) =>
        (guest.firstName + " " + guest.lastName + " " + guest.email).toLocaleLowerCase().includes(query))
        .map((guest) => h("tr", {},
          h("td", {}, guest.firstName + " " + guest.lastName),
          h("td", {}, guest.replied ? "Replied" : "Awaiting reply"),
          ...data.events.map((event) => {
            if (!guest.events.includes(event.id)) return h("td", {}, "—");
            const answer = guest.responses[event.id];
            return h("td", {}, answer === true ? "Yes" : answer === false ? "No" : "Awaiting");
          }),
          h("td", {}, guest.email),
          h("td", { class: "admin-detail" }, guest.dietary),
          h("td", { class: "admin-detail" }, guest.notes),
          h("td", {}, guest.updatedAt ? new Date(guest.updatedAt).toLocaleString() : "—"))));
    }

    search.addEventListener("input", () => populate(search.value));
    populate("");
    root.replaceChildren(
      h("header", { class: "site-header" },
        h("a", { class: "brand", href: "index.html" }, "Nathan & Ashling"),
        h("button", { type: "button", class: "text-button admin-signout", onclick: signOut }, "Sign out")),
      h("main", { class: "page-body admin-page" },
        h("div", { class: "page-head" }, h("h1", {}, "RSVP dashboard")),
        h("div", { class: "admin-summary" },
          h("p", {}, h("strong", {}, String(data.guests.length)), "Guests invited"),
          h("p", {}, h("strong", {}, String(replied)), "Replied"),
          h("p", {}, h("strong", {}, String(data.guests.length - replied)), "Awaiting reply")),
        h("h2", {}, "Event attendance"),
        h("div", { class: "admin-events" }, eventStats.map((stat) =>
          h("p", {}, h("strong", {}, stat.event.name), ": ",
            stat.attending + " attending, " + stat.declined + " not attending, " +
            stat.pending + " awaiting (" + stat.invited + " invited)"))),
        h("h2", {}, "Guest responses"),
        h("div", { class: "admin-tools" }, search),
        h("div", { class: "admin-table-wrap" }, table)),
      h("footer", { class: "foot" }, h("a", { class: "admin-link", href: "index.html" }, "Back to the website")));
  }

  async function loadDashboard() {
    message("Loading RSVP responses...");
    const response = await fetch(cfg.adminApiUrl.replace(/\/$/, "") + "/admin/rsvps", {
      headers: { Authorization: "Bearer " + idToken },
      cache: "no-store"
    });
    if (response.status === 401 || response.status === 403) {
      sessionStorage.removeItem(tokenKey);
      idToken = "";
      await signIn();
      return;
    }
    if (!response.ok) throw new Error("Could not load RSVP responses. Please try again.");
    renderDashboard(await response.json());
  }

  async function start() {
    try {
      if (!authUrl || !cfg.adminClientId || !cfg.adminApiUrl) {
        message("Admin sign-in has not been configured. Check the deployment outputs and site/config.js.", true);
        return;
      }
      const params = new URLSearchParams(window.location.search);
      if (params.has("error")) {
        window.history.replaceState({}, "", redirectUri);
        throw new Error("Cognito sign-in was not completed. Please try again.");
      }
      if (params.has("code")) {
        idToken = await exchangeCode(params.get("code"), params.get("state"));
        sessionStorage.setItem(tokenKey, idToken);
      } else {
        idToken = sessionStorage.getItem(tokenKey) || "";
      }
      if (!idToken) {
        const button = h("button", { type: "button", class: "primary", onclick: signIn }, "Sign in");
        root.replaceChildren(h("main", { class: "page-body" },
          h("h1", {}, "RSVP dashboard"),
          h("p", { class: "lead" }, "Sign in with your administrator account to view guest responses."),
          button,
          h("p", {}, h("a", { class: "admin-link", href: "index.html" }, "Back to the website"))));
        return;
      }
      await loadDashboard();
    } catch (error) {
      message(error.message || "Something went wrong. Please try again.", true);
    }
  }

  start();
})();
