// salebot — Telegram-бот для рассылки предложений.
import { Bot } from 'grammy';

const TOKEN = process.env.SALEBOT_TOKEN || '';
const bot = new Bot(TOKEN);

bot.command('start', (ctx) => ctx.reply('Привет! Я salebot.'));
bot.command('status', (ctx) => ctx.reply('Работаю в штатном режиме.'));

bot.on('message', (ctx) => {
  const text = ctx.message.text || '';
  ctx.reply(formatReply(text));
});

export async function run() {
  if (!TOKEN) throw new Error('SALEBOT_TOKEN не задан');
  await bot.start();
}

// Точка входа при прямом запуске.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(e); process.exit(1); });
}
