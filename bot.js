// Telegram-бот кафе-пекарни «Мука & Мёд» на Node.js (без зависимостей, нужен Node 20.6+).
// Запуск: node --env-file=.env bot.js
// «Мозг» бота — системный промпт из prompts/system.md, модель — бесплатная, через OpenRouter.

const fs = require('node:fs');
const path = require('node:path');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OR_KEY = process.env.OPENROUTER_API_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // необязательно: куда слать заявки
const TIMEZONE = process.env.TIMEZONE || 'Asia/Almaty';
const MODELS = (process.env.OPENROUTER_MODELS ||
  'google/gemma-4-31b-it:free,nvidia/nemotron-3-ultra-550b-a55b:free,baidu/ernie-5.5-flash-preview:free')
  .split(',').map((s) => s.trim()).filter((m) => m.endsWith(':free')); // только бесплатные модели
const HISTORY_LIMIT = 20; // сколько последних сообщений помнить на чат
const DATA_DIR = path.join(__dirname, 'data');

if (!TG_TOKEN || !OR_KEY) {
  console.error('Нет TELEGRAM_BOT_TOKEN или OPENROUTER_API_KEY. Запускайте: node --env-file=.env bot.js');
  process.exit(1);
}

const PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompts', 'system.md'), 'utf8');

// Подставляем в промпт текущую дату, чтобы бот понимал «завтра», «в пятницу».
function systemPrompt() {
  const d = new Date();
  const human = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeStyle: 'short', timeZone: TIMEZONE }).format(d);
  const iso = new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE }).format(d); // ГГГГ-ММ-ДД
  return PROMPT_TEMPLATE.replaceAll('{{NOW}}', `${human} (${iso}), часовой пояс ${TIMEZONE}`);
}

const TG = `https://api.telegram.org/bot${TG_TOKEN}`;
const histories = new Map(); // chatId -> [{role, content}]
const queues = new Map(); // chatId -> Promise: сообщения одного чата обрабатываем по очереди

const GREETING =
  'Привет! Я Миша, виртуальный помощник кафе-пекарни «Мука & Мёд» 🥐\n' +
  'Покажу меню, приму заявку на столик, подготовлю коммерческое предложение для вашей компании ' +
  'или отвечу на любые вопросы о кафе. С чего начнём?';

const KEYBOARD = {
  inline_keyboard: [
    [{ text: '🍽 Меню', callback_data: 'menu' }, { text: '📅 Забронировать', callback_data: 'book' }],
    [{ text: '💼 Коммерческое предложение', callback_data: 'offer' }],
    [{ text: '📍 Адрес и часы работы', callback_data: 'contacts' }],
  ],
};

// Быстрые действия: кнопки и команды превращаются в обычный вопрос к модели.
const QUICK = {
  menu: 'Покажи меню кафе.',
  book: 'Хочу забронировать столик.',
  offer: 'Мне нужно коммерческое предложение для компании.',
  contacts: 'Где вы находитесь, как с вами связаться и какой у вас график работы?',
};

// Сеть до Telegram бывает медленной (подключение 8-10 с), поэтому
// при сетевых сбоях запрос повторяется несколько раз.
async function tg(method, body = {}, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(`${TG}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw Object.assign(new Error(`Telegram ${method}: ${data.description}`), { api: true });
      return data.result;
    } catch (e) {
      if (e.api || i >= attempts) throw e; // ошибки API не повторяем
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

async function askModel(history) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      models: MODELS, // OpenRouter сам переключится на следующую при 429/ошибке
      max_tokens: 1200,
      temperature: 0.4,
      messages: [{ role: 'system', content: systemPrompt() }, ...history],
    }),
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(data.error?.message || 'Пустой ответ модели');
  return text;
}

// Модель в конце ответа добавляет служебную метку [[BOOKING {...}]], [[LEAD {...}]] или [[HANDOFF {...}]].
// Гостю метка не показывается: бот вырезает её и сохраняет заявку.
const MARKER_RE = /\[\[(BOOKING|LEAD|HANDOFF)\s+(\{[\s\S]*?\})\s*\]\]/g;

function extractMarkers(text) {
  const events = [];
  let clean = text.replace(MARKER_RE, (_, type, json) => {
    try { events.push({ type, data: JSON.parse(json) }); } catch { /* битый JSON — пропускаем */ }
    return '';
  });
  clean = clean.replace(/\[\[[\s\S]*?\]\]/g, '').trim(); // на случай недописанных меток
  return { clean, events };
}

// Сообщения уходят как обычный текст, поэтому убираем Markdown, если модель всё же его вставила.
function stripMarkdown(text) {
  return text
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
    .replace(/__([\s\S]+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[*-]\s+/gm, '• ')
    .replace(/`([^`]+)`/g, '$1');
}

// Защита от обхода подтверждения: заявку (BOOKING/LEAD) сохраняем, только если предыдущая реплика бота
// была вопросом гостю «Всё верно? Отправляю?». Иначе модель могла «согласиться» вместо гостя.
const CONFIRM_RE = /верно|подтверд|отправ|передать|согласу/i;

function guardEvents(events, prevAssistant) {
  const accepted = [];
  const rejected = [];
  for (const ev of events) {
    const needsConfirm = ev.type === 'BOOKING' || ev.type === 'LEAD';
    (needsConfirm && !CONFIRM_RE.test(prevAssistant) ? rejected : accepted).push(ev);
  }
  return { accepted, rejected };
}

// Сводка для повторного подтверждения, собранная кодом, а не моделью.
function confirmationText(ev) {
  const d = ev.data;
  if (ev.type === 'BOOKING') {
    return `Давайте сверим данные перед отправкой:\n• Имя: ${d.name}\n• Телефон: ${d.phone}\n• Дата: ${d.date}\n• Время: ${d.time}\n• Гостей: ${d.guests}` +
      `${d.comment ? `\n• Пожелания: ${d.comment}` : ''}\n\nВсё верно? Напишите «Да», и я отправлю заявку администратору.`;
  }
  return `Проверим запрос перед отправкой:\n• Компания: ${d.company}\n• Формат: ${d.format}\n• Человек: ${d.people}\n• Дата: ${d.date}\n• Сумма: ${d.total} ₸\n\nВсё верно? Напишите «Да», чтобы передать запрос менеджеру.`;
}

const TITLES = { BOOKING: '📅 Новая заявка на бронь', LEAD: '💼 Запрос коммерческого предложения', HANDOFF: '🙋 Нужен администратор' };

async function saveEvent(ev, msg) {
  const record = {
    time: new Date().toISOString(),
    type: ev.type,
    chatId: msg.chat.id,
    username: msg.from?.username || null,
    data: ev.data,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(DATA_DIR, 'requests.jsonl'), JSON.stringify(record) + '\n');
  console.log(`${ev.type}:`, JSON.stringify(ev.data));

  if (ADMIN_CHAT_ID) {
    const lines = Object.entries(ev.data).map(([k, v]) => `${k}: ${v}`);
    const from = msg.from?.username ? `@${msg.from.username}` : `chat ${msg.chat.id}`;
    await tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `${TITLES[ev.type]}\nот ${from}\n\n${lines.join('\n')}` })
      .catch((e) => console.error('Не удалось уведомить администратора:', e.message));
  }
}

async function sendLong(chatId, text, extra = {}) {
  for (let i = 0; i < text.length; i += 4000) {
    await tg('sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000), ...(i === 0 ? extra : {}) });
  }
}

async function reply(msg, text) {
  const chatId = msg.chat.id;
  const history = histories.get(chatId) || [];
  // Гость не должен подсовывать модели служебные метки [[...]].
  history.push({ role: 'user', content: text.replace(/\[\[|\]\]/g, '').slice(0, 2000) });
  while (history.length > HISTORY_LIMIT) history.shift();
  histories.set(chatId, history);
  const prev = history.at(-2);
  const prevAssistant = prev?.role === 'assistant' ? prev.content : '';

  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    let raw;
    try {
      raw = await askModel(history);
    } catch (e) {
      console.warn('Повтор после ошибки:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
      raw = await askModel(history);
    }
    const { clean, events } = extractMarkers(raw);
    const { accepted, rejected } = guardEvents(events, prevAssistant);
    // Если модель попыталась оформить заявку без подтверждения гостя, вместо её текста
    // показываем сводку и просим подтвердить.
    let answer = clean;
    if (rejected.length) {
      console.warn('Заявка без подтверждения отклонена:', rejected.map((e) => e.type).join(','));
      answer = confirmationText(rejected[0]);
    }
    history.push({ role: 'assistant', content: answer || raw });
    while (history.length > HISTORY_LIMIT) history.shift();
    for (const ev of accepted) await saveEvent(ev, msg);
    await sendLong(chatId, stripMarkdown(answer) || 'Готово! Если нужна помощь, я на связи 🙂');
  } catch (e) {
    console.error('Ошибка:', e.message);
    history.pop(); // не оставляем вопрос без ответа в истории
    await sendLong(chatId, 'Кажется, на кухне небольшая заминка 🙈 Попробуйте ещё раз через минуту или позвоните: +7 (700) 123-45-67.');
  }
}

async function handleMessage(msg) {
  const text = msg.text;
  if (!text) return;
  const chatId = msg.chat.id;
  const cmd = text.split(/[\s@]/)[0];

  if (cmd === '/start') {
    histories.delete(chatId);
    return sendLong(chatId, GREETING, { reply_markup: KEYBOARD });
  }
  if (cmd === '/reset') {
    histories.delete(chatId);
    return sendLong(chatId, 'Диалог начат заново. Чем могу помочь?', { reply_markup: KEYBOARD });
  }
  if (cmd === '/menu') return reply(msg, QUICK.menu);
  if (cmd === '/book') return reply(msg, QUICK.book);
  if (cmd === '/offer') return reply(msg, QUICK.offer);
  if (cmd === '/contacts') return reply(msg, QUICK.contacts);
  return reply(msg, text);
}

async function handleCallback(cq) {
  tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  const question = QUICK[cq.data];
  if (!question || !cq.message) return;
  return reply({ chat: cq.message.chat, from: cq.from }, question);
}

// Сообщения одного чата выполняются строго по очереди, чтобы не путать историю.
function enqueue(chatId, job) {
  const prev = queues.get(chatId) || Promise.resolve();
  const next = prev.then(job).catch((e) => console.error(e.message));
  queues.set(chatId, next);
  next.finally(() => { if (queues.get(chatId) === next) queues.delete(chatId); });
}

async function main() {
  const me = await tg('getMe');
  await tg('setMyCommands', {
    commands: [
      { command: 'menu', description: 'Меню кафе' },
      { command: 'book', description: 'Забронировать столик' },
      { command: 'offer', description: 'Коммерческое предложение' },
      { command: 'contacts', description: 'Адрес и часы работы' },
      { command: 'reset', description: 'Начать диалог заново' },
    ],
  }).catch((e) => console.warn('setMyCommands:', e.message));
  console.log(`Бот @${me.username} запущен. Модели: ${MODELS.join(' → ')}`);
  console.log(ADMIN_CHAT_ID ? 'Заявки дублируются администратору.' : 'ADMIN_CHAT_ID не задан: заявки только в data/requests.jsonl.');

  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) enqueue(u.message.chat.id, () => handleMessage(u.message));
        if (u.callback_query?.message) enqueue(u.callback_query.message.chat.id, () => handleCallback(u.callback_query));
      }
    } catch (e) {
      console.error('Polling:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main();
