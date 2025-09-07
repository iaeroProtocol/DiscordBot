// index.mjs
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
} from 'discord.js';

// ── Boot diagnostics ──────────────────────────────────────────────────────────
console.log('🚀 Starting Docs Bot bridge…');
console.log('📁 CWD:', process.cwd());
console.log('🔧 Node:', process.version);

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DOCSBOT_TEAM_ID,
  DOCSBOT_BOT_ID,
  DOCSBOT_API_KEY,
  ALLOWED_CHANNEL_IDS,
} = process.env;

console.log('ENV check:', {
  DISCORD_TOKEN: DISCORD_TOKEN ? `${DISCORD_TOKEN.slice(0, 5)}…` : '(missing)',
  DISCORD_CLIENT_ID: DISCORD_CLIENT_ID || '(missing - needed for slash commands)',
  DOCSBOT_TEAM_ID,
  DOCSBOT_BOT_ID,
  DOCSBOT_API_KEY: DOCSBOT_API_KEY ? 'present' : '(missing)',
  ALLOWED_CHANNEL_IDS: ALLOWED_CHANNEL_IDS || '(none)',
});

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!DOCSBOT_TEAM_ID) throw new Error('Missing DOCSBOT_TEAM_ID');
if (!DOCSBOT_BOT_ID) throw new Error('Missing DOCSBOT_BOT_ID');
if (!DOCSBOT_API_KEY) throw new Error('Missing DOCSBOT_API_KEY');

// ── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ── Register slash commands ──────────────────────────────────────────────────
async function registerCommands() {
  if (!DISCORD_CLIENT_ID) {
    console.warn('⚠️ DISCORD_CLIENT_ID not set - slash commands will not be registered');
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName('ask')
      .setDescription('Ask the Docs Bot a question')
      .addStringOption(option =>
        option.setName('question')
          .setDescription('Your question for the bot')
          .setRequired(true)
          .setMaxLength(500)
      ),
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    console.log('📝 Clearing old commands and registering new ones...');
    
    // Clear then register to avoid duplicates
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: [] });
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
    
    console.log('✅ Successfully registered slash commands');
  } catch (error) {
    console.error('❌ Error registering slash commands:', error);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  await registerCommands();
});

client.on('warn', (m) => console.warn('[warn]', m));
client.on('error', (e) => console.error('[client error]', e));

// ── Per-user conversation tracking ───────────────────────────────────────────
const convoByUser = new Map();

function getConversationIdForUser(userId) {
  let id = convoByUser.get(userId);
  if (!id) {
    id = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).toString();
    convoByUser.set(userId, id);
  }
  return id;
}

// ── DocsBot API function ─────────────────────────────────────────────────────
async function askDocsBot(question, userId) {
  console.log('[DocsBot] Calling API with question:', question);
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  const conversationId = getConversationIdForUser(userId);
  const url = `https://api.docsbot.ai/teams/${DOCSBOT_TEAM_ID}/bots/${DOCSBOT_BOT_ID}/chat-agent`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${DOCSBOT_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        conversationId,
        question,
        stream: false,
        context_items: 5,
        document_retriever: true,
        followup_rating: false,
        human_escalation: false,
      }),
      signal: controller.signal,
    });

    console.log('[DocsBot] Response status:', res.status);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[DocsBot] API error:', text);
      throw new Error(`DocsBot ${res.status}: ${text}`);
    }

    const responseText = await res.text();
    
    if (!responseText || responseText === 'null') {
      console.warn('[DocsBot] Received null response');
      return {
        answer: 'The bot is still initializing. Please try again in a moment.',
        sources: []
      };
    }

    const events = JSON.parse(responseText);
    const lookup = events.find(e => e?.event === 'lookup_answer');
    const simple = events.find(e => e?.event === 'answer');
    const chosen = lookup || simple || events[0];

    const answer = chosen?.data?.answer?.trim() || 'Sorry, I could not find an answer.';
    const sources = Array.isArray(chosen?.data?.sources) ? chosen.data.sources : [];

    console.log('[DocsBot] Answer retrieved successfully');
    return { answer, sources };
    
  } catch (error) {
    console.error('[DocsBot] Error:', error.message);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Auto-answer channel config ───────────────────────────────────────────────
const autoChannels = new Set(
  (ALLOWED_CHANNEL_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);
console.log('🧭 Auto-answer channels:', [...autoChannels]);

// ── Slash command handler ────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'ask') return;

  try {
    const question = interaction.options.getString('question', true);
    
    await interaction.deferReply({ flags: 64 }); // Ephemeral
    
    const { answer, sources } = await askDocsBot(question, interaction.user.id);
    
    // Build embed
    const embed = new EmbedBuilder()
      .setColor(0x2dd4bf)
      .setTitle('Answer')
      .setDescription(answer.slice(0, 4000))
      .setFooter({ text: 'Powered by DocsBot.ai' });
    
    if (sources.length > 0) {
      const sourceList = sources
        .slice(0, 5)
        .map(s => `• [${s.title || 'Source'}](${s.url || '#'})`)
        .join('\n')
        .slice(0, 1024);
      embed.addFields({ name: 'Sources', value: sourceList });
    }
    
    await interaction.editReply({ embeds: [embed] });
    
  } catch (error) {
    console.error('[Slash command error]', error);
    const errorMsg = { content: '❌ I had trouble getting an answer. Please try again.' };
    if (interaction.deferred) {
      await interaction.editReply(errorMsg).catch(() => {});
    } else {
      await interaction.reply({ ...errorMsg, flags: 64 }).catch(() => {});
    }
  }
});

// ── Message handler ──────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (msg) => {
  try {
    // Ignore bot messages
    if (msg.author.bot) return;
    
    // Reset conversation command
    if (msg.content.trim().toLowerCase() === 'new topic') {
      convoByUser.delete(msg.author.id);
      await msg.reply('🧹 Started a new conversation. Ask away!');
      return;
    }
    
    const isAutoChannel = autoChannels.has(msg.channelId);
    const isMentioned = msg.mentions.has(client.user);
    
    // Skip if not mentioned and not in auto-channel
    if (!isMentioned && !isAutoChannel) return;
    
    let question = msg.content;
    
    // If mentioned, remove the mention from the question
    if (isMentioned) {
      question = msg.content.replace(/<@!?(\d+)>/g, '').trim();
      if (!question) return;
      console.log('[Mention] User asked:', question);
    }
    
    // If auto-channel, check if it looks like a question
    if (isAutoChannel && !isMentioned) {
      const text = msg.content.trim().toLowerCase();
      
      // Skip short messages
      if (text.length < 5) return;
      
      // Skip commands
      if (text.startsWith('!') || text.startsWith('/') || text.startsWith('.')) return;
      
      // Skip common non-questions
      const skipWords = ['gm', 'gn', 'thanks', 'thank you', 'ty', 'ok', 'nice', 'lol'];
      if (skipWords.some(word => text === word || text.startsWith(word + ' '))) return;
      
      // Check if it's likely a question
      const questionIndicators = ['what', 'how', 'why', 'when', 'where', 'who', 'can', 'does', 'is'];
      const hasQuestion = text.includes('?') || questionIndicators.some(w => text.startsWith(w + ' '));
      const hasKeywords = ['iaero', 'aero', 'stake', 'vault', 'token', 'reward'].some(k => text.includes(k));
      
      if (!hasQuestion && !hasKeywords) return;
      
      console.log('[Auto-answer] Detected question:', question);
    }
    
    // Send typing indicator
    await msg.channel.sendTyping().catch(() => {});
    
    // Get answer from DocsBot
    let answer, sources;
    try {
      const result = await askDocsBot(question, msg.author.id);
      answer = result.answer;
      sources = result.sources;
    } catch (error) {
      console.error('[MessageCreate] Error getting answer:', error);
      answer = 'Sorry, I encountered an error. Please try again in a moment.';
      sources = [];
    }
    
    // Send the answer as a simple message
    try {
      let response = `<@${msg.author.id}>\n\n**${question}**\n\n${answer}`;
      
      // Add sources if available
      if (sources.length > 0) {
        const sourceLinks = sources.map(s => s.url || s.title).filter(Boolean).join('\n');
        if (sourceLinks) {
          response += `\n\n📚 **Sources:**\n${sourceLinks}`;
        }
      }
      
      // Discord has a 2000 character limit
      if (response.length > 2000) {
        response = response.slice(0, 1997) + '...';
      }
      
      const sentMsg = await msg.channel.send(response);
      console.log('[Message sent] ID:', sentMsg.id);
      
    } catch (sendError) {
      console.error('[MessageCreate] Error sending message:', sendError);
      // Try ultra-simple fallback
      try {
        await msg.channel.send(`<@${msg.author.id}> ${answer.slice(0, 1900)}`);
      } catch (e) {
        console.error('[MessageCreate] Failed to send any message:', e);
      }
    }
    
  } catch (error) {
    console.error('[MessageCreate] Unexpected error:', error);
  }
});

// ── Connect to Discord ───────────────────────────────────────────────────────
console.log('🔌 Connecting to Discord…');
client.login(DISCORD_TOKEN)
  .then(() => console.log('🟢 Login successful'))
  .catch((err) => {
    console.error('❌ Failed to login:', err.message);
    process.exit(1);
  });

// Keep process alive
setInterval(() => {}, 60000);