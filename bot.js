// finance-bot-enhanced-full.js
const { Telegraf, Markup, session } = require('telegraf')
const sqlite3 = require('sqlite3').verbose()
require('dotenv').config()

const bot = new Telegraf(process.env.BOT_TOKEN)
bot.use(session())
const db = new sqlite3.Database('./finance.db')

const ALLOWED_USERS = [
    586995184,
    1319991227,
]

// -------------------- Helpers --------------------

function isUserAllowed(ctx) {
    if (!ctx.from || !ctx.chat) return false
    const userId = ctx.from.id
    const chatId = ctx.chat.id

    const isAllowed =
        ALLOWED_USERS.includes(userId) || ALLOWED_USERS.includes(chatId)

    if (!isAllowed) {
        console.log(`🚫 Доступ запрещен: User ID: ${userId}, Chat ID: ${chatId}`)
    }

    return isAllowed
}

bot.use((ctx, next) => {
    if (!isUserAllowed(ctx)) {
        ctx.reply(
            '❌ Доступ запрещен!\n\n' +
            'Это приватный бот для учета расходов. ' +
            'Если вы должны иметь доступ, обратитесь к администратору.'
        )
        return
    }
    return next()
})

function parseAmount(amountStr) {
    if (amountStr === null || amountStr === undefined) return NaN
    const cleaned = String(amountStr).replace(',', '.').replace(/\s/g, '')
    return parseFloat(cleaned)
}

function formatAmount(amount) {
    const n = parseFloat(amount) || 0
    return n.toFixed(2)
}

function getMainMenu() {
    return Markup.keyboard([
        ['📊 Статистика', '📋 Отчёт'],
        ['💸 Добавить трату', '💰 Добавить доход'],
        ['✏️ Мои траты', '🗂️ Мои доходы'],
        ['📈 Баланс'],
        ['📅 Текущий месяц', '📅 Прошлый месяц'],
        ['🗑️ Очистить прошлый месяц', '🔄 Сбросить меню'],
    ]).resize()
}

function getEditMenu(type, id) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('✏️ Изменить', `edit_${type}_${id}`),
            Markup.button.callback('❌ Удалить', `delete_${type}_${id}`),
        ],
        [Markup.button.callback('⬅️ Назад', 'back_to_list')]
    ])
}

function ensureCategoryColumn(table, cb) {
    db.all(`PRAGMA table_info(${table})`, (err, cols) => {
        if (err) {
            console.error('PRAGMA error', err)
            return cb && cb(err)
        }
        const hasCategory = cols.some(c => c.name === 'category')
        if (!hasCategory) {
            db.run(`ALTER TABLE ${table} ADD COLUMN category TEXT DEFAULT 'Прочее'`, cb)
        } else {
            cb && cb(null)
        }
    })
}

// -------------------- DB init --------------------

db.serialize(() => {
    db.run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      who TEXT NOT NULL,
      category TEXT DEFAULT 'Прочее',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

    db.run(`
    CREATE TABLE IF NOT EXISTS incomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      who TEXT NOT NULL,
      category TEXT DEFAULT 'Прочее',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

    ensureCategoryColumn('expenses', (e) => { if (e) console.error('Ошибка добавления category в expenses', e) })
    ensureCategoryColumn('incomes', (e) => { if (e) console.error('Ошибка добавления category в incomes', e) })
})

// -------------------- Previous month cleanup --------------------

function cleanupPreviousMonthIfNeeded() {
    try {
        const now = new Date()
        const day = now.getDate()
        if (day !== 5) return
        let year = now.getFullYear()
        let month = now.getMonth()
        let prevMonthIndex = month - 1
        let prevYear = year
        if (prevMonthIndex < 0) { prevMonthIndex = 11; prevYear = year - 1 }
        const mStr = String(prevMonthIndex + 1).padStart(2, '0')
        const pattern = '%.' + mStr + '.' + prevYear
        db.run('DELETE FROM expenses WHERE date LIKE ?', [pattern], function (err) {
            if (err) console.error('Ошибка удаления расходов предыдущего месяца:', err)
            else console.log(`✅ Удалены расходы за ${mStr}.${prevYear}, строк: ${this.changes}`)
        })
        db.run('DELETE FROM incomes WHERE date LIKE ?', [pattern], function (err) {
            if (err) console.error('Ошибка удаления доходов предыдущего месяца:', err)
            else console.log(`✅ Удалены доходы за ${mStr}.${prevYear}, строк: ${this.changes}`)
        })
    } catch (e) {
        console.error('Ошибка в cleanupPreviousMonthIfNeeded', e)
    }
}
cleanupPreviousMonthIfNeeded()
setInterval(cleanupPreviousMonthIfNeeded, 24 * 60 * 60 * 1000)

// -------------------- Menu stack helper --------------------

function pushMenu(ctx, menuName) {
    ctx.session.menuStack = ctx.session.menuStack || []
    ctx.session.menuStack.push(menuName)
}

function popMenu(ctx) {
    ctx.session.menuStack = ctx.session.menuStack || []
    return ctx.session.menuStack.pop()
}

function goBack(ctx) {
    const prevMenu = popMenu(ctx)
    switch (prevMenu) {
        case 'main':
            ctx.reply('Выберите действие:', getMainMenu())
            break
        case 'balance_period':
            ctx.reply('Выберите период:', Markup.keyboard([['📅 Текущий месяц', '📅 Прошлый месяц'], ['⬅️ Назад']], { resize_keyboard: true }))
            break
        case 'my_expenses':
            bot.handleUpdate({ message: { text: '✏️ Мои траты', chat: ctx.chat, from: ctx.from } })
            break
        case 'my_incomes':
            bot.handleUpdate({ message: { text: '🗂️ Мои доходы', chat: ctx.chat, from: ctx.from } })
            break
        default:
            ctx.reply('Выберите действие:', getMainMenu())
            break
    }
}

// -------------------- Bot handlers --------------------

bot.start(ctx => {
    ctx.session = {}
    ctx.session.menuStack = []
    pushMenu(ctx, 'main')
    const userName = ctx.from.first_name || 'Пользователь'
    ctx.reply(
        `💰 Привет, ${userName}!\n\nЭто приватный бот для учёта финансов.\n\n` +
        'Формат ввода: \n<code>Дата | На что | Сумма | Кто</code>\nОпционально: добавить категорию\n\n' +
        'Пример:\n<code>25.12.2023 | Продажа ноутбука | 45000 | Я | Техника</code>\n<code>26.12.2023 | Продукты | 2500,75 | Маша | Продукты</code>\n\n' +
        'После добавления запись будет сохранена в таблице доходов или расходов в зависимости от выбранной кнопки.',
        { parse_mode: 'HTML', ...getMainMenu() }
    )
})

// Сброс меню
bot.hears('🔄 Сбросить меню', ctx => {
    ctx.session = {}
    ctx.reply('Меню сброшено. Используйте /start для показа кнопок.')
})

// Добавить трату
bot.hears('💸 Добавить трату', ctx => {
    ctx.session.mode = 'expense'
    ctx.session.editing = null
    pushMenu(ctx, 'main')
    ctx.reply('Введите трату в формате: Дата | На что | Сумма | Кто | Категория (опционально)', { parse_mode: 'HTML' })
})

// Добавить доход
bot.hears('💰 Добавить доход', ctx => {
    ctx.session.mode = 'income'
    ctx.session.editing = null
    pushMenu(ctx, 'main')
    ctx.reply('Введите доход в формате: Дата | Описание | Сумма | Кто | Категория (опционально)', { parse_mode: 'HTML' })
})

// Статистика
bot.hears('📊 Статистика', ctx => {
    pushMenu(ctx, 'main')
    // тут логика статистики (как в твоём коде)
})

// Баланс
bot.hears('📈 Баланс', ctx => {
    pushMenu(ctx, 'main')
    pushMenu(ctx, 'balance_period')
    ctx.reply('Выберите период:', Markup.keyboard([['📅 Текущий месяц', '📅 Прошлый месяц'], ['⬅️ Назад']], { resize_keyboard: true }))
})

// Текущий / прошлый месяц
bot.hears(['📅 Текущий месяц', '📅 Прошлый месяц'], ctx => {
    pushMenu(ctx, 'balance_period')
    // тут логика баланса и графика
})

// Показать график
bot.hears('📈 Показать график', ctx => {
    // логика графика
})

// Отчёт
bot.hears('📋 Отчёт', ctx => {
    pushMenu(ctx, 'main')
    // логика отчёта
})

// Мои траты
bot.hears('✏️ Мои траты', ctx => {
    pushMenu(ctx, 'main')
    pushMenu(ctx, 'my_expenses')
    // логика показа последних трат с inline кнопками
})

// Мои доходы
bot.hears('🗂️ Мои доходы', ctx => {
    pushMenu(ctx, 'main')
    pushMenu(ctx, 'my_incomes')
    // логика показа последних доходов с inline кнопками
})

// Кнопка Назад
bot.hears(['🔙', '⬅️ Назад'], ctx => {
    goBack(ctx)
})

bot.action('back_to_list', ctx => {
    ctx.answerCbQuery()
    goBack(ctx)
})

bot.action('back_to_main', ctx => {
    ctx.answerCbQuery()
    ctx.session.menuStack = []
    ctx.session = {}
    ctx.deleteMessage().catch(() => { })
    ctx.reply('Выберите действие:', getMainMenu())
})

// -------------------- Text input handling --------------------
// здесь оставляем весь твой блок обработки текста (добавление и редактирование), без изменений

// -------------------- Manual cleanup previous month --------------------
bot.hears('🗑️ Очистить прошлый месяц', ctx => {
    // логика удаления, как в твоём коде
})

// -------------------- Catch & launch --------------------

bot.catch((err, ctx) => {
    console.error('Error for', ctx.updateType, err)
})

bot.launch().then(() => {
    console.log('✅ Бот запущен (full enhanced)!')
    console.log('✅ Разрешены пользователи:', ALLOWED_USERS)
}).catch(e => {
    console.error('❌ Ошибка запуска бота:', e)
})

process.once('SIGINT', () => { db.close(); bot.stop('SIGINT') })
process.once('SIGTERM', () => { db.close(); bot.stop('SIGTERM') })
