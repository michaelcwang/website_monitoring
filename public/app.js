const sitesEl = document.querySelector("#sites");
const template = document.querySelector("#site-template");
const form = document.querySelector("#site-form");
const smtpStatus = document.querySelector("#smtp-status");
const refreshButton = document.querySelector("#refresh");
const testEmailButton = document.querySelector("#test-email");
const adminTokenInput = document.querySelector("#admin-token");

let sites = [];
adminTokenInput.value = localStorage.getItem("adminToken") || "";

adminTokenInput.addEventListener("change", () => {
  localStorage.setItem("adminToken", adminTokenInput.value.trim());
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  payload.intervalMs = Number(payload.intervalMs);

  await request("/api/sites", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  form.reset();
  form.intervalMs.value = "600000";
  form.maintenanceKeywords.value = "maintenance, temporarily unavailable, scheduled maintenance";
  await loadSites();
});

refreshButton.addEventListener("click", loadSites);
testEmailButton.addEventListener("click", sendTestEmail);

async function loadSites() {
  const data = await request("/api/sites");
  sites = data.sites;
  smtpStatus.textContent = data.smtpReady ? "Email alerts ready" : "Email setup missing";
  smtpStatus.className = `smtp-status ${data.smtpReady ? "ready" : "missing"}`;
  adminTokenInput.hidden = !data.adminAuthEnabled;
  testEmailButton.disabled = !data.smtpReady;
  renderSites();
}

async function sendTestEmail() {
  testEmailButton.disabled = true;
  testEmailButton.textContent = "Sending...";
  try {
    await request("/api/test-email", { method: "POST" });
    testEmailButton.textContent = "Test sent";
  } catch (error) {
    testEmailButton.textContent = "Send failed";
    alert(error.message);
  } finally {
    setTimeout(() => {
      testEmailButton.textContent = "Send test email";
      testEmailButton.disabled = smtpStatus.classList.contains("missing");
    }, 2500);
  }
}

function renderSites() {
  sitesEl.replaceChildren();

  if (!sites.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No websites are being monitored yet.";
    sitesEl.append(empty);
    return;
  }

  for (const site of sites) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector("h3").textContent = site.name;

    const link = node.querySelector("a");
    link.href = site.url;
    link.textContent = site.url;

    const badge = node.querySelector(".badge");
    badge.textContent = site.status;
    badge.className = `badge ${site.status}`;

    node.querySelector('[data-field="lastCheckedAt"]').textContent = formatDate(site.lastCheckedAt);
    node.querySelector('[data-field="statusCode"]').textContent = site.statusCode || "Unknown";
    node.querySelector('[data-field="interval"]').textContent = formatInterval(site.intervalMs);
    node.querySelector('[data-field="alerts"]').textContent = site.alertsEnabled ? "Enabled" : "Paused";
    renderCertificate(node, site.tlsCertificate);

    const message = node.querySelector(".message");
    message.textContent = site.lastError || statusCopy(site);

    const enabledButton = node.querySelector('[data-action="toggle-enabled"]');
    enabledButton.textContent = site.enabled ? "Pause checks" : "Resume checks";

    const alertsButton = node.querySelector('[data-action="toggle-alerts"]');
    alertsButton.textContent = site.alertsEnabled ? "Pause alerts" : "Resume alerts";

    node.querySelector('[data-action="check"]').addEventListener("click", () => checkNow(site.id));
    enabledButton.addEventListener("click", () => updateSite(site.id, { enabled: !site.enabled }));
    alertsButton.addEventListener("click", () => updateSite(site.id, { alertsEnabled: !site.alertsEnabled }));
    node.querySelector('[data-action="acknowledge"]').addEventListener("click", () => acknowledge(site.id));
    node.querySelector('[data-action="delete"]').addEventListener("click", () => deleteSite(site.id));

    sitesEl.append(node);
  }
}

async function checkNow(id) {
  await request(`/api/sites/${id}/check`, { method: "POST" });
  await loadSites();
}

async function acknowledge(id) {
  await request(`/api/sites/${id}/acknowledge`, { method: "POST" });
  await loadSites();
}

async function updateSite(id, payload) {
  await request(`/api/sites/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
  await loadSites();
}

async function deleteSite(id) {
  await request(`/api/sites/${id}`, { method: "DELETE" });
  await loadSites();
}

async function request(url, options = {}) {
  const headers = { "Content-Type": "application/json" };
  const adminToken = localStorage.getItem("adminToken");
  if (adminToken) headers["X-Admin-Token"] = adminToken;

  const response = await fetch(url, {
    headers,
    ...options
  });

  if (!response.ok && response.status !== 204) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      const token = prompt("Enter admin token");
      if (token) {
        localStorage.setItem("adminToken", token.trim());
        adminTokenInput.value = token.trim();
      }
    }
    throw new Error(data.error || "Request failed");
  }

  return response.status === 204 ? null : response.json();
}

function statusCopy(site) {
  if (site.status === "up") return "The last check passed and no maintenance keywords were found.";
  if (site.status === "maintenance") return "The page is reachable but still appears to show maintenance content.";
  if (site.status === "down") return "The last check failed or returned a status outside the expected range.";
  return "Waiting for the first check.";
}

function renderCertificate(node, certificate) {
  const statusEl = node.querySelector('[data-field="tlsStatus"]');
  const hostEl = node.querySelector('[data-field="tlsHost"]');
  const expiresEl = node.querySelector('[data-field="tlsExpiration"]');
  const subjectEl = node.querySelector('[data-field="tlsSubject"]');
  const issuerEl = node.querySelector('[data-field="tlsIssuer"]');
  const fingerprintEl = node.querySelector('[data-field="tlsFingerprint"]');

  if (!certificate) {
    statusEl.textContent = "Certificate pending";
    statusEl.className = "";
    hostEl.textContent = "";
    expiresEl.textContent = "Unknown";
    subjectEl.textContent = "Unknown";
    issuerEl.textContent = "Unknown";
    fingerprintEl.textContent = "Unknown";
    return;
  }

  if (certificate.status === "not_applicable") {
    statusEl.textContent = "No HTTPS certificate";
    statusEl.className = "warning";
    hostEl.textContent = certificate.host || "";
    expiresEl.textContent = "Not HTTPS";
    subjectEl.textContent = "Not applicable";
    issuerEl.textContent = "Not applicable";
    fingerprintEl.textContent = "Not applicable";
    return;
  }

  const warning = certificate.status === "valid" && certificate.daysUntilExpiration <= 30;
  statusEl.textContent = certificate.status === "valid"
    ? warning
      ? "Certificate expiring soon"
      : "Certificate valid"
    : "Certificate invalid";
  statusEl.className = certificate.status === "valid" ? (warning ? "warning" : "valid") : "invalid";
  hostEl.textContent = certificate.host || "";
  expiresEl.textContent = certificate.validTo
    ? `${formatDate(certificate.validTo)} (${certificate.daysUntilExpiration} days)`
    : "Unknown";
  subjectEl.textContent = certificate.subject || "Unknown";
  issuerEl.textContent = certificate.issuer || "Unknown";
  fingerprintEl.textContent = certificate.fingerprint256 || "Unknown";
}

function formatDate(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatInterval(ms) {
  const minutes = Math.round(ms / 60000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

loadSites();
setInterval(loadSites, 30_000);
