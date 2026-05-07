import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await loadEnvFiles([".env", ".env.example"]);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "sites.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 5 * 60 * 1000);
const CHECK_TIMEOUT_MS = 20 * 1000;
const MAX_RESPONSE_BYTES = 250_000;
const MAX_SITES = Number(process.env.MAX_SITES || 25);
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 24 * 60 * 60 * 1000);
const RECOVERY_CONFIRMATION_CHECKS = Number(process.env.RECOVERY_CONFIRMATION_CHECKS || 2);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const REQUIRE_AUTH_FOR_READS = process.env.REQUIRE_AUTH_FOR_READS === "true";
const BLOCK_PRIVATE_NETWORKS = process.env.BLOCK_PRIVATE_NETWORKS !== "false";
const ALLOWED_DOMAINS = parseCsv(process.env.ALLOWED_DOMAINS || "");
const CHECK_USER_AGENT = process.env.CHECK_USER_AGENT || "WebsiteHealthMonitor/0.1 (+https://github.com/michaelcwang/website_monitoring)";
const MUTATION_LIMIT = {
  windowMs: Number(process.env.MUTATION_RATE_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.MUTATION_RATE_MAX || 30)
};

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
const mutationHits = new Map();

await ensureDataFile();
sites = await readSites();
for (const site of sites) {
  scheduleSite(site, { immediate: true });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      if (!authorizeApi(req, res)) return;
      if (isMutation(req) && !checkMutationRateLimit(req, res)) return;
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (error.name === "ValidationError") {
      sendJson(res, 400, { error: error.message });
    } else {
      sendJson(res, 500, { error: "Unexpected server error" });
    }
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

function validationError(message) {
  const error = new Error(message);
  error.name = "ValidationError";
  return error;
}

function authorizeApi(req, res) {
  if (!ADMIN_TOKEN) return true;
  if (req.method === "GET" && !REQUIRE_AUTH_FOR_READS) return true;

  const token = req.headers["x-admin-token"];
  if (typeof token === "string" && safeEqual(token, ADMIN_TOKEN)) {
    return true;
  }

  sendJson(res, 401, { error: "Admin token required" });
  return false;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isMutation(req) {
  return !["GET", "HEAD", "OPTIONS"].includes(req.method);
}

function checkMutationRateLimit(req, res) {
  const key = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const hits = (mutationHits.get(key) || []).filter((timestamp) => now - timestamp < MUTATION_LIMIT.windowMs);
  hits.push(now);
  mutationHits.set(key, hits);

  if (hits.length > MUTATION_LIMIT.max) {
    sendJson(res, 429, { error: "Too many changes. Please wait before trying again." });
    return false;
  }

  return true;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/sites") {
    sendJson(res, 200, {
      sites: sites.map(toClientSite),
      smtpReady: isSmtpReady(),
      defaultIntervalMs: DEFAULT_INTERVAL_MS,
      adminAuthEnabled: Boolean(ADMIN_TOKEN),
      requireAuthForReads: REQUIRE_AUTH_FOR_READS,
      allowedDomains: ALLOWED_DOMAINS,
      maxSites: MAX_SITES,
      minIntervalMs: MIN_INTERVAL_MS,
      recoveryConfirmationChecks: RECOVERY_CONFIRMATION_CHECKS,
      alertCooldownMs: ALERT_COOLDOWN_MS
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/test-email") {
    await sendTestEmail();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sites") {
    if (sites.length >= MAX_SITES) {
      sendJson(res, 400, { error: `Monitor limit reached. MAX_SITES is ${MAX_SITES}.` });
      return;
    }
    const body = await readBody(req);
    const site = await normalizeSite(body);
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
    Object.assign(site, await normalizeSiteUpdate(site, body));
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

async function normalizeSite(input) {
  const url = await cleanUrl(input.url);
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
    consecutiveUpChecks: 0,
    pendingRecoverySince: null,
    createdAt: now,
    updatedAt: now
  };
}

async function normalizeSiteUpdate(site, input) {
  const update = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) update.name = String(input.name).trim();
  if (input.url !== undefined) update.url = await cleanUrl(input.url);
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

async function cleanUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw validationError("Enter a valid http or https URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw validationError("Only http and https URLs are supported");
  }
  if (url.username || url.password) {
    throw validationError("URLs with embedded credentials are not supported");
  }
  if (ALLOWED_DOMAINS.length && !isAllowedDomain(url.hostname)) {
    throw validationError(`Hostname is not in ALLOWED_DOMAINS: ${url.hostname}`);
  }
  if (BLOCK_PRIVATE_NETWORKS) {
    await assertPublicHostname(url.hostname);
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

function parseCsv(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedDomain(hostname) {
  const normalized = hostname.toLowerCase();
  return ALLOWED_DOMAINS.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

async function assertPublicHostname(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw validationError("Private and local network addresses are blocked");
    return;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw validationError("Hostname did not resolve");
  if (records.some((record) => isPrivateAddress(record.address))) {
    throw validationError("Hostnames resolving to private or local networks are blocked");
  }
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) return isPrivateIpv4(address);
  if (net.isIPv6(address)) return isPrivateIpv6(address);
  return true;
}

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a === 0;
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase();
  return normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:")
    || normalized === "::"
    || normalized.startsWith("::ffff:127.")
    || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.");
}

function withJitter(ms) {
  const jitter = Math.round(ms * 0.1);
  return Math.max(MIN_INTERVAL_MS, ms + randomBetween(-jitter, jitter));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function scheduleSite(site, { immediate }) {
  clearSiteTimer(site.id);
  if (!site.enabled) return;

  const delay = immediate ? randomBetween(1_000, 5_000) : withJitter(site.intervalMs);
  const timer = setTimeout(async () => {
    await runCheck(site);
    scheduleSite(site, { immediate: false });
  }, delay);
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
    const consecutiveUpChecks = nextStatus === "up" ? Number(site.consecutiveUpChecks || 0) + 1 : 0;
    const pendingRecoverySince = nextStatus === "up" && previousStatus !== "up"
      ? site.pendingRecoverySince || checkedAt
      : nextStatus === "up"
        ? site.pendingRecoverySince
        : null;

    site.status = nextStatus;
    site.statusCode = result.statusCode;
    site.lastError = result.reason;
    site.lastCheckedAt = checkedAt;
    site.consecutiveUpChecks = consecutiveUpChecks;
    site.pendingRecoverySince = pendingRecoverySince;
    if (previousStatus !== nextStatus) site.lastChangedAt = checkedAt;

    const recovered = nextStatus === "up"
      && pendingRecoverySince
      && consecutiveUpChecks >= RECOVERY_CONFIRMATION_CHECKS;
    if (recovered && site.alertsEnabled && shouldNotify(site)) {
      await sendRecoveryEmail(site, result);
      site.lastNotificationAt = new Date().toISOString();
      site.pendingRecoverySince = null;
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
    site.consecutiveUpChecks = 0;
    site.pendingRecoverySince = null;
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
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.1",
        "User-Agent": CHECK_USER_AGENT
      }
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      body: body.slice(0, MAX_RESPONSE_BYTES),
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
  if (!isSmtpReady()) return false;
  if (!site.lastNotificationAt) return true;
  return site.notifyOnEveryRecovery && elapsedSince(site.lastNotificationAt) >= ALERT_COOLDOWN_MS;
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
    const starterSite = await normalizeSite({
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
