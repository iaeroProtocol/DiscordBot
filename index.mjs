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
  // NEW tuning flags (optional)
  STRICT_ANSWERS = 'true',
  MIN_SOURCES = '1',
  MIN_ANSWER_CHARS = '40',
  MIN_CONFIDENCE = '0.35',
} = process.env;

const STRICT = String(STRICT_ANSWERS).toLowerCase() !== 'false';
const MIN_SRC = Math.max(0, parseInt(MIN_SOURCES || '1', 10));
const MIN_LEN = Math.max(0, parseInt(MIN_ANSWER_CHARS || '40', 10));
const MIN_CONF = Math.max(0, Math.min(1, parseFloat(MIN_CONFIDENCE || '0.35')));

console.log('ENV check:', {
  DISCORD_TOKEN: DISCORD_TOKEN ? `${DISCORD_TOKEN.slice(0, 5)}…` : '(missing)',
  DISCORD_CLIENT_ID: DISCORD_CLIENT_ID || '(missing - needed for slash commands)',
  DOCSBOT_TEAM_ID,
  DOCSBOT_BOT_ID,
  DOCSBOT_API_KEY: DOCSBOT_API_KEY ? 'present' : '(missing)',
  ALLOWED_CHANNEL_IDS: ALLOWED_CHANNEL_IDS || '(none)',
  STRICT_ANSWERS: STRICT,
  MIN_SOURCES: MIN_SRC,
  MIN_ANSWER_CHARS: MIN_LEN,
  MIN_CONFIDENCE: MIN_CONF,
});

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!DOCSBOT_TEAM_ID) throw new Error('Missing DOCSBOT_TEAM_ID');
if (!DOCSBOT_BOT_ID) throw new Error('Missing DOCSBOT_BOT_ID');
if (!DOCSBOT_API_KEY) throw new Error('Missing DOCSBOT_API_KEY');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

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

// ── Conversation tracking ────────────────────────────────────────────────────
const convoByUser = new Map();
function getConversationIdForUser(userId) {
  let id = convoByUser.get(userId);
  if (!id) {
    id = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).toString();
    convoByUser.set(userId, id);
  }
  return id;
}

// ── Strict answer heuristics ─────────────────────────────────────────────────
// Matches common fallback/clarification language
const FALLBACK_PATTERNS = [
  /i\s+don['’]t\s+know/i,
  /not\s+sure/i,
  /please\s+clarify/i,
  /can\s+you\s+clarify/i,
  /i\s+could\s+not\s+find/i,
  /couldn['’]t\s+find/i,
  /no\s+information/i,
  /unsure/i,
  /as\s+an\s+ai/i,
  /i\s+do\s+not\s+have\s+enough\s+context/i,
  /i\s+can(?:not|'t)\s+help\s+with\s+that/i,
  /try\s+again/i,
  /rephrase/i,
];

function looksLikeFallback(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length === 0) return true;
  // very short answers are suspicious
  if (t.length < MIN_LEN) return true;
  // generic fallbacks
  return FALLBACK_PATTERNS.some(re => re.test(t));
}

// try to read any confidence-like fields from DocsBot events
function extractConfidence(candidate) {
  const d = candidate?.data || {};
  const cands = [
    d.confidence,
    d.score,
    d.relevance,
    d.similarity,
    d.lookup_score,
  ];
  for (const v of cands) {
    const n = Number(v);
    if (Number.isFinite(n)) return n; // 0..1 or 0..100 — we’ll normalize
  }
  // also try source scores
  const sources = Array.isArray(d.sources) ? d.sources : [];
  for (const s of sources) {
    const n = Number(s?.score ?? s?.confidence ?? s?.similarity);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}
function normalizeConfidence(x) {
  if (!Number.isFinite(x)) return NaN;
  return x > 1 ? x / 100 : x; // accept 0..100 or 0..1
}

function passesStrictGate(answer, sources, chosen) {
  if (!STRICT) return true; // permissive mode

  // textual heuristics
  if (looksLikeFallback(answer)) return false;

  // sources
  const src = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (MIN_SRC > 0 && src.length < MIN_SRC) return false;

  // confidence if present
  const raw = extractConfidence(chosen);
  const conf = normalizeConfidence(raw);
  if (Number.isFinite(conf) && conf < MIN_CONF) return false;

  return true;
}

// ── DocsBot API ──────────────────────────────────────────────────────────────
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
      return { ok: false, answer: '', sources: [] };
    }

    const events = JSON.parse(responseText);
    const lookup = events.find(e => e?.event === 'lookup_answer');
    const simple = events.find(e => e?.event === 'answer');
    const chosen = lookup || simple || events[0];

    const answer = chosen?.data?.answer?.trim() || '';
    const sources = Array.isArray(chosen?.data?.sources) ? chosen.data.sources : [];

    const ok = passesStrictGate(answer, sources, chosen);
    console.log(`[DocsBot] Answer gate: ${ok ? 'PASS' : 'BLOCK'}`);
    return { ok, answer, sources, chosen };

  } catch (error) {
    console.error('[DocsBot] Error:', error.message);
    // Treat errors as no-answer so callers can suppress output
    return { ok: false, answer: '', sources: [] };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Auto-answer channels ─────────────────────────────────────────────────────
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

    const { ok, answer, sources } = await askDocsBot(question, interaction.user.id);

    if (!ok) {
      await interaction.editReply({ content: '🤐 No confident answer found for that question.' });
      return;
    }

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
      if (sourceList.length > 0) embed.addFields({ name: 'Sources', value: sourceList });
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
    if (msg.author.bot) return;

    if (msg.content.trim().toLowerCase() === 'new topic') {
      convoByUser.delete(msg.author.id);
      await msg.reply('🧹 Started a new conversation. Ask away!');
      return;
    }

    const isAutoChannel = autoChannels.has(msg.channelId);
    const isMentioned = msg.mentions.has(client.user);
    if (!isMentioned && !isAutoChannel) return;

    let question = msg.content;

    if (isMentioned) {
      question = msg.content.replace(/<@!?(\d+)>/g, '').trim();
      if (!question) return;
      console.log('[Mention] User asked:', question);
    }

    if (isAutoChannel && !isMentioned) {
      const text = msg.content.trim().toLowerCase();
      if (text.length < 5) return;
      if (text.startsWith('!') || text.startsWith('/') || text.startsWith('.')) return;
      const skipWords = ['gm', 'gn', 'thanks', 'thank you', 'ty', 'ok', 'nice', 'lol'];
      if (skipWords.some(word => text === word || text.startsWith(word + ' '))) return;
      const questionIndicators = ['what', 'how', 'why', 'when', 'where', 'who', 'can', 'does,', 'is'];
      const hasQuestion = text.includes('?') || questionIndicators.some(w => text.startsWith(w + ' '));
      const hasKeywords = ['iaero', 'aero', 'stake', 'vault', 'token', 'reward'].some(k => text.includes(k));
      if (!hasQuestion && !hasKeywords) return;
      console.log('[Auto-answer] Detected question:', question);
    }

    await msg.channel.sendTyping().catch(() => {});

    const { ok, answer, sources } = await askDocsBot(question, msg.author.id);
    if (!ok) {
      // Strict mode: do not reply at all on low confidence
      console.log('[Auto/Mention] Suppressed low-confidence answer');
      return;
    }

    let response = `<@${msg.author.id}>\n\n**${question}**\n\n${answer}`;
    if (sources?.length > 0) {
      const sourceLinks = sources.map(s => s.url || s.title).filter(Boolean).join('\n');
      if (sourceLinks) response += `\n\n📚 **Sources:**\n${sourceLinks}`;
    }

    if (response.length > 2000) response = response.slice(0, 1997) + '...';

    const sentMsg = await msg.channel.send(response);
    console.log('[Message sent] ID:', sentMsg.id);

  } catch (error) {
    console.error('[MessageCreate] Unexpected error:', error);
  }
});

// ── Connect ─────────────────────────────────────────────────────────────────
console.log('🔌 Connecting to Discord…');
client.login(DISCORD_TOKEN)
  .then(() => console.log('🟢 Login successful'))
  .catch((err) => {
    console.error('❌ Failed to login:', err.message);
    process.exit(1);
  });

// Keep process alive
setInterval(() => {}, 60000);
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
