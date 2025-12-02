const { Telegraf, Markup, session } = require('telegraf')
const sqlite3 = require('sqlite3').verbose()
require('dotenv').config()

const bot = new Telegraf(process.env.BOT_TOKEN)
bot.use(session())

const db = new sqlite3.Database('./finance.db')
const ALLOWED_USERS = [586995184, 1319991227]

// Проверка доступа
function isUserAllowed(ctx) {
	const userId = ctx.from.id
	const chatId = ctx.chat.id
	const allowed = ALLOWED_USERS.includes(userId) || ALLOWED_USERS.includes(chatId)
	if (!allowed)
		console.log(`🚫 Доступ запрещен: User ID: ${userId}, Chat ID: ${chatId}`)
	return allowed
}

bot.use((ctx, next) => {
	if (!isUserAllowed(ctx)) {
		ctx.reply(
			'❌ Доступ запрещен!\n\nЭто приватный бот для учета расходов.\nЕсли нужен доступ — обратитесь к администратору.'
		)
		return
	}
	return next()
})

// Создание таблиц
db.serialize(() => {
	db.run(`
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            who TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `)
	db.run(`
        CREATE TABLE IF NOT EXISTS income (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            who TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `)
})

// Утилиты
function parseAmount(str) {
	return parseFloat(str.replace(',', '.').replace(/\s/g, ''))
}
function formatAmount(amount) {
	return parseFloat(amount).toFixed(2)
}
function getMainMenu() {
	return Markup.keyboard([
		['📊 Статистика', '📋 Отчёт'],
		['💸 Добавить трату', '💰 Добавить доход'],
		['✏️ Мои траты', '📈 Баланс'],
		['✏️ Мои доходы'],
		['🔄 Сбросить меню'],
	]).resize()
}
function getEditMenu(type, id) {
	return Markup.inlineKeyboard([
		[
			Markup.button.callback('✏️ Изменить', `edit_${type}_${id}`),
			Markup.button.callback('❌ Удалить', `delete_${type}_${id}`),
		],
		[Markup.button.callback('⬅️ Назад к списку', `back_to_list_${type}`)],
	])
}

// Старт
bot.start(ctx => {
	const name = ctx.from.first_name || 'Пользователь'
	ctx.reply(`💰 Привет, ${name}!\nВыберите действие:`, getMainMenu())
})

// Меню
bot.hears('🔄 Сбросить меню', ctx =>
	ctx.reply('Меню сброшено. Используйте /start', {
		reply_markup: { remove_keyboard: true },
	})
)

// Добавить трату
bot.hears('💸 Добавить трату', ctx => {
	ctx.reply(
		'Введите трату в формате:\nДата | На что | Сумма | Кто\nПример:\n25.12.2023 | Xbox | 850 | Кирилл',
		{ parse_mode: 'HTML' }
	)
	ctx.session = ctx.session || {}
	ctx.session.addingExpense = true
})

// Добавить доход
bot.hears('💰 Добавить доход', ctx => {
	ctx.reply(
		'Введите доход в формате:\nДата | Описание | Сумма | Кто\nПример:\n27.12.2024 | Зарплата | 50000 | Кирилл',
		{ parse_mode: 'HTML' }
	)
	ctx.session = ctx.session || {}
	ctx.session.addingIncome = true
})

// Статистика (расходы + доходы)
bot.hears('📊 Статистика', ctx => {
	db.all(
		`SELECT 'Расход' AS type, who, SUM(amount) AS total, COUNT(*) AS count FROM expenses GROUP BY who
         UNION ALL
         SELECT 'Доход' AS type, who, SUM(amount) AS total, COUNT(*) AS count FROM income GROUP BY who`,
		(err, rows) => {
			if (err) return ctx.reply('❌ Ошибка получения статистики')
			if (!rows.length) return ctx.reply('📊 Пока нет данных')
			let msg = '📊 <b>Статистика:</b>\n\n'
			let totalAll = 0
			rows.forEach(r => {
				msg += `<b>${r.type} — ${r.who}:</b> ${formatAmount(r.total)} руб. (${r.count} записей)\n`
				totalAll += r.total
			})
			msg += `\n💵 <b>Общий итог:</b> ${formatAmount(totalAll)} руб.`
			ctx.reply(msg, { parse_mode: 'HTML' })
		}
	)
})

// Отчёт (расходы + доходы)
bot.hears('📋 Отчёт', ctx => {
	db.all(
		`SELECT date, description, amount, who, 'Расход' AS type FROM expenses
         UNION ALL
         SELECT date, description, amount, who, 'Доход' AS type FROM income
         ORDER BY date DESC LIMIT 30`,
		(err, rows) => {
			if (err) return ctx.reply('❌ Ошибка получения отчёта')
			if (!rows.length) return ctx.reply('📋 Нет записей')
			let msg = '📋 <b>Последние записи:</b>\n\n'
			let total = 0
			rows.forEach(r => {
				msg += `[${r.type}] ${r.date} | ${r.description} | ${formatAmount(r.amount)} руб. | ${r.who}\n`
				total += r.amount
			})
			msg += `\n💵 <b>Итого:</b> ${formatAmount(total)} руб.`
			ctx.reply(msg, { parse_mode: 'HTML' })
		}
	)
})

// Мои траты
function sendExpensesList(ctx) {
	db.all(`SELECT * FROM expenses ORDER BY date DESC, id DESC LIMIT 10`, (err, rows) => {
		if (err) return ctx.reply('❌ Ошибка получения списка трат')
		if (!rows.length) return ctx.reply('✏️ Пока нет трат для редактирования')
		let msg = '✏️ <b>Последние траты:</b>\n\n'
		const keyboard = []
		rows.forEach((r, i) => {
			msg += `${i + 1}. ${r.date} | ${r.description} | ${formatAmount(r.amount)} руб. | ${r.who}\n`
			keyboard.push([Markup.button.callback(`${r.date} - ${r.description} - ${formatAmount(r.amount)} руб.`, `select_expense_${r.id}`)])
		})
		keyboard.push([Markup.button.callback('⬅️ Назад', 'back_to_main')])
		ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(keyboard) })
	})
}

bot.hears('✏️ Мои траты', sendExpensesList)

// Мои доходы
function sendIncomeList(ctx) {
	db.all(`SELECT * FROM income ORDER BY created_at DESC LIMIT 10`, (err, rows) => {
		if (err) return ctx.reply('❌ Ошибка получения доходов')
		if (!rows.length) return ctx.reply('🪙 Доходов пока нет')
		let msg = '✏️ <b>Последние доходы:</b>\n\n'
		const keyboard = []
		rows.forEach((r, i) => {
			msg += `${i + 1}. ${r.date} | ${r.description} | ${formatAmount(r.amount)} руб. | ${r.who}\n`
			keyboard.push([Markup.button.callback(`${r.date} - ${r.description} - ${formatAmount(r.amount)} руб.`, `select_income_${r.id}`)])
		})
		keyboard.push([Markup.button.callback('⬅️ Назад', 'back_to_main')])
		ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(keyboard) })
	})
}

bot.hears('✏️ Мои доходы', sendIncomeList)

// Баланс
bot.hears('📈 Баланс', ctx => {
	db.get('SELECT SUM(amount) AS total FROM income', (err, incRow) => {
		if (err) return ctx.reply('❌ Ошибка получения доходов')
		db.get('SELECT SUM(amount) AS total FROM expenses', (err, expRow) => {
			if (err) return ctx.reply('❌ Ошибка получения расходов')
			const balance = (incRow.total || 0) - (expRow.total || 0)
			ctx.reply(
				`📈 Баланс:\n💰 Доходы: ${formatAmount(incRow.total || 0)} руб.\n💸 Расходы: ${formatAmount(expRow.total || 0)} руб.\n\n${balance >= 0 ? '🟢' : '🔴'} ИТОГО: ${formatAmount(balance)} руб.`,
				{ parse_mode: 'HTML' }
			)
		})
	})
})

// Обработка текста
bot.on('text', ctx => {
	const text = ctx.message.text
	ctx.session = ctx.session || {}

	// Редактирование записи
	if (ctx.session.editing) {
		const { type, id } = ctx.session.editing
		const table = type === 'expense' ? 'expenses' : 'income'
		if (!text.includes('|')) return ctx.reply('❌ Формат: Дата | На что/Описание | Сумма | Кто')
		const [date, desc, amountStr, who] = text.split('|').map(p => p.trim())
		const amount = parseAmount(amountStr)
		if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Сумма должна быть числом >0')

		db.run(`UPDATE ${table} SET date=?, description=?, amount=?, who=? WHERE id=?`, [date, desc, amount, who, id], err => {
			if (err) return ctx.reply('❌ Ошибка обновления: ' + err.message)
			ctx.reply(`✅ Запись обновлена:\n${date} | ${desc} | ${formatAmount(amount)} | ${who}`)
			delete ctx.session.editing
		})
		return
	}

	// Добавление расхода
	if (ctx.session.addingExpense) {
		if (!text.includes('|')) return ctx.reply('❌ Формат: Дата | На что | Сумма | Кто')
		const [date, desc, amountStr, who] = text.split('|').map(p => p.trim())
		const amount = parseAmount(amountStr)
		if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Сумма должна быть числом >0')
		db.run('INSERT INTO expenses (date, description, amount, who) VALUES (?,?,?,?)', [date, desc, amount, who], err => {
			if (err) return ctx.reply('❌ Ошибка добавления: ' + err.message)
			ctx.reply(`✅ Трата добавлена:\n${date} | ${desc} | ${formatAmount(amount)} | ${who}`)
		})
		delete ctx.session.addingExpense
		return
	}

	// Добавление дохода
	if (ctx.session.addingIncome) {
		if (!text.includes('|')) return ctx.reply('❌ Формат: Дата | Описание | Сумма | Кто')
		const [date, desc, amountStr, who] = text.split('|').map(p => p.trim())
		const amount = parseAmount(amountStr)
		if (isNaN(amount) || amount <= 0) return ctx.reply('❌ Сумма должна быть числом >0')
		db.run('INSERT INTO income (date, description, amount, who) VALUES (?,?,?,?)', [date, desc, amount, who], err => {
			if (err) return ctx.reply('❌ Ошибка добавления: ' + err.message)
			ctx.reply(`✅ Доход добавлен:\n${date} | ${desc} | ${formatAmount(amount)} | ${who}`)
		})
		delete ctx.session.addingIncome
		return
	}
})

// Редактирование/удаление через кнопки
bot.action(/select_(expense|income)_(\d+)/, ctx => {
	const [_, type, id] = ctx.match
	const table = type === 'expense' ? 'expenses' : 'income'
	db.get(`SELECT * FROM ${table} WHERE id=?`, [id], (err, row) => {
		if (err || !row) return ctx.answerCbQuery('❌ Запись не найдена')
		const msg = `✏️ <b>Редактирование ${type === 'expense' ? 'траты' : 'дохода'}:</b>\n\n<b>Дата:</b> ${row.date}\n<b>Описание:</b> ${row.description}\n<b>Сумма:</b> ${formatAmount(row.amount)} руб.\n<b>Кто:</b> ${row.who}\n\nВыберите действие:`
		ctx.editMessageText(msg, { parse_mode: 'HTML', ...getEditMenu(type, id) })
	})
})

bot.action(/edit_(expense|income)_(\d+)/, ctx => {
	const [_, type, id] = ctx.match
	ctx.session = ctx.session || {}
	ctx.session.editing = { type, id }
	ctx.answerCbQuery()
	ctx.reply(`Введите новые данные в формате:\nДата | На что/Описание | Сумма | Кто`, { parse_mode: 'HTML', ...Markup.removeKeyboard() })
})

bot.action(/delete_(expense|income)_(\d+)/, ctx => {
	const [_, type, id] = ctx.match
	const table = type === 'expense' ? 'expenses' : 'income'
	db.run(`DELETE FROM ${table} WHERE id=?`, [id], function(err) {
		if (err) return ctx.answerCbQuery('❌ Ошибка при удалении')
		ctx.answerCbQuery('✅ Удалено')
		ctx.editMessageText('✅ Запись удалена', { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад к списку', callback_data: `back_to_list_${type}` }]] } })
	})
})

bot.action(/back_to_list_(expense|income)/, ctx => {
	const [_, type] = ctx.match
	ctx.answerCbQuery()
	if (type === 'expense') sendExpensesList(ctx)
	else sendIncomeList(ctx)
})

// Запуск
bot.catch((err, ctx) => console.error('Error:', ctx.updateType, err))
bot.launch()
console.log('✅ Бот запущен')
console.log('✅ Разрешены пользователи:', ALLOWED_USERS)

process.once('SIGINT', () => {
	db.close()
	bot.stop('SIGINT')
})
process.once('SIGTERM', () => {
	db.close()
	bot.stop('SIGTERM')
})
