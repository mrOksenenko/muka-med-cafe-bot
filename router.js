// Когда включать рассуждение: только для брони и расчётов, на простые вопросы модель отвечает сразу.
// Решает код по тексту гостя, отдельный запрос к модели не тратится. Модуль без побочных эффектов, поэтому тестируется отдельно.

'use strict';

const OFFER_TTL_MS = 30 * 60 * 1000; // сколько держим рассуждение включённым, пока собирается КП

// Модели, у которых рассуждение нельзя выключить (reasoning.mandatory в списке моделей OpenRouter, 26.11.2026).
const ALWAYS_REASONING = new Set(['baidu/ernie-5.5-flash-preview:free']);

// \b не работает с кириллицей, поэтому границы слов заданы через \p{L}. Буква «ё» заранее заменена на «е».
const OFFER_RE = /кейтеринг|фуршет|кофе[- ]?брейк|ланч[- ]?бокс|сладк\p{L}* стол|коммерческ|(?<!\p{L})кп(?!\p{L})|корпоратив|торт\p{L}* на заказ|catering/u;

const BOOKING_RE = new RegExp([
  'брон', 'заявк', 'опозда', '(?<!\\p{L})записан',
  '(?<!\\p{L})стол(?:а|у|ом|е|ы|ов|ик\\p{L}*)?(?!\\p{L})', // «стол», «столик», но не «столько»
  '\\d+\\s*(?:человек|чел(?!\\p{L})|гост|персон)',
  '(?<!\\p{L})на \\d{1,2}:\\d{2}',
  '\\b(?:book|booking|reserve|reservation|table)\\b', 'үстел',
].join('|'), 'u');

const CALC_RE = new RegExp([
  'посчита', 'подсчита', 'рассчита', 'расчет', 'вычисл',
  'сколько[^.?!]*(?:выйдет|получится|всего|вместе|обойдется)', 'обойдется',
  'итого', 'в сумме', 'общ(?:ая|ий|ую) (?:сумм|счет|стоимост)',
  '(?<!\\p{L})(?:счет|чек)(?:а|у|ом)?(?!\\p{L})',
  'скидк', 'предоплат', 'добав(?:ь|ить|им|ка|ку)',
  '\\d\\s*[+×*]\\s*\\d',
  '\\b(?:total|calculate|discount)\\b', 'жеңілдік', 'есепте',
].join('|'), 'u');

const ITEM = '(?:капучино|латте|эспрессо|американо|флэт|раф|чайник|лимонад|смузи|круассан|булоч|баурсак|эклер|медовик|чизкейк|сырник|омлет|каш[аиу]|тост|суп|паст[аыу]|сэндвич|салат|коктейл)';
const NUMBER = '(?:\\d{1,3}|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|пару|пара|несколько)';
// «три миндальных круассана», «2 капучино»: количество, возможно одно прилагательное, позиция меню.
const QUANTITY_RE = new RegExp(`(?<![\\p{L}\\d:.])${NUMBER}(?![\\p{L}\\d])\\s*(?:(?:порци|чаш|штук|шт)\\p{L}*\\.?\\s+)?(?:\\p{L}+\\s+)?(?<!\\p{L})${ITEM}`, 'u');
const ITEMS_RE = new RegExp(`(?<!\\p{L})${ITEM}`, 'gu');
const PRICE_RE = /сколько|цена|почем|стоимост|how much|қанша/u;

const CONFIRM_QUESTION_RE = /все верно|передать запрос|отправляю заявку/u;
const CONSENT_RE = /^(?:да|ага|угу|верно|все верно|подтверждаю|отправляй|передавай|ок|окей|конечно|yes|иә)(?![\p{L}\d])/u;
const FOLLOW_UP_RE = /^(?:а|и|еще|плюс|убери|без)(?![\p{L}])/u;

const normalize = (text) => String(text || '').toLowerCase().replace(/ё/g, 'е').trim();

// Тема сообщения: 'offer' (КП), 'booking' (бронь), 'calc' (расчёт) или null (простой вопрос).
function classify(text) {
  const t = normalize(text);
  if (OFFER_RE.test(t)) return 'offer';
  if (CALC_RE.test(t) || QUANTITY_RE.test(t)) return 'calc';
  // Цена нескольких позиций или позиции с растительным молоком — это уже сложение.
  if (PRICE_RE.test(t) && ((t.match(ITEMS_RE) || []).length > 1 || /молок/u.test(t))) return 'calc';
  if (BOOKING_RE.test(t)) return 'booking';
  return null;
}

const LABELS = { offer: 'коммерческое предложение', booking: 'бронь', calc: 'расчёт' };

// mode: 'auto' (по сообщению), 'on' (всегда), 'off' (никогда).
// Короткие реплики («30», «да») темы не называют, поэтому учитываем диалог: идущий сбор КП,
// вопрос бота о подтверждении и уточнение к предыдущему расчёту («а с чизкейком?»).
function decide({ mode = 'auto', text, prevUser = '', prevAssistant = '', offerActive = false }) {
  const kind = classify(text);
  if (mode !== 'auto') return { think: mode === 'on', kind, why: `REASONING=${mode}` };
  const t = normalize(text);
  if (kind) return { think: true, kind, why: LABELS[kind] };
  if (offerActive) return { think: true, kind: 'offer', why: 'идёт сбор КП' };
  if (CONSENT_RE.test(t) && CONFIRM_QUESTION_RE.test(normalize(prevAssistant))) return { think: true, kind: 'booking', why: 'подтверждение заявки' };
  if (FOLLOW_UP_RE.test(t) && classify(prevUser) === 'calc') return { think: true, kind: 'calc', why: 'уточнение расчёта' };
  return { think: false, kind: null, why: 'простой вопрос' };
}

const offerIsActive = (since, now = Date.now()) => since !== undefined && now - since < OFFER_TTL_MS;

// Параметры запроса к OpenRouter. Для режима без рассуждения убираем модели, где его нельзя выключить;
// если других в списке нет, параметр reasoning не передаём, чтобы запрос не отклонили.
function requestOptions(think, models) {
  if (think) return { models, reasoning: { effort: 'high' }, max_tokens: 8000 }; // рассуждение входит в лимит
  const switchable = models.filter((m) => !ALWAYS_REASONING.has(m));
  return switchable.length
    ? { models: switchable, reasoning: { effort: 'none' }, max_tokens: 3000 }
    : { models, max_tokens: 3000 };
}

module.exports = { classify, decide, offerIsActive, requestOptions, OFFER_TTL_MS };
