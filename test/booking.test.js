// Запуск: npm test (node --test). Модель подменена заранее заготовленными ответами, сеть не нужна.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const b = require('../booking');

const TZ = 'Asia/Almaty';
// Суббота, 21 ноября 2026, 15:00 по Астане.
const NOW = new Date('2026-11-21T10:00:00Z');

const json = (o) => JSON.stringify({ intent: 'booking', date: null, time: null, guests: null, name: null, phone: null, missing: [], ...o });

// Подставная модель: отдаёт ответы по очереди и запоминает вызовы.
function makeDeps(answers) {
  const queue = [...answers];
  const calls = [];
  const saved = [];
  return {
    calls, saved,
    callModel: async (system, user) => { calls.push({ system, user }); if (!queue.length) throw new Error('модель вызвана лишний раз'); return queue.shift(); },
    now: () => NOW,
    tz: TZ,
    save: (r) => saved.push(r),
  };
}

const full = { date: '2026-11-22', time: '19:00', guests: 4, name: 'Алина', phone: '8 700 123 45 67' };

test('полная заявка одним сообщением → сводка и «Подтверждаете?»', async () => {
  const deps = makeDeps([json(full)]);
  const res = await b.step(b.newState(null), 'Столик на завтра в 19:00 на 4, Алина, 8 700 123 45 67', deps);
  assert.equal(res.state.stage, 'confirm');
  assert.match(res.reply, /Подтверждаете\?$/);
  assert.match(res.reply, /воскресенье, 22 ноября 2026/);
  assert.match(res.reply, /\+7 \(700\) 123-45-67/);
  assert.equal(res.state.draft.phone, '+77001234567'); // 8 → 7
  assert.equal(deps.saved.length, 0); // до «да» ничего не сохраняем
});

test('в промпт попадает сегодняшняя дата из кода', async () => {
  const deps = makeDeps([json({})]);
  await b.step(b.newState(null), 'хочу столик', deps);
  assert.match(deps.calls[0].system, /Сегодня: 2026-11-21 \(суббота\)/);
});

test('не хватает данных → один вопрос про первое недостающее поле', async () => {
  const deps = makeDeps([json({ date: '2026-11-22', time: '19:00', guests: 4 })]);
  const res = await b.step(b.newState(null), 'на завтра в 19:00 на четверых', deps);
  assert.equal(res.state.stage, 'collect');
  assert.equal(res.state.asked, 'name');
  assert.equal(res.reply, 'Как тебя зовут?');
});

test('поля копятся между сообщениями, а в промпт уходит подсказка о поле', async () => {
  const deps = makeDeps([json({ date: '2026-11-22', time: '19:00', guests: 4 }), json({ name: 'Алина' }), json({ phone: '+7 700 123 45 67' })]);
  let res = await b.step(b.newState(null), 'на завтра в 19:00 на четверых', deps);
  res = await b.step(res.state, 'Алина', deps);
  assert.match(deps.calls[1].system, /спросил гостя про поле «name»/);
  assert.equal(res.state.asked, 'phone');
  res = await b.step(res.state, '+7 700 123 45 67', deps);
  assert.equal(res.state.stage, 'confirm');
  assert.deepEqual(res.state.draft, { ...full, phone: '+77001234567' });
});

test('missing от модели не учитывается: недостающее считает код', async () => {
  // Модель сказала, что всё есть (missing пуст), но телефона на деле нет.
  const deps = makeDeps([json({ ...full, phone: null, missing: [] })]);
  const res = await b.step(b.newState(null), '...', deps);
  assert.equal(res.state.asked, 'phone');
});

test('"null" строкой и пустые значения считаются отсутствием данных', () => {
  const p = b.parseModelJson('{"intent":"booking","date":"null","time":"","guests":null,"name":"None"}');
  assert.deepEqual([p.date, p.time, p.guests, p.name, p.phone], [null, null, null, null, null]);
});

test('JSON в ```-обёртке разбирается, текст вокруг JSON — нет', () => {
  assert.ok(b.parseModelJson('```json\n{"intent":"booking"}\n```'));
  assert.equal(b.parseModelJson('Вот ваш JSON: {"intent":"booking"}'), null);
  assert.equal(b.parseModelJson('не json'), null);
  assert.equal(b.parseModelJson('[1,2]'), null);
});

test('битый JSON → один повтор, затем вежливая просьба написать заново', async () => {
  const deps = makeDeps(['это не json', 'и это тоже']);
  const res = await b.step(b.newState(null), 'столик', deps);
  assert.equal(deps.calls.length, 2);
  assert.equal(res.reply, b.RETRY_MSG);
});

test('битый JSON, затем нормальный → повтор помог, заявка идёт дальше', async () => {
  const deps = makeDeps(['ой', json(full)]);
  const res = await b.step(b.newState(null), 'столик', deps);
  assert.equal(deps.calls.length, 2);
  assert.equal(res.state.stage, 'confirm');
});

test('дата в прошлом отклоняется, бот спрашивает дату заново', async () => {
  const deps = makeDeps([json({ ...full, date: '2026-11-20' })]);
  const res = await b.step(b.newState(null), 'вчера', deps);
  assert.equal(res.state.draft.date, null);
  assert.match(res.reply, /Эта дата уже прошла\. На какую дату\?/);
});

test('несуществующая дата отклоняется', () => {
  const { errors } = b.validateDraft({ date: '2026-02-30', time: null, guests: null, name: null, phone: null }, NOW, TZ);
  assert.ok(errors.date);
});

test('время вне часов работы: будни до 22:00 (последняя заявка 21:00), выходные до 23:00 (22:00)', () => {
  const v = (date, time) => b.validateDraft({ date, time, guests: null, name: null, phone: null }, NOW, TZ);
  assert.ok(v('2026-11-23', '07:59').errors.time); // понедельник, открытие в 08:00
  assert.ok(!v('2026-11-23', '08:00').errors.time);
  assert.ok(!v('2026-11-23', '21:00').errors.time);
  assert.ok(v('2026-11-23', '21:30').errors.time); // меньше чем за час до закрытия
  assert.ok(v('2026-11-22', '08:30').errors.time); // воскресенье открывается в 09:00
  assert.ok(!v('2026-11-22', '22:00').errors.time);
  assert.ok(v('2026-11-22', '22:30').errors.time);
  assert.match(v('2026-11-23', '23:00').errors.time, /с 08:00 до 22:00/);
});

test('время сегодня, которое уже прошло, отклоняется', () => {
  const v = (time) => b.validateDraft({ date: '2026-11-21', time, guests: null, name: null, phone: null }, NOW, TZ);
  assert.ok(v('12:00').errors.time); // сейчас 15:00
  assert.ok(!v('18:00').errors.time);
});

test('время проверяется заново, когда гость назвал дату позже', async () => {
  const deps = makeDeps([json({ time: '08:30' }), json({ date: '2026-11-22' })]); // воскресенье: с 09:00
  let res = await b.step(b.newState(null), 'в 8:30', deps);
  assert.equal(res.state.draft.time, '08:30'); // даты ещё нет, проверять нечем
  res = await b.step(res.state, 'в воскресенье', deps);
  assert.equal(res.state.draft.time, null);
  assert.match(res.reply, /работаем с 09:00 до 23:00/);
});

test('телефон: ровно 11 цифр', () => {
  assert.equal(b.checkPhone('+7 (700) 123-45-67').value, '+77001234567');
  assert.equal(b.checkPhone('87001234567').value, '+77001234567');
  assert.ok(!b.checkPhone('700 123 45 67').ok); // 10 цифр
  assert.ok(!b.checkPhone('+7 700 123 45 678').ok); // 12 цифр
  assert.ok(!b.checkPhone('телефон').ok);
});

test('число гостей: целое от 1 до 12', () => {
  assert.equal(b.checkGuests(4).value, 4);
  assert.equal(b.checkGuests('4').value, 4);
  for (const bad of [0, 13, 2.5, 'много', -1]) assert.ok(!b.checkGuests(bad).ok, String(bad));
});

test('«да» подтверждает только без отрицаний и цифр', () => {
  for (const s of ['да', 'Да!', 'Да, всё верно', 'подтверждаю', 'верно', 'ок']) assert.ok(b.isYes(s), s);
  for (const s of ['нет', 'да, но на 5 человек', 'да нет', 'не надо', 'да, на 5', 'наверное', 'давай поменяем']) assert.ok(!b.isYes(s), s);
});

test('«да» после сводки сохраняет заявку с chat_id и username', async () => {
  const deps = makeDeps([json(full)]);
  let res = await b.step(b.newState(null, { chat_id: 42, username: 'alina' }), 'столик...', deps);
  res = await b.step(res.state, 'да', deps);
  assert.equal(res.state, null);
  assert.equal(res.reply, b.DONE_MSG);
  assert.equal(deps.saved.length, 1);
  assert.deepEqual(
    { ...deps.saved[0], created_at: undefined },
    { created_at: undefined, chat_id: 42, username: 'alina', date: '2026-11-22', time: '19:00', guests: 4, name: 'Алина', phone: '+77001234567' },
  );
  assert.equal(deps.calls.length, 1); // подтверждение не тратит запрос к модели
});

test('«нет» после сводки: спрашивает, что поправить, без обращения к модели; данные не сохраняются', async () => {
  const deps = makeDeps([json(full)]);
  let res = await b.step(b.newState(null), 'столик...', deps);
  res = await b.step(res.state, 'нет', deps);
  assert.equal(res.reply, b.FIX_MSG);
  assert.equal(res.state.stage, 'confirm');
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.saved.length, 0);
});

test('правка после сводки: «нет, на 5 человек» → новая сводка, ничего не сохранено', async () => {
  const deps = makeDeps([json(full), json({ guests: 5 })]);
  let res = await b.step(b.newState(null), 'столик...', deps);
  res = await b.step(res.state, 'нет, на 5 человек', deps);
  assert.equal(res.state.stage, 'confirm');
  assert.match(res.reply, /Гостей: 5/);
  assert.equal(deps.saved.length, 0);
});

test('«да, но…» не сохраняет старые данные', async () => {
  const deps = makeDeps([json(full), json({ time: '20:00' })]);
  let res = await b.step(b.newState(null), 'столик...', deps);
  res = await b.step(res.state, 'да, но лучше в 20:00', deps);
  assert.equal(deps.saved.length, 0);
  assert.match(res.reply, /Время: 20:00/);
});

test('ошибка сохранения: гость получает сообщение, состояние остаётся для повторного «да»', async () => {
  const deps = makeDeps([json(full)]);
  deps.save = () => { throw new Error('диск полон'); };
  const origError = console.error;
  console.error = () => {};
  try {
    let res = await b.step(b.newState(null), 'столик...', deps);
    res = await b.step(res.state, 'да', deps);
    assert.match(res.reply, /Не получилось сохранить/);
    assert.equal(res.state.stage, 'confirm');
  } finally { console.error = origError; }
});

test('сообщение не про заявку → passthrough, состояние не меняется', async () => {
  const deps = makeDeps([JSON.stringify({ intent: 'other', date: null, time: null, guests: null, name: null, phone: null, missing: [] })]);
  const state = b.newState('date');
  const res = await b.step(state, 'а парковка у вас есть?', deps);
  assert.equal(res.passthrough, true);
  assert.equal(res.state, state);
});

test('«отмена» сбрасывает заявку без обращения к модели', async () => {
  const deps = makeDeps([]);
  const res = await b.step(b.newState(), 'отмена', deps);
  assert.equal(res.state, null);
  assert.equal(deps.calls.length, 0);
});

test('ошибка модели (лимит и т.п.) пробрасывается наружу, состояние не портится', async () => {
  const deps = makeDeps([]);
  const state = b.newState();
  await assert.rejects(b.step(state, 'на завтра', deps), /лишний раз/);
  assert.equal(state.stage, 'collect');
});

test('черновик устаревает через 30 минут', () => {
  const s = b.newState();
  assert.equal(b.isExpired(s, s.ts + 29 * 60 * 1000), false);
  assert.equal(b.isExpired(s, s.ts + 31 * 60 * 1000), true);
});

test('CSV: заголовок и BOM один раз, кавычки экранируются, формулы обезврежены', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'bookings.csv');
  const rec = { created_at: '2026-11-21T10:00:00.000Z', chat_id: 42, username: 'alina', date: '2026-11-22', time: '19:00', guests: 4, phone: '+77001234567' };
  b.appendBooking(file, { ...rec, name: 'Алина "Али"' });
  b.appendBooking(file, { ...rec, name: '=HYPERLINK("http://x")' });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('﻿created_at,chat_id,username,name,phone,date,time,guests\n'));
  assert.equal(text.match(/created_at/g).length, 1);
  const rows = text.trim().split('\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[1], '"2026-11-21T10:00:00.000Z","42","alina","Алина ""Али""","+77001234567","2026-11-22","19:00","4"');
  assert.match(rows[2], /,"'=HYPERLINK\(""http:\/\/x""\)",/); // формула получила префикс '
});
