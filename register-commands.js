// Run this once (or whenever you change commands) to register /checklist
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { TOKEN, CLIENT_ID } = require('./config');

const commands = [
  new SlashCommandBuilder()
    .setName('checklist')
    .setDescription('Post a fresh weekly checklist'),
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  // Global registration — no GUILD_ID needed. Can take up to ~1 hour to
  // show up in Discord the first time; instant on subsequent edits usually.
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('Slash commands registered (global).');
})();
