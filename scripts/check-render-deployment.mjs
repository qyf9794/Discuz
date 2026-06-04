import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const reportsDir = path.join(rootDir, "data", "render-checks");
const defaultTimeoutMs = Number(process.env.RENDER_CHECK_TIMEOUT_MS || 20000);

function usage() {
  return [
    "Usage:",
    "  npm run check:render -- https://your-service.onrender.com",
    "",
    "Options:",
    "  --timeout-ms <ms>   Per-request timeout, default 20000",
    "  --json              Print full JSON report to stdout",
    "",
    "Environment fallback:",
    "  RENDER_URL=https://your-service.onrender.com npm run check:render"
  ].join("\n");
}

function parseArgs(argv) {
  const args = { baseUrl: "", timeoutMs: defaultTimeoutMs, printJson: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (item === "--json") {
      args.printJson = true;
      continue;
    }
    if (item === "--timeout-ms") {
      args.timeoutMs = Number(argv[index + 1] || "");
      index += 1;
      continue;
    }
    if (!args.baseUrl) args.baseUrl = item;
  }
  args.baseUrl ||= process.env.RENDER_URL || process.env.DISCUS_RENDER_URL || "";
  if (!args.baseUrl) {
    console.error(usage());
    process.exit(1);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1000) args.timeoutMs = defaultTimeoutMs;
  return args;
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").replace("Z", "Z");
}

function redact(value) {
  if (typeof value === "string") {
    if (/ek_[A-Za-z0-9_-]{8,}/.test(value)) return value.replace(/ek_[A-Za-z0-9_-]+/g, "ek_***redacted***");
    if (/sk-[A-Za-z0-9_-]{8,}/.test(value)) return value.replace(/sk-[A-Za-z0-9_-]+/g, "sk-***redacted***");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      /secret|token|key|clientSecret/i.test(key) ? key : key,
      /secret|token|key|clientSecret/i.test(key) && typeof entry === "string" ? "***redacted***" : redact(entry)
    ]));
  }
  return value;
}

function compactBody(text, max = 4000) {
  const clean = String(text || "");
  return clean.length > max ? `${clean.slice(0, max)}...<truncated ${clean.length - max} chars>` : clean;
}

async function request(baseUrl, route, options = {}, timeoutMs) {
  const url = new URL(route, baseUrl).toString();
  const controller = new AbortController();
  const startedAt = performance.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      elapsedMs,
      url,
      headers: {
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        xRenderRouting: response.headers.get("x-render-routing")
      },
      json: redact(json),
      text: json ? undefined : compactBody(text)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      elapsedMs: Math.round(performance.now() - startedAt),
      url,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function addFinding(findings, severity, title, detail = "") {
  findings.push({ severity, title, detail });
}

function statusLine(result) {
  const status = result.ok ? "ok" : "fail";
  return `${status.padEnd(4)} ${String(result.status).padStart(3)} ${String(result.elapsedMs).padStart(5)}ms ${result.url}`;
}

function checkState(stateResult, findings) {
  const state = stateResult.json;
  if (!stateResult.ok) {
    addFinding(findings, "high", "/api/state failed", stateResult.error || stateResult.text || `HTTP ${stateResult.status}`);
    return;
  }
  if (!state || typeof state !== "object") {
    addFinding(findings, "high", "/api/state did not return JSON");
    return;
  }
  if (!state.activeTopicId) addFinding(findings, "medium", "No active topic id", "The app may create one on demand, but missing activeTopicId is unusual after startup.");
  if (!state.settings?.openaiApiKeyConfigured) {
    addFinding(findings, "high", "OpenAI API key is not configured", "Realtime session creation will fail until OPENAI_API_KEY or saved settings are configured.");
  }
  const ai = state.settings?.ai || {};
  if (!ai.realtimeModel) addFinding(findings, "medium", "Missing realtime model setting");
  if (!ai.transcriptionModel) addFinding(findings, "medium", "Missing transcription model setting");
}

function checkRealtime(result, findings) {
  const body = result.json;
  if (!result.ok) {
    const message = body?.error || result.error || result.text || `HTTP ${result.status}`;
    addFinding(findings, "high", "/api/realtime/session failed", message);
    if (/OPENAI_API_KEY/i.test(message)) addFinding(findings, "high", "Render env missing OPENAI_API_KEY", "Set OPENAI_API_KEY in Render environment variables and redeploy.");
    if (/model|not found|permission|access/i.test(message)) addFinding(findings, "medium", "Realtime model/access issue", "Check whether the configured realtime model is available to the API key.");
    return;
  }
  if (!body?.clientSecret) addFinding(findings, "high", "Realtime session did not return clientSecret");
  if (!body?.model) addFinding(findings, "medium", "Realtime session did not return model");
  if (!Array.isArray(body?.tools) || body.tools.length === 0) addFinding(findings, "medium", "Realtime session has no tools");
  const turnDetection = body?.audio?.input?.turn_detection || body?.audio?.input?.turnDetection;
  if (!turnDetection) {
    addFinding(findings, "medium", "Missing Realtime turn_detection config");
  } else {
    if (turnDetection.create_response !== true && turnDetection.createResponse !== true) {
      addFinding(findings, "high", "turn_detection.create_response is not true", "The assistant may listen but not automatically respond after user speech.");
    }
    if (turnDetection.interrupt_response !== true && turnDetection.interruptResponse !== true) {
      addFinding(findings, "medium", "turn_detection.interrupt_response is not true", "User interruptions may not cancel active responses correctly.");
    }
  }
  if (body?.expiresAt || body?.expires_at) {
    const expiresAt = Number(body.expiresAt || body.expires_at) * 1000;
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) addFinding(findings, "high", "Realtime client secret is already expired");
  }
}

function checkDiagnostics(postResult, listResult, sessionId, findings) {
  if (!postResult.ok) {
    addFinding(findings, "medium", "Could not write diagnostic marker", postResult.error || postResult.text || `HTTP ${postResult.status}`);
  }
  if (!listResult.ok) {
    addFinding(findings, "medium", "Could not list diagnostics", listResult.error || listResult.text || `HTTP ${listResult.status}`);
    return;
  }
  const files = Array.isArray(listResult.json?.files) ? listResult.json.files : [];
  if (!files.some((file) => file.sessionId === sessionId)) {
    addFinding(findings, "medium", "Diagnostic marker was not visible in /api/diagnostics", "This can indicate non-persistent storage, write failure, or multiple instances.");
  }
}

function checkHtmlAndAssets(htmlResult, assetResults, findings) {
  if (!htmlResult.ok) {
    addFinding(findings, "high", "Root page failed", htmlResult.error || htmlResult.text || `HTTP ${htmlResult.status}`);
    return;
  }
  const html = htmlResult.text || "";
  if (!/div id="root"|type="module"|assets\//i.test(html)) {
    addFinding(findings, "medium", "Root page does not look like the built Vite app");
  }
  for (const asset of assetResults) {
    if (!asset.ok) addFinding(findings, "high", "Static asset failed", `${asset.url} -> ${asset.status || asset.error}`);
  }
}

function extractAssetPaths(html) {
  const paths = new Set();
  const pattern = /(?:src|href)="([^"]+)"/g;
  for (const match of html.matchAll(pattern)) {
    const value = match[1];
    if (value.startsWith("/assets/") || value.startsWith("assets/")) {
      paths.add(value.startsWith("/") ? value : `/${value}`);
    }
  }
  return Array.from(paths).slice(0, 8);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeBaseUrl(args.baseUrl);
  const sessionId = `render-check-${nowStamp()}-${crypto.randomBytes(4).toString("hex")}`;
  const findings = [];
  const checks = {};

  checks.root = await request(baseUrl, "/", {}, args.timeoutMs);
  const assetPaths = extractAssetPaths(checks.root.text || "");
  checks.assets = [];
  for (const assetPath of assetPaths) {
    checks.assets.push(await request(baseUrl, assetPath, {}, args.timeoutMs));
  }

  checks.state = await request(baseUrl, "/api/state", {}, args.timeoutMs);
  checks.settings = await request(baseUrl, "/api/settings", {}, args.timeoutMs);
  checks.diagnosticsBefore = await request(baseUrl, "/api/diagnostics", {}, args.timeoutMs);
  checks.diagnosticMarker = await request(baseUrl, "/api/diagnostics/events", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      events: [
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          kind: "render_check",
          detail: {
            baseUrl,
            source: "scripts/check-render-deployment.mjs"
          }
        }
      ]
    })
  }, args.timeoutMs);
  checks.diagnosticsAfter = await request(baseUrl, "/api/diagnostics", {}, args.timeoutMs);
  checks.realtimeSession = await request(baseUrl, "/api/realtime/session", {
    method: "POST",
    body: JSON.stringify({ transport: "webrtc", sdk: "@openai/agents/realtime", source: "render-check" })
  }, args.timeoutMs);
  checks.contextSearch = await request(baseUrl, "/api/context/search?q=render-check", {}, args.timeoutMs);

  checkHtmlAndAssets(checks.root, checks.assets, findings);
  checkState(checks.state, findings);
  checkRealtime(checks.realtimeSession, findings);
  checkDiagnostics(checks.diagnosticMarker, checks.diagnosticsAfter, sessionId, findings);
  if (!checks.settings.ok) addFinding(findings, "medium", "/api/settings failed", checks.settings.error || checks.settings.text || `HTTP ${checks.settings.status}`);
  if (!checks.contextSearch.ok) addFinding(findings, "low", "/api/context/search failed", checks.contextSearch.error || checks.contextSearch.text || `HTTP ${checks.contextSearch.status}`);

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    timeoutMs: args.timeoutMs,
    sessionId,
    summary: {
      ok: findings.filter((item) => item.severity === "high").length === 0,
      high: findings.filter((item) => item.severity === "high").length,
      medium: findings.filter((item) => item.severity === "medium").length,
      low: findings.filter((item) => item.severity === "low").length
    },
    findings,
    checks
  };

  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `${sessionId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`Render check report: ${reportPath}`);
  console.log(`Target: ${baseUrl}`);
  console.log("");
  console.log("Checks:");
  for (const [name, value] of Object.entries(checks)) {
    if (Array.isArray(value)) {
      for (const item of value) console.log(`- ${name}: ${statusLine(item)}`);
    } else {
      console.log(`- ${name}: ${statusLine(value)}`);
    }
  }
  console.log("");
  if (findings.length) {
    console.log("Findings:");
    for (const finding of findings) {
      console.log(`- [${finding.severity}] ${finding.title}${finding.detail ? `: ${finding.detail}` : ""}`);
    }
  } else {
    console.log("Findings: none");
  }
  if (args.printJson) {
    console.log("");
    console.log(JSON.stringify(report, null, 2));
  }
  process.exit(report.summary.high > 0 ? 2 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
