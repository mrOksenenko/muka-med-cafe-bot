// Тесты выбора режима рассуждения (router.js). Сеть не нужна.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, decide, offerIsActive, requestOptions, OFFER_TTL_MS } = require('../router');

const think = (text, extra = {}) => decide({ text, ...extra }).think;

test('бронь: рассуждение включено', () => {
  for (const text of [
    'Хочу забронировать столик.',
    'Привет! Забронируй столик на эту субботу в 22:30, нас будет 15 человек.',
    'Я записан на 19:00, но опоздаю на 40 минут. Мой стол сохранят?',
    'Нас придёт 20 человек в субботу вечером. Примете всех?',
    'Можно прийти компанией из 15 человек?',
    'Can I book a table for tomorrow?',
  ]) assert.equal(think(text), true, text);
});

test('расчёты и КП: рассуждение включено', () => {
  for (const text of [
    'Посчитай, сколько выйдет: два капучино на миндальном молоке, один латте на обычном, три миндальных круассана и чизкейк.',
    'Друг сказал, что у вас сейчас скидка 20% на всю выпечку. Посчитай мне два медовика со скидкой.',
    'Сколько стоит латте с миндальным молоком?',
    'Сколько стоят капучино и круассан?',
    '3 эклера и американо',
    'Мне нужно коммерческое предложение для компании.',
    'Нужен фуршет на пятницу',
  ]) assert.equal(think(text), true, text);
});

test('простые вопросы: рассуждение выключено', () => {
  for (const text of [
    'Привет!',
    'Сколько стоит капучино?',
    'Во сколько вы открываетесь в воскресенье?',
    'Покажи меню кафе.',
    'Где вы находитесь, как с вами связаться и какой у вас график работы?',
    'А десерты без сахара у вас есть?',
    'Можно у вас отметить день рождения с аниматором?',
    'Почему у вас столько видов чая?',
    'Do you have vegetable soup?',
    'Спасибо!',
  ]) assert.equal(think(text), false, text);
});

test('короткие реплики учитывают диалог', () => {
  assert.equal(think('30', { offerActive: true }), true);
  assert.equal(think('30'), false);
  assert.equal(think('Да', { prevAssistant: 'Всё верно? Отправляю заявку администратору?' }), true);
  assert.equal(think('Да', { prevAssistant: 'Показать меню?' }), false);
  assert.equal(think('А с чизкейком?', { prevUser: 'Посчитай два латте' }), true);
  assert.equal(think('А где вы находитесь?', { prevUser: 'Привет' }), false);
});

test('REASONING=on и off перекрывают выбор по сообщению', () => {
  assert.equal(think('Привет', { mode: 'on' }), true);
  assert.equal(think('Посчитай два латте', { mode: 'off' }), false);
  assert.equal(classify('Посчитай два латте'), 'calc');
});

test('сбор КП держит режим ограниченное время', () => {
  assert.equal(offerIsActive(undefined, 1000), false);
  assert.equal(offerIsActive(1000, 1000 + OFFER_TTL_MS - 1), true);
  assert.equal(offerIsActive(1000, 1000 + OFFER_TTL_MS), false);
});

test('параметры запроса: effort и список моделей', () => {
  const models = ['google/gemma-4-31b-it:free', 'baidu/ernie-5.5-flash-preview:free'];
  assert.deepEqual(requestOptions(true, models), { models, reasoning: { effort: 'high' }, max_tokens: 8000 });
  assert.deepEqual(requestOptions(false, models), { models: [models[0]], reasoning: { effort: 'none' }, max_tokens: 3000 });
  assert.deepEqual(requestOptions(false, [models[1]]), { models: [models[1]], max_tokens: 3000 });
});
