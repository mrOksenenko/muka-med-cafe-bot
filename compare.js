// Сравнение рассуждения модели: каждый трудный вопрос из test_cases.md уходит в OpenRouter дважды,
// с reasoning.effort = "none" и "high". Одна бесплатная модель, без повторов: всего 6 запросов.
// Запуск: node --env-file=.env compare.js   (проверка без сети: node compare.js --dry-run)
// Результат: раздел в конце comparison.md, сырые ответы API — в data/compare.json.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { promptWithoutReasoning } = require('./reasoning');

const MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free'; // рассуждение необязательно, поддерживает none и high
const EFFORTS = ['none', 'high'];
const TEMPERATURE = 0.4;
const MAX_TOKENS = 8000; // с запасом: рассуждение входит в лимит и не должно обрезать ответ
const TIMEOUT_MS = 180_000;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Almaty';

const PROMPT_FILE = path.join(__dirname, 'prompts', 'system.md');
const CASES_FILE = path.join(__dirname, 'test_cases.md');
const REPORT_FILE = path.join(__dirname, 'comparison.md');
const RAW_FILE = path.join(__dirname, 'data', 'compare.json');

// Вопросы — строки «**Гость:** …» из раздела «Трудные вопросы», название — заголовок «### …» над ними.
function readQuestions() {
  const text = fs.readFileSync(CASES_FILE, 'utf8');
  const section = text.split(/^## Трудные вопросы$/m)[1]?.split(/^## /m)[0];
  if (!section) throw new Error('В test_cases.md нет раздела «Трудные вопросы»');
  const questions = section.split(/^### /m).slice(1).map((block) => ({
    title: block.split('\n')[0].replace(/^\d+\.\s*/, '').trim(),
    question: /^\*\*Гость:\*\*\s*(.+)$/m.exec(block)?.[1].trim(),
  }));
  if (questions.length !== 3 || questions.some((q) => !q.question)) {
    throw new Error('Ожидались 3 вопроса с строкой «**Гость:** …»');
  }
  return questions;
}

// Промпт бота без раздела «ФОРМАТ ОТВЕТА» (одинаковый для обоих режимов), с датой, как в bot.js.
function buildSystemPrompt(now) {
  const human = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full', timeStyle: 'short', timeZone: TIMEZONE }).format(now);
  const iso = new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE }).format(now);
  const template = promptWithoutReasoning(fs.readFileSync(PROMPT_FILE, 'utf8'));
  return {
    when: `${human} (${iso}), часовой пояс ${TIMEZONE}`,
    text: template.replaceAll('{{NOW}}', `${human} (${iso}), часовой пояс ${TIMEZONE}`),
  };
}

async function ask(system, question, effort) {
  const started = Date.now();
  const seconds = () => (Date.now() - started) / 1000;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        reasoning: { effort },
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json();
    const time = seconds();
    const choice = data.choices?.[0];
    const failure = data.error || choice?.error;
    const answer = choice?.message?.content?.trim() || '';
    return {
      time,
      status: res.status,
      error: failure ? failure.message || 'Ошибка без описания' : answer ? null : 'Пустой ответ модели',
      answer,
      reasoning: choice?.message?.reasoning || '',
      finish: choice?.finish_reason || null,
      model: data.model || null,
      provider: data.provider || null,
      usage: data.usage || null,
      raw: data,
    };
  } catch (e) {
    return { time: seconds(), status: null, error: e.message, answer: '', reasoning: '', finish: null, model: null, provider: null, usage: null, raw: null };
  }
}

const num = (v) => (typeof v === 'number' ? String(v) : '—');
const sec = (v) => `${v.toFixed(1).replace('.', ',')} с`;
const tokens = (r) => ({
  input: r.usage?.prompt_tokens,
  output: r.usage?.completion_tokens,
  thinking: r.usage?.completion_tokens_details?.reasoning_tokens,
  total: r.usage?.total_tokens,
});
const fence = (text) => `~~~~text\n${text}\n~~~~`;

function report(runs, when) {
  const rows = runs.map((r) => {
    const t = tokens(r);
    const status = r.error ? `ошибка: ${r.error.replace(/[|\n]+/g, ' ')}` : r.finish || '—';
    return `| ${r.n} | ${r.effort} | ${sec(r.time)} | ${num(t.input)} | ${num(t.output)} | ${num(t.thinking)} | ${num(t.total)} | ${r.reasoning ? `${r.reasoning.length} симв.` : 'пусто'} | ${status} |`;
  });
  const totals = EFFORTS.map((effort) => {
    const group = runs.filter((r) => r.effort === effort);
    const ok = group.filter((r) => !r.error);
    const sum = (key) => (ok.length ? ok.reduce((s, r) => s + (tokens(r)[key] || 0), 0) : '—');
    return `| ${effort} | ${ok.length} из ${group.length} | ${sec(group.reduce((s, r) => s + r.time, 0))} | ${sum('input')} | ${sum('output')} | ${sum('thinking')} | ${sum('total')} |`;
  });
  const details = runs.map((r) => [
    `#### Вопрос ${r.n}, effort: ${r.effort}`,
    `**Ответ:**`,
    fence(r.answer || `(нет ответа: ${r.error})`),
    `**message.reasoning:**`,
    r.reasoning ? fence(r.reasoning) : '(поле пустое)',
  ].join('\n\n'));
  const questions = runs.filter((r) => r.effort === EFFORTS[0]).map((r) => `${r.n}. ${r.title}: «${r.question}»`);
  const served = [...new Set(runs.filter((r) => r.model).map((r) => `${r.model}${r.provider ? ` (${r.provider})` : ''}`))];

  return `
---

# Сравнение через API: reasoning effort "none" и "high"

## Условия
- Скрипт \`compare.js\`, один прогон, ${runs.length} запросов по очереди, без повторов.
- Дата в промпте: ${when}.
- Запрошена модель \`${MODEL}\`, ответила: ${served.join(', ') || 'нет ответов'}.
- \`temperature ${TEMPERATURE}\`, \`max_tokens ${MAX_TOKENS}\`.
- Промпт — \`prompts/system.md\` без раздела «ФОРМАТ ОТВЕТА» и тегов в примерах, одинаковый в обоих режимах.
- Проверка \`guard.js\` и напоминание правил не использовались: это сырые ответы модели.
- Время — от отправки запроса до получения всего ответа. «Выход» включает токены рассуждения.

## Вопросы
${questions.join('\n')}

## Запуски

| Вопрос | effort | Время | Токены: вход | Выход | Из них рассуждение | Всего | message.reasoning | Завершение |
|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Итого по режимам

| effort | Успешных | Время | Токены: вход | Выход | Из них рассуждение | Всего |
|---|---|---|---|---|---|---|
${totals.join('\n')}

## Тексты ответов и рассуждений

${details.join('\n\n')}
`;
}

async function main() {
  const questions = readQuestions();
  const prompt = buildSystemPrompt(new Date());

  if (process.argv.includes('--dry-run')) {
    console.log(`Модель: ${MODEL}\nДата: ${prompt.when}\nПромпт: ${prompt.text.length} символов`);
    console.log(`Раздел «ФОРМАТ ОТВЕТА» убран: ${!/ФОРМАТ ОТВЕТА|<размышление>|<ответ>|\{\{NOW\}\}/.test(prompt.text)}`);
    questions.forEach((q, i) => console.log(`${i + 1}. ${q.title}\n   ${q.question}`));
    console.log(`Будет запросов: ${questions.length * EFFORTS.length}`);
    return;
  }

  if (!process.env.OPENROUTER_API_KEY) throw new Error('Нет OPENROUTER_API_KEY. Запускайте: node --env-file=.env compare.js');
  // Защита от случайного второго прогона.
  if (fs.existsSync(RAW_FILE)) throw new Error('Прогон уже был (есть data/compare.json). Чтобы повторить, переименуйте этот файл.');
  fs.mkdirSync(path.dirname(RAW_FILE), { recursive: true });

  const runs = [];
  for (const [i, q] of questions.entries()) {
    for (const effort of EFFORTS) {
      const run = { n: i + 1, ...q, effort, ...(await ask(prompt.text, q.question, effort)) };
      runs.push(run);
      fs.writeFileSync(RAW_FILE, JSON.stringify({ when: prompt.when, model: MODEL, runs }, null, 2)); // сохраняем после каждого запроса
      console.log(`[${runs.length}/6] вопрос ${run.n}, effort=${effort}: ${sec(run.time)}, ${run.error ? `ошибка: ${run.error}` : `токенов ${num(run.usage?.total_tokens)}`}`);
    }
  }

  fs.appendFileSync(REPORT_FILE, report(runs, prompt.when));
  console.log('Готово: результат дописан в comparison.md');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
