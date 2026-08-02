require('dotenv').config();

// Secrets now come ONLY from environment variables (loaded from a local
// .env file, which is never committed to Git). No hardcoded fallbacks —
// that's what leaked the previous token into chat.
if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID. Copy .env.example to .env and fill in your values.');
  process.exit(1);
}

module.exports = {
  TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
};