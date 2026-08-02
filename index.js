// Weekly Video Checklist Bot — discord.js v14
// -----------------------------------------------------------------
// One row per day of the week (Mon–Sun), one video per day.
// Flow per day:
//   1. Editor clicks "Edited"      -> pings the QC role/person
//   2. QC clicks "QC Approved"     -> day is locked, done
//
// SETUP:
//   npm install discord.js node-cron
//   node register-commands.js   (registers /checklist)
//   node index.js
//
// Set DISCORD_TOKEN, CLIENT_ID as env vars (or edit config.js).

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const cron = require('node-cron');
const http = require('http');
const { TOKEN } = require('./config');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------------------------------------------------------------
// 1. CONFIG
// QC_BY_DAY: who gets pinged when an editor marks THAT DAY "Edited".
// EDITOR_BY_DAY: who gets pinged back when QC approves THAT DAY.
// Both take a role ID (prefixed with '&') or a user ID (no prefix).
// ---------------------------------------------------------------
const QC_BY_DAY = {
  Monday: '&1533358634942074991',
  Tuesday: '&333333333333333333',     // <-- replace with each day's QC role ID
  Wednesday: '&444444444444444444',
  Thursday: '&444444444444444444',
  Friday: '&555555555555555555',
  Saturday: '&555555555555555555',
  Sunday: '&555555555555555555',
};
const EDITOR_BY_DAY = {
  Monday: '&1533358503320752199',
  Tuesday: null,                       // <-- replace with each day's Editor role ID, or leave null for no ping-back
  Wednesday: null,
  Thursday: null,
  Friday: null,
  Saturday: null,
  Sunday: null,
};

const DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function buildWeekConfig() {
  return DAYS_OF_WEEK.map((day) => ({
    rowLabel: day,
    items: [
      { name: 'Edited', pingId: QC_BY_DAY[day] },
      { name: 'QC Approved', pingId: EDITOR_BY_DAY[day] },
    ],
  }));
}

// In-memory state: { [messageId]: { rows: [{ label, items: [{name, done, pingId, pinged}] }] } }
// Swap this Map for a DB (SQLite/Redis) if you need it to survive restarts.
const checklistState = new Map();

function makeMention(pingId) {
  return pingId.startsWith('&') ? `<@&${pingId.slice(1)}>` : `<@${pingId}>`;
}

function buildChecklistPayload(state) {
  const embed = new EmbedBuilder()
    .setTitle('📋 Weekly Video Checklist')
    .setColor(0x5865f2)
    .setDescription(
      state.rows
        .map(
          (row) =>
            `**${row.label}**\n` +
            row.items.map((i) => `${i.done ? '✅' : '⬜'} ${i.name}`).join('   ')
        )
        .join('\n\n')
    );

  // Discord allows max 5 action rows per message, and max 5 buttons per
  // row. With 7 days x 2 buttons = 14 buttons, we can't do one row per
  // day — so flatten all buttons and pack them 5-per-row instead.
  const allButtons = [];
  state.rows.forEach((row, rowIdx) => {
    const rowLocked = row.items.every((i) => i.done); // lock once fully approved
    row.items.forEach((item, itemIdx) => {
      allButtons.push(
        new ButtonBuilder()
          .setCustomId(`chk_${rowIdx}_${itemIdx}`)
          .setLabel(`${row.label.slice(0, 3)}: ${item.name}`)
          .setStyle(item.done ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(rowLocked)
      );
    });
  });

  const components = [];
  for (let i = 0; i < allButtons.length; i += 5) {
    components.push(new ActionRowBuilder().addComponents(allButtons.slice(i, i + 5)));
  }

  return { embeds: [embed], components };
}

function freshState() {
  return {
    rows: buildWeekConfig().map((r) => ({
      label: r.rowLabel,
      items: r.items.map((i) => ({ name: i.name, done: false, pingId: i.pingId, pinged: false })),
    })),
  };
}

// ---------------------------------------------------------------
// 2. SLASH COMMAND: /checklist  -> posts a fresh weekly checklist
// ---------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'checklist') {
      const state = freshState();
      const reply = await interaction.reply({ ...buildChecklistPayload(state), fetchReply: true });
      checklistState.set(reply.id, state);
      return;
    }

    // -----------------------------------------------------------
    // 3. BUTTON CLICKS: toggle item, ping when that specific item
    // (Edited or QC Approved) is checked for the first time.
    // -----------------------------------------------------------
    if (interaction.isButton() && interaction.customId.startsWith('chk_')) {
      const messageId = interaction.message.id;
      const state = checklistState.get(messageId);
      if (!state) {
        await interaction.reply({ content: 'This checklist expired — post a new one with /checklist.', ephemeral: true });
        return;
      }

      const [, rowIdxStr, itemIdxStr] = interaction.customId.split('_');
      const row = state.rows[Number(rowIdxStr)];
      const item = row.items[Number(itemIdxStr)];
      item.done = !item.done;

      if (item.done && item.pingId && !item.pinged) {
        item.pinged = true;
        const label = item.name === 'Edited' ? 'ready for QC' : 'approved';
        await interaction.channel.send(`${makeMention(item.pingId)} — **${row.label}**'s video is ${label}. (${item.name})`);
      }
      // Un-checking doesn't re-ping if checked again later (by design, avoids spam).
      // To allow re-pinging, reset item.pinged = false when item.done is toggled off.

      await interaction.update(buildChecklistPayload(state));
    }
  } catch (err) {
    // Discord interaction tokens expire after ~3s (code 10062 "Unknown
    // interaction"). Log it instead of crashing the whole bot — this is
    // usually caused by two bot instances running at once, or a slow
    // response. Doesn't affect other users' checklists.
    console.error('Interaction error:', err.message);
  }
});

// ---------------------------------------------------------------
// 4. Auto-post a fresh checklist every Monday morning
// (set your channel ID below and uncomment the call near the bottom)
// ---------------------------------------------------------------
function scheduleWeeklyReset(channelId) {
  cron.schedule(
    '0 8 * * 1',
    async () => {
      const channel = await client.channels.fetch(channelId);
      const state = freshState();
      const msg = await channel.send(buildChecklistPayload(state));
      checklistState.set(msg.id, state);
    },
    { timezone: 'Asia/Kuala_Lumpur' }
  );
}

// ---------------------------------------------------------------
// 5. KEEP-ALIVE (for Render's free tier)
// Render's free Web Service sleeps after ~15 min with no incoming
// HTTP traffic. This bot has no HTTP server on its own (it just
// talks to Discord), so we spin up a bare-bones one Render can see,
// then self-ping it every 14 minutes to keep the app awake.
// Not needed if you're hosting elsewhere (e.g. Oracle Cloud) — it's
// harmless either way, just skips the ping if RENDER_EXTERNAL_URL
// isn't set.
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Checklist bot is alive');
  })
  .listen(PORT, () => console.log(`Keep-alive server listening on port ${PORT}`));

function startKeepAlivePing() {
  // Render sets RENDER_EXTERNAL_URL automatically for web services.
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (!selfUrl) {
    console.log('RENDER_EXTERNAL_URL not set — skipping self-ping (fine if not on Render).');
    return;
  }
  setInterval(async () => {
    try {
      const res = await fetch(selfUrl);
      console.log(`Keep-alive ping -> ${res.status}`);
    } catch (err) {
      console.error('Keep-alive ping failed:', err.message);
    }
  }, 14 * 60 * 1000); // every 14 min — just under Render's 15-min idle timeout
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  // scheduleWeeklyReset('YOUR_CHANNEL_ID_HERE'); // uncomment to enable auto-reset
  startKeepAlivePing();
});

client.login(TOKEN);