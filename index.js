import * as dotenv from "dotenv";
dotenv.config();
import http from "node:http";
import { Bot, InlineKeyboard } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { Redis } from "ioredis";
import { CronJob } from "cron";

const bot = new Bot(process.env.BOT_TOKEN);
const redis = new Redis(process.env.REDIS_CLIENT_URL);

async function addVocabulary(conversation, ctx) {
  await ctx.reply(
    "Please send the word you want to add to your vocabulary list.",
  );
  const { message } = await conversation.waitFor("message:text");
  if (!message.text) {
    await ctx.reply("Please send a valid word.");
    return;
  }
  const word = message.text.trim().toLocaleLowerCase();
  await conversation.external(() => redis.sadd("vocabularies", word));

  await ctx.reply(`The word "${word}" has been added to your vocabulary list.`);
}

bot.use(conversations());
bot.use(createConversation(addVocabulary));

bot.command("start", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  await ctx.reply(
    `Hello ${ctx.from.first_name || ctx.from.username}! I am your vocabulary bot.`,
  );
});

bot.command("add", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  await ctx.conversation.enter("addVocabulary");
});

bot.command("random", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const vocabularies = await redis.smembers("vocabularies");
  if (vocabularies.length === 0) {
    await ctx.reply("No vocabulary words found. Please add some first.");
  } else {
    const randomWord =
      vocabularies[Math.floor(Math.random() * vocabularies.length)];
    const meaning = await getWordMeaning(randomWord);
    if (meaning) {
      const message = renderWordEntry(meaning);
      await ctx.reply(message, {
        parse_mode: "MarkdownV2",
      });
    } else {
      await ctx.reply(
        "Sorry, I couldn't find the definition for the random word.",
      );
    }
  }
});

bot.command("list", async (ctx) => {
  await ctx.replyWithChatAction("typing");
  const vocabularies = await redis.smembers("vocabularies");

  const keyboard = new InlineKeyboard();

  vocabularies.sort().forEach((word, i) => {
    keyboard.text(word, `action:${word}`);
    if ((i + 1) % 3 === 0) {
      keyboard.row();
    }
  });

  await ctx.reply("Your vocabulary words:", { reply_markup: keyboard });
});

bot.on("callback_query:data", async (ctx) => {
  await ctx.replyWithChatAction("typing");

  const data = ctx.callbackQuery.data;

  if (data.startsWith("action:")) {
    const word = data.split(":")[1];
    const menu = new InlineKeyboard()
      .text("Get Meaning", `get_meaning:${word}`)
      .primary()
      .text("Remove", `remove:${word}`)
      .danger();
    await ctx.reply(`What would you like to do with "${word}"?`, {
      reply_markup: menu,
    });
  }

  if (data.startsWith("get_meaning:")) {
    const word = data.split(":")[1];
    const meaning = await getWordMeaning(word);
    if (meaning) {
      await ctx.reply(renderWordEntry(meaning), {
        parse_mode: "MarkdownV2",
      });
    } else {
      await ctx.reply(`Sorry, I couldn't find the definition for "${word}".`);
    }
  }

  if (data.startsWith("remove:")) {
    const word = data.split(":")[1];
    await redis.srem("vocabularies", word);
    await ctx.reply(
      `The word "${word}" has been removed from your vocabulary list.`,
    );
  }
});

bot.catch((err) => {
  if (process.env.NODE_ENV === "development") {
    console.error("Error in bot:", err);
  }
});

async function getWordMeaning(word) {
  try {
    const response = await fetch(
      `https://freedictionaryapi.com/api/v1/entries/en/${word}`,
    );

    if (!response.ok) {
      throw new Error(`Word not found: ${word}`);
    }

    const data = await response.json();

    return data;
  } catch (error) {
    console.error(error.message);
    return null;
  }
}

/**
 * Escapes characters that MarkdownV2 treats as special.
 */
function escapeMarkdownV2(text) {
  if (!text) return "";
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

/**
 * Renders a dictionary API response as a Telegram MarkdownV2 message.
 */
function renderWordEntry(data) {
  const word = escapeMarkdownV2(data?.word) || "Unknown word";

  // Use the first entry (usually the most common part of speech)
  const entry = data?.entries?.[0];

  const partOfSpeech = escapeMarkdownV2(entry?.partOfSpeech);

  // Grab the first available pronunciation, prefer type "ipa"
  const pronunciationObj =
    entry?.pronunciations?.find((p) => p?.type === "ipa") ??
    entry?.pronunciations?.[0];
  const pronunciation = escapeMarkdownV2(pronunciationObj?.text);

  const firstSense = entry?.senses?.[0];
  const definition =
    escapeMarkdownV2(firstSense?.definition) || "No definition available\\.";
  const example = escapeMarkdownV2(firstSense?.examples?.[0]);

  // Synonyms can live on the sense or the entry — merge and dedupe
  const synonymList = [
    ...(firstSense?.synonyms ?? []),
    ...(entry?.synonyms ?? []),
  ].filter(Boolean);
  const uniqueSynonyms = [...new Set(synonymList)];

  let message = `*${word}*`;
  if (pronunciation) message += ` \\(${pronunciation}\\)`;
  message += `\n`;
  if (partOfSpeech) message += `_${partOfSpeech}_\n\n`;
  message += definition;

  if (example) {
    message += `\n\n📌 *Example:*\n${example}`;
  }

  if (uniqueSynonyms.length > 0) {
    const synonyms = uniqueSynonyms.map((s) => escapeMarkdownV2(s)).join(", ");
    message += `\n\n🔄 *Synonyms:* ${synonyms}`;
  }

  return message;
}

const job = new CronJob(process.env.CRON_SCHEDULE, async () => {
  const vocabularies = await redis.smembers("vocabularies");
  if (vocabularies.length > 0) {
    const randomWord =
      vocabularies[Math.floor(Math.random() * vocabularies.length)];
    const meaning = await getWordMeaning(randomWord);
    if (meaning) {
      const message = renderWordEntry(meaning);
      await bot.api.sendMessage(process.env.CHAT_ID, message, {
        parse_mode: "MarkdownV2",
      });
    }
  }
});

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running\n");
  });

  server.listen(process.env.PORT || 3000, () => {
    console.log(`Server is running on port ${process.env.PORT || 3000}`);
  });

  job.start();

  await bot.api.setMyCommands([
    { command: "start", description: "Start the bot" },
    { command: "add", description: "Add a new vocabulary word" },
    { command: "random", description: "Get a random vocabulary word" },
    { command: "list", description: "List all vocabulary words" },
  ]);

  await bot.start({
    drop_pending_updates: true,
    onStart: (botInfo) => {
      console.log(`Bot started as @${botInfo.username}`);
    },
  });

  // Graceful shutdown
  process.once("SIGINT", () => {
    console.log("SIGINT received, stopping bot...");
    bot.stop();
    job.stop();
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });
}

main();
