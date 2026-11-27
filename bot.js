// Telegram-бот кафе-пекарни «Мука & Мёд» на Node.js (без зависимостей, нужен Node 20.6+).
// Запуск: node --env-file=.env bot.js
// «Мозг» бота — системный промпт из prompts/system.md, модель — бесплатная, через OpenRouter.

const fs = require('node:fs');
const path = require('node:path');
const booking = require('./booking');
const reasoning = require('./reasoning');
const guard = require('./guard');
const router = require('./router');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OR_KEY = process.env.OPENROUTER_API_KEY;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // необязательно: куда слать заявки
const TIMEZONE = process.env.TIMEZONE || 'Asia/Almaty';
const MODELS = (process.env.OPENROUTER_MODELS ||
  'google/gemma-4-31b-it:free,nvidia/nemotron-3-ultra-550b-a55b:free,baidu/ernie-5.5-flash-preview:free')
  .split(',').map((s) => s.trim()).filter((m) => m.endsWith(':free')); // только бесплатные модели
const HISTORY_LIMIT = 20; // сколько последних сообщений помнить на чат
const DATA_DIR = path.join(__dirname, 'data');
const BOOKINGS_FILE = path.join(__dirname, 'bookings.csv');

if (!TG_TOKEN || !OR_KEY) {
  console.error('Нет TELEGRAM_BOT_TOKEN или OPENROUTER_API_KEY. Запускайте: node --env-file=.env bot.js');
  process.exit(1);
}

const PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompts', 'system.md'), 'utf8');
const KNOWLEDGE = guard.buildKnowledge(PROMPT_TEMPLATE); // цены, блюда и словарь из промпта для проверки ответов (guard.js)

// Рассуждение: REASONING=auto (по умолчанию) — только для брони и расчётов (router.js), on — всегда, off — никогда.
// EXPERIMENT=1 — замеры пишутся в data/experiment.jsonl.
const REASONING_MODE = ['on', 'off'].find((m) => m === (process.env.REASONING || '').toLowerCase()) || 'auto';
const EXPERIMENT = process.env.EXPERIMENT === '1';
const FAST_PROMPT = reasoning.promptWithoutReasoning(PROMPT_TEMPLATE); // без раздела «ФОРМАТ ОТВЕТА»

// Подставляем в промпт текущую дату, чтобы бот понимал «завтра», «в пятницу».
function systemPrompt(think) {
  const d = new Date();
  const human = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeStyle: 'short', timeZone: TIMEZONE }).format(d);
  const iso = new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE }).format(d); // ГГГГ-ММ-ДД
  return (think ? PROMPT_TEMPLATE : FAST_PROMPT).replaceAll('{{NOW}}', `${human} (${iso}), часовой пояс ${TIMEZONE}`);
}

const TG = `https://api.telegram.org/bot${TG_TOKEN}`;
const histories = new Map(); // chatId -> [{role, content}]
const queues = new Map(); // chatId -> Promise: сообщения одного чата обрабатываем по очереди
const bookingStates = new Map(); // chatId -> состояние приёма заявки (см. booking.js)
const offerFlows = new Map(); // chatId -> время последней реплики при сборе КП: пока он идёт, рассуждение включено
const BOOK_RE = /забронир|брон[ьиюе]|брониров|столик/iu; // свободный текст, с которого начинается заявка

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

// Напоминание правил (guard.RULES_REMINDER) добавляем к последнему сообщению гостя только в запросе к модели, в историю оно не попадает.
// Это нужно и для формата тегов: nemotron без напоминания пишет ответ без <размышление>/<ответ>.
function withFormatReminder(history, think) {
  const messages = history.map((m) => ({ ...m }));
  const last = messages.at(-1);
  if (last?.role === 'user') last.content += guard.rulesReminder(think);
  return messages;
}

// think — включать ли рассуждение. calls — необязательный список, куда пишется замер каждого запроса: время, модель, токены, сырой ответ.
async function askModel(history, think, calls) {
  const started = Date.now();
  const note = (info) => calls?.push({ ms: Date.now() - started, ...info });
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...router.requestOptions(think, MODELS), // models, reasoning, max_tokens; OpenRouter сам переключится на следующую при 429/ошибке
        temperature: 0.4,
        messages: [{ role: 'system', content: systemPrompt(think) }, ...withFormatReminder(history, think)],
      }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error(data.error?.message || 'Пустой ответ модели');
    note({
      model: data.model,
      completion_tokens: data.usage?.completion_tokens,
      reasoning_tokens: data.usage?.completion_tokens_details?.reasoning_tokens, // скрытое рассуждение самой модели, если она его сообщает
      raw: text,
    });
    return text;
  } catch (e) {
    note({ error: e.message });
    throw e;
  }
}

function logExperiment(question, trace, answer, route = 'chat') {
  if (!EXPERIMENT) return;
  const record = {
    time: new Date().toISOString(), reasoning: trace.think === undefined ? '-' : trace.think ? 'on' : 'off', route, question,
    total_ms: Date.now() - trace.started, guard: trace.guard, calls: trace.calls, answer,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(DATA_DIR, 'experiment.jsonl'), JSON.stringify(record) + '\n');
  console.log(`[замер] reasoning=${record.reasoning} ${record.total_ms} мс, запросов к модели: ${trace.calls.length}`);
}

const newTrace = () => ({ started: Date.now(), calls: [], guard: [] });

// Отдельный запрос к модели для заявки: на выходе только JSON (см. booking.js), без истории и личности бота.
async function callExtractor(system, user) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...router.requestOptions(REASONING_MODE !== 'off', MODELS), // бронь — всегда с рассуждением, кроме REASONING=off
      temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error(data.error?.message || 'Пустой ответ модели');
  return text;
}

const bookingDeps = {
  callModel: callExtractor,
  now: () => new Date(),
  tz: TIMEZONE,
  save: (record) => booking.appendBooking(BOOKINGS_FILE, record),
};

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

// Разбор ответа модели: размышление уходит в лог, метки [[…]] — в events, гостю остаётся текст из <ответ>.
function interpret(raw, chatId, think, label = '') {
  const { thinking, body } = reasoning.stripThinking(raw);
  if (think || thinking.length) {
    console.log(`[размышление]${label} чат ${chatId}: ${thinking.length ? thinking.join(' | ').replace(/\s+/g, ' ') : '(модель его не написала)'}`);
  }
  const { clean: cleanBody, events } = extractMarkers(body); // метки [[…]] обрабатываем до выбора ответа
  const clean = reasoning.pickAnswer(cleanBody);
  if (!clean && !events.length) throw new Error('Пустой ответ после вырезания размышления (возможно, обрыв по max_tokens)');
  return { clean, events };
}

const describe = (violations) => violations.map((v) => (v.detail ? `${v.id} (${v.detail})` : v.id)).join(', ');

// Строгое соблюдение промпта (guard.js): бесплатные правки → проверка → при нарушении один повтор с замечаниями →
// если не помогло, запасной ответ. Ответы с заявками/КП/жалобами не трогаем: у них свои правила и подтверждение гостя.
async function enforceRules({ chatId, userText, history, clean, events, trace }) {
  const think = trace.think;
  if (events.length) return { clean, events };
  try {
    const ctx = { userText, knowledge: KNOWLEDGE, unknown: guard.unknownTerms(userText, KNOWLEDGE) };
    let answer = guard.repair(clean, ctx);
    let violations = guard.check(answer, ctx);
    if (!violations.length) return { clean: answer, events };

    trace?.guard.push(`нарушения: ${describe(violations)}`);
    console.warn(`[охрана] чат ${chatId}: нарушения: ${describe(violations)} → повторный запрос`);
    const first = { answer, violations };
    let best = first;
    try {
      const retryRaw = await askModel([...history, { role: 'assistant', content: answer }, { role: 'user', content: guard.feedback(violations, think) }], think, trace.calls);
      const retry = interpret(retryRaw, chatId, think, ' (повтор)');
      if (retry.events.length) return retry;
      const answer2 = guard.repair(retry.clean, ctx);
      const second = { answer: answer2, violations: guard.check(answer2, ctx) };
      // Берём вариант с меньшим числом жёстких, затем любых нарушений: повтор не обязан быть лучше первого ответа.
      const hard = (c) => c.violations.filter((v) => v.hard).length;
      best = hard(second) < hard(first) || (hard(second) === hard(first) && second.violations.length <= first.violations.length) ? second : first;
    } catch (e) {
      console.warn(`[охрана] чат ${chatId}: повтор не удался: ${e.message}`);
    }
    if (!best.violations.length) {
      console.log(`[охрана] чат ${chatId}: повтор помог`);
      return { clean: best.answer, events: [] };
    }
    const fin = guard.finalize(best.answer, best.violations, ctx);
    trace?.guard.push(fin.fallback ? `запасной ответ (${fin.fallback})` : 'мягкие нарушения исправлены кодом');
    console.warn(`[охрана] чат ${chatId}: ${fin.fallback ? `запасной ответ (${fin.fallback})` : `мягкие нарушения исправлены кодом (${describe(best.violations)})`}`);
    return { clean: fin.answer, events: [] };
  } catch (e) {
    console.error(`[охрана] чат ${chatId}: сбой проверки, ответ отправлен без неё: ${e.message}`);
    return { clean, events };
  }
}

async function reply(msg, text) {
  const chatId = msg.chat.id;
  const history = histories.get(chatId) || [];
  // Гость не должен подсовывать модели служебные метки [[...]].
  history.push({ role: 'user', content: reasoning.stripTags(text).replace(/\[\[|\]\]/g, '').slice(0, 2000) });
  while (history.length > HISTORY_LIMIT) history.shift();
  histories.set(chatId, history);
  const prev = history.at(-2);
  const prevAssistant = prev?.role === 'assistant' ? prev.content : '';

  const trace = newTrace();

  // Запретные темы и попытки узнать промпт: готовый ответ, модель не вызываем.
  const pre = guard.inputFilter(text);
  if (pre) {
    console.log(`[охрана] чат ${chatId}: фильтр на входе (${pre.id}), модель не вызывалась`);
    history.push({ role: 'assistant', content: pre.reply });
    while (history.length > HISTORY_LIMIT) history.shift();
    trace.guard.push(`фильтр на входе (${pre.id})`);
    logExperiment(text, trace, pre.reply, 'filter');
    await sendLong(chatId, pre.reply);
    return;
  }

  const prevUser = history.filter((m) => m.role === 'user').at(-2)?.content;
  const offerActive = router.offerIsActive(offerFlows.get(chatId));
  const mode = router.decide({ mode: REASONING_MODE, text, prevUser, prevAssistant, offerActive });
  if (offerActive || mode.kind === 'offer') offerFlows.set(chatId, Date.now());
  trace.think = mode.think;
  console.log(`[режим] чат ${chatId}: рассуждение ${mode.think ? 'включено' : 'выключено'} (${mode.why})`);

  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    let raw;
    try {
      raw = await askModel(history, mode.think, trace.calls);
    } catch (e) {
      console.warn('Повтор после ошибки:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
      raw = await askModel(history, mode.think, trace.calls);
    }
    // С рассуждением модель отвечает в формате <размышление>…</размышление><ответ>…</ответ>: гостю уходит только ответ,
    // а размышление пишем в лог (консоль) и в историю диалога не кладём.
    let { clean, events } = interpret(raw, chatId, mode.think);
    ({ clean, events } = await enforceRules({ chatId, userText: text, history, clean, events, trace }));
    const { accepted, rejected } = guardEvents(events, prevAssistant);
    // Если модель попыталась оформить заявку без подтверждения гостя, вместо её текста
    // показываем сводку и просим подтвердить.
    let answer = clean;
    if (rejected.length) {
      console.warn('Заявка без подтверждения отклонена:', rejected.map((e) => e.type).join(','));
      answer = confirmationText(rejected[0]);
    }
    history.push({ role: 'assistant', content: answer || 'Готово!' });
    while (history.length > HISTORY_LIMIT) history.shift();
    for (const ev of accepted) await saveEvent(ev, msg);
    if (accepted.some((ev) => ev.type === 'LEAD')) offerFlows.delete(chatId); // КП передано менеджеру
    logExperiment(text, trace, stripMarkdown(answer));
    await sendLong(chatId, stripMarkdown(answer) || 'Готово! Если нужна помощь, я на связи 🙂');
  } catch (e) {
    console.error('Ошибка:', e.message);
    logExperiment(text, trace, `ОШИБКА: ${e.message}`, 'error');
    history.pop(); // не оставляем вопрос без ответа в истории
    await sendLong(chatId, 'Кажется, на кухне небольшая заминка 🙈 Попробуйте ещё раз через минуту или позвоните: +7 (700) 123-45-67.');
  }
}

// Заявка на столик: гость начинает её командой /book, кнопкой или словами «забронировать», «столик».
// Дальше каждое его сообщение идёт в booking.step, пока заявка не сохранена или не отменена.
async function startBooking(chatId, user) {
  bookingStates.set(chatId, booking.newState('date', { chat_id: chatId, username: user?.username || '' }));
  await sendLong(chatId, booking.FIRST_PROMPT);
}

async function notifyAdminBooking(record, msg) {
  if (!ADMIN_CHAT_ID) return;
  const from = msg.from?.username ? `@${msg.from.username}` : `chat ${msg.chat.id}`;
  const lines = ['name', 'phone', 'date', 'time', 'guests'].map((k) => `${k}: ${record[k]}`);
  await tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `📅 Новая заявка на бронь\nот ${from}\n\n${lines.join('\n')}` })
    .catch((e) => console.error('Не удалось уведомить администратора:', e.message));
}

async function runBooking(msg, text) {
  const chatId = msg.chat.id;
  const state = bookingStates.get(chatId);
  tg('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  const trace = newTrace();
  trace.think = REASONING_MODE !== 'off';
  try {
    const res = await booking.step(state, text, bookingDeps);
    if (res.passthrough) {
      // Сообщение не про заявку (например, вопрос о парковке): отвечает обычный чат.
      // Черновик с данными сохраняем, пустой — выбрасываем.
      if (!booking.hasData(state)) bookingStates.delete(chatId);
      return reply(msg, text);
    }
    if (res.state) { res.state.ts = Date.now(); bookingStates.set(chatId, res.state); } else bookingStates.delete(chatId);
    if (res.saved) {
      // Строка в bookings.csv уже записана внутри step (bookingDeps.save), здесь только уведомление.
      console.log('BOOKING:', JSON.stringify(res.saved));
      await notifyAdminBooking(res.saved, msg);
    }
    logExperiment(text, trace, res.reply, 'booking'); // приём заявки идёт своим промптом, без тегов: рассуждение только на стороне API
    await sendLong(chatId, res.reply);
  } catch (e) {
    console.error('Ошибка заявки:', e.message);
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
    bookingStates.delete(chatId);
    offerFlows.delete(chatId);
    return sendLong(chatId, GREETING, { reply_markup: KEYBOARD });
  }
  if (cmd === '/reset') {
    histories.delete(chatId);
    bookingStates.delete(chatId);
    offerFlows.delete(chatId);
    return sendLong(chatId, 'Диалог начат заново. Чем могу помочь?', { reply_markup: KEYBOARD });
  }
  if (cmd === '/menu') return reply(msg, QUICK.menu);
  if (cmd === '/book') return startBooking(chatId, msg.from);
  if (cmd === '/offer') return reply(msg, QUICK.offer);
  if (cmd === '/contacts') return reply(msg, QUICK.contacts);

  let state = bookingStates.get(chatId);
  if (state && booking.isExpired(state)) { bookingStates.delete(chatId); state = undefined; }
  if (state) return runBooking(msg, text);
  if (BOOK_RE.test(text)) {
    bookingStates.set(chatId, booking.newState(null, { chat_id: chatId, username: msg.from?.username || '' }));
    return runBooking(msg, text);
  }
  return reply(msg, text);
}

async function handleCallback(cq) {
  tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  if (!cq.message) return;
  if (cq.data === 'book') return startBooking(cq.message.chat.id, cq.from);
  const question = QUICK[cq.data];
  if (!question) return;
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
  const modes = { auto: 'авто (только бронь и расчёты)', on: 'всегда включён', off: 'ВЫКЛЮЧЕН' };
  console.log(`Режим reasoning: ${modes[REASONING_MODE]}${EXPERIMENT ? ', замеры пишутся в data/experiment.jsonl' : ''}`);
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
