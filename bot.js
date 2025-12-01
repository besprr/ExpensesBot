const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const db = new sqlite3.Database('./finance.db');

const ALLOWED_USERS = [
  586995184,    
  1319991227,   
];

function isUserAllowed(ctx) {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  
  const isAllowed = ALLOWED_USERS.includes(userId) || ALLOWED_USERS.includes(chatId);
  
  if (!isAllowed) {
    console.log(`🚫 Доступ запрещен: User ID: ${userId}, Chat ID: ${chatId}`);
  }
  
  return isAllowed;
}

bot.use((ctx, next) => {
  if (!isUserAllowed(ctx)) {
    ctx.reply(
      '❌ Доступ запрещен!\n\n' +
      'Это приватный бот для учета расходов. ' +
      'Если вы должны иметь доступ, обратитесь к администратору.'
    );
    return;
  }
  return next();
});

db.serialize(() => {
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

function parseAmount(amountStr) {
  const cleaned = amountStr.replace(',', '.').replace(/\s/g, '');
  return parseFloat(cleaned);
}

function formatAmount(amount) {
  return parseFloat(amount).toFixed(2);
}

function cleanupOldData() {
  const currentDate = new Date();
  const oneMonthAgo = new Date(currentDate);
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
  oneMonthAgo.setDate(oneMonthAgo.getDate() - 5); 
  
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

cleanupOldData();
setInterval(cleanupOldData, 24 * 60 * 60 * 1000);

function getMainMenu() {
  return Markup.keyboard([
    ['📊 Статистика', '📋 Отчёт'],
    ['💸 Добавить расход', '💰 Добавить доход'],
    ['✏️ Мои записи', '🗑️ Очистить старые'],
    ['🔄 Сбросить меню']
  ]).resize();
}

function getTypeMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📥 Расход', 'type_expense'),
      Markup.button.callback('📤 Доход', 'type_income')
    ]
  ]);
}

function getEditMenu(recordId, type) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✏️ Изменить', `edit_${type}_${recordId}`),
      Markup.button.callback('❌ Удалить', `delete_${type}_${recordId}`)
    ],
    [Markup.button.callback('⬅️ Назад к списку', 'back_to_list')]
  ]);
}

bot.start((ctx) => {
  const userName = ctx.from.first_name || 'Пользователь';
  
  ctx.reply(
    `💰 Привет, ${userName}!\n\n` +
    'Это приватный бот для учета финансов.\n\n' +
    '📥 <b>Расходы</b> - траты, покупки\n' +
    '📤 <b>Доходы</b> - зарплата, продажи\n\n' +
    'Данные старше месяца+5 дней удаляются автоматически.\n\n' +
    'Выберите действие:',
    {
      parse_mode: 'HTML',
      ...getMainMenu()
    }
  );
});

bot.hears('🔄 Сбросить меню', (ctx) => {
  ctx.reply('Меню сброшено. Используйте /start для показа кнопок.');
});

bot.hears('💸 Добавить расход', (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.entryType = 'expense';
  ctx.session.entryStep = 'waiting_date';
  
  ctx.reply(
    '📥 <b>Добавление расхода</b>\n\n' +
    '1. Введите дату (ДД.ММ.ГГГГ):\n' +
    '<i>Например: 05.12.2023</i>',
    { parse_mode: 'HTML' }
  );
});

bot.hears('💰 Добавить доход', (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.entryType = 'income';
  ctx.session.entryStep = 'waiting_date';
  
  ctx.reply(
    '📤 <b>Добавление дохода</b>\n\n' +
    '1. Введите дату (ДД.ММ.ГГГГ):\n' +
    '<i>Например: 05.12.2023</i>',
    { parse_mode: 'HTML' }
  );
});

bot.hears('📊 Статистика', (ctx) => {
  const chatId = ctx.chat.id;
  
  db.all(`
    SELECT who, SUM(amount) as total, COUNT(*) as count 
    FROM expenses 
    GROUP BY who
  `, (err, expenseRows) => {
    if (err) {
      bot.telegram.sendMessage(chatId, '❌ Ошибка при получении статистики');
      return;
    }
    
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
      
      response += '📤 <b>Доходы:</b>\n';
      let totalIncome = 0;
      let incomeCount = 0;
      
      if (!incomeRows || incomeRows.length === 0) {
        response += '   <i>Пока нет доходов</i>\n';
      } else {
        incomeRows.forEach(row => {
          response += `   <b>${row.who}:</b> ${formatAmount(row.total)} руб. (${row.count} записей)\n`;
          totalIncome += row.total;
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
          response += `   <b>${row.who}:</b> ${formatAmount(row.total)} руб. (${row.count} записей)\n`;
          totalExpense += row.total;
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
    ORDER BY date DESC, id DESC
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
        totalIncome += row.amount;
      } else {
        totalExpense += row.amount;
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

bot.hears('🗑️ Очистить старые', (ctx) => {
  cleanupOldData();
  ctx.reply('✅ Старые данные (старше месяца+5 дней) удалены!');
});

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
  
  ctx.session = ctx.session || {};
  ctx.session.editingRecordId = recordId;
  ctx.session.editingType = type;
});

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

bot.action('back_to_main', (ctx) => {
  ctx.answerCbQuery();
  ctx.deleteMessage();
  bot.telegram.sendMessage(ctx.chat.id, 'Выберите действие:', getMainMenu());
});

bot.on('text', (ctx) => {
  const text = ctx.message.text;
  
  if (['📊 Статистика', '📋 Отчёт', '💸 Добавить расход', '💰 Добавить доход', 
       '✏️ Мои записи', '🗑️ Очистить старые', '🔄 Сбросить меню'].includes(text)) {
    return;
  }
  
  const session = ctx.session || {};
  
  if (session.editingRecordId && session.editingType) {
    if (text.includes('|')) {
      const parts = text.split('|').map(p => p.trim());
      if (parts.length === 4) {
        const [date, desc, amount, who] = parts;
        const amountNum = parseAmount(amount);
        
        if (!isNaN(amountNum) && amountNum > 0) {
          const table = session.editingType === 'expense' ? 'expenses' : 'incomes';
          
          db.run(
            `UPDATE ${table} SET date = ?, description = ?, amount = ?, who = ? WHERE id = ?`,
            [date, desc, amountNum, who, session.editingRecordId],
            (err) => {
              if (err) {
                ctx.reply('❌ Ошибка обновления: ' + err.message);
              } else {
                const typeText = session.editingType === 'expense' ? 'Расход' : 'Доход';
                ctx.reply(`${typeText} обновлен!\n${date} | ${desc} | ${formatAmount(amountNum)} | ${who}`);
                delete ctx.session.editingRecordId;
                delete ctx.session.editingType;
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
  
  if (session.entryType && session.entryStep) {
    switch(session.entryStep) {
      case 'waiting_date':
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(text)) {
          ctx.session.entryDate = text;
          ctx.session.entryStep = 'waiting_description';
          ctx.reply(
            '2. Введите описание:\n' +
            '<i>Например: Зарплата за декабрь или Покупка продуктов</i>',
            { parse_mode: 'HTML' }
          );
        } else {
          ctx.reply('❌ Неверный формат даты. Используйте ДД.ММ.ГГГГ\nНапример: 05.12.2023');
        }
        break;
        
      case 'waiting_description':
        ctx.session.entryDescription = text;
        ctx.session.entryStep = 'waiting_amount';
        ctx.reply(
          '3. Введите сумму:\n' +
          '<i>Например: 50000 или 1500,50</i>\n' +
          '💡 Можно использовать точки или запятые для копеек',
          { parse_mode: 'HTML' }
        );
        break;
        
      case 'waiting_amount':
        const amountNum = parseAmount(text);
        if (!isNaN(amountNum) && amountNum > 0) {
          ctx.session.entryAmount = amountNum;
          ctx.session.entryStep = 'waiting_who';
          
          const typeText = session.entryType === 'expense' ? 'расхода' : 'дохода';
          ctx.reply(
            `4. Укажите, кто ${typeText}:\n` +
            '<i>Например: Я, Маша, или оба</i>',
            { parse_mode: 'HTML' }
          );
        } else {
          ctx.reply('❌ Сумма должна быть положительным числом');
        }
        break;
        
      case 'waiting_who':
        const { entryType, entryDate, entryDescription, entryAmount } = session;
        const who = text;
        const table = entryType === 'expense' ? 'expenses' : 'incomes';
        
        db.run(
          `INSERT INTO ${table} (date, description, amount, who, type) VALUES (?, ?, ?, ?, ?)`,
          [entryDate, entryDescription, entryAmount, who, entryType],
          (err) => {
            if (err) {
              ctx.reply('❌ Ошибка сохранения: ' + err.message);
            } else {
              const typeText = entryType === 'expense' ? '📥 Расход' : '📤 Доход';
              ctx.reply(
                `✅ ${typeText} добавлен!\n\n` +
                `<b>Дата:</b> ${entryDate}\n` +
                `<b>Описание:</b> ${entryDescription}\n` +
                `<b>Сумма:</b> ${formatAmount(entryAmount)} руб.\n` +
                `<b>Кто:</b> ${who}`,
                { parse_mode: 'HTML' }
              );
            }
          }
        );
        
        delete ctx.session.entryType;
        delete ctx.session.entryStep;
        delete ctx.session.entryDate;
        delete ctx.session.entryDescription;
        delete ctx.session.entryAmount;
        break;
    }
    return;
  }
  
  if (text.includes('|')) {
    const parts = text.split('|').map(p => p.trim());
    if (parts.length === 4) {
      const [date, desc, amount, who] = parts;
      const amountNum = parseAmount(amount);
      
      if (!isNaN(amountNum) && amountNum > 0) {
        db.run(
          'INSERT INTO expenses (date, description, amount, who) VALUES (?, ?, ?, ?)',
          [date, desc, amountNum, who],
          (err) => {
            if (err) {
              ctx.reply('❌ Ошибка сохранения: ' + err.message);
            } else {
              ctx.reply(
                `✅ Расход добавлен!\n${date} | ${desc} | ${formatAmount(amountNum)} | ${who}`
              );
            }
          }
        );
      } else {
        ctx.reply(
          '❌ Сумма должна быть положительным числом (можно использовать запятые или точки для копеек)\n\n' +
          '💡 <b>Совет:</b> Используйте кнопки "Добавить расход" или "Добавить доход" для удобного пошагового ввода!',
          { parse_mode: 'HTML' }
        );
      }
    } else {
      ctx.reply('❌ Неверный формат. Используйте: Дата | Описание | Сумма | Кто');
    }
  } else {
    ctx.reply(
      '🤔 Не понял ваше сообщение.\n\n' +
      'Выберите действие из меню или используйте формат:\n' +
      '<code>Дата | Описание | Сумма | Кто</code>\n\n' +
      '💡 <b>Лучше использовать кнопки меню!</b>',
      { parse_mode: 'HTML' }
    );
  }
});

bot.catch((err, ctx) => {
  console.error('Error for', ctx.updateType, err);
});

bot.launch();
console.log('✅ Бот запущен с улучшениями!');
console.log('✅ Разрешены пользователи:', ALLOWED_USERS);
console.log('✅ Автоматическая очистка настроена');

process.once('SIGINT', () => {
  db.close();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  db.close();
  bot.stop('SIGTERM');
});