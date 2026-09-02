// Weekly Video Checklist Bot — discord.js v14
// -----------------------------------------------------------------
// One row per day (Mon–Sat), one video per day.
// Flow per day:
//   1. Editor clicks "Edited"   -> modal asks for the Drive link
//                               -> pings that day's QC role
//   2. QC clicks "QC ✓" or "QC ✗" -> modal asks for notes
//                               -> pings that day's Editor role with notes
//   - "QC ✓" locks the day as done.
//   - "QC ✗" reopens the day so the editor can resubmit.
//
// SETUP:
//   npm install
//   node register-commands.js   (registers /checklist — only needed once)
//   node index.js

const dns = require("node:dns");
const net = require("node:net");
const tls = require("node:tls");
const https = require("node:https");

// Some Render instances resolve discord.com to an AAAA record but have no
// working IPv6 route out. The connection then hangs until the TCP timeout
// instead of failing fast, which looks exactly like a stuck handshake.
// Preferring A records sidesteps it. Set NO_IPV4_FIRST=1 to opt out.
if (process.env.NO_IPV4_FIRST !== "1") {
  try {
    dns.setDefaultResultOrder("ipv4first");
    console.log("[net] DNS result order set to ipv4first");
  } catch (err) {
    console.warn("[net] could not set ipv4first:", err.message);
  }
}

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  REST,
  Routes,
} = require("discord.js");
const cron = require("node-cron");
const http = require("http");
const { TOKEN } = require("./config");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------------------------------------------------------------
// 1. CONFIG
// QC_BY_DAY: pinged when an editor marks THAT DAY "Edited".
// EDITOR_BY_DAY: pinged when QC approves or declines THAT DAY.
// Both take a role ID (prefixed with '&') or a user ID (no prefix).
// ---------------------------------------------------------------
const QC_BY_DAY = {
  Monday: "&1533389121622376489",
  Tuesday: "&1533389610762375228",
  Wednesday: "&1533389665627930675",
  Thursday: "&1533389719080271963",
  Friday: "&1533389774864519279",
  Saturday: "&1533389809878306947",
};
const EDITOR_BY_DAY = {
  Monday: "&1533389029058547785",
  Tuesday: "&1533389275608125530",
  Wednesday: "&1533389373826138153",
  Thursday: "&1533389443283685486",
  Friday: "&1533389491824365628",
  Saturday: "&1533389549336789077",
};

// Send ping messages to a DIFFERENT channel than the checklist itself.
// Set to null to ping in whatever channel the checklist lives in.
const PING_CHANNEL_ID = "1533134289586229493";

// Channel the weekly checklist auto-posts to.
const AUTOPOST_CHANNEL_ID = "1533398389314551860";

const DAYS_OF_WEEK = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const CHECKLIST_TITLE = "📋 Weekly Video Checklist";

// In-memory state, keyed by message ID. Lost on restart — swap for
// SQLite/Redis if you need checklists to survive a redeploy.
const checklistState = new Map();

function freshState() {
  return {
    rows: DAYS_OF_WEEK.map((day) => ({
      label: day,
      qcPingId: QC_BY_DAY[day],
      editorPingId: EDITOR_BY_DAY[day],
      driveLink: null,
      edited: false,
      editedPinged: false,
      qcStatus: null, // null | 'complete' | 'declined'
      qcNotes: null,
    })),
  };
}

function makeMention(pingId) {
  if (!pingId) return "";
  return pingId.startsWith("&") ? `<@&${pingId.slice(1)}>` : `<@${pingId}>`;
}

// Resolves where ping messages go: PING_CHANNEL_ID if set, otherwise
// the same channel the checklist is in.
async function getPingChannel(fallbackChannel) {
  if (!PING_CHANNEL_ID) return fallbackChannel;
  try {
    return await client.channels.fetch(PING_CHANNEL_ID);
  } catch (err) {
    console.error(
      "Could not fetch PING_CHANNEL_ID, falling back:",
      err.message,
    );
    return fallbackChannel;
  }
}

function statusLine(row) {
  if (row.qcStatus === "complete") return "✅ Edited   ✅ QC approved";
  if (row.qcStatus === "declined")
    return "⚠️ Changes requested — awaiting re-edit";
  if (row.edited) return "✅ Edited   ⏳ Awaiting QC";
  return "⬜ Not edited";
}

function buildChecklistPayload(state) {
  const embed = new EmbedBuilder()
    .setTitle(CHECKLIST_TITLE)
    .setColor(0x5865f2)
    .setDescription(
      state.rows
        .map((row) => {
          let block = `**${row.label}**\n${statusLine(row)}`;
          if (row.driveLink) block += `\n🔗 ${row.driveLink}`;
          if (row.qcNotes) block += `\n📝 QC notes: ${row.qcNotes}`;
          return block;
        })
        .join("\n\n"),
    );

  // Discord caps a message at 5 action rows x 5 buttons. With 6 days x 3
  // buttons = 18, we flatten everything and pack 5 per row (4 rows).
  const allButtons = [];
  state.rows.forEach((row, rowIdx) => {
    const locked = row.qcStatus === "complete";
    const short = row.label.slice(0, 3);

    allButtons.push(
      new ButtonBuilder()
        .setCustomId(`chk_${rowIdx}_edited`)
        .setLabel(`${short}: Edited`)
        .setStyle(row.edited ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(locked),
    );
    allButtons.push(
      new ButtonBuilder()
        .setCustomId(`chk_${rowIdx}_pass`)
        .setLabel(`${short}: QC ✓`)
        .setStyle(
          row.qcStatus === "complete"
            ? ButtonStyle.Success
            : ButtonStyle.Secondary,
        )
        .setDisabled(locked || !row.edited),
    );
    allButtons.push(
      new ButtonBuilder()
        .setCustomId(`chk_${rowIdx}_fail`)
        .setLabel(`${short}: QC ✗`)
        .setStyle(
          row.qcStatus === "declined"
            ? ButtonStyle.Danger
            : ButtonStyle.Secondary,
        )
        .setDisabled(locked || !row.edited),
    );
  });

  const components = [];
  for (let i = 0; i < allButtons.length; i += 5) {
    components.push(
      new ActionRowBuilder().addComponents(allButtons.slice(i, i + 5)),
    );
  }

  return { embeds: [embed], components };
}

// Pins a new checklist and unpins older ones so pins don't pile up.
// Needs the "Manage Messages" permission in that channel.
async function pinChecklist(message) {
  try {
    const pinned = await message.channel.messages.fetchPinned();
    const old = pinned.filter(
      (m) =>
        m.author.id === client.user.id &&
        m.embeds[0]?.title === CHECKLIST_TITLE,
    );
    for (const m of old.values()) await m.unpin();
    await message.pin();
  } catch (err) {
    console.error("Could not pin checklist:", err.message);
  }
}

// ---------------------------------------------------------------
// 2. INTERACTIONS
// ---------------------------------------------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    // --- /checklist -> post a fresh weekly checklist ---
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "checklist"
    ) {
      const state = freshState();
      const reply = await interaction.reply({
        ...buildChecklistPayload(state),
        fetchReply: true,
      });
      checklistState.set(reply.id, state);
      await pinChecklist(reply);
      return;
    }

    // --- Button clicks: every button opens a modal first ---
    if (interaction.isButton() && interaction.customId.startsWith("chk_")) {
      const messageId = interaction.message.id;
      const state = checklistState.get(messageId);
      if (!state) {
        await interaction.reply({
          content:
            "This checklist expired (the bot restarted) — post a new one with /checklist.",
          ephemeral: true,
        });
        return;
      }

      const [, rowIdxStr, action] = interaction.customId.split("_");
      const row = state.rows[Number(rowIdxStr)];

      if (action === "edited") {
        // Toggling OFF an already-edited day needs no input.
        if (row.edited) {
          row.edited = false;
          row.editedPinged = false;
          await interaction.update(buildChecklistPayload(state));
          return;
        }
        const modal = new ModalBuilder()
          .setCustomId(`mod_${messageId}_${rowIdxStr}_edited`)
          .setTitle(`${row.label} — Video Link`);
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("driveLink")
              .setLabel("Google Drive link")
              .setStyle(TextInputStyle.Short)
              .setPlaceholder("https://drive.google.com/...")
              .setRequired(true),
          ),
        );
        await interaction.showModal(modal);
        return;
      }

      // QC pass / fail -> ask for notes.
      const isPass = action === "pass";
      const modal = new ModalBuilder()
        .setCustomId(`mod_${messageId}_${rowIdxStr}_${action}`)
        .setTitle(`${row.label} — QC ${isPass ? "Approve" : "Decline"}`);
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("qcNotes")
            .setLabel(isPass ? "Notes (optional)" : "What needs fixing?")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder(
              isPass
                ? "Looks good, minor nitpicks..."
                : "Describe the changes needed...",
            )
            .setRequired(!isPass), // notes required when declining
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    // --- Modal submissions ---
    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("mod_")
    ) {
      const [, messageId, rowIdxStr, action] = interaction.customId.split("_");
      const state = checklistState.get(messageId);
      if (!state) {
        await interaction.reply({
          content:
            "This checklist expired (the bot restarted) — post a new one with /checklist.",
          ephemeral: true,
        });
        return;
      }

      const row = state.rows[Number(rowIdxStr)];
      const pingChannel = await getPingChannel(interaction.channel);
      let confirmation;

      if (action === "edited") {
        row.driveLink = interaction.fields
          .getTextInputValue("driveLink")
          .trim();
        row.edited = true;
        // A fresh submission clears any previous QC decision.
        row.qcStatus = null;
        row.qcNotes = null;

        await pingChannel.send(
          `${makeMention(row.qcPingId)} — **${row.label}**'s video is ready for QC.\n${row.driveLink}`,
        );
        confirmation = `Marked **${row.label}** as edited.`;
      } else {
        const notes = (
          interaction.fields.getTextInputValue("qcNotes") || ""
        ).trim();
        row.qcNotes = notes || null;

        if (action === "pass") {
          row.qcStatus = "complete";
          const noteLine = notes ? `\n📝 Notes: ${notes}` : "";
          await pingChannel.send(
            `${makeMention(row.editorPingId)} — **${row.label}**'s video passed QC. ✅${noteLine}`,
          );
          confirmation = `Approved **${row.label}**.`;
        } else {
          row.qcStatus = "declined";
          // Reopen the day so the editor can resubmit.
          row.edited = false;
          row.editedPinged = false;
          await pingChannel.send(
            `${makeMention(row.editorPingId)} — **${row.label}**'s video needs changes. ❌\n📝 ${notes}`,
          );
          confirmation = `Declined **${row.label}** and sent it back to the editor.`;
        }
      }

      const message = await interaction.channel.messages.fetch(messageId);
      await message.edit(buildChecklistPayload(state));
      await interaction.reply({ content: confirmation, ephemeral: true });
      return;
    }
  } catch (err) {
    // Interaction tokens expire after ~3s (code 10062). Log rather than
    // crash — usually caused by two bot instances running at once.
    console.error("Interaction error:", err.message);
  }
});

// ---------------------------------------------------------------
// 3. Auto-post a fresh checklist every Wednesday 8am (Malaysia time),
// with an @everyone ping. Needs "Mention Everyone" in that channel.
// NOTE: cron only fires if the process is alive at that moment — it
// does NOT catch up on missed runs after a restart or spin-down.
// ---------------------------------------------------------------
function scheduleWeeklyReset(channelId) {
  cron.schedule(
    "0 8 * * 6", // Saturday 8am (0=Sun, 6=Sat)
    async () => {
      console.log("[cron] Weekly checklist job firing...");
      try {
        const channel = await client.channels.fetch(channelId);
        const state = freshState();
        const msg = await channel.send({
          content: "@everyone New weekly checklist is up!",
          allowedMentions: { parse: ["everyone"] },
          ...buildChecklistPayload(state),
        });
        checklistState.set(msg.id, state);
        await pinChecklist(msg);
        console.log("[cron] Weekly checklist posted.");
      } catch (err) {
        console.error("[cron] Failed to post weekly checklist:", err.message);
      }
    },
    { timezone: "Asia/Kuala_Lumpur" },
  );
  console.log(
    `[cron] Weekly checklist scheduled: Saturdays 08:00 Asia/Kuala_Lumpur -> channel ${channelId}`,
  );
}

// ---------------------------------------------------------------
// 4. KEEP-ALIVE (Render free tier only)
// Render's free Web Service sleeps after ~15 min without HTTP traffic.
// Harmless if you host elsewhere — it skips the ping when
// RENDER_EXTERNAL_URL isn't set.
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Checklist bot is alive");
  })
  .listen(PORT, () =>
    console.log(`Keep-alive server listening on port ${PORT}`),
  );

function startKeepAlivePing() {
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (!selfUrl) {
    console.log(
      "RENDER_EXTERNAL_URL not set — skipping self-ping (fine if not on Render).",
    );
    return;
  }
  setInterval(
    async () => {
      try {
        const res = await fetch(selfUrl);
        console.log(`Keep-alive ping -> ${res.status}`);
      } catch (err) {
        console.error("Keep-alive ping failed:", err.message);
      }
    },
    10 * 60 * 1000,
  );
}

let readyHandled = false;
function onReady() {
  if (readyHandled) return;
  readyHandled = true;
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Server time now: ${new Date().toString()}`);
  scheduleWeeklyReset(AUTOPOST_CHANNEL_ID);
  startKeepAlivePing();
}

client.once("ready", onReady);
client.once("clientReady", onReady);

client.on("error", (err) => console.error("[client error]", err));
client.on("shardError", (err) => console.error("[shard error]", err));
client.on("invalidated", () =>
  console.error("[client invalidated] token may be revoked"),
);

// Gateway debug is loud, so it stays on only until the handshake completes —
// that is the window where it actually tells us something. Set DISCORD_DEBUG=1
// to keep it on permanently.
// discord.js emits the raw token in its debug stream ("Provided token: ..."),
// which would otherwise land in Render's logs verbatim.
function scrub(msg) {
  return TOKEN ? String(msg).split(TOKEN).join("[REDACTED]") : String(msg);
}

client.on("debug", (msg) => {
  if (!readyHandled || process.env.DISCORD_DEBUG === "1") {
    console.log("[debug]", scrub(msg));
  }
});
client.on("warn", (msg) => console.warn("[warn]", scrub(msg)));

client.on("shardDisconnect", (event, id) =>
  console.error(
    `[shard ${id} disconnected] code=${event.code} reason=${event.reason || "(none)"}`,
  ),
);
client.on("shardReconnecting", (id) =>
  console.warn(`[shard ${id}] reconnecting...`),
);

setTimeout(() => {
  if (readyHandled) return;
  console.error("STILL NOT READY after 30s — gateway handshake appears stuck.");
  console.error(`  ws.status = ${client.ws?.status}`);
  console.error(`  shards    = ${client.ws?.shards?.size ?? 0}`);
  for (const shard of client.ws?.shards?.values() ?? []) {
    console.error(`  shard ${shard.id}: status=${shard.status}`);
  }
}, 30000);

// Every probe below is wrapped in this. A hung socket is the failure mode we
// are chasing, so anything without a deadline just hangs with it.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// Is the network itself usable? Separates DNS failure from a blocked or
// black-holed TCP connect, which the REST error alone cannot distinguish.
function tcpProbe(host, port, ms = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host, port });
    const done = (result) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(ms);
    sock.once("connect", () =>
      done(`OK in ${Date.now() - started}ms via ${sock.remoteAddress}`),
    );
    sock.once("timeout", () => done(`TIMED OUT after ${ms}ms`));
    sock.once("error", (err) => done(`FAILED: ${err.message}`));
  });
}

// TCP connecting but HTTPS hanging means the stall is above the socket, so
// these walk up the stack one layer at a time: TLS handshake, then Node's own
// HTTP client, then undici (which backs global fetch and discord.js's REST).
// Whichever is the first to hang is the layer at fault.
function tlsProbe(host, ms = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = tls.connect({ host, port: 443, servername: host });
    const done = (result) => {
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(ms);
    sock.once("secureConnect", () =>
      done(
        `OK in ${Date.now() - started}ms (${sock.getProtocol()}, authorized=${sock.authorized})`,
      ),
    );
    sock.once("timeout", () => done(`TIMED OUT after ${ms}ms`));
    sock.once("error", (err) => done(`FAILED: ${err.message}`));
  });
}

// A 429 has two very different causes and two very different remedies:
// Cloudflare banning the source IP (error 1015, an HTML body, no JSON) versus
// Discord's own global rate limit (JSON with retry_after). Only the response
// tells them apart, so surface the parts that do.
function describe429(status, headers, body) {
  if (status !== 429) return "";
  const parts = [];
  const h = (k) => headers[k] ?? headers[k.toLowerCase()];
  if (h("retry-after")) parts.push(`retry-after=${h("retry-after")}s`);
  if (h("x-ratelimit-scope")) parts.push(`scope=${h("x-ratelimit-scope")}`);
  if (h("x-ratelimit-global")) parts.push("global=true");
  if (h("cf-ray")) parts.push(`cf-ray=${h("cf-ray")}`);
  if (h("server")) parts.push(`server=${h("server")}`);
  const cloudflareBan = /error code: 1015|banned|Access denied/i.test(body);
  parts.push(cloudflareBan ? "VERDICT=cloudflare-ip-ban" : "VERDICT=discord-ratelimit");
  parts.push(`body=${JSON.stringify(body.slice(0, 200))}`);
  return `\n      -> ${parts.join(" ")}`;
}

// Node's built-in HTTP client, deliberately NOT undici.
function httpsProbe(ms = 10000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(
      {
        host: "discord.com",
        path: "/api/v10/users/@me",
        method: "GET",
        headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": "DiscordBot (probe, 1.0)" },
        timeout: ms,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          if (body.length < 400) body += c;
        });
        res.on("end", () =>
          resolve(
            `HTTP ${res.statusCode} in ${Date.now() - started}ms` +
              describe429(res.statusCode, res.headers, body),
          ),
        );
      },
    );
    req.once("timeout", () => {
      req.destroy();
      resolve(`TIMED OUT after ${ms}ms`);
    });
    req.once("error", (err) => resolve(`FAILED: ${err.message}`));
    req.end();
  });
}

// global fetch === undici, the same stack discord.js's REST uses.
async function fetchProbe(ms = 10000) {
  const started = Date.now();
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": "DiscordBot (probe, 1.0)" },
      signal: AbortSignal.timeout(ms),
    });
    const body = await res.text().catch(() => "");
    return (
      `HTTP ${res.status} in ${Date.now() - started}ms` +
      describe429(res.status, Object.fromEntries(res.headers), body)
    );
  } catch (err) {
    return `FAILED after ${Date.now() - started}ms: ${err.message}`;
  }
}

async function netDiagnostics() {
  console.log(`[net] node ${process.version} on ${process.platform}/${process.arch}`);
  for (const host of ["discord.com", "gateway.discord.gg"]) {
    try {
      const v4 = await withTimeout(dns.promises.resolve4(host), 5000, "resolve4");
      console.log(`[net] ${host} A    -> ${v4.join(", ")}`);
    } catch (err) {
      console.warn(`[net] ${host} A    -> ${err.message}`);
    }
    try {
      const v6 = await withTimeout(dns.promises.resolve6(host), 5000, "resolve6");
      console.log(`[net] ${host} AAAA -> ${v6.join(", ")}`);
    } catch (err) {
      console.log(`[net] ${host} AAAA -> ${err.message}`);
    }
    console.log(`[net] tcp ${host}:443 -> ${await tcpProbe(host, 443)}`);
    console.log(`[net] tls ${host}:443 -> ${await tlsProbe(host)}`);
  }
  console.log(`[net] node https  GET /users/@me -> ${await httpsProbe()}`);
  console.log(`[net] undici fetch GET /users/@me -> ${await fetchProbe()}`);
}

// Preflight: hit the REST API. This separates "the token is bad" from "the
// WebSocket cannot get out", and surfaces the identify budget — a drained
// session_start_limit stalls the handshake with no error.
async function preflight() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    const me = await withTimeout(rest.get(Routes.user("@me")), 15000, "GET /users/@me");
    console.log(`[preflight] REST auth OK -> ${me.username} (${me.id})`);
  } catch (err) {
    console.error(`[preflight] REST auth FAILED: ${err.message}`);
    console.error("  -> token is wrong/revoked, or outbound HTTPS is blocked.");
    return;
  }
  try {
    const gw = await withTimeout(rest.get(Routes.gatewayBot()), 15000, "GET /gateway/bot");
    const l = gw.session_start_limit;
    console.log(`[preflight] gateway url = ${gw.url}, shards = ${gw.shards}`);
    console.log(
      `[preflight] identifies remaining ${l.remaining}/${l.total}, ` +
        `resets in ${Math.round(l.reset_after / 1000)}s, ` +
        `max_concurrency ${l.max_concurrency}`,
    );
    if (l.remaining === 0) {
      console.error(
        "[preflight] identify budget EXHAUSTED — login will hang until reset.",
      );
    }
  } catch (err) {
    console.error(`[preflight] GET /gateway/bot FAILED: ${err.message}`);
  }
}

console.log(
  `Attempting Discord login (token length: ${TOKEN ? TOKEN.length : "MISSING"})...`,
);
// Diagnostics run alongside login, never in front of it — gating the login on
// a probe means one hung probe takes the whole bot down with it.
const diagnostics = netDiagnostics()
  .then(preflight)
  .catch((err) => console.error("[diagnostics] aborted:", err.message));

client.login(TOKEN).catch(async (err) => {
  console.error("LOGIN FAILED:", err.message);
  // Let the probes finish first. Exiting here would kill the diagnostics
  // exactly when a failed login makes them worth reading.
  await Promise.race([
    diagnostics,
    new Promise((r) => setTimeout(r, 45000)),
  ]);
  process.exit(1);
});
