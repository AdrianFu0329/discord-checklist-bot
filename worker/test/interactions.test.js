// Drives the full editor -> QC flow against the Worker's fetch handler, with
// KV and the Discord API stubbed. Signature verification is exercised too:
// Discord probes the endpoint with a bad signature during setup and expects
// that to be rejected.

import assert from "node:assert";
import worker from "../src/index.js";

const PUBLIC_KEY_HEX = "".padEnd(64, "a"); // 32 bytes; verify() itself is stubbed

// --- stubs ---------------------------------------------------------------
const kv = new Map();
const sent = [];

const env = {
  DISCORD_TOKEN: "test-token",
  DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX,
  PING_CHANNEL_ID: "999",
  AUTOPOST_CHANNEL_ID: "888",
  CHECKLIST: {
    get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null),
    put: async (k, v) => void kv.set(k, v),
  },
};

const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };

globalThis.fetch = async (url, init) => {
  sent.push({ url, body: JSON.parse(init.body || "{}"), method: init.method });
  // GET /channels/{id}/pins answers with an array of messages, not a message.
  const body = /\/pins$/.test(url) && (!init.method || init.method === "GET")
    ? []
    : { id: "msg-1" };
  return new Response(JSON.stringify(body), { status: 200 });
};

// Bypass real Ed25519 by making verification succeed for a known marker.
const realVerify = crypto.subtle.verify.bind(crypto.subtle);
crypto.subtle.verify = async (alg, key, sig, msg) => {
  const text = new TextDecoder().decode(msg);
  if (text.includes('"__valid__"')) return true;
  if (text.includes('"__invalid__"')) return false;
  return realVerify(alg, key, sig, msg);
};

function post(interaction, { valid = true } = {}) {
  const body = JSON.stringify({ ...interaction, marker: valid ? "__valid__" : "__invalid__" });
  return worker.fetch(
    new Request("https://bot.example/", {
      method: "POST",
      body,
      headers: {
        "x-signature-ed25519": "00".repeat(64),
        "x-signature-timestamp": "1700000000",
      },
    }),
    env,
    ctx,
  );
}

const j = async (res) => JSON.parse(await res.text());

// --- tests ---------------------------------------------------------------
let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

await test("rejects a bad signature with 401", async () => {
  const res = await post({ type: 1 }, { valid: false });
  assert.strictEqual(res.status, 401);
});

await test("rejects a malformed signature with 401, not a 500", async () => {
  // Discord's endpoint validation deliberately sends a bad signature and
  // requires a rejection; a thrown error would surface as 500 and is not one.
  const res = await worker.fetch(
    new Request("https://bot.example/", {
      method: "POST",
      body: JSON.stringify({ type: 1 }),
      headers: {
        "x-signature-ed25519": "zzzz",
        "x-signature-timestamp": "1700000000",
      },
    }),
    env,
    ctx,
  );
  assert.strictEqual(res.status, 401);
});

await test("rejects a wrong-length signature with 401", async () => {
  const res = await worker.fetch(
    new Request("https://bot.example/", {
      method: "POST",
      body: JSON.stringify({ type: 1 }),
      headers: {
        "x-signature-ed25519": "00".repeat(10),
        "x-signature-timestamp": "1700000000",
      },
    }),
    env,
    ctx,
  );
  assert.strictEqual(res.status, 401);
});

await test("answers Discord's PING with PONG", async () => {
  const res = await post({ type: 1 });
  assert.deepStrictEqual(await j(res), { type: 1 });
});

let stateId;
await test("/checklist posts 6 days with 18 buttons", async () => {
  const res = await post({ type: 2, data: { name: "checklist" }, channel_id: "1" });
  const body = await j(res);
  assert.strictEqual(body.type, 4);
  const buttons = body.data.components.flatMap((r) => r.components);
  assert.strictEqual(buttons.length, 18);
  assert.match(body.data.embeds[0].description, /\*\*Monday\*\*/);
  stateId = buttons[0].custom_id.split("_")[1];
});

await test("Edited button opens the drive-link modal", async () => {
  const res = await post({
    type: 3,
    data: { custom_id: `chk_${stateId}_0_edited` },
    channel_id: "1",
  });
  const body = await j(res);
  assert.strictEqual(body.type, 9);
  assert.strictEqual(body.data.components[0].components[0].custom_id, "driveLink");
});

await test("submitting the link marks the day and pings QC", async () => {
  const res = await post({
    type: 5,
    data: {
      custom_id: `mod_${stateId}_0_edited`,
      components: [
        { components: [{ custom_id: "driveLink", value: "https://drive.google.com/x" }] },
      ],
    },
    channel_id: "1",
  });
  const body = await j(res);
  assert.strictEqual(body.type, 7, "should update the original message");
  assert.match(body.data.embeds[0].description, /✅ Edited   ⏳ Awaiting QC/);

  await Promise.all(pending);
  const ping = sent.at(-1);
  assert.match(ping.url, /\/channels\/999\/messages$/, "ping goes to PING_CHANNEL_ID");
  assert.match(ping.body.content, /<@&1533389121622376489>/, "pings Monday's QC role");
  assert.match(ping.body.content, /drive\.google\.com/);
});

await test("QC decline reopens the day and pings the editor", async () => {
  const res = await post({
    type: 5,
    data: {
      custom_id: `mod_${stateId}_0_fail`,
      components: [{ components: [{ custom_id: "qcNotes", value: "audio is clipping" }] }],
    },
    channel_id: "1",
  });
  const body = await j(res);
  assert.match(body.data.embeds[0].description, /Changes requested/);

  await Promise.all(pending);
  const ping = sent.at(-1);
  assert.match(ping.body.content, /<@&1533389029058547785>/, "pings Monday's editor role");
  assert.match(ping.body.content, /audio is clipping/);

  const buttons = body.data.components.flatMap((r) => r.components);
  assert.strictEqual(buttons[0].disabled, false, "day reopens for a resubmit");
});

await test("QC approve locks the day", async () => {
  await post({
    type: 5,
    data: {
      custom_id: `mod_${stateId}_0_edited`,
      components: [{ components: [{ custom_id: "driveLink", value: "https://drive.google.com/y" }] }],
    },
    channel_id: "1",
  });
  const res = await post({
    type: 5,
    data: {
      custom_id: `mod_${stateId}_0_pass`,
      components: [{ components: [{ custom_id: "qcNotes", value: "" }] }],
    },
    channel_id: "1",
  });
  const body = await j(res);
  assert.match(body.data.embeds[0].description, /✅ QC approved/);
  const buttons = body.data.components.flatMap((r) => r.components);
  assert.ok(buttons[0].disabled && buttons[1].disabled && buttons[2].disabled, "locked");
});

await test("state survives a cold start (read back from KV)", async () => {
  const res = await post({
    type: 3,
    data: { custom_id: `chk_${stateId}_1_edited` },
    channel_id: "1",
  });
  assert.strictEqual((await j(res)).type, 9, "unknown state would answer ephemeral instead");
});

await test("unknown state id reports expiry rather than crashing", async () => {
  const res = await post({
    type: 3,
    data: { custom_id: "chk_deadbeefdeadbeef_0_edited" },
    channel_id: "1",
  });
  const body = await j(res);
  assert.strictEqual(body.data.flags, 64, "ephemeral");
  assert.match(body.data.content, /no longer tracked/);
});

await test("cron posts a fresh checklist with @everyone", async () => {
  sent.length = 0;
  await worker.scheduled({}, env, ctx);
  await Promise.all(pending);
  const post0 = sent.find((s) => s.url.endsWith("/channels/888/messages"));
  assert.ok(post0, "posts to AUTOPOST_CHANNEL_ID");
  assert.match(post0.body.content, /@everyone/);
  assert.deepStrictEqual(post0.body.allowed_mentions, { parse: ["everyone"] });
  assert.ok(sent.some((s) => s.method === "PUT" && /\/pins\//.test(s.url)), "pins it");
});

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
