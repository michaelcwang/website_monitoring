import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await loadEnvFiles([".env", ".env.example"]);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "sites.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const CHECK_TIMEOUT_MS = 20 * 1000;

const smtpConfig = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  from: process.env.ALERT_FROM || process.env.SMTP_USER,
  to: process.env.ALERT_TO,
  secure: process.env.SMTP_SECURE === "true"
};

let sites = [];
const timers = new Map();
const activeChecks = new Set();

await ensureDataFile();
sites = await readSites();
for (const site of sites) {
  scheduleSite(site, { immediate: true });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Unexpected server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Website health monitor running at http://${HOST}:${PORT}`);
});

async function loadEnvFiles(files) {
  for (const file of files) {
    const envPath = path.join(__dirname, file);
    try {
      const contents = await fs.readFile(envPath, "utf8");
      for (const line of contents.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const separatorIndex = trimmed.indexOf("=");
        if (separatorIndex === -1) continue;

        const key = trimmed.slice(0, separatorIndex).trim();
        const rawValue = trimmed.slice(separatorIndex + 1).trim();
        if (!key || process.env[key] !== undefined) continue;

        process.env[key] = stripEnvQuotes(rawValue);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function stripEnvQuotes(value) {
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/sites") {
    sendJson(res, 200, {
      sites: sites.map(toClientSite),
      smtpReady: isSmtpReady(),
      defaultIntervalMs: DEFAULT_INTERVAL_MS
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/test-email") {
    await sendTestEmail();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sites") {
    const body = await readBody(req);
    const site = normalizeSite(body);
    sites.push(site);
    await saveSites();
    scheduleSite(site, { immediate: true });
    sendJson(res, 201, { site: toClientSite(site) });
    return;
  }

  const siteMatch = url.pathname.match(/^\/api\/sites\/([^/]+)(?:\/([^/]+))?$/);
  if (!siteMatch) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const [, id, action] = siteMatch;
  const site = sites.find((entry) => entry.id === id);
  if (!site) {
    sendJson(res, 404, { error: "Site not found" });
    return;
  }

  if (req.method === "PATCH" && !action) {
    const body = await readBody(req);
    Object.assign(site, normalizeSiteUpdate(site, body));
    await saveSites();
    scheduleSite(site, { immediate: false });
    sendJson(res, 200, { site: toClientSite(site) });
    return;
  }

  if (req.method === "DELETE" && !action) {
    sites = sites.filter((entry) => entry.id !== id);
    clearSiteTimer(id);
    await saveSites();
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "POST" && action === "check") {
    await runCheck(site, { manual: true });
    sendJson(res, 200, { site: toClientSite(site) });
    return;
  }

  if (req.method === "POST" && action === "acknowledge") {
    site.alertsEnabled = false;
    site.acknowledgedAt = new Date().toISOString();
    await saveSites();
    sendJson(res, 200, { site: toClientSite(site) });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8"
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function normalizeSite(input) {
  const url = cleanUrl(input.url);
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: String(input.name || new URL(url).hostname).trim(),
    url,
    intervalMs: clampInterval(input.intervalMs),
    maintenanceKeywords: normalizeKeywords(input.maintenanceKeywords),
    expectedStatusMin: Number(input.expectedStatusMin || 200),
    expectedStatusMax: Number(input.expectedStatusMax || 399),
    enabled: input.enabled !== false,
    alertsEnabled: input.alertsEnabled !== false,
    notifyOnEveryRecovery: input.notifyOnEveryRecovery === true,
    status: "unknown",
    statusCode: null,
    lastCheckedAt: null,
    lastChangedAt: null,
    lastError: null,
    lastNotificationAt: null,
    acknowledgedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function normalizeSiteUpdate(site, input) {
  const update = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) update.name = String(input.name).trim();
  if (input.url !== undefined) update.url = cleanUrl(input.url);
  if (input.intervalMs !== undefined) update.intervalMs = clampInterval(input.intervalMs);
  if (input.maintenanceKeywords !== undefined) update.maintenanceKeywords = normalizeKeywords(input.maintenanceKeywords);
  if (input.expectedStatusMin !== undefined) update.expectedStatusMin = Number(input.expectedStatusMin);
  if (input.expectedStatusMax !== undefined) update.expectedStatusMax = Number(input.expectedStatusMax);
  if (input.enabled !== undefined) update.enabled = Boolean(input.enabled);
  if (input.alertsEnabled !== undefined) update.alertsEnabled = Boolean(input.alertsEnabled);
  if (input.notifyOnEveryRecovery !== undefined) update.notifyOnEveryRecovery = Boolean(input.notifyOnEveryRecovery);
  if (update.alertsEnabled === true) {
    update.acknowledgedAt = null;
    update.lastNotificationAt = null;
  }
  return update;
}

function cleanUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }
  return url.toString();
}

function clampInterval(value) {
  const parsed = Number(value || DEFAULT_INTERVAL_MS);
  return Math.max(MIN_INTERVAL_MS, parsed);
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || "maintenance,temporarily unavailable")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function scheduleSite(site, { immediate }) {
  clearSiteTimer(site.id);
  if (!site.enabled) return;

  if (immediate) {
    void runCheck(site);
  }

  const timer = setInterval(() => {
    void runCheck(site);
  }, site.intervalMs);
  timers.set(site.id, timer);
}

function clearSiteTimer(id) {
  const timer = timers.get(id);
  if (timer) clearInterval(timer);
  timers.delete(id);
}

async function runCheck(site, options = {}) {
  if (activeChecks.has(site.id)) return;
  activeChecks.add(site.id);

  const previousStatus = site.status;
  const checkedAt = new Date().toISOString();

  try {
    const result = await fetchSite(site);
    const nextStatus = classifyHealth(site, result);
    site.status = nextStatus;
    site.statusCode = result.statusCode;
    site.lastError = result.reason;
    site.lastCheckedAt = checkedAt;
    if (previousStatus !== nextStatus) site.lastChangedAt = checkedAt;

    const recovered = nextStatus === "up" && ["maintenance", "down", "unknown"].includes(previousStatus);
    if (recovered && site.alertsEnabled && shouldNotify(site)) {
      await sendRecoveryEmail(site, result);
      site.lastNotificationAt = new Date().toISOString();
      if (!site.notifyOnEveryRecovery) {
        site.alertsEnabled = false;
        site.acknowledgedAt = site.lastNotificationAt;
      }
    }
  } catch (error) {
    site.status = "down";
    site.statusCode = null;
    site.lastError = error.message;
    site.lastCheckedAt = checkedAt;
    if (previousStatus !== "down") site.lastChangedAt = checkedAt;
  } finally {
    site.updatedAt = new Date().toISOString();
    activeChecks.delete(site.id);
    await saveSites();
  }

  if (options.manual) {
    console.log(`Manual check completed for ${site.name}: ${site.status}`);
  }
}

async function fetchSite(site) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(site.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "WebsiteHealthMonitor/0.1"
      }
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      body: body.slice(0, 250_000),
      reason: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

function classifyHealth(site, result) {
  const statusOk = result.statusCode >= site.expectedStatusMin && result.statusCode <= site.expectedStatusMax;
  const body = result.body.toLowerCase();
  const maintenanceHit = site.maintenanceKeywords.some((keyword) => body.includes(keyword.toLowerCase()));

  if (statusOk && !maintenanceHit) return "up";
  if (maintenanceHit) return "maintenance";
  return "down";
}

function shouldNotify(site) {
  return isSmtpReady() && (site.notifyOnEveryRecovery || !site.lastNotificationAt);
}

async function sendRecoveryEmail(site, result) {
  const subject = `${site.name} is back up`;
  const text = [
    `${site.name} appears to be back from maintenance.`,
    "",
    `URL: ${site.url}`,
    `HTTP status: ${result.statusCode}`,
    `Checked at: ${new Date().toLocaleString()}`,
    "",
    "Alerts for this site were automatically paused after this recovery notification unless repeat notifications are enabled."
  ].join("\n");

  await sendMail({
    from: smtpConfig.from,
    to: smtpConfig.to,
    subject,
    text
  });
}

async function sendTestEmail() {
  await sendMail({
    from: smtpConfig.from,
    to: smtpConfig.to,
    subject: "Website Health Monitor test email",
    text: [
      "This is a test email from Website Health Monitor.",
      "",
      `Sent at: ${new Date().toLocaleString()}`,
      "If you received this, SMTP notifications are working."
    ].join("\n")
  });
}

async function sendMail({ from, to, subject, text }) {
  if (!isSmtpReady()) {
    throw new Error("SMTP settings are incomplete");
  }

  const socket = await connectSmtp();
  const read = createLineReader(socket);

  try {
    await expectCode(read, 220);
    await command(socket, read, `EHLO localhost`, 250);

    if (!smtpConfig.secure && smtpConfig.port !== 465) {
      socket.write("STARTTLS\r\n");
      await expectCode(read, 220);
      const secureSocket = tls.connect({ socket, servername: smtpConfig.host });
      await onceSecure(secureSocket);
      return await sendMailOverSocket(secureSocket, { from, to, subject, text });
    }

    await sendMailOverSocket(socket, { from, to, subject, text }, read);
  } finally {
    socket.destroy();
  }
}

async function sendMailOverSocket(socket, mail, existingReader) {
  const read = existingReader || createLineReader(socket);
  await command(socket, read, `EHLO localhost`, 250);
  await command(socket, read, "AUTH LOGIN", 334);
  await command(socket, read, Buffer.from(smtpConfig.user).toString("base64"), 334);
  await command(socket, read, Buffer.from(smtpConfig.pass).toString("base64"), 235);
  await command(socket, read, `MAIL FROM:<${mail.from}>`, 250);
  await command(socket, read, `RCPT TO:<${mail.to}>`, [250, 251]);
  await command(socket, read, "DATA", 354);

  const message = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${mail.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    mail.text.replace(/^\./gm, ".."),
    "."
  ].join("\r\n");

  socket.write(`${message}\r\n`);
  await expectCode(read, 250);
  await command(socket, read, "QUIT", 221);
}

function connectSmtp() {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    const socket = smtpConfig.secure || smtpConfig.port === 465
      ? tls.connect({ host: smtpConfig.host, port: smtpConfig.port, servername: smtpConfig.host }, () => {
          socket.off("error", onError);
          resolve(socket);
        })
      : net.connect({ host: smtpConfig.host, port: smtpConfig.port }, () => {
          socket.off("error", onError);
          resolve(socket);
        });
    socket.once("error", onError);
  });
}

function createLineReader(socket) {
  let buffer = "";
  const queue = [];
  const waiters = [];

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index + 1).trimEnd();
      buffer = buffer.slice(index + 1);
      queue.push(line);
    }
    while (queue.length && waiters.length) {
      waiters.shift()(queue.shift());
    }
  });

  return () => new Promise((resolve) => {
    if (queue.length) resolve(queue.shift());
    else waiters.push(resolve);
  });
}

async function command(socket, read, value, expected) {
  socket.write(`${value}\r\n`);
  await expectCode(read, expected);
}

async function expectCode(read, expected) {
  const expectedCodes = Array.isArray(expected) ? expected : [expected];
  let line = await read();
  let code = Number(line.slice(0, 3));
  while (line[3] === "-") {
    line = await read();
    code = Number(line.slice(0, 3));
  }
  if (!expectedCodes.includes(code)) {
    throw new Error(`SMTP error: ${line}`);
  }
}

function onceSecure(socket) {
  return new Promise((resolve, reject) => {
    if (socket.authorized || socket.encrypted) resolve();
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
}

function isSmtpReady() {
  return Boolean(smtpConfig.host && smtpConfig.user && smtpConfig.pass && smtpConfig.from && smtpConfig.to);
}

function toClientSite(site) {
  return {
    ...site,
    nextCheckInMs: site.enabled ? Math.max(0, site.intervalMs - elapsedSince(site.lastCheckedAt)) : null
  };
}

function elapsedSince(isoDate) {
  if (!isoDate) return 0;
  return Date.now() - new Date(isoDate).getTime();
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  if (status === 204) res.end();
  else res.end(JSON.stringify(value));
}

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    const starterSite = normalizeSite({
      name: "LISD Canvas",
      url: "https://lisdtx.instructure.com/login/canvas",
      intervalMs: DEFAULT_INTERVAL_MS,
      maintenanceKeywords: ["maintenance", "temporarily unavailable", "scheduled maintenance"]
    });
    await fs.writeFile(DATA_FILE, JSON.stringify([starterSite], null, 2));
  }
}

async function readSites() {
  const contents = await fs.readFile(DATA_FILE, "utf8");
  return JSON.parse(contents);
}

async function saveSites() {
  await fs.writeFile(DATA_FILE, JSON.stringify(sites, null, 2));
}
