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
	const allowed =
		ALLOWED_USERS.includes(userId) || ALLOWED_USERS.includes(chatId)
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
function getEditMenu(id) {
	return Markup.inlineKeyboard([
		[
			Markup.button.callback('✏️ Изменить', `edit_${id}`),
			Markup.button.callback('❌ Удалить', `delete_${id}`),
		],
		[Markup.button.callback('⬅️ Назад к списку', 'back_to_list')],
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

// Статистика
bot.hears('📊 Статистика', ctx => {
	db.all(
		`SELECT who, SUM(amount) AS total, COUNT(*) AS count FROM expenses GROUP BY who`,
		(err, rows) => {
			if (err) return ctx.reply('❌ Ошибка получения статистики')
			if (!rows.length) return ctx.reply('📊 Пока нет данных о тратах')
			let totalAll = 0,
				countAll = 0,
				msg = '📊 <b>Статистика:</b>\n\n'
			rows.forEach(r => {
				msg += `<b>${r.who}:</b> ${formatAmount(r.total)} руб. (${
					r.count
				} трат)\n`
				totalAll += r.total
				countAll += r.count
			})
			msg += `\n💵 <b>Всего:</b> ${formatAmount(
				totalAll
			)} руб. (${countAll} трат)`
			ctx.reply(msg, { parse_mode: 'HTML' })
		}
	)
})

// Отчёт
bot.hears('📋 Отчёт', ctx => {
	db.all(
		`SELECT date, description, amount, who FROM expenses ORDER BY date DESC, id DESC LIMIT 30`,
		(err, rows) => {
			if (err) return ctx.reply('❌ Ошибка получения отчёта')
			if (!rows.length) return ctx.reply('📋 Пока нет трат')
			let msg = '📋 <b>Последние траты:</b>\n\n',
				total = 0
			rows.forEach(r => {
				msg += `${r.date} | ${r.description} | ${formatAmount(
					r.amount
				)} руб. | ${r.who}\n`
				total += r.amount
			})
			msg += `\n💵 <b>Итого:</b> ${formatAmount(total)} руб.`
			ctx.reply(msg, { parse_mode: 'HTML' })
		}
	)
})

// Мои траты
bot.hears('✏️ Мои траты', ctx => {
	db.all(
		`SELECT * FROM expenses ORDER BY date DESC, id DESC LIMIT 10`,
		(err, rows) => {
			if (err) return ctx.reply('❌ Ошибка получения списка трат')
			if (!rows.length) return ctx.reply('✏️ Пока нет трат для редактирования')
			let msg = '✏️ <b>Последние траты:</b>\n\n'
			rows.forEach((r, i) => {
				msg += `${i + 1}. ${r.date} | ${r.description} | ${formatAmount(
					r.amount
				)} руб. | ${r.who}\n`
			})
			const keyboard = rows.map(r => [
				Markup.button.callback(
					`${r.date} - ${r.description} - ${formatAmount(r.amount)} руб.`,
					`select_${r.id}`
				),
			])
			keyboard.push([Markup.button.callback('⬅️ Назад', 'back_to_main')])
			ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard(keyboard) })
		}
	)
})

// Мои доходы
bot.hears('✏️ Мои доходы', ctx => {
	db.all(
		`SELECT * FROM income ORDER BY created_at DESC LIMIT 30`,
		(err, rows) => {
			if (err) return ctx.reply('❌ Ошибка получения доходов')
			if (!rows.length) return ctx.reply('🪙 Доходов пока нет')
			let msg = '✏️ <b>Последние доходы:</b>\n\n'
			rows.forEach(r => {
				msg += `#${r.id} | ${r.date} | ${r.description} | ${formatAmount(
					r.amount
				)} | ${r.who}\n`
			})
			msg += '\nДля редактирования: доход #id с = новая строка'
			ctx.reply(msg, { parse_mode: 'HTML' })
		}
	)
})

// Баланс
bot.hears('📈 Баланс', ctx => {
	db.get('SELECT SUM(amount) AS total FROM income', (err, incRow) => {
		if (err) return ctx.reply('❌ Ошибка получения доходов')
		db.get('SELECT SUM(amount) AS total FROM expenses', (err, expRow) => {
			if (err) return ctx.reply('❌ Ошибка получения расходов')
			const balance = (incRow.total || 0) - (expRow.total || 0)
			ctx.reply(
				`📈 Баланс:\n💰 Доходы: ${formatAmount(
					incRow.total || 0
				)} руб.\n💸 Расходы: ${formatAmount(expRow.total || 0)} руб.\n\n${
					balance >= 0 ? '🟢' : '🔴'
				} ИТОГО: ${formatAmount(balance)} руб.`,
				{ parse_mode: 'HTML' }
			)
		})
	})
})

// Обработка текста
bot.on('text', ctx => {
	const text = ctx.message.text
	ctx.session = ctx.session || {}

	// Добавление расхода
	if (ctx.session.addingExpense) {
		if (!text.includes('|'))
			return ctx.reply('❌ Формат: Дата | На что | Сумма | Кто')
		const [date, desc, amountStr, who] = text.split('|').map(p => p.trim())
		const amount = parseAmount(amountStr)
		if (isNaN(amount) || amount <= 0)
			return ctx.reply('❌ Сумма должна быть числом > 0')
		db.run(
			'INSERT INTO expenses (date, description, amount, who) VALUES (?,?,?,?)',
			[date, desc, amount, who],
			err => {
				if (err) return ctx.reply('❌ Ошибка добавления: ' + err.message)
				ctx.reply(
					`✅ Трата добавлена:\n${date} | ${desc} | ${formatAmount(
						amount
					)} | ${who}`
				)
			}
		)
		delete ctx.session.addingExpense
		return
	}

	// Добавление дохода
	if (ctx.session.addingIncome) {
		if (!text.includes('|'))
			return ctx.reply('❌ Формат: Дата | Описание | Сумма | Кто')
		const [date, desc, amountStr, who] = text.split('|').map(p => p.trim())
		const amount = parseAmount(amountStr)
		if (isNaN(amount) || amount <= 0)
			return ctx.reply('❌ Сумма должна быть числом > 0')
		db.run(
			'INSERT INTO income (date, description, amount, who) VALUES (?,?,?,?)',
			[date, desc, amount, who],
			err => {
				if (err) return ctx.reply('❌ Ошибка добавления: ' + err.message)
				ctx.reply(
					`✅ Доход добавлен:\n${date} | ${desc} | ${formatAmount(
						amount
					)} | ${who}`
				)
			}
		)
		delete ctx.session.addingIncome
		return
	}

	// Редактирование доходов
	if (/^доход #\d+\s+с\s*=\s*/i.test(text)) {
		const match = text.match(/^доход #(\d+)\s+с\s*=\s*(.+)$/i)
		if (!match) return ctx.reply('❌ Формат: доход #id с = новая строка')
		const id = parseInt(match[1]),
			newText = match[2]
		const parts = newText.split('|').map(p => p.trim())
		if (parts.length !== 4)
			return ctx.reply('❌ Формат: Дата | Описание | Сумма | Кто')
		const [date, desc, amountStr, who] = parts
		const amount = parseAmount(amountStr)
		if (isNaN(amount)) return ctx.reply('❌ Сумма должна быть числом')
		db.run(
			'UPDATE income SET date=?, description=?, amount=?, who=? WHERE id=?',
			[date, desc, amount, who, id],
			err => {
				if (err) return ctx.reply('❌ Ошибка обновления: ' + err.message)
				ctx.reply(
					`✨ Доход #${id} обновлён:\n${date} | ${desc} | ${formatAmount(
						amount
					)} | ${who}`
				)
			}
		)
		return
	}
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
