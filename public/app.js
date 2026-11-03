
const $ = s => document.querySelector(s);

let currentUser = null;
let allGames = [];
let activeFilter = "all";

const modal = $("#modal");
const modalContent = $("#modal-content");

$("#year").textContent = new Date().getFullYear();

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const type = res.headers.get("content-type") || "";
  const data = type.includes("application/json")
    ? await res.json()
    : null;

  if (!res.ok) {
    throw new Error(data?.error || "Request failed.");
  }

  return data;
}

function toast(message) {
  const t = $("#toast");
  t.textContent = message;
  t.classList.add("show");

  setTimeout(() => t.classList.remove("show"), 2600);
}

function openModal(html) {
  modalContent.innerHTML = html;
  modal.classList.remove("hidden");
}

function closeModal() {
  modal.classList.add("hidden");
  modalContent.innerHTML = "";
}

document.addEventListener("click", e => {
  if (e.target.matches("[data-close]")) {
    closeModal();
  }
});

$("#auth-open").addEventListener("click", showAuth);
$("#wallet-open").addEventListener("click", showWallet);
$("#admin-open").addEventListener("click", showDashboard);

document.querySelectorAll(".filter").forEach(button => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;

    document.querySelectorAll(".filter").forEach(item => {
      item.classList.toggle("active", item === button);
    });

    renderGames();
  });
});

// Authentication modal
function showAuth(mode = "login") {
  const register = mode === "register";

  openModal(`
    <h2>${register ? "CREATE ACCOUNT" : "WELCOME BACK"}</h2>

    <form id="auth-form">
      ${
        register
          ? `
            <div class="field">
              <label>USERNAME</label>
              <input
                name="username"
                minlength="3"
                maxlength="24"
                required
                placeholder="Player name"
              >
            </div>
          `
          : ""
      }

      <div class="field">
        <label>EMAIL</label>
        <input
          name="email"
          type="email"
          required
          placeholder="you@example.com"
        >
      </div>

      <div class="field">
        <label>PASSWORD</label>
        <input
          name="password"
          type="password"
          minlength="10"
          required
          placeholder="At least 10 characters"
        >
      </div>

      <div id="form-error" class="form-error"></div>

      <button class="btn btn-primary" type="submit">
        ${register ? "CREATE ACCOUNT" : "SIGN IN"}
      </button>
    </form>

    <p class="form-note">
      ${register ? "Already registered?" : "New to NEON GAMES?"}
      <a href="#" id="switch-auth" class="accent">
        ${register ? "Sign in" : "Create an account"}
      </a>
    </p>
  `);

  $("#switch-auth").onclick = e => {
    e.preventDefault();
    showAuth(register ? "login" : "register");
  };

  $("#auth-form").onsubmit = async e => {
    e.preventDefault();

    const form = new FormData(e.target);
    const submitButton = e.target.querySelector('button[type="submit"]');
    const errorBox = $("#form-error");

    submitButton.disabled = true;
    submitButton.textContent = "PLEASE WAIT...";
    errorBox.textContent = "";

    try {
      const data = await api(
        `/api/auth/${register ? "register" : "login"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(Object.fromEntries(form))
        }
      );

      currentUser = data.user;

      closeModal();
      syncHeader();

      if (currentUser.role === "admin") {
        toast("Welcome, Studio Administrator.");
        showDashboard();
      } else {
        toast("Welcome to NEON GAMES.");
      }
    } catch (error) {
      errorBox.textContent = error.message;
      submitButton.disabled = false;
      submitButton.textContent = register
        ? "CREATE ACCOUNT"
        : "SIGN IN";
    }
  };
}

// Header according to account role
function syncHeader() {
  if (currentUser) {
    const role = currentUser.role === "admin" ? "ADMIN" : "PLAYER";
    $("#user-label").textContent =
      `${role}: ${currentUser.username}`;
  } else {
    $("#user-label").textContent = "";
  }

  $("#auth-open").textContent = currentUser
    ? "Sign out"
    : "Sign in";

  $("#admin-open").classList.toggle(
    "hidden",
    currentUser?.role !== "admin"
  );
  $("#wallet-open").classList.toggle("hidden", !currentUser);

  $("#auth-open").onclick = async () => {
    if (!currentUser) {
      showAuth();
      return;
    }

    try {
      await api("/api/auth/logout", {
        method: "POST"
      });

      currentUser = null;
      syncHeader();
      toast("Signed out.");
    } catch (error) {
      toast(error.message);
    }
  };
}

// Player wallet and secure PC-game linking
async function showWallet() {
  if (!currentUser) return showAuth();
  try {
    const data = await api("/api/wallet");
    const tx = data.transactions.map(item => `
      <div class="wallet-row">
        <span>${esc(item.description)}</span>
        <b class="${Number(item.amount) >= 0 ? "wallet-plus" : "wallet-minus"}">${Number(item.amount) > 0 ? "+" : ""}${Number(item.amount).toLocaleString()} ◆</b>
      </div>
    `).join("") || '<p class="form-note">No wallet activity yet.</p>';
    const requests = data.requests.map(item => `
      <div class="wallet-row"><span>Recharge #${item.id} · ${Number(item.amount_tnd).toFixed(3)} TND</span><b>${esc(item.status.toUpperCase())}</b></div>
      ${item.admin_note ? `<small class="form-note">${esc(item.admin_note)}</small>` : ""}
    `).join("") || "";

    openModal(`
      <div class="wallet-head"><div><div class="eyebrow">PLAYER ACCOUNT</div><h2>NEON WALLET</h2></div><div class="wallet-balance"><b>${Number(data.diamonds).toLocaleString()}</b><span>NEON DIAMONDS ◆</span></div></div>
      <section class="wallet-section">
        <h3 class="accent">CONNECT YOUR PC GAME</h3>
        <p class="form-note">Generate a one-time code, then enter it in NEON BRAWL. The code expires after 5 minutes.</p>
        <button id="game-link-code" class="btn btn-primary" type="button">GENERATE GAME LINK CODE</button>
        <div id="game-code-result" class="game-code-result hidden"></div>
      </section>
      <section class="wallet-section">
        <h3 class="accent">ADD NEON DIAMONDS</h3>
        ${data.d17.enabled ? `
          <div class="d17-instructions"><b>D17 PAYMENT DETAILS</b><p>${esc(data.d17.receiverName)} ${esc(data.d17.receiverPhone)}</p><p>${esc(data.d17.instructions)}</p></div>
          <form id="d17-form">
            <div class="field"><label>AMOUNT SENT (TND)</label><input name="amountTnd" type="number" min="1" max="1000" step="0.001" required></div>
            <div class="field"><label>PAYMENT PROOF (IMAGE, MAX 5 MB)</label><input name="proof" type="file" accept=".jpg,.jpeg,.png,.webp" required></div>
            <div id="d17-error" class="form-error"></div><button class="btn btn-primary" type="submit">SUBMIT PAYMENT PROOF</button>
          </form>
        ` : `<p class="form-note">Manual D17 recharges are not enabled yet. During the initial launch, Diamonds are added by the NEON GAMES administrator.</p>`}
      </section>
      ${requests ? `<section class="wallet-section"><h3 class="accent">RECHARGE REQUESTS</h3>${requests}</section>` : ""}
      <section class="wallet-section"><h3 class="accent">RECENT TRANSACTIONS</h3>${tx}</section>
    `);

    $("#game-link-code").onclick = async () => {
      const button = $("#game-link-code");
      button.disabled = true;
      try {
        const result = await api("/api/game/link-code", { method: "POST" });
        const box = $("#game-code-result");
        box.classList.remove("hidden");
        box.innerHTML = `<span>YOUR ONE-TIME CODE</span><strong>${esc(result.code)}</strong><small>Valid for 5 minutes · Use it in NEON BRAWL</small>`;
      } catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    };

    const d17Form = $("#d17-form");
    if (d17Form) d17Form.onsubmit = async event => {
      event.preventDefault();
      const button = d17Form.querySelector('button[type="submit"]');
      const error = $("#d17-error");
      button.disabled = true;
      error.textContent = "";
      try {
        await api("/api/wallet/recharge", { method: "POST", body: new FormData(d17Form) });
        toast("Payment proof submitted. Waiting for admin review.");
        await showWallet();
      } catch (e) { error.textContent = e.message; button.disabled = false; }
    };
  } catch (error) { toast(error.message); }
}

// Escape HTML
function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

// Display public games
function renderGames() {
  const list = allGames.filter(game =>
    activeFilter === "all" ||
    (
      activeFilter === "windows"
        ? game.hasWindows
        : game.hasAndroid
    )
  );

  $("#hero-game-count").textContent = allGames.length;

  if (!list.length) {
    $("#games-grid").innerHTML =
      '<div class="empty-state">NO GAMES HERE YET — CHECK BACK SOON.</div>';
    return;
  }

  $("#games-grid").innerHTML = list.map(game => `
    <article class="game-card">
      <div class="cover">
        ${
          game.cover
            ? `<img src="${esc(game.cover)}" alt="${esc(game.title)}">`
            : '<span class="cover-placeholder">NG</span>'
        }
      </div>

      <div class="game-info">
        <div class="game-topline">
          <h3 class="game-title">${esc(game.title)}</h3>
          <span class="version">v${esc(game.version)}</span>
        </div>

        <p class="game-desc">
          ${esc(game.description.slice(0, 115))}
          ${game.description.length > 115 ? "…" : ""}
        </p>

        <div class="chips">
          ${
            game.hasWindows
              ? '<span class="chip">WINDOWS PC</span>'
              : ""
          }

          ${
            game.hasAndroid
              ? '<span class="chip">ANDROID</span>'
              : ""
          }

          ${
            game.featured
              ? '<span class="chip">FEATURED</span>'
              : ""
          }
        </div>

        <div class="game-actions">
          ${
            game.hasWindows
              ? `<a class="btn btn-primary" href="/api/games/${game.id}/download/windows">PC DOWNLOAD</a>`
              : ""
          }

          ${
            game.hasAndroid
              ? `<a class="btn btn-ghost" href="/api/games/${game.id}/download/android">APK DOWNLOAD</a>`
              : ""
          }
        </div>

        <p class="form-note">
          ${Number(game.downloads || 0)} downloads
        </p>
      </div>
    </article>
  `).join("");
}

// Load games from server
async function loadGames() {
  try {
    const data = await api("/api/games");
    allGames = data.games;
    renderGames();
  } catch (error) {
    $("#games-grid").innerHTML =
      '<div class="empty-state">COULD NOT LOAD GAMES. REFRESH THE PAGE.</div>';
  }
}

// Admin dashboard
async function showDashboard() {
  if (currentUser?.role !== "admin") {
    toast("Admin access only.");
    return;
  }

  try {
    const [stats, list, walletRequests] = await Promise.all([
      api("/api/admin/stats"),
      api("/api/admin/games"),
      api("/api/admin/wallet/requests")
    ]);

    openModal(`
      <h2>DEVELOPER DASHBOARD</h2>

      <p class="form-note">
        Welcome back, ${esc(currentUser.username)}.
        Manage and publish your studio games here.
      </p>

      <div class="dashboard-stats">
        <div class="stat">
          <b>${stats.games}</b>
          <span>GAMES</span>
        </div>

        <div class="stat">
          <b>${stats.users}</b>
          <span>PLAYERS</span>
        </div>

        <div class="stat">
          <b>${stats.downloads}</b>
          <span>DOWNLOADS</span>
        </div>
      </div>

      <h3 class="accent">NEON DIAMONDS — ADMIN WALLET</h3>
      <p class="form-note">Grant Diamonds manually to a player. Every change is recorded in the wallet ledger.</p>
      <form id="diamond-grant-form" class="admin-wallet-form">
        <div class="field"><label>PLAYER EMAIL</label><input name="email" type="email" required placeholder="player@example.com"></div>
        <div class="field"><label>DIAMONDS TO GRANT</label><input name="diamonds" type="number" min="1" max="1000000" step="1" required></div>
        <div class="field"><label>REASON (OPTIONAL)</label><input name="description" maxlength="180" placeholder="Welcome bonus, event reward..."></div>
        <div id="diamond-grant-error" class="form-error"></div>
        <button class="btn btn-primary" type="submit">CREDIT PLAYER WALLET</button>
      </form>

      <h3 class="accent">PENDING D17 REQUESTS (${walletRequests.requests.length})</h3>
      <div id="d17-admin-requests">
        ${walletRequests.requests.map(request => `
          <div class="admin-request" data-request="${request.id}">
            <div><b>${esc(request.username)}</b><small>${esc(request.email)} · ${Number(request.amount_tnd).toFixed(3)} TND · #${request.id}</small></div>
            <a href="${esc(request.proofUrl)}" target="_blank" rel="noopener">VIEW PROOF ↗</a>
            <div class="admin-request-actions">
              <input type="number" min="1" max="1000000" step="1" placeholder="Diamonds" data-credit-amount>
              <button class="btn btn-primary" type="button" data-review="approved">APPROVE</button>
              <button class="btn danger" type="button" data-review="rejected">REJECT</button>
            </div>
          </div>
        `).join("") || '<p class="form-note">No pending D17 requests.</p>'}
      </div>

      <h3 class="accent">PUBLISH A GAME</h3>

      <form id="game-form" enctype="multipart/form-data">
        <div class="field">
          <label>GAME TITLE</label>
          <input name="title" required maxlength="90" placeholder="Your game name">
        </div>

        <div class="field">
          <label>DESCRIPTION</label>
          <textarea
            name="description"
            required
            minlength="10"
            maxlength="5000"
            placeholder="Describe your game..."
          ></textarea>
        </div>

        <div class="field">
          <label>VERSION</label>
          <input name="version" value="1.0.0" required>
        </div>

        <div class="field">
          <label>PLATFORM</label>
          <select name="platform">
            <option value="both">PC + Android</option>
            <option value="windows">PC</option>
            <option value="android">Android</option>
          </select>
        </div>

        <div class="field">
          <label>COVER IMAGE (JPG / PNG / WEBP)</label>
          <input
            type="file"
            name="cover"
            accept=".jpg,.jpeg,.png,.webp"
          >
        </div>

        <div class="field">
          <label>WINDOWS GAME FILE (EXE / ZIP / 7Z / MSI)</label>
          <input
            type="file"
            name="windowsFile"
            accept=".exe,.zip,.7z,.msi"
          >
        </div>

        <div class="field">
          <label>ANDROID GAME FILE (APK / ZIP / 7Z)</label>
          <input
            type="file"
            name="androidFile"
            accept=".apk,.zip,.7z"
          >
        </div>

        <div class="field">
          <label>
            <input type="checkbox" name="featured" value="true">
            FEATURE THIS GAME
          </label>
        </div>

        <div id="game-error" class="form-error"></div>

        <button class="btn btn-primary" type="submit">
          PUBLISH GAME
        </button>
      </form>

      <h3 class="accent">PUBLISHED GAMES</h3>

      <div id="admin-list">
        ${
          list.games.map(game => `
            <div class="admin-game">
              <div>
                <b>${esc(game.title)}</b>
                <small>
                  v${esc(game.version)} ·
                  ${Number(game.downloads || 0)} downloads
                </small>
              </div>

              <button
                class="btn danger"
                data-delete="${game.id}"
                type="button"
              >
                DELETE
              </button>
            </div>
          `).join("") ||
          '<p class="form-note">No games published yet.</p>'
        }
      </div>
    `);

    // Admin wallet credit
    $("#diamond-grant-form").onsubmit = async e => {
      e.preventDefault();
      const form = e.target;
      const button = form.querySelector('button[type="submit"]');
      const error = $("#diamond-grant-error");
      button.disabled = true;
      error.textContent = "";
      try {
        const body = Object.fromEntries(new FormData(form));
        const result = await api("/api/admin/wallet/grant", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        toast(`Wallet credited. New balance: ${Number(result.diamonds).toLocaleString()} Diamonds.`);
        form.reset();
      } catch (err) { error.textContent = err.message; }
      finally { button.disabled = false; }
    };

    document.querySelectorAll("[data-review]").forEach(button => {
      button.onclick = async () => {
        const card = button.closest("[data-request]");
        const amount = Number(card.querySelector("[data-credit-amount]").value);
        const status = button.dataset.review;
        if (status === "approved" && (!Number.isInteger(amount) || amount < 1)) {
          toast("Enter the Diamonds amount to credit first."); return;
        }
        if (!confirm(status === "approved" ? `Approve and credit ${amount} Diamonds?` : "Reject this D17 request?")) return;
        button.disabled = true;
        try {
          await api(`/api/admin/wallet/requests/${card.dataset.request}/review`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status, diamonds: amount })
          });
          toast(status === "approved" ? "Request approved and Diamonds credited." : "Request rejected.");
          await showDashboard();
        } catch (err) { toast(err.message); button.disabled = false; }
      };
    });

    // Publish game
    $("#game-form").onsubmit = async e => {
      e.preventDefault();

      const form = e.target;
      const formData = new FormData(form);
      const errorBox = $("#game-error");
      const submitButton = form.querySelector('button[type="submit"]');

      formData.set(
        "featured",
        form.querySelector('[name="featured"]').checked
          ? "true"
          : "false"
      );

      errorBox.textContent = "";
      submitButton.disabled = true;
      submitButton.textContent = "UPLOADING...";

      try {
        await api("/api/admin/games", {
          method: "POST",
          body: formData
        });

        toast("Game published successfully.");
        await loadGames();
        await showDashboard();
      } catch (error) {
        errorBox.textContent = error.message;
        submitButton.disabled = false;
        submitButton.textContent = "PUBLISH GAME";
      }
    };

    // Delete game
    document.querySelectorAll("[data-delete]").forEach(button => {
      button.onclick = async () => {
        const confirmed = confirm(
          "Delete this game and its uploaded files?"
        );

        if (!confirmed) return;

        try {
          await api(
            `/api/admin/games/${button.dataset.delete}`,
            { method: "DELETE" }
          );

          toast("Game deleted.");
          await loadGames();
          await showDashboard();
        } catch (error) {
          toast(error.message);
        }
      };
    });
  } catch (error) {
    toast(error.message);

    if (error.message.includes("Admin access")) {
      currentUser = null;
      syncHeader();
    }
  }
}

// Initialize website
async function init() {
  try {
    const data = await api("/api/me");
    currentUser = data.user;
  } catch {
    currentUser = null;
  }

  syncHeader();
  await loadGames();
}

init();
