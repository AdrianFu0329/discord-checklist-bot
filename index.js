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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
  Monday: '&1533389121622376489',
  Tuesday: '&1533389610762375228',
  Wednesday: '&1533389665627930675',
  Thursday: '&1533389719080271963',
  Friday: '&1533389774864519279',
  Saturday: '&1533389809878306947',
};
const EDITOR_BY_DAY = {
  Monday: '&1533389029058547785',
  Tuesday: '&1533389275608125530',
  Wednesday: '&1533389373826138153',
  Thursday: '&1533389443283685486',
  Friday: '&1533389491824365628',
  Saturday: '&1533389549336789077',
};

// Optional: send ping messages (QC/Editor notifications) to a DIFFERENT
// channel than the checklist itself. Leave as null to ping in the same
// channel the checklist was posted in.
const PING_CHANNEL_ID = '1533134289586229493'; // pings go here; checklist itself stays in whatever channel /checklist is run in

const DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

// Resolves where ping messages should go: PING_CHANNEL_ID if set,
// otherwise the same channel the checklist itself is in.
async function getPingChannel(fallbackChannel) {
  if (!PING_CHANNEL_ID) return fallbackChannel;
  try {
    return await client.channels.fetch(PING_CHANNEL_ID);
  } catch (err) {
    console.error('Could not fetch PING_CHANNEL_ID, falling back to checklist channel:', err.message);
    return fallbackChannel;
  }
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
            row.items.map((i) => `${i.done ? '✅' : '⬜'} ${i.name}`).join('   ') +
            (row.driveLink ? `\n🔗 ${row.driveLink}` : '')
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

// Pins a newly-posted checklist, and unpins any older checklist messages
// in the same channel first so the pin list doesn't fill up over time.
// Requires the bot to have the "Manage Messages" permission in that channel.
async function pinChecklist(message) {
  try {
    const pinned = await message.channel.messages.fetchPinned();
    const oldChecklists = pinned.filter(
      (m) => m.author.id === client.user.id && m.embeds[0]?.title === '📋 Weekly Video Checklist'
    );
    for (const old of oldChecklists.values()) {
      await old.unpin();
    }
    await message.pin();
  } catch (err) {
    // Most likely missing "Manage Messages" permission — log but don't crash.
    console.error('Could not pin checklist:', err.message);
  }
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
      await pinChecklist(reply);
      return;
    }

    // -----------------------------------------------------------
    // 3. BUTTON CLICKS
    // "Edited" going from unchecked -> checked: show a modal asking
    // for the Google Drive link before marking it done.
    // Everything else (un-checking, or QC Approved): toggle directly.
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

      if (item.name === 'Edited' && !item.done) {
        // Ask for the Drive link before marking this done.
        const modal = new ModalBuilder()
          .setCustomId(`chkmodal_${messageId}_${rowIdxStr}_${itemIdxStr}`)
          .setTitle(`${row.label} — Video Link`);

        const linkInput = new TextInputBuilder()
          .setCustomId('driveLink')
          .setLabel('Google Drive link')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://drive.google.com/...')
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(linkInput));
        await interaction.showModal(modal);
        return;
      }

      item.done = !item.done;

      if (item.done && item.pingId && !item.pinged) {
        item.pinged = true;
        const label = item.name === 'Edited' ? 'ready for QC' : 'approved';
        const linkLine = row.driveLink ? `\n${row.driveLink}` : '';
        const pingChannel = await getPingChannel(interaction.channel);
        await pingChannel.send(`${makeMention(item.pingId)} — **${row.label}**'s video is ${label}. (${item.name})${linkLine}`);
      }
      // Un-checking doesn't re-ping if checked again later (by design, avoids spam).
      // To allow re-pinging, reset item.pinged = false when item.done is toggled off.

      await interaction.update(buildChecklistPayload(state));
      return;
    }

    // -----------------------------------------------------------
    // 4. MODAL SUBMIT: save the Drive link, mark "Edited" done, ping QC
    // -----------------------------------------------------------
    if (interaction.isModalSubmit() && interaction.customId.startsWith('chkmodal_')) {
      const [, messageId, rowIdxStr, itemIdxStr] = interaction.customId.split('_');
      const state = checklistState.get(messageId);
      if (!state) {
        await interaction.reply({ content: 'This checklist expired — post a new one with /checklist.', ephemeral: true });
        return;
      }

      const row = state.rows[Number(rowIdxStr)];
      const item = row.items[Number(itemIdxStr)];
      const link = interaction.fields.getTextInputValue('driveLink').trim();

      row.driveLink = link;
      item.done = true;

      if (item.pingId && !item.pinged) {
        item.pinged = true;
        const pingChannel = await getPingChannel(interaction.channel);
        await pingChannel.send(`${makeMention(item.pingId)} — **${row.label}**'s video is ready for QC.\n${link}`);
      }

      const message = await interaction.channel.messages.fetch(messageId);
      await message.edit(buildChecklistPayload(state));
      await interaction.reply({ content: `Marked **${row.label}** as edited.`, ephemeral: true });
      return;
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
// 4. Auto-post a fresh checklist every Thursday morning, with an
// @everyone ping so the whole server sees it.
// ---------------------------------------------------------------
function scheduleWeeklyReset(channelId) {
  cron.schedule(
    '0 8 * * 4', // Thursday, 8am (day-of-week: 0=Sun ... 4=Thu)
    async () => {
      const channel = await client.channels.fetch(channelId);
      const state = freshState();
      const msg = await channel.send({
        content: '@everyone New weekly checklist is up!',
        allowedMentions: { parse: ['everyone'] },
        ...buildChecklistPayload(state),
      });
      checklistState.set(msg.id, state);
      await pinChecklist(msg);
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
  scheduleWeeklyReset('1533398389314551860'); // auto-posts every Thursday 8am
  startKeepAlivePing();
});

client.login(TOKEN);