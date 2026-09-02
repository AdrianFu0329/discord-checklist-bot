// Weekly Video Checklist Bot — Cloudflare Workers / HTTP Interactions
// -----------------------------------------------------------------
// The gateway build (../../index.js) holds a WebSocket open to Discord, which
// needs an always-on process and an outbound IP Discord is not rate-limiting.
// This build inverts that: Discord POSTs each interaction here, and most
// replies go straight back in the HTTP response, so no outbound call is made
// at all on the hot path.
//
// State lives in KV rather than a Map, so a redeploy no longer expires every
// open checklist.

import {
  buildChecklistPayload,
  freshState,
  makeMention,
  CHECKLIST_TITLE,
} from "./checklist.js";

const API = "https://discord.com/api/v10";

// Interaction types
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const MODAL_SUBMIT = 5;

// Response types
const PONG = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const UPDATE_MESSAGE = 7;
const MODAL = 9;

const EPHEMERAL = 64;

// Checklists are keyed by a minted id rather than a message id; 90 days is far
// longer than a weekly checklist stays relevant, and stops KV growing forever.
const STATE_TTL_SECONDS = 90 * 24 * 60 * 60;

function json(body) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function ephemeral(content) {
  return json({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL },
  });
}

function mintStateId() {
  // 8 bytes of randomness, hex-encoded. custom_id has 100 chars to play with
  // and this leaves ample room for the row index and action suffix.
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Discord signs every request. An endpoint that skips this check can be driven
// by anyone who learns the URL, so a failure here is a hard 401 — and Discord
// itself probes with a deliberately bad signature during setup, expecting one.
async function verifySignature(request, rawBody, publicKeyHex) {
  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) return false;

  const message = new TextEncoder().encode(timestamp + rawBody);
  let key;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, hexToBytes(signature), message);
  } catch {
    // Older Workers runtimes only expose Ed25519 under the NODE-ED25519 name.
    key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "NODE-ED25519", namedCurve: "NODE-ED25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "NODE-ED25519" },
      key,
      hexToBytes(signature),
      message,
    );
  }
}

async function discordFetch(env, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Surfaced rather than thrown: a failed ping must not roll back a checklist
    // update the user can already see.
    console.error(`Discord ${init.method || "GET"} ${path} -> ${res.status} ${body.slice(0, 300)}`);
  }
  return res;
}

function sendMessage(env, channelId, payload) {
  return discordFetch(env, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function loadState(env, stateId) {
  return await env.CHECKLIST.get(`state:${stateId}`, "json");
}

async function saveState(env, stateId, state) {
  await env.CHECKLIST.put(`state:${stateId}`, JSON.stringify(state), {
    expirationTtl: STATE_TTL_SECONDS,
  });
}

function modalFor(stateId, rowIdx, action, row) {
  const isEdited = action === "edited";
  const isPass = action === "pass";
  return json({
    type: MODAL,
    data: {
      custom_id: `mod_${stateId}_${rowIdx}_${action}`,
      title: isEdited
        ? `${row.label} — Video Link`
        : `${row.label} — QC ${isPass ? "Approve" : "Decline"}`,
      components: [
        {
          type: 1,
          components: [
            isEdited
              ? {
                  type: 4,
                  custom_id: "driveLink",
                  label: "Google Drive link",
                  style: 1, // short
                  placeholder: "https://drive.google.com/...",
                  required: true,
                }
              : {
                  type: 4,
                  custom_id: "qcNotes",
                  label: isPass ? "Notes (optional)" : "What needs fixing?",
                  style: 2, // paragraph
                  placeholder: isPass
                    ? "Looks good, minor nitpicks..."
                    : "Describe the changes needed...",
                  required: !isPass, // notes required when declining
                },
          ],
        },
      ],
    },
  });
}

function modalValue(interaction, customId) {
  for (const row of interaction.data.components || []) {
    for (const component of row.components || []) {
      if (component.custom_id === customId) return component.value || "";
    }
  }
  return "";
}

const EXPIRED =
  "This checklist is no longer tracked — post a new one with /checklist.";

async function handleInteraction(interaction, env, ctx) {
  // --- /checklist -> post a fresh weekly checklist ---
  if (
    interaction.type === APPLICATION_COMMAND &&
    interaction.data.name === "checklist"
  ) {
    const stateId = mintStateId();
    const state = freshState();
    await saveState(env, stateId, state);
    return json({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: buildChecklistPayload(state, stateId),
    });
  }

  // --- Button clicks ---
  if (interaction.type === MESSAGE_COMPONENT) {
    const [, stateId, rowIdxStr, action] = interaction.data.custom_id.split("_");
    const state = await loadState(env, stateId);
    if (!state) return ephemeral(EXPIRED);

    const row = state.rows[Number(rowIdxStr)];

    // Toggling OFF an already-edited day needs no input, so it updates in place.
    if (action === "edited" && row.edited) {
      row.edited = false;
      await saveState(env, stateId, state);
      return json({
        type: UPDATE_MESSAGE,
        data: buildChecklistPayload(state, stateId),
      });
    }

    return modalFor(stateId, rowIdxStr, action, row);
  }

  // --- Modal submissions ---
  if (interaction.type === MODAL_SUBMIT) {
    const [, stateId, rowIdxStr, action] = interaction.data.custom_id.split("_");
    const state = await loadState(env, stateId);
    if (!state) return ephemeral(EXPIRED);

    const row = state.rows[Number(rowIdxStr)];
    const pingChannel = env.PING_CHANNEL_ID || interaction.channel_id;

    if (action === "edited") {
      row.driveLink = modalValue(interaction, "driveLink").trim();
      row.edited = true;
      // A fresh submission clears any previous QC decision.
      row.qcStatus = null;
      row.qcNotes = null;
      ctx.waitUntil(
        sendMessage(env, pingChannel, {
          content: `${makeMention(row.qcPingId)} — **${row.label}**'s video is ready for QC.\n${row.driveLink}`,
        }),
      );
    } else {
      const notes = modalValue(interaction, "qcNotes").trim();
      row.qcNotes = notes || null;

      if (action === "pass") {
        row.qcStatus = "complete";
        const noteLine = notes ? `\n📝 Notes: ${notes}` : "";
        ctx.waitUntil(
          sendMessage(env, pingChannel, {
            content: `${makeMention(row.editorPingId)} — **${row.label}**'s video passed QC. ✅${noteLine}`,
          }),
        );
      } else {
        row.qcStatus = "declined";
        // Reopen the day so the editor can resubmit.
        row.edited = false;
        ctx.waitUntil(
          sendMessage(env, pingChannel, {
            content: `${makeMention(row.editorPingId)} — **${row.label}**'s video needs changes. ❌\n📝 ${notes}`,
          }),
        );
      }
    }

    await saveState(env, stateId, state);
    // The modal was opened from a button, so the original checklist message can
    // be edited directly in the response — no follow-up API call needed.
    return json({
      type: UPDATE_MESSAGE,
      data: buildChecklistPayload(state, stateId),
    });
  }

  return ephemeral("Unrecognised interaction.");
}

// Posts the weekly checklist and pins it, unpinning any previous one so pins do
// not pile up. Needs "Mention Everyone" and "Manage Messages" in the channel.
async function postWeeklyChecklist(env) {
  const channelId = env.AUTOPOST_CHANNEL_ID;
  const stateId = mintStateId();
  const state = freshState();
  await saveState(env, stateId, state);

  const res = await sendMessage(env, channelId, {
    content: "@everyone New weekly checklist is up!",
    allowed_mentions: { parse: ["everyone"] },
    ...buildChecklistPayload(state, stateId),
  });
  if (!res.ok) return;
  const message = await res.json();

  // Clearing old pins is best effort and must not prevent the new checklist
  // from being pinned, so the two are tried independently.
  try {
    const pinsRes = await discordFetch(env, `/channels/${channelId}/pins`);
    if (pinsRes.ok) {
      const pins = await pinsRes.json();
      // v10 returns a bare array; tolerate the paginated {items} shape too.
      const list = Array.isArray(pins) ? pins : pins?.items || [];
      for (const pin of list) {
        if (pin.embeds?.[0]?.title === CHECKLIST_TITLE && pin.id !== message.id) {
          await discordFetch(env, `/channels/${channelId}/pins/${pin.id}`, {
            method: "DELETE",
          });
        }
      }
    }
  } catch (err) {
    console.error("Could not clear old pins:", err.message);
  }

  try {
    await discordFetch(env, `/channels/${channelId}/pins/${message.id}`, {
      method: "PUT",
    });
  } catch (err) {
    console.error("Could not pin checklist:", err.message);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return new Response("Checklist bot is alive", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const rawBody = await request.text();
    if (!(await verifySignature(request, rawBody, env.DISCORD_PUBLIC_KEY))) {
      return new Response("Bad request signature", { status: 401 });
    }

    const interaction = JSON.parse(rawBody);
    if (interaction.type === PING) return json({ type: PONG });

    try {
      return await handleInteraction(interaction, env, ctx);
    } catch (err) {
      console.error("Interaction error:", err.stack || err.message);
      return ephemeral("Something went wrong handling that — please try again.");
    }
  },

  // Cron trigger. Workers schedules in UTC, so Saturday 08:00 Asia/Kuala_Lumpur
  // (UTC+8) is 00:00 UTC on Saturday. Unlike the gateway build's node-cron, this
  // does not depend on a process happening to be alive at the time.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(postWeeklyChecklist(env));
  },
};
