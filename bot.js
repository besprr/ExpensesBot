// finance-bot.js (исправленный)
const { Telegraf, Markup, session } = require('telegraf'); // добавил session
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const db = new sqlite3.Database('./finance.db');

const ALLOWED_USERS = [
  586995184,    // Маша
  1319991227,   // Кирилл
];

// Подключаем session middleware первым
bot.use(session());

// Функция проверки доступа
function isUserAllowed(ctx) {
  const userId = ctx.from && ctx.from.id;
  const chatId = ctx.chat && ctx.chat.id;

  const isAllowed = ALLOWED_USERS.includes(userId) || ALLOWED_USERS.includes(chatId);

  if (!isAllowed) {
    console.log(`🚫 Доступ запрещен: User ID: ${userId}, Chat ID: ${chatId}`);
  }

  return isAllowed;
}

// Middleware для проверки доступа
bot.use((ctx, next) => {
  if (!isUserAllowed(ctx)) {
    // Отправляем ответ и не продолжаем цепочку
    ctx.reply(
      '❌ Доступ запрещен!\n\n' +
      'Это приватный бот для учета расходов. ' +
      'Если вы должны иметь доступ, обратитесь к администратору.'
    );
    return;
  }
  return next();
});

// Создаем таблицы
db.serialize(() => {
  // Расходы
  db.run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      who TEXT NOT NULL,
      type TEXT DEFAULT 'expense',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Доходы
  db.run(`
    CREATE TABLE IF NOT EXISTS incomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      who TEXT NOT NULL,
      type TEXT DEFAULT 'income',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Функция для правильного парсинга чисел
function parseAmount(amountStr) {
  if (typeof amountStr !== 'string' && typeof amountStr !== 'number') return NaN;
  const cleaned = String(amountStr).replace(',', '.').replace(/\s/g, '');
  return parseFloat(cleaned);
}

// Функция для форматирования чисел (2 знака после запятой)
function formatAmount(amount) {
  const n = parseFloat(amount) || 0;
  return n.toFixed(2);
}

// Функция для удаления данных старше месяца+5 дней
function cleanupOldData() {
  const currentDate = new Date();
  const oneMonthAgo = new Date(currentDate);
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  oneMonthAgo.setDate(oneMonthAgo.getDate() - 5);

  // Формат YYYY-MM-DD
  const formattedDate = oneMonthAgo.toISOString().split('T')[0];

  db.run('DELETE FROM expenses WHERE date < ?', [formattedDate], (err) => {
    if (err) {
      console.error('❌ Ошибка при очистке расходов:', err);
    } else {
      console.log(`✅ Удалены расходы старше ${formattedDate}`);
    }
  });

  db.run('DELETE FROM incomes WHERE date < ?', [formattedDate], (err) => {
    if (err) {
      console.error('❌ Ошибка при очистке доходов:', err);
    } else {
      console.log(`✅ Удалены доходы старше ${formattedDate}`);
    }
  });
}

// Запускаем очистку при старте
cleanupOldData();
// И каждые 24 часа
setInterval(cleanupOldData, 24 * 60 * 60 * 1000);

// Главное меню
function getMainMenu() {
  return Markup.keyboard([
    ['📊 Статистика', '📋 Отчёт'],
    ['💸 Добавить расход', '💰 Добавить доход'],
    ['✏️ Мои записи', '🗑️ Очистить старые'],
    ['🔄 Сбросить меню']
  ]).resize();
}

// Меню редактирования
function getEditMenu(recordId, type) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✏️ Изменить', `edit_${type}_${recordId}`),
      Markup.button.callback('❌ Удалить', `delete_${type}_${recordId}`)
    ],
    [Markup.button.callback('⬅️ Назад к списку', 'back_to_list')]
  ]);
}

// ==================== ОБРАБОТЧИКИ КОМАНД ====================

// Команда /start с кнопками
bot.start((ctx) => {
  // Очистим возможный режим/сессию при старте
  ctx.session.mode = null;
  ctx.session.editingRecordId = null;
  ctx.session.editingType = null;

  const userName = ctx.from.first_name || 'Пользователь';

  ctx.reply(
    `💰 Привет, ${userName}!\n\n` +
    'Это приватный бот для учета финансов.\n\n' +
    '📥 <b>Расходы</b> - траты, покупки\n' +
    '📤 <b>Доходы</b> - зарплата, продажи\n\n' +
    'Данные старше месяца+5 дней удаляются автоматически.\n\n' +
    'Используйте формат:\n' +
    '<code>Дата | На что | Сумма | Кто</code>\n\n' +
    'Примеры:\n' +
    '<code>05.12.2023 | Зарплата | 50000 | Я</code>\n' +
    '<code>05.12.2023 | Продукты | 2500.50 | Маша</code>',
    {
      parse_mode: 'HTML',
      ...getMainMenu()
    }
  );
});

// Команда сброса меню — теперь очищаем сессию
bot.hears('🔄 Сбросить меню', (ctx) => {
  ctx.session.mode = null;
  ctx.session.editingRecordId = null;
  ctx.session.editingType = null;
  ctx.reply('Меню сброшено. Используйте /start для показа кнопок.');
});

// Добавление расхода — устанавливаем режим
bot.hears('💸 Добавить расход', (ctx) => {
  // Устанавливаем режим новой записи как расход
  ctx.session.mode = 'expense';
  ctx.session.editingRecordId = null;
  ctx.session.editingType = null;

  ctx.reply(
    '📥 <b>Добавление расхода</b>\n\n' +
    'Введите в формате:\n' +
    '<code>Дата | На что | Сумма | Кто</code>\n\n' +
    'Пример:\n' +
    '<code>05.12.2023 | Продукты | 2500.50 | Маша</code>\n\n' +
    '💡 Можно использовать точки или запятые для копеек',
    { parse_mode: 'HTML' }
  );
});

// Добавление дохода — устанавливаем режим
bot.hears('💰 Добавить доход', (ctx) => {
  // Устанавливаем режим новой записи как доход
  ctx.session.mode = 'income';
  ctx.session.editingRecordId = null;
  ctx.session.editingType = null;

  ctx.reply(
    '📤 <b>Добавление дохода</b>\n\n' +
    'Введите в формате:\n' +
    '<code>Дата | На что | Сумма | Кто</code>\n\n' +
    'Пример:\n' +
    '<code>05.12.2023 | Зарплата | 50000 | Я</code>\n\n' +
    '💡 Можно использовать точки или запятые для копеек',
    { parse_mode: 'HTML' }
  );
});

// Статистика
bot.hears('📊 Статистика', (ctx) => {
  const chatId = ctx.chat.id;

  // Получаем расходы
  db.all(`
    SELECT who, SUM(amount) as total, COUNT(*) as count 
    FROM expenses 
    GROUP BY who
  `, (err, expenseRows) => {
    if (err) {
      bot.telegram.sendMessage(chatId, '❌ Ошибка при получении статистики');
      return;
    }

    // Получаем доходы
    db.all(`
      SELECT who, SUM(amount) as total, COUNT(*) as count 
      FROM incomes 
      GROUP BY who
    `, (err, incomeRows) => {
      if (err) {
        bot.telegram.sendMessage(chatId, '❌ Ошибка при получении статистики');
        return;
      }

      let response = '📊 <b>Общая статистика:</b>\n\n';

      // Доходы
      response += '📤 <b>Доходы:</b>\n';
      let totalIncome = 0;
      let incomeCount = 0;

      if (!incomeRows || incomeRows.length === 0) {
        response += '   <i>Пока нет доходов</i>\n';
      } else {
        incomeRows.forEach(row => {
          const t = parseFloat(row.total) || 0;
          response += `   <b>${row.who}:</b> ${formatAmount(t)} руб. (${row.count} записей)\n`;
          totalIncome += t;
          incomeCount += row.count;
        });
      }

      response += '\n📥 <b>Расходы:</b>\n';
      let totalExpense = 0;
      let expenseCount = 0;

      if (!expenseRows || expenseRows.length === 0) {
        response += '   <i>Пока нет расходов</i>\n';
      } else {
        expenseRows.forEach(row => {
          const t = parseFloat(row.total) || 0;
          response += `   <b>${row.who}:</b> ${formatAmount(t)} руб. (${row.count} записей)\n`;
          totalExpense += t;
          expenseCount += row.count;
        });
      }

      const balance = totalIncome - totalExpense;

      response += `\n💰 <b>Баланс:</b> ${formatAmount(balance)} руб.\n`;
      response += `📤 <b>Всего доходов:</b> ${formatAmount(totalIncome)} руб. (${incomeCount} записей)\n`;
      response += `📥 <b>Всего расходов:</b> ${formatAmount(totalExpense)} руб. (${expenseCount} записей)\n`;

      bot.telegram.sendMessage(chatId, response, { parse_mode: 'HTML' });
    });
  });
});

// Отчет
bot.hears('📋 Отчёт', (ctx) => {
  const chatId = ctx.chat.id;

  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  const formattedDate = oneMonthAgo.toISOString().split('T')[0];

  db.all(`
    SELECT 
      date,
      description,
      amount,
      who,
      'expense' as type
    FROM expenses 
    WHERE date >= ?
    UNION ALL
    SELECT 
      date,
      description,
      amount,
      who,
      'income' as type
    FROM incomes 
    WHERE date >= ?
    ORDER BY date DESC
    LIMIT 40
  `, [formattedDate, formattedDate], (err, rows) => {
    if (err) {
      bot.telegram.sendMessage(chatId, '❌ Ошибка при получении отчёта');
      return;
    }

    if (!rows || rows.length === 0) {
      bot.telegram.sendMessage(chatId, '📋 Пока нет записей для отчёта за последний месяц');
      return;
    }

    let response = '📋 <b>Последние записи (30 дней):</b>\n\n';
    let totalIncome = 0;
    let totalExpense = 0;

    rows.forEach((row) => {
      const icon = row.type === 'income' ? '📤' : '📥';
      response += `${icon} <b>${row.date}</b> | ${row.description} | ${formatAmount(row.amount)} руб. | ${row.who}\n`;

      if (row.type === 'income') {
        totalIncome += parseFloat(row.amount) || 0;
      } else {
        totalExpense += parseFloat(row.amount) || 0;
      }
    });

    const balance = totalIncome - totalExpense;

    response += `\n📊 <b>Итоги за 30 дней:</b>\n`;
    response += `📤 Доходы: ${formatAmount(totalIncome)} руб.\n`;
    response += `📥 Расходы: ${formatAmount(totalExpense)} руб.\n`;
    response += `💰 Баланс: ${formatAmount(balance)} руб.`;

    if (response.length > 4000) {
      const parts = response.match(/[\s\S]{1,4000}/g);
      parts.forEach(part => bot.telegram.sendMessage(chatId, part, { parse_mode: 'HTML' }));
    } else {
      bot.telegram.sendMessage(chatId, response, { parse_mode: 'HTML' });
    }
  });
});

// Мои записи
bot.hears('✏️ Мои записи', (ctx) => {
  const chatId = ctx.chat.id;

  db.all(`
    SELECT 
      id,
      date,
      description,
      amount,
      who,
      'expense' as type
    FROM expenses 
    UNION ALL
    SELECT 
      id,
      date,
      description,
      amount,
      who,
      'income' as type
    FROM incomes 
    ORDER BY date DESC, id DESC
    LIMIT 15
  `, (err, rows) => {
    if (err) {
      bot.telegram.sendMessage(chatId, '❌ Ошибка при получении списка записей');
      return;
    }

    if (!rows || rows.length === 0) {
      bot.telegram.sendMessage(chatId, '✏️ Пока нет записей для редактирования');
      return;
    }

    let response = '✏️ <b>Последние записи:</b>\n\n';

    rows.forEach((row, index) => {
      const icon = row.type === 'income' ? '📤' : '📥';
      response += `${index + 1}. ${icon} <b>${row.date}</b> | ${row.description} | ${formatAmount(row.amount)} руб. | ${row.who}\n`;
    });

    response += '\nНажмите на кнопки ниже для редактирования:';

    const keyboard = rows.map(row => [
      Markup.button.callback(
        `${row.type === 'income' ? '📤' : '📥'} ${row.date} - ${row.description.substring(0, 15)}...`,
        `select_${row.type}_${row.id}`
      )
    ]);

    keyboard.push([Markup.button.callback('⬅️ Назад', 'back_to_main')]);

    bot.telegram.sendMessage(chatId, response, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(keyboard)
    });
  });
});

// Очистка старых
bot.hears('🗑️ Очистить старые', (ctx) => {
  cleanupOldData();
  ctx.reply('✅ Старые данные (старше месяца+5 дней) удалены!');
});

// ==================== INLINE КНОПКИ ====================

// Выбор записи для редактирования
bot.action(/select_(expense|income)_(\d+)/, (ctx) => {
  const type = ctx.match[1];
  const recordId = ctx.match[2];
  const table = type === 'expense' ? 'expenses' : 'incomes';

  db.get(`SELECT * FROM ${table} WHERE id = ?`, [recordId], (err, row) => {
    if (err || !row) {
      ctx.answerCbQuery('Запись не найдена');
      return;
    }

    const typeText = type === 'expense' ? 'расхода' : 'дохода';
    const icon = type === 'expense' ? '📥' : '📤';

    const response =
      `${icon} <b>Редактирование ${typeText}:</b>\n\n` +
      `<b>Дата:</b> ${row.date}\n` +
      `<b>Описание:</b> ${row.description}\n` +
      `<b>Сумма:</b> ${formatAmount(row.amount)} руб.\n` +
      `<b>Кто:</b> ${row.who}\n\n` +
      `Выберите действие:`;

    ctx.editMessageText(response, {
      parse_mode: 'HTML',
      ...getEditMenu(recordId, type)
    });
  });
});

// Редактирование записи
bot.action(/edit_(expense|income)_(\d+)/, (ctx) => {
  const type = ctx.match[1];
  const recordId = ctx.match[2];
  ctx.answerCbQuery();

  const typeText = type === 'expense' ? 'расхода' : 'дохода';

  ctx.reply(
    `Введите новые данные в формате:\n\n` +
    `<code>Дата | Описание | Сумма | Кто</code>\n\n` +
    `Пример:\n` +
    `<code>05.12.2023 | Зарплата | 50000.00 | Я</code>\n\n` +
    `💡 <i>Запись будет обновлена</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.removeKeyboard()
    }
  );

  // Сохраняем в сессию, чтобы следующий текст обновил запись
  ctx.session.editingRecordId = recordId;
  ctx.session.editingType = type;
  // Убираем общий режим добавления
  ctx.session.mode = null;
});

// Удаление записи
bot.action(/delete_(expense|income)_(\d+)/, async (ctx) => {
  const type = ctx.match[1];
  const recordId = ctx.match[2];
  const table = type === 'expense' ? 'expenses' : 'incomes';

  db.run(`DELETE FROM ${table} WHERE id = ?`, [recordId], function(err) {
    if (err) {
      ctx.answerCbQuery('Ошибка при удалении');
      return;
    }

    if (this.changes > 0) {
      ctx.answerCbQuery('✅ Запись удалена');
      ctx.editMessageText('✅ Запись успешно удалена!', {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ Назад к списку', 'back_to_list')]
        ])
      });
    } else {
      ctx.answerCbQuery('Запись не найдена');
    }
  });
});

// Назад к списку
bot.action('back_to_list', (ctx) => {
  ctx.answerCbQuery();
  const message = {
    text: '✏️ Мои записи',
    chat: ctx.chat,
    from: ctx.from
  };
  const update = { message };
  bot.handleUpdate(update);
});

// Назад в главное меню
bot.action('back_to_main', (ctx) => {
  ctx.answerCbQuery();
  ctx.deleteMessage();
  // очистим режим и редактирование
  ctx.session.mode = null;
  ctx.session.editingRecordId = null;
  ctx.session.editingType = null;
  bot.telegram.sendMessage(ctx.chat.id, 'Выберите действие:', getMainMenu());
});

// ==================== ОБРАБОТКА ТЕКСТА ====================

bot.on('text', (ctx) => {
  const text = ctx.message.text;

  // Пропускаем команды меню
  if (['📊 Статистика', '📋 Отчёт', '💸 Добавить расход', '💰 Добавить доход',
    '✏️ Мои записи', '🗑️ Очистить старые', '🔄 Сбросить меню'].includes(text)) {
    return;
  }

  // Инициализируем сессию-объект при необходимости
  ctx.session = ctx.session || {};

  // Проверяем, редактируем ли мы существующую запись
  if (ctx.session.editingRecordId && ctx.session.editingType) {
    if (text.includes('|')) {
      const parts = text.split('|').map(p => p.trim());
      if (parts.length === 4) {
        const [date, desc, amount, who] = parts;
        const amountNum = parseAmount(amount);

        if (!isNaN(amountNum) && amountNum > 0) {
          const table = ctx.session.editingType === 'expense' ? 'expenses' : 'incomes';
          const recordId = ctx.session.editingRecordId;

          db.run(
            `UPDATE ${table} SET date = ?, description = ?, amount = ?, who = ? WHERE id = ?`,
            [date, desc, amountNum, who, recordId],
            (err) => {
              if (err) {
                ctx.reply('❌ Ошибка обновления: ' + err.message);
              } else {
                const typeText = ctx.session.editingType === 'expense' ? 'Расход' : 'Доход';
                ctx.reply(`${typeText} обновлен!\n${date} | ${desc} | ${formatAmount(amountNum)} | ${who}`);
                ctx.session.editingRecordId = null;
                ctx.session.editingType = null;
              }
            }
          );
          return;
        } else {
          ctx.reply('❌ Сумма должна быть положительным числом');
        }
      }
    }

    ctx.reply('❌ Неверный формат. Используйте: Дата | Описание | Сумма | Кто');
    return;
  }

  // Обычное добавление новой записи
  if (text.includes('|')) {
    const parts = text.split('|').map(p => p.trim());
    if (parts.length === 4) {
      const [date, desc, amount, who] = parts;
      const amountNum = parseAmount(amount);

      if (!isNaN(amountNum) && amountNum > 0) {
        // Используем режим из сессии: income или expense, по умолчанию expense
        const mode = ctx.session.mode || 'expense';

        if (mode === 'income') {
          db.run(
            'INSERT INTO incomes (date, description, amount, who) VALUES (?, ?, ?, ?)',
            [date, desc, amountNum, who],
            (err) => {
              if (err) {
                ctx.reply('❌ Ошибка сохранения: ' + err.message);
              } else {
                ctx.reply(`✅ Доход добавлен!\n${date} | ${desc} | ${formatAmount(amountNum)} | ${who}`, { reply_markup: getMainMenu().reply_markup });
                // Сбрасываем режим после добавления
                ctx.session.mode = null;
              }
            }
          );
        } else {
          // expense (по умолчанию)
          db.run(
            'INSERT INTO expenses (date, description, amount, who) VALUES (?, ?, ?, ?)',
            [date, desc, amountNum, who],
            (err) => {
              if (err) {
                ctx.reply('❌ Ошибка сохранения: ' + err.message);
              } else {
                ctx.reply(`✅ Расход добавлен!\n${date} | ${desc} | ${formatAmount(amountNum)} | ${who}`, { reply_markup: getMainMenu().reply_markup });
                ctx.session.mode = null;
              }
            }
          );
        }
      } else {
        ctx.reply(
          '❌ Сумма должна быть положительным числом (можно использовать запятые или точки для копеек)'
        );
      }
    } else {
      ctx.reply('❌ Неверный формат. Используйте: Дата | На что | Сумма | Кто');
    }
  } else {
    // Если сообщение не распознано
    ctx.reply(
      '🤔 Не понял ваше сообщение.\n\n' +
      'Используйте формат:\n' +
      '<code>Дата | На что | Сумма | Кто</code>\n\n' +
      'Пример:\n' +
      '<code>05.12.2023 | Продукты | 2500.50 | Маша</code>\n\n' +
      'Или выберите действие из меню.',
      { parse_mode: 'HTML' }
    );
  }
});

// Обработка ошибок
bot.catch((err, ctx) => {
  console.error('Error for', ctx.updateType, err);
});

// ==================== ЗАПУСК НА RAILWAY ====================

const PORT = process.env.PORT || 3000;
const http = require('http');

// Создаем HTTP сервер для Railway
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Finance Bot is running on Railway!');
});

server.listen(PORT, () => {
  console.log(`🚀 HTTP Server running on port ${PORT}`);
});

// Запускаем бота
bot.launch().then(() => {
  console.log('✅ Бот запущен на Railway!');
  console.log('✅ Разрешены пользователи:', ALLOWED_USERS);
  console.log('✅ Автоматическая очистка настроена');
}).catch(err => {
  console.error('❌ Ошибка запуска бота:', err);
});

// Корректное завершение
process.once('SIGINT', () => {
  db.close();
  bot.stop('SIGINT');
  server.close();
});

process.once('SIGTERM', () => {
  db.close();
  bot.stop('SIGTERM');
  server.close();
});
