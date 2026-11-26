"use strict";

/**
 * FLOP Faucet Tracker — a 24/7 Telegram bot for the FLOP testnet faucet.
 *
 * It polls the public faucet metadata every 30 seconds and sends exactly one
 * notification per state change (open / empty / degraded / offline). It never
 * spams the same state, and every number shown is read live from the faucet.
 *
 * Free Render web services sleep after 15 minutes without inbound traffic, so
 * this process also pings its own RENDER_EXTERNAL_URL every 9 minutes. The
 * repository's GitHub Action provides a second keep-alive path.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Telegraf, Markup } = require("telegraf");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required.");
  process.exit(1);
}

const FAUCET_BASE = (process.env.FAUCET_BASE_URL || "https://faucet.flop.network").replace(
  /\/+$/,
  "",
);
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 30_000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 8_000);
const OPEN_THRESHOLD_FLOP = 100;
const GRANT_FLOP = 10;
const OFFLINE_AFTER_FAILURES = 3;
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const SUBS_FILE = path.join(DATA_DIR, "subscribers.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PORT = Number(process.env.PORT || 3000);

const bot = new Telegraf(TOKEN, { handlerTimeout: 15_000 });

/** @type {Map<string, {chatId: string, username?: string, firstName?: string, joinedAt: string}>} */
const subscribers = new Map();
let snapshot = null;
let lastCategory = null;
let checking = null;
let consecutiveFailures = 0;
let lastSuccessAt = null;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (error) {
    console.error(`Could not write ${file}: ${error.message}`);
  }
}

function loadSubscribers() {
  const stored = readJson(SUBS_FILE, []);
  if (!Array.isArray(stored)) return;
  for (const entry of stored) {
    if (entry && entry.chatId) subscribers.set(String(entry.chatId), entry);
  }
}

function saveSubscribers() {
  writeJson(SUBS_FILE, [...subscribers.values()]);
}

function loadState() {
  const stored = readJson(STATE_FILE, null);
  lastCategory = stored && typeof stored.category === "string" ? stored.category : null;
}

function saveState() {
  writeJson(STATE_FILE, { category: lastCategory, at: new Date().toISOString() });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("en-US") : "—";
}

function fmtDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "now";
  const totalMinutes = Math.ceil(milliseconds / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${Math.ceil(hours / 24)}d`;
}

function nextUtcMidnight(now = new Date()) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
}

function resetEstimate() {
  const reset = nextUtcMidnight();
  return {
    at: reset,
    in: fmtDuration(reset.getTime() - Date.now()),
    utc: `${reset.toISOString().slice(0, 16).replace("T", " ")} UTC`,
  };
}

function dhakaTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

const STATE_LABEL = {
  open: "🟢 OPEN — pool is distributing",
  empty: "🔴 EMPTY — distribution stopped",
  degraded: "🟠 DEGRADED — a dependency is down",
  offline: "⚫ OFFLINE — faucet unreachable",
};

async function fetchJson(route) {
  const started = Date.now();
  const response = await fetch(`${FAUCET_BASE}${route}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: response.status, data, latencyMs: Date.now() - started };
}

function evaluate(health, limits) {
  const dependencies = health.dependencies || {};
  const signerOk = dependencies.signer?.ok === true;
  const indexerOk = dependencies.indexer?.ok === true;
  const connected = health.connected === true;
  const live = health.live !== false;
  const status = limits.faucet?.status ?? "unknown";
  const remainingFlop = Number(limits.faucet?.dailyCap?.remainingFlop ?? 0);
  const pendingGrants = Number(limits.faucet?.pendingGrants ?? 0);
  const effectiveFlop = remainingFlop - pendingGrants * GRANT_FLOP;

  if (!connected || !live) {
    return { category: "degraded", reason: "Faucet RPC is disconnected" };
  }
  if (!signerOk) {
    return { category: "degraded", reason: "Signer is down" };
  }
  if (!indexerOk) {
    return { category: "degraded", reason: "Indexer is down" };
  }
  if (status !== "open") {
    return { category: "empty", reason: `Faucet status is ${status}` };
  }
  if (remainingFlop < OPEN_THRESHOLD_FLOP) {
    return { category: "empty", reason: "Daily pool is used up" };
  }
  if (effectiveFlop < OPEN_THRESHOLD_FLOP) {
    return {
      category: "empty",
      reason: "Global queue is ahead of the remaining pool (no capacity for new claims)",
    };
  }
  return { category: "open", reason: "New pool has capacity and is distributing" };
}

function poolStats(limits) {
  const faucet = limits.faucet || {};
  const cap = faucet.dailyCap || {};
  const limit = Number(cap.limitFlop ?? 0);
  const used = Number(cap.usedFlop ?? 0);
  const remaining = Number(cap.remainingFlop ?? 0);
  const pending = Number(faucet.pendingGrants ?? 0);
  const effective = remaining - pending * GRANT_FLOP;
  const percent = limit > 0 ? ((used / limit) * 100).toFixed(1) : "—";
  return { faucet, cap, limit, used, remaining, percent, pending, effective };
}

function statusText(current) {
  if (!current) {
    return "⏳ <b>Collecting the first faucet sample…</b>\nTry /status again in a few seconds.";
  }

  const health = current.health || {};
  const limits = current.limits || {};
  const { faucet, limit, used, remaining, percent, pending, effective } = poolStats(limits);
  const dependencies = health.dependencies || {};
  const indexer = dependencies.indexer?.details || {};
  const signing = dependencies.signing || {};
  const sponsor = limits.sponsor || {};
  const reset = resetEstimate();

  const rpcOk = health.connected === true;
  const signerOk = dependencies.signer?.ok === true;
  const indexerOk = dependencies.indexer?.ok === true;
  const ready = health.ready === true;
  const live = health.live !== false;
  const stale = limits.stale === true;

  const ok = (value) => (value ? "✅" : "❌");
  const balance = faucet.balanceFlop ?? "—";
  const minBalance = faucet.minBalanceFlop ?? "—";

  return [
    "🚰 <b>FLOP FAUCET TRACKER</b>",
    `${STATE_LABEL[current.category] || current.category} · <i>${escapeHtml(current.reason || "")}</i>`,
    "",
    "💧 <b>Pool</b>",
    `Remaining: <b>${fmtInt(remaining)}</b> / ${fmtInt(limit)} FLOP`,
    `Used: ${fmtInt(used)} FLOP (${percent}%)`,
    `Global queue: <b>${fmtInt(pending)}</b> grants`,
    `New-claim capacity: <b>${fmtInt(Math.max(0, effective))}</b> FLOP ${effective < 0 ? "(queue ahead)" : ""}`,
    "",
    "🔐 <b>Signer & dependencies</b>",
    `Balance: ${fmtInt(balance)} FLOP · min ${fmtInt(minBalance)}`,
    `RPC ${ok(rpcOk)} · Signer ${ok(signerOk)} · Indexer ${ok(indexerOk)}`,
    `Indexer head: ${fmtInt(indexer.indexedHead ?? "—")} · lag ${fmtInt(indexer.lagBlocks ?? "—")}`,
    `Signing: ${signing.held ? `held (${escapeHtml(signing.reason || "reason unknown")})` : "released"}`,
    "",
    "🧾 <b>Per-client limits</b>",
    `${limits.perClient?.ipGrantsPerDay ?? "—"} grants/IP/day · ${limits.perClient?.ipRangeGrantsPerDay ?? "—"} grants per /24/day`,
    `Address cooldown: ${Math.round((limits.perClient?.addressCooldownSeconds ?? 86_400) / 3_600)}h`,
    "",
    "🏦 <b>Sponsor</b>",
    `Miner: ${escapeHtml(sponsor.miner?.status ?? "—")} · Validator: ${escapeHtml(sponsor.validator?.status ?? "—")}`,
    "",
    `📦 Faucet: ${escapeHtml(faucet.status ?? "—")} · v${escapeHtml(health.image?.version ?? "—")} · ready ${ok(ready)} · live ${ok(live)}${stale ? " · ⚠️ stale" : ""}`,
    `♻️ Next reset (est.): in ${reset.in} · ${reset.utc}`,
    `🕒 Checked ${dhakaTime(new Date(current.checkedAt))} · every ${Math.round(CHECK_INTERVAL_MS / 1_000)}s`,
  ].join("\n");
}

function openText(current) {
  const { limit, remaining, pending, effective } = poolStats(current.limits);
  const reset = resetEstimate();
  return [
    "🚰 <b>FLOP FAUCET OPEN</b> — new pool has capacity and is distributing",
    "",
    `💧 <b>${fmtInt(remaining)}</b> FLOP left / ${fmtInt(limit)}`,
    `🧾 Global queue: <b>${fmtInt(pending)}</b> grants`,
    `⚡ New-claim capacity: <b>${fmtInt(Math.max(0, effective))}</b> FLOP`,
    `🔐 Signer ${current.health?.dependencies?.signer?.ok ? "✅" : "❌"} · Indexer ${current.health?.dependencies?.indexer?.ok ? "✅" : "❌"} · RPC ${current.health?.connected ? "✅" : "❌"}`,
    "",
    "⚡ Claim now: https://faucet.flop.network",
    `⏱ Next reset (est.): in ${reset.in} · /status for full details`,
  ].join("\n");
}

function emptyText(current) {
  const { limit, used, pending, effective } = poolStats(current.limits);
  const reset = resetEstimate();
  return [
    "⛔ <b>FLOP FAUCET EMPTY</b> — distribution stopped",
    "",
    `Reason: <i>${escapeHtml(current.reason || "pool used up")}</i>`,
    `Used: ${fmtInt(used)} / ${fmtInt(limit)} FLOP`,
    `Global queue: <b>${fmtInt(pending)}</b> grants`,
    `New-claim capacity: <b>${fmtInt(Math.max(0, effective))}</b> FLOP ${effective < 0 ? "(queue ahead)" : ""}`,
    `♻️ Next reset (est.): in ${reset.in} · ${reset.utc}`,
    "",
    "I’ll ping you the moment a new pool has capacity.",
  ].join("\n");
}

function degradedText(current) {
  const health = current.health || {};
  const dependencies = health.dependencies || {};
  const { remaining } = poolStats(current.limits || {});
  const ok = (value) => (value ? "✅" : "❌");
  return [
    "⚠️ <b>FLOP FAUCET DEGRADED</b>",
    "",
    `Reason: <i>${escapeHtml(current.reason || "dependency down")}</i>`,
    `RPC ${ok(health.connected)} · Signer ${ok(dependencies.signer?.ok)} · Indexer ${ok(dependencies.indexer?.ok)}`,
    `Pool left: ${fmtInt(remaining)} FLOP`,
    `Queue: ${fmtInt((current.limits || {}).faucet?.pendingGrants ?? 0)} grants`,
    "",
    "I’ll notify when the faucet is healthy again.",
  ].join("\n");
}

function offlineText(previous, error) {
  return [
    "📡 <b>FLOP FAUCET UNREACHABLE</b>",
    "",
    `${OFFLINE_AFTER_FAILURES} consecutive checks failed.`,
    `Last good check: ${lastSuccessAt ? dhakaTime(new Date(lastSuccessAt)) : "not yet"}`,
    `Error: <i>${escapeHtml(error?.message || "no response")}</i>`,
    `Previous state: ${previous ? STATE_LABEL[previous] || previous : "unknown"}`,
    "",
    "I’ll notify when it answers again.",
  ].join("\n");
}

function transitionText(previous, category, current) {
  if (category === "open") return openText(current);
  if (category === "empty") return emptyText(current);
  if (category === "degraded") return degradedText(current);
  return offlineText(previous, new Error("faucet unreachable"));
}

function statusKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🔄 Refresh", "refresh"),
      Markup.button.url("🌐 Open faucet", `${FAUCET_BASE}/limits`),
    ],
    [
      Markup.button.callback("🔔 Alerts on", "subscribe"),
      Markup.button.callback("🔕 Alerts off", "unsubscribe"),
      Markup.button.callback("📊 Status", "status"),
    ],
  ]);
}

function replyOptions() {
  return {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...statusKeyboard(),
  };
}

async function broadcast(text) {
  if (subscribers.size === 0) return;
  for (const [chatId, entry] of [...subscribers.entries()]) {
    try {
      await bot.telegram.sendMessage(chatId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      console.log(`notified ${chatId} (${entry.username || entry.firstName || "user"})`);
    } catch (error) {
      const code = error?.response?.error_code;
      if (code === 403 || code === 400) {
        subscribers.delete(chatId);
        saveSubscribers();
        console.log(`removed unreachable subscriber ${chatId}`);
      } else {
        console.error(`notify ${chatId} failed: ${code || error.message}`);
      }
    }
  }
}

async function runCheck() {
  if (checking) return checking;
  checking = (async () => {
    try {
      const [healthResponse, limitsResponse] = await Promise.all([
        fetchJson("/health"),
        fetchJson("/limits"),
      ]);
      if (!healthResponse.data || !limitsResponse.data) {
        throw new Error(
          `Faucet returned HTTP ${healthResponse.status}/${limitsResponse.status}`,
        );
      }
      const result = evaluate(healthResponse.data, limitsResponse.data);
      const checkedAt = new Date().toISOString();
      snapshot = {
        health: healthResponse.data,
        limits: limitsResponse.data,
        category: result.category,
        reason: result.reason,
        checkedAt,
        latencyMs: healthResponse.latencyMs,
      };
      consecutiveFailures = 0;
      lastSuccessAt = checkedAt;

      if (lastCategory === null) {
        lastCategory = result.category;
        saveState();
      } else if (lastCategory !== result.category) {
        const previous = lastCategory;
        lastCategory = result.category;
        saveState();
        await broadcast(transitionText(previous, result.category, snapshot));
      }

      console.log(
        `check ok · state=${result.category} · remaining=${poolStats(limitsResponse.data).remaining} · queue=${limitsResponse.data.faucet?.pendingGrants ?? 0}`,
      );
    } catch (error) {
      consecutiveFailures += 1;
      console.error(`check failed (${consecutiveFailures}/${OFFLINE_AFTER_FAILURES}): ${error.message}`);
      if (consecutiveFailures >= OFFLINE_AFTER_FAILURES && lastCategory !== "offline") {
        const previous = lastCategory;
        lastCategory = "offline";
        saveState();
        await broadcast(offlineText(previous, error));
      }
    } finally {
      checking = null;
    }
  })();
  return checking;
}

function subscribe(ctx) {
  const chatId = String(ctx.chat.id);
  const existing = subscribers.get(chatId);
  subscribers.set(chatId, {
    chatId,
    username: ctx.from?.username,
    firstName: ctx.from?.first_name,
    joinedAt: existing?.joinedAt || new Date().toISOString(),
  });
  saveSubscribers();
  return Boolean(existing);
}

bot.start(async (ctx) => {
  const already = subscribe(ctx);
  await runCheck();
  const intro = [
    "👋 <b>FLOP Faucet Tracker</b>",
    already
      ? "You are already subscribed. Alerts are on."
      : "You are subscribed. Alerts are on.",
    "",
    "I watch the FLOP testnet faucet 24/7 and send <b>one message per state change</b>:",
    "• 🚰 pool opens / starts distributing",
    "• ⛔ pool empty / distribution stops",
    "• ⚠️ signer or indexer goes down",
    "• 📡 faucet unreachable",
    "",
    "No repeated spam. Use the buttons or /status, /help.",
    "",
  ].join("\n");
  await ctx.reply(`${intro}${statusText(snapshot)}`, replyOptions());
});

bot.command("status", async (ctx) => {
  await runCheck();
  await ctx.reply(statusText(snapshot), replyOptions());
});

bot.command("subscribe", async (ctx) => {
  const already = subscribe(ctx);
  await runCheck();
  await ctx.reply(
    `${already ? "🔔 Alerts were already on." : "🔔 Alerts enabled."}\n\n${statusText(snapshot)}`,
    replyOptions(),
  );
});

bot.command("unsubscribe", async (ctx) => {
  const removed = subscribers.delete(String(ctx.chat.id));
  saveSubscribers();
  await ctx.reply(
    removed
      ? "🔕 Alerts disabled. Send /start or /subscribe to enable them again."
      : "You are not subscribed. Send /start to enable alerts.",
    { parse_mode: "HTML" },
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    [
      "🤖 <b>FLOP Faucet Tracker — help</b>",
      "",
      "/start — subscribe and show live status",
      "/status — pool, queue, signer, deps, limits",
      "/subscribe — enable open/empty alerts",
      "/unsubscribe — disable alerts",
      "/ping — verify the monitor is alive",
      "",
      "The bot checks the faucet every 30 seconds and only messages on a state change. All values are read live from the public faucet endpoints.",
    ].join("\n"),
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
});

bot.command("ping", async (ctx) => {
  const age = snapshot?.checkedAt
    ? fmtDuration(Date.now() - Date.parse(snapshot.checkedAt))
    : "no sample yet";
  await ctx.reply(
    `🏓 Pong.\nMonitor: ${snapshot ? "alive" : "starting"}\nLast check: ${age} ago\nState: ${snapshot ? STATE_LABEL[snapshot.category] : "—"}`,
    { parse_mode: "HTML" },
  );
});

bot.action("refresh", async (ctx) => {
  try {
    await ctx.answerCbQuery("Refreshing…");
  } catch {
    // Callback may be outdated.
  }
  await runCheck();
  try {
    await ctx.editMessageText(statusText(snapshot), replyOptions());
  } catch {
    await ctx.reply(statusText(snapshot), replyOptions());
  }
});

bot.action("status", async (ctx) => {
  try {
    await ctx.answerCbQuery("Fetching status…");
  } catch {
    // Callback may be outdated.
  }
  await runCheck();
  await ctx.reply(statusText(snapshot), replyOptions());
});

bot.action("subscribe", async (ctx) => {
  subscribe(ctx);
  await ctx.answerCbQuery("Alerts enabled");
  await runCheck();
  try {
    await ctx.editMessageText(statusText(snapshot), replyOptions());
  } catch {
    // Message may be too old to edit.
  }
});

bot.action("unsubscribe", async (ctx) => {
  subscribers.delete(String(ctx.chat.id));
  saveSubscribers();
  await ctx.answerCbQuery("Alerts disabled");
});

bot.catch((error, ctx) => {
  console.error(`Bot error for ${ctx?.update?.update_id}: ${error.message}`);
});

function healthPayload() {
  return {
    ok: true,
    bot: "flop-faucet-tracker",
    state: snapshot?.category || lastCategory || "starting",
    reason: snapshot?.reason || null,
    checkedAt: snapshot?.checkedAt || null,
    subscribers: subscribers.size,
    intervalSeconds: Math.round(CHECK_INTERVAL_MS / 1_000),
    uptimeSeconds: Math.round(process.uptime()),
  };
}

function startServer() {
  const server = http.createServer((request, response) => {
    if (request.url === "/health" || request.url === "/" || request.url?.startsWith("/health?")) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(healthPayload()));
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`health server listening on ${PORT}`);
  });
  return server;
}

function startKeepAlive() {
  const external = process.env.RENDER_EXTERNAL_URL
    || (process.env.RENDER_EXTERNAL_HOSTNAME
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
      : null);
  if (!external) {
    console.log("RENDER_EXTERNAL_URL is not set; self keep-alive is off.");
    return;
  }
  const url = `${external.replace(/\/+$/, "")}/health`;
  console.log(`self keep-alive target: ${url}`);
  setInterval(() => {
    fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" }).catch(() => {});
  }, 9 * 60 * 1_000);
}

async function main() {
  ensureDataDir();
  loadSubscribers();
  loadState();
  console.log(
    `starting tracker · subscribers=${subscribers.size} · interval=${CHECK_INTERVAL_MS}ms · lastState=${lastCategory || "none"}`,
  );

  startServer();
  startKeepAlive();

  bot.launch().catch((error) => {
    console.error(`Telegram launch failed: ${error.message}`);
    process.exit(1);
  });

  bot.telegram
    .setMyCommands([
      { command: "start", description: "Subscribe + live faucet status" },
      { command: "status", description: "Pool, queue, signer and dependencies" },
      { command: "subscribe", description: "Enable open/empty alerts" },
      { command: "unsubscribe", description: "Disable alerts" },
      { command: "ping", description: "Check that the monitor is alive" },
      { command: "help", description: "How this bot works" },
    ])
    .catch((error) => console.error(`setMyCommands failed: ${error.message}`));

  await runCheck();
  setInterval(() => {
    void runCheck();
  }, CHECK_INTERVAL_MS);

  process.once("SIGTERM", () => {
    console.log("SIGTERM received, stopping.");
    bot.stop("SIGTERM");
    process.exit(0);
  });
  process.once("SIGINT", () => {
    bot.stop("SIGINT");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(`fatal: ${error.stack || error.message}`);
  process.exit(1);
});
