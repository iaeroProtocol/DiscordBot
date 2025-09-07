import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const appId   = process.env.DISCORD_APP_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const token   = process.env.DISCORD_TOKEN;

if (!appId || !guildId || !token) {
  throw new Error('Missing DISCORD_APP_ID / DISCORD_GUILD_ID / DISCORD_TOKEN');
}

// define commands
const commands = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the protocol Docs Bot')
    .addStringOption(opt =>
      opt.setName('question')
         .setDescription('Your question')
         .setRequired(true)
    )
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('🔧 Registering guild commands…');
    await rest.put(
      Routes.applicationGuildCommands(appId, guildId),
      { body: commands }
    );
    console.log('✅ Slash command /ask registered.');
  } catch (e) {
    console.error('❌ Failed to register commands:', e);
    process.exit(1);
  }
})();

