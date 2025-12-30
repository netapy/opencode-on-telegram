import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { createOpencodeClient, type Event, type TextPart } from "@opencode-ai/sdk";

// Configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS?.split(",").map(Number) ?? [];
const OPENCODE_URL = process.env.OPENCODE_URL ?? "http://localhost:4096";

// Rate limiting for streaming updates
const MIN_UPDATE_INTERVAL_MS = 1000;
const MIN_CHARS_BEFORE_UPDATE = 50;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

// Initialize bot
const bot = new Bot(TELEGRAM_BOT_TOKEN);

// Auto-retry on rate limits
bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

// Initialize OpenCode client
const opencode = createOpencodeClient({ baseUrl: OPENCODE_URL });

// Auth middleware
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  
  if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(userId)) {
    await ctx.reply("You are not authorized to use this bot.");
    return;
  }
  
  await next();
});

// Start command
bot.command("start", async (ctx) => {
  await ctx.reply(
    "Welcome to OpenCode on Telegram!\n\n" +
    "Send me any message and I'll process it through OpenCode.\n\n" +
    "Commands:\n" +
    "/new - Start a new session\n" +
    "/sessions - List active sessions"
  );
});

// New session command
bot.command("new", async (ctx) => {
  try {
    const session = await opencode.session.create({
      body: { title: `Telegram ${ctx.from?.username ?? ctx.from?.id}` }
    });
    
    // Store session ID (TODO: implement proper session storage per user)
    await ctx.reply(`New session created: ${session.data?.id}`);
  } catch (error) {
    console.error("Failed to create session:", error);
    await ctx.reply("Failed to create new session. Is OpenCode running?");
  }
});

// Handle text messages
bot.on("message:text", async (ctx) => {
  const userMessage = ctx.message.text;
  
  // Send initial "thinking" message
  const thinkingMsg = await ctx.reply("Thinking...");
  
  try {
    // Get or create session (TODO: implement session storage per user)
    const sessions = await opencode.session.list();
    let sessionId = sessions.data?.[0]?.id;
    
    if (!sessionId) {
      const newSession = await opencode.session.create({
        body: { title: `Telegram ${ctx.from?.username ?? ctx.from?.id}` }
      });
      sessionId = newSession.data?.id;
    }
    
    if (!sessionId) {
      await ctx.api.editMessageText(ctx.chat.id, thinkingMsg.message_id, "Failed to get session.");
      return;
    }
    
    // Subscribe to events for streaming
    const events = await opencode.event.subscribe();
    
    // Send prompt
    opencode.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: userMessage }]
      }
    });
    
    // Stream response with throttling
    let accumulated = "";
    let lastUpdate = 0;
    let lastLength = 0;
    
    for await (const event of events.stream as AsyncIterable<Event>) {
      // Handle text part events
      if (event.type === "message.part.updated" && event.properties.part.type === "text") {
        const textPart = event.properties.part as TextPart;
        if (textPart.text) {
          accumulated = textPart.text;
          
          const now = Date.now();
          const charDiff = accumulated.length - lastLength;
          
          // Throttle updates: 1 second minimum + 50 chars minimum
          if (now - lastUpdate >= MIN_UPDATE_INTERVAL_MS && charDiff >= MIN_CHARS_BEFORE_UPDATE) {
            try {
              await ctx.api.editMessageText(ctx.chat.id, thinkingMsg.message_id, accumulated || "...");
              lastUpdate = now;
              lastLength = accumulated.length;
            } catch {
              // Ignore "message not modified" errors
            }
          }
        }
      }
      
      // Check if session is idle (response complete)
      if (event.type === "session.idle" && event.properties.sessionID === sessionId) {
        break;
      }
    }
    
    // Final update with complete response
    if (accumulated) {
      // Split long messages (Telegram limit: 4096 chars)
      if (accumulated.length > 4096) {
        await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id);
        const chunks = splitMessage(accumulated, 4096);
        for (const chunk of chunks) {
          await ctx.reply(chunk);
        }
      } else {
        await ctx.api.editMessageText(ctx.chat.id, thinkingMsg.message_id, accumulated);
      }
    }
    
  } catch (error) {
    console.error("Error processing message:", error);
    await ctx.api.editMessageText(
      ctx.chat.id,
      thinkingMsg.message_id,
      "Error processing your message. Is OpenCode running?"
    );
  }
});

// Helper to split long messages
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    
    // Try to split at newline
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      // Fall back to space
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      // Hard split
      splitAt = maxLength;
    }
    
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  
  return chunks;
}

// Start the bot
console.log("Starting OpenCode Telegram bot...");
bot.start();
