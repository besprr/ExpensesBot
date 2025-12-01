// finance-bot-enhanced.js
const { Telegraf, Markup, session } = require('telegraf')
const sqlite3 = require('sqlite3').verbose()
const fs = require('fs')
const os = require('os')
const path = require('path')
require('dotenv').config()

const bot = new Telegraf(process.env.BOT_TOKEN)
bot.use(session()) // обеспечиваем persist ctx.session
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
	// type: 'expense' | 'income'
	return Markup.inlineKeyboard([
		[
			Markup.button.callback('✏️ Изменить', `edit_${type}_${id}`),
			Markup.button.callback('❌ Удалить', `delete_${type}_${id}`),
		],
		[Markup.button.callback('⬅️ Назад к списку', 'back_to_list')],
	])
}

// добавим column category, если нет
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

	// на случай старых таблиц — убедимся, что column category есть
	ensureCategoryColumn('expenses', (e) => {
		if (e) console.error('Ошибка добавления category в expenses', e)
	})
	ensureCategoryColumn('incomes', (e) => {
		if (e) console.error('Ошибка добавления category в incomes', e)
	})
})

// -------------------- Auto cleanup previous month (5th day) --------------------

// Удаляем записи предыдущего месяца (по полю date, формат DD.MM.YYYY)
// Запускаем проверку каждый день в полночь-ish. Для простоты — каждые 24 часа.
function cleanupPreviousMonthIfNeeded() {
	try {
		const now = new Date()
		const day = now.getDate()
		if (day !== 5) return // выполняем только 5 числа
		// вычисляем предыдущий месяц
		let year = now.getFullYear()
		let month = now.getMonth() // 0..11, текущий
		// previous month index:
		let prevMonthIndex = month - 1
		let prevYear = year
		if (prevMonthIndex < 0) {
			prevMonthIndex = 11
			prevYear = year - 1
		}
		const mStr = String(prevMonthIndex + 1).padStart(2, '0') // 1..12
		const pattern = '%.' + mStr + '.' + prevYear // like "%.11.2025"
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

// запуск при старте
cleanupPreviousMonthIfNeeded()
// и каждые 24 часа
setInterval(cleanupPreviousMonthIfNeeded, 24 * 60 * 60 * 1000)

// -------------------- Bot handlers --------------------

bot.start(ctx => {
	ctx.session = ctx.session || {}
	ctx.session.mode = null // 'expense' | 'income' | null
	ctx.session.editing = null // { type, id }
	const userName = ctx.from.first_name || 'Пользователь'

	ctx.reply(
		`💰 Привет, ${userName}!\n\n` +
			'Это приватный бот для учёта финансов.\n\n' +
			'Формат ввода: \n' +
			'<code>Дата | На что | Сумма | Кто</code>\n' +
			'Опционально: добавить пятый аргумент — категория\n\n' +
			'Пример:\n' +
			'<code>25.12.2023 | Продажа ноутбука | 45000 | Я | Техника</code>\n' +
			'<code>26.12.2023 | Продукты | 2500,75 | Маша | Продукты</code>\n\n' +
			'После добавления запись будет сохранена в таблице доходов или расходов в зависимости от выбранной кнопки.',
		{ parse_mode: 'HTML', ...getMainMenu() }
	)
})

bot.hears('🔄 Сбросить меню', ctx => {
	ctx.session = {}
	ctx.reply('Меню сброшено. Используйте /start для показа кнопок.')
})

// Добавить трату
bot.hears('💸 Добавить трату', ctx => {
	ctx.session = ctx.session || {}
	ctx.session.mode = 'expense'
	ctx.session.editing = null
	ctx.reply(
		'Введите трату в формате:\n\n' +
			'📅 <b>Дата(ДД.MM.YYYY)</b> | 🛍️ <b>На что</b> | 💰 <b>Сумма</b> | 👤 <b>Кто</b> | <i>Категория (опционально)</i>\n\n' +
			'Примеры:\n' +
			'<code>25.12.2023 | Xbox | 30000.50 | Я | Развлечения</code>\n' +
			'<code>26.12.2023 | Продукты | 2500,75 | Девушка</code>\n\n' +
			'💡 Можно использовать точки или запятые для копеек',
		{ parse_mode: 'HTML' }
	)
})

// Добавить доход
bot.hears('💰 Добавить доход', ctx => {
	ctx.session = ctx.session || {}
	ctx.session.mode = 'income'
	ctx.session.editing = null
	ctx.reply(
		'Введите доход в формате:\n\n' +
			'📅 <b>Дата(ДД.MM.YYYY)</b> | 📝 <b>Описание</b> | 💰 <b>Сумма</b> | 👤 <b>Кто</b> | <i>Категория (опционально)</i>\n\n' +
			'Пример:\n' +
			'<code>05.12.2023 | Зарплата | 50000 | Я | Зарплата</code>\n\n' +
			'💡 Можно использовать точки или запятые для копеек',
		{ parse_mode: 'HTML' }
	)
})

// Статистика (общая)
bot.hears('📊 Статистика', ctx => {
	const chatId = ctx.chat.id

	db.all(
		`SELECT who, SUM(amount) as total, COUNT(*) as count FROM expenses GROUP BY who`,
		(err, expenseRows) => {
			if (err) {
				bot.telegram.sendMessage(chatId, '❌ Ошибка при получении статистики расходов')
				return
			}
			db.all(
				`SELECT who, SUM(amount) as total, COUNT(*) as count FROM incomes GROUP BY who`,
				(err2, incomeRows) => {
					if (err2) {
						bot.telegram.sendMessage(chatId, '❌ Ошибка при получении статистики доходов')
						return
					}

					let response = '📊 <b>Общая статистика:</b>\n\n'
					let totalIncome = 0
					let countIncome = 0
					if (!incomeRows || incomeRows.length === 0) {
						response += '📤 <i>Доходов пока нет</i>\n'
					} else {
						response += '📤 <b>Доходы:</b>\n'
						incomeRows.forEach(r => {
							const t = parseFloat(r.total) || 0
							response += `   <b>${r.who}:</b> ${formatAmount(t)} руб. (${r.count} записей)\n`
							totalIncome += t
							countIncome += r.count
						})
					}

					let totalExpense = 0
					let countExpense = 0
					if (!expenseRows || expenseRows.length === 0) {
						response += '\n📥 <i>Расходов пока нет</i>\n'
					} else {
						response += '\n📥 <b>Расходы:</b>\n'
						expenseRows.forEach(r => {
							const t = parseFloat(r.total) || 0
							response += `   <b>${r.who}:</b> ${formatAmount(t)} руб. (${r.count} трат)\n`
							totalExpense += t
							countExpense += r.count
						})
					}

					const balance = totalIncome - totalExpense
					response += `\n💰 <b>Баланс:</b> ${formatAmount(balance)} руб.\n`
					response += `📤 <b>Всего доходов:</b> ${formatAmount(totalIncome)} руб. (${countIncome} записей)\n`
					response += `📥 <b>Всего расходов:</b> ${formatAmount(totalExpense)} руб. (${countExpense} трат)\n`

					bot.telegram.sendMessage(chatId, response, { parse_mode: 'HTML' })
				}
			)
		}
	)
})

// Баланс за текущий или прошлый месяц
bot.hears('📈 Баланс', ctx => {
	ctx.reply('Выберите период:', Markup.keyboard([['📅 Текущий месяц', '📅 Прошлый месяц'], ['🔙 Назад']], { resize_keyboard: true }))
})

// Quick helpers to build SQL LIKE pattern for month YYYY and MM
function monthPattern(monthIndex, year) {
	// monthIndex: 1..12
	const m = String(monthIndex).padStart(2, '0')
	return '%.' + m + '.' + year // matches DD.MM.YYYY
}

function parseDateDDMMYYYY(str) {
	// returns { day, month, year } or null
	const m = String(str).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
	if (!m) return null
	return { day: Number(m[1]), month: Number(m[2]), year: Number(m[3]) }
}

function monthBoundsFromNow(offsetMonths = 0) {
	const now = new Date()
	now.setMonth(now.getMonth() + offsetMonths)
	return { year: now.getFullYear(), month: now.getMonth() + 1 } // month 1..12
}

// Показать баланс по месяцам (текущий/прошлый)
bot.hears(['📅 Текущий месяц', '📅 Прошлый месяц'], ctx => {
	let offset = 0
	if (ctx.message.text === '📅 Прошлый месяц') offset = -1
	const { year, month } = monthBoundsFromNow(offset)
	const pattern = monthPattern(month, year)
	// получаем суммарно доходы и расходы за этот месяц
	db.get(`SELECT SUM(amount) as total FROM incomes WHERE date LIKE ?`, [pattern], (err, incRow) => {
		if (err) { ctx.reply('❌ Ошибка получения доходов'); return }
		db.get(`SELECT SUM(amount) as total FROM expenses WHERE date LIKE ?`, [pattern], (err2, expRow) => {
			if (err2) { ctx.reply('❌ Ошибка получения расходов'); return }
			const inc = parseFloat(incRow && incRow.total) || 0
			const exp = parseFloat(expRow && expRow.total) || 0
			const bal = inc - exp
			const title = ctx.message.text === '📅 Текущий месяц' ? 'Текущий месяц' : 'Прошлый месяц'
			let resp = `📊 <b>Баланс — ${title} (${String(month).padStart(2,'0')}.${year}):</b>\n\n`
			resp += `📤 Доходы: ${formatAmount(inc)} руб.\n`
			resp += `📥 Расходы: ${formatAmount(exp)} руб.\n`
			resp += `💰 Баланс: ${formatAmount(bal)} руб.\n\n`
			resp += `Хотите график (по дням) или экспорт CSV?`
			ctx.reply(resp, Markup.keyboard([['📈 Показать график'], ['🔙 Назад']], { resize_keyboard: true }))
			// сохраняем в сессию выбранный месяц для экспорта/графика
			ctx.session = ctx.session || {}
			ctx.session.last_selected_month = { month, year }
		})
	})
})

// Показать график (используем QuickChart)
bot.hears('📈 Показать график', ctx => {
	// берём месяц из сессии или текущий
	const sel = (ctx.session && ctx.session.last_selected_month) || monthBoundsFromNow(0)
	const month = sel.month
	const year = sel.year
	const pattern = monthPattern(month, year)

	// собираем дневные суммы
	db.all(`SELECT date, amount FROM incomes WHERE date LIKE ?`, [pattern], (err, incRows) => {
		if (err) { ctx.reply('❌ Ошибка получения доходов'); return }
		db.all(`SELECT date, amount FROM expenses WHERE date LIKE ?`, [pattern], (err2, expRows) => {
			if (err2) { ctx.reply('❌ Ошибка получения расходов'); return }

			// prepare arrays for days
			const daysInMonth = new Date(year, month, 0).getDate()
			const labels = []
			for (let d = 1; d <= daysInMonth; d++) labels.push(String(d))

			const incByDay = Array(daysInMonth).fill(0)
			const expByDay = Array(daysInMonth).fill(0)

			;(incRows || []).forEach(r => {
				const parsed = parseDateDDMMYYYY(r.date)
				if (!parsed) return
				const day = parsed.day
				if (parsed.month !== month || parsed.year !== year) return
				incByDay[day - 1] += parseFloat(r.amount) || 0
			})
			;(expRows || []).forEach(r => {
				const parsed = parseDateDDMMYYYY(r.date)
				if (!parsed) return
				const day = parsed.day
				if (parsed.month !== month || parsed.year !== year) return
				expByDay[day - 1] += parseFloat(r.amount) || 0
			})

			// build QuickChart URL
			const chartConfig = {
				type: 'line',
				data: {
					labels,
					datasets: [
						{ label: 'Доходы', data: incByDay, fill: false },
						{ label: 'Расходы', data: expByDay, fill: false }
					]
				},
				options: {
					title: { display: true, text: `Доходы и расходы ${String(month).padStart(2,'0')}.${year}` },
					scales: { yAxes: [{ ticks: { beginAtZero: true } }] }
				}
			}
			const qc = 'https://quickchart.io/chart?'
			const url = qc + 'c=' + encodeURIComponent(JSON.stringify(chartConfig)) + '&w=800&h=400'
			ctx.replyWithPhoto({ url })
		})
	})
})

// -------------------- Report (combined) --------------------
bot.hears('📋 Отчёт', ctx => {
	const chatId = ctx.chat.id
	// последние 40 записей из обеих таблиц
	db.all(
		`
    SELECT date, description, amount, who, category, 'expense' as type, id FROM expenses
    UNION ALL
    SELECT date, description, amount, who, category, 'income' as type, id FROM incomes
    ORDER BY date DESC
    LIMIT 40
  `,
		(err, rows) => {
			if (err) {
				bot.telegram.sendMessage(chatId, '❌ Ошибка при получении отчёта')
				return
			}

			if (!rows || rows.length === 0) {
				bot.telegram.sendMessage(chatId, '📋 Пока нет записей для отчёта')
				return
			}

			let response = '📋 <b>Последние записи (смешанные):</b>\n\n'
			let totalInc = 0
			let totalExp = 0

			rows.forEach(row => {
				const icon = row.type === 'income' ? '📤' : '📥'
				response += `${icon} <b>${row.date}</b> | ${row.description} | ${formatAmount(row.amount)} руб. | ${row.who} | ${row.category || 'Прочее'}\n`
				if (row.type === 'income') totalInc += parseFloat(row.amount) || 0
				else totalExp += parseFloat(row.amount) || 0
			})

			const balance = totalInc - totalExp
			response += `\n📊 <b>Итоги по выборке:</b>\n`
			response += `📤 Доходы: ${formatAmount(totalInc)} руб.\n`
			response += `📥 Расходы: ${formatAmount(totalExp)} руб.\n`
			response += `💰 Баланс: ${formatAmount(balance)} руб.`

			// сообщение длинное — разделим
			if (response.length > 4000) {
				const parts = response.match(/[\s\S]{1,4000}/g)
				parts.forEach(p => bot.telegram.sendMessage(chatId, p, { parse_mode: 'HTML' }))
			} else {
				bot.telegram.sendMessage(chatId, response, { parse_mode: 'HTML' })
			}
		}
	)
})

// -------------------- My expenses & incomes (edit/delete) --------------------

bot.hears('✏️ Мои траты', ctx => {
	const chatId = ctx.chat.id
	db.all(
		`SELECT id, date, description, amount, who, category FROM expenses ORDER BY date DESC, id DESC LIMIT 15`,
		(err, rows) => {
			if (err) {
				bot.telegram.sendMessage(chatId, '❌ Ошибка при получении списка трат')
				return
			}
			if (!rows || rows.length === 0) {
				bot.telegram.sendMessage(chatId, '✏️ Пока нет трат для редактирования')
				return
			}
			let response = '✏️ <b>Последние траты:</b>\n\n'
			rows.forEach((r, i) => {
				response += `${i + 1}. <b>${r.date}</b> | ${r.description} | ${formatAmount(r.amount)} руб. | ${r.who} | ${r.category}\n`
			})
			response += '\nНажмите на кнопки ниже для редактирования:'
			const keyboard = rows.map(r => [
				Markup.button.callback(`${r.date} - ${r.description} - ${formatAmount(r.amount)} руб.`, `select_expense_${r.id}`)
			])
			keyboard.push([Markup.button.callback('⬅️ Назад', 'back_to_main')])
			bot.telegram.sendMessage(chatId, response, { parse_mode: 'HTML', ...Markup.inlineKeyboard(keyboard) })
		}
	)
})

bot.hears('🗂️ Мои доходы', ctx => {
	const chatId = ctx.chat.id
	db.all(
		`SELECT id, date, description, amount, who, category FROM incomes ORDER BY date DESC, id DESC LIMIT 15`,
		(err, rows) => {
			if (err) {
				bot.telegram.sendMessage(chatId, '❌ Ошибка при получении списка доходов')
				return
			}
			if (!rows || rows.length === 0) {
				bot.telegram.sendMessage(chatId, '✏️ Пока нет доходов для редактирования')
				return
			}
			let response = '✏️ <b>Последние доходы:</b>\n\n'
			rows.forEach((r, i) => {
				response += `${i + 1}. <b>${r.date}</b> | ${r.description} | ${formatAmount(r.amount)} руб. | ${r.who} | ${r.category}\n`
			})
			response += '\nНажмите на кнопки ниже для редактирования:'
			const keyboard = rows.map(r => [
				Markup.button.callback(`${r.date} - ${r.description} - ${formatAmount(r.amount)} руб.`, `select_income_${r.id}`)
			])
			keyboard.push([Markup.button.callback('⬅️ Назад', 'back_to_main')])
			bot.telegram.sendMessage(chatId, response, { parse_mode: 'HTML', ...Markup.inlineKeyboard(keyboard) })
		}
	)
})

// selectors
bot.action(/select_expense_(\d+)/, ctx => {
	const id = ctx.match[1]
	db.get('SELECT * FROM expenses WHERE id = ?', [id], (err, row) => {
		if (err || !row) { ctx.answerCbQuery('Трата не найдена'); return }
		const resp = `✏️ <b>Редактирование траты:</b>\n\n` +
			`<b>Дата:</b> ${row.date}\n<b>Описание:</b> ${row.description}\n<b>Сумма:</b> ${formatAmount(row.amount)} руб.\n<b>Кто:</b> ${row.who}\n<b>Категория:</b> ${row.category || 'Прочее'}\n\nВыберите действие:`
		ctx.editMessageText(resp, { parse_mode: 'HTML', ...getEditMenu('expense', id) })
	})
})

bot.action(/select_income_(\d+)/, ctx => {
	const id = ctx.match[1]
	db.get('SELECT * FROM incomes WHERE id = ?', [id], (err, row) => {
		if (err || !row) { ctx.answerCbQuery('Доход не найден'); return }
		const resp = `✏️ <b>Редактирование дохода:</b>\n\n` +
			`<b>Дата:</b> ${row.date}\n<b>Описание:</b> ${row.description}\n<b>Сумма:</b> ${formatAmount(row.amount)} руб.\n<b>Кто:</b> ${row.who}\n<b>Категория:</b> ${row.category || 'Прочее'}\n\nВыберите действие:`
		ctx.editMessageText(resp, { parse_mode: 'HTML', ...getEditMenu('income', id) })
	})
})

// edit handlers
bot.action(/edit_(expense|income)_(\d+)/, ctx => {
	const type = ctx.match[1]
	const id = ctx.match[2]
	ctx.answerCbQuery()
	ctx.session = ctx.session || {}
	ctx.session.editing = { type, id }
	ctx.session.mode = null
	ctx.reply(
		`Введите новые данные в формате:\n\n<code>Дата | Описание | Сумма | Кто | Категория (опционально)</code>\n\nПример:\n<code>27.12.2023 | Xbox Series X | 35000,50 | Я | Техника</code>\n\n💡 Текущая запись будет заменена`,
		{ parse_mode: 'HTML', ...Markup.removeKeyboard() }
	)
})

bot.action(/delete_(expense|income)_(\d+)/, ctx => {
	const type = ctx.match[1]
	const id = ctx.match[2]
	const table = type === 'expense' ? 'expenses' : 'incomes'
	db.run(`DELETE FROM ${table} WHERE id = ?`, [id], function (err) {
		if (err) { ctx.answerCbQuery('Ошибка при удалении'); return }
		if (this.changes > 0) {
			ctx.answerCbQuery('✅ Запись удалена')
			ctx.editMessageText('✅ Запись успешно удалена!', { ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад к списку', 'back_to_list')]]) })
		} else {
			ctx.answerCbQuery('Запись не найдена')
		}
	})
})

bot.action('back_to_list', ctx => {
	ctx.answerCbQuery()
	const message = { text: '✏️ Мои траты', chat: ctx.chat, from: ctx.from }
	const update = { message }
	bot.handleUpdate(update)
})

bot.action('back_to_main', ctx => {
	ctx.answerCbQuery()
	ctx.deleteMessage().catch(()=>{})
	ctx.session = {}
	bot.telegram.sendMessage(ctx.chat.id, 'Выберите действие:', getMainMenu())
})

// -------------------- Text input handling --------------------

bot.on('text', ctx => {
	const text = ctx.message.text
	// skip control buttons
	const skip = [
		'📊 Статистика','📋 Отчёт','💸 Добавить трату','✏️ Мои траты','🔄 Сбросить меню',
		'💰 Добавить доход','✏️ Мои траты','🗂️ Мои доходы','📈 Баланс',
		'📅 Текущий месяц','📅 Прошлый месяц','📈 Показать график',
		'🗑️ Очистить прошлый месяц','🔙 Назад','🔄 Сбросить меню'
	]
	if (skip.includes(text)) return

	ctx.session = ctx.session || {}

	// if editing (expense or income)
	if (ctx.session.editing && ctx.session.editing.type && ctx.session.editing.id) {
		const { type, id } = ctx.session.editing
		if (!text.includes('|')) {
			ctx.reply('❌ Неверный формат. Используйте: Дата | Описание | Сумма | Кто | Категория (опционально)')
			return
		}
		const parts = text.split('|').map(p => p.trim())
		if (parts.length < 4) {
			ctx.reply('❌ Недостаточно полей. Нужны: Дата | Описание | Сумма | Кто')
			return
		}
		const [date, desc, amount, who] = parts
		const category = parts[4] || 'Прочее'
		const amountNum = parseAmount(amount)
		if (isNaN(amountNum) || amountNum <= 0) {
			ctx.reply('❌ Сумма должна быть положительным числом')
			return
		}
		const table = type === 'expense' ? 'expenses' : 'incomes'
		db.run(`UPDATE ${table} SET date = ?, description = ?, amount = ?, who = ?, category = ? WHERE id = ?`,
			[date, desc, amountNum, who, category, id],
			(err) => {
				if (err) ctx.reply('❌ Ошибка обновления: ' + err.message)
				else {
					ctx.reply(`✅ Запись обновлена!\n${date} | ${desc} | ${formatAmount(amountNum)} | ${who} | ${category}`)
					ctx.session.editing = null
				}
			})
		return
	}

	// normal adding flow
	if (text.includes('|')) {
		const parts = text.split('|').map(p => p.trim())
		if (parts.length < 4) {
			ctx.reply('❌ Неверный формат. Используйте: Дата | На что | Сумма | Кто | (Категория опционально)')
			return
		}
		const [date, desc, amount, who] = parts
		const category = parts[4] || 'Прочее'
		const amountNum = parseAmount(amount)
		if (isNaN(amountNum) || amountNum <= 0) {
			ctx.reply('❌ Сумма должна быть положительным числом (можно использовать запятые или точки для копеек)')
			return
		}
		// mode decides income vs expense
		const mode = ctx.session.mode || 'expense' // default expense if not set
		if (mode === 'income') {
			db.run('INSERT INTO incomes (date, description, amount, who, category) VALUES (?, ?, ?, ?, ?)',
				[date, desc, amountNum, who, category],
				(err) => {
					if (err) ctx.reply('❌ Ошибка сохранения: ' + err.message)
					else {
						ctx.reply(`✅ Доход добавлен!\n${date} | ${desc} | ${formatAmount(amountNum)} | ${who} | ${category}`)
						ctx.session.mode = null
					}
				})
		} else {
			db.run('INSERT INTO expenses (date, description, amount, who, category) VALUES (?, ?, ?, ?, ?)',
				[date, desc, amountNum, who, category],
				(err) => {
					if (err) ctx.reply('❌ Ошибка сохранения: ' + err.message)
					else {
						ctx.reply(`✅ Трата добавлена!\n${date} | ${desc} | ${formatAmount(amountNum)} | ${who} | ${category}`)
						ctx.session.mode = null
					}
				})
		}
	}
})

// -------------------- Manual cleanup previous month --------------------

bot.hears('🗑️ Очистить прошлый месяц', ctx => {
	const now = new Date()
	let prevMonth = now.getMonth() // 0..11 current
	let prevYear = now.getFullYear()
	prevMonth = prevMonth // current month index
	prevMonth -= 1
	if (prevMonth < 0) { prevMonth = 11; prevYear -= 1 }
	const mStr = String(prevMonth + 1).padStart(2, '0')
	const pat = '%.' + mStr + '.' + prevYear
	db.run('DELETE FROM expenses WHERE date LIKE ?', [pat], function(err) {
		if (err) { ctx.reply('❌ Ошибка при удалении расходов'); console.error(err); return }
		const expDeleted = this.changes
		db.run('DELETE FROM incomes WHERE date LIKE ?', [pat], function(err2) {
			if (err2) { ctx.reply('❌ Ошибка при удалении доходов'); console.error(err2); return }
			const incDeleted = this.changes
			ctx.reply(`✅ Удалены записи за ${mStr}.${prevYear}\nРасходов: ${expDeleted}\nДоходов: ${incDeleted}`)
		})
	})
})

// Обработчик для кнопки "Назад", которая может появляться в разных контекстах
bot.hears('🔙 Назад', ctx => {
  ctx.session = {}
  ctx.deleteMessage().catch(()=>{}) // удаляем текущее сообщение, если возможно
  ctx.reply('Выберите действие:', getMainMenu())
})

// Добавляем обработчик для inline-кнопки "Назад", если она есть (например, в edit menu)
bot.action('back_to_main', ctx => {
  ctx.answerCbQuery() // подтверждаем нажатие
  ctx.session = {}
  ctx.deleteMessage().catch(()=>{}) // удаляем предыдущее сообщение с inline-кнопками
  ctx.reply('Выберите действие:', getMainMenu())
})

// -------------------- Catch & launch --------------------

bot.catch((err, ctx) => {
	console.error('Error for', ctx.updateType, err)
})

bot.launch().then(() => {
	console.log('✅ Бот запущен (enhanced)!')
	console.log('✅ Разрешены пользователи:', ALLOWED_USERS)
}).catch(e => {
	console.error('❌ Ошибка запуска бота:', e)
})

// graceful shutdown
process.once('SIGINT', () => {
	db.close()
	bot.stop('SIGINT')
})
process.once('SIGTERM', () => {
	db.close()
	bot.stop('SIGTERM')
})