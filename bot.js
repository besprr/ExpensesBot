// finance-bot-enhanced.js
const { Telegraf, Markup, session } = require('telegraf')
const sqlite3 = require('sqlite3').verbose()
require('dotenv').config()

const bot = new Telegraf(process.env.BOT_TOKEN)
bot.use(session()) // обеспечиваем persist ctx.session
const db = new sqlite3.Database('./finance.db')

const ALLOWED_USERS = [586995184, 1319991227]

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
		[Markup.button.callback('⬅️ Назад к списку', 'back_to_list')],
	])
}

function ensureCategoryColumn(table, cb) {
	db.all(`PRAGMA table_info(${table})`, (err, cols) => {
		if (err) return cb && cb(err)
		const hasCategory = cols.some(c => c.name === 'category')
		if (!hasCategory) {
			db.run(
				`ALTER TABLE ${table} ADD COLUMN category TEXT DEFAULT 'Прочее'`,
				cb
			)
		} else {
			cb && cb(null)
		}
	})
}

// -------------------- Menu history helper --------------------

// Показывает меню и сохраняет его в стек истории
function showMenu(ctx, menuButtons, message = 'Выберите действие:') {
	ctx.session = ctx.session || {}
	ctx.session.menuHistory = ctx.session.menuHistory || []
	ctx.session.menuHistory.push(menuButtons)
	return ctx.telegram.sendMessage(ctx.chat.id, message, menuButtons)
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

	ensureCategoryColumn('expenses', e => {
		if (e) console.error('Ошибка добавления category в expenses', e)
	})
	ensureCategoryColumn('incomes', e => {
		if (e) console.error('Ошибка добавления category в incomes', e)
	})
})

// -------------------- Auto cleanup previous month (5th day) --------------------

function cleanupPreviousMonthIfNeeded() {
	try {
		const now = new Date()
		if (now.getDate() !== 5) return
		let year = now.getFullYear()
		let month = now.getMonth()
		let prevMonthIndex = month - 1
		let prevYear = year
		if (prevMonthIndex < 0) {
			prevMonthIndex = 11
			prevYear = year - 1
		}
		const mStr = String(prevMonthIndex + 1).padStart(2, '0')
		const pattern = '%.' + mStr + '.' + prevYear
		db.run('DELETE FROM expenses WHERE date LIKE ?', [pattern], function (err) {
			if (err)
				console.error('Ошибка удаления расходов предыдущего месяца:', err)
			else
				console.log(
					`✅ Удалены расходы за ${mStr}.${prevYear}, строк: ${this.changes}`
				)
		})
		db.run('DELETE FROM incomes WHERE date LIKE ?', [pattern], function (err) {
			if (err) console.error('Ошибка удаления доходов предыдущего месяца:', err)
			else
				console.log(
					`✅ Удалены доходы за ${mStr}.${prevYear}, строк: ${this.changes}`
				)
		})
	} catch (e) {
		console.error('Ошибка в cleanupPreviousMonthIfNeeded', e)
	}
}

cleanupPreviousMonthIfNeeded()
setInterval(cleanupPreviousMonthIfNeeded, 24 * 60 * 60 * 1000)

// -------------------- Bot handlers --------------------

bot.start(ctx => {
	ctx.session = ctx.session || {}
	ctx.session.mode = null
	ctx.session.editing = null
	ctx.session.menuHistory = []

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
	ctx.session.menuHistory.push(getMainMenu())
})

bot.hears('🔄 Сбросить меню', ctx => {
	ctx.session = {}
	ctx.reply('Меню сброшено. Используйте /start для показа кнопок.')
})

// Добавить трату
bot.hears('💸 Добавить трату', ctx => {
	ctx.session.mode = 'expense'
	ctx.session.editing = null
	ctx.reply(
		'Введите трату в формате:\n\n' +
			'📅 <b>Дата(ДД.MM.YYYY)</b> | 🛍️ <b>На что</b> | 💰 <b>Сумма</b> | 👤 <b>Кто</b> | <i>Категория (опционально)</i>\n\n' +
			'Примеры:\n<code>25.12.2023 | Xbox | 30000.50 | Я | Развлечения</code>\n' +
			'<code>26.12.2023 | Продукты | 2500,75 | Девушка</code>\n\n' +
			'💡 Можно использовать точки или запятые для копеек',
		{ parse_mode: 'HTML' }
	)
})

// Добавить доход
bot.hears('💰 Добавить доход', ctx => {
	ctx.session.mode = 'income'
	ctx.session.editing = null
	ctx.reply(
		'Введите доход в формате:\n\n' +
			'📅 <b>Дата(ДД.MM.YYYY)</b> | 📝 <b>Описание</b> | 💰 <b>Сумма</b> | 👤 <b>Кто</b> | <i>Категория (опционально)</i>\n\n' +
			'Пример:\n<code>05.12.2023 | Зарплата | 50000 | Я | Зарплата</code>\n\n' +
			'💡 Можно использовать точки или запятые для копеек',
		{ parse_mode: 'HTML' }
	)
})

// -------------------- Баланс --------------------

bot.hears('📈 Баланс', ctx => {
	showMenu(
		ctx,
		Markup.keyboard([['📅 Текущий месяц', '📅 Прошлый месяц'], ['🔙 Назад']], {
			resize_keyboard: true,
		})
	)
})

function monthPattern(monthIndex, year) {
	const m = String(monthIndex).padStart(2, '0')
	return '%.' + m + '.' + year
}

function monthBoundsFromNow(offsetMonths = 0) {
	const now = new Date()
	now.setMonth(now.getMonth() + offsetMonths)
	return { year: now.getFullYear(), month: now.getMonth() + 1 }
}

// Текущий/Прошлый месяц
bot.hears(['📅 Текущий месяц', '📅 Прошлый месяц'], ctx => {
	let offset = ctx.message.text === '📅 Прошлый месяц' ? -1 : 0
	const { year, month } = monthBoundsFromNow(offset)
	const pattern = monthPattern(month, year)

	db.get(
		`SELECT SUM(amount) as total FROM incomes WHERE date LIKE ?`,
		[pattern],
		(err, incRow) => {
			if (err) return ctx.reply('❌ Ошибка получения доходов')
			db.get(
				`SELECT SUM(amount) as total FROM expenses WHERE date LIKE ?`,
				[pattern],
				(err2, expRow) => {
					if (err2) return ctx.reply('❌ Ошибка получения расходов')
					const inc = parseFloat(incRow?.total) || 0
					const exp = parseFloat(expRow?.total) || 0
					const bal = inc - exp
					const title =
						ctx.message.text === '📅 Текущий месяц'
							? 'Текущий месяц'
							: 'Прошлый месяц'
					let resp = `📊 <b>Баланс — ${title} (${String(month).padStart(
						2,
						'0'
					)}.${year}):</b>\n\n`
					resp += `📤 Доходы: ${formatAmount(inc)} руб.\n`
					resp += `📥 Расходы: ${formatAmount(exp)} руб.\n`
					resp += `💰 Баланс: ${formatAmount(bal)} руб.\n\n`
					resp += `Хотите график (по дням) или экспорт CSV?`

					showMenu(
						ctx,
						Markup.keyboard([['📈 Показать график'], ['🔙 Назад']], {
							resize_keyboard: true,
							parse_mode: 'HTML',
						}),
						resp
					)
					ctx.session.last_selected_month = { month, year }
				}
			)
		}
	)
})

// Показать график (QuickChart)
bot.hears('📈 Показать график', ctx => {
	const sel = ctx.session?.last_selected_month || monthBoundsFromNow(0)
	const month = sel.month
	const year = sel.year
	const pattern = monthPattern(month, year)

	db.all(
		`SELECT date, amount FROM incomes WHERE date LIKE ?`,
		[pattern],
		(err, incRows) => {
			if (err) return ctx.reply('❌ Ошибка получения доходов')
			db.all(
				`SELECT date, amount FROM expenses WHERE date LIKE ?`,
				[pattern],
				(err2, expRows) => {
					if (err2) return ctx.reply('❌ Ошибка получения расходов')

					const daysInMonth = new Date(year, month, 0).getDate()
					const labels = Array.from({ length: daysInMonth }, (_, i) =>
						String(i + 1)
					)
					const incByDay = Array(daysInMonth).fill(0)
					const expByDay = Array(daysInMonth).fill(0)

					;(incRows || []).forEach(r => {
						const [d, m, y] = r.date.split('.').map(Number)
						if (m !== month || y !== year) return
						incByDay[d - 1] += parseFloat(r.amount) || 0
					})
					;(expRows || []).forEach(r => {
						const [d, m, y] = r.date.split('.').map(Number)
						if (m !== month || y !== year) return
						expByDay[d - 1] += parseFloat(r.amount) || 0
					})

					const chartConfig = {
						type: 'line',
						data: {
							labels,
							datasets: [
								{ label: 'Доходы', data: incByDay, fill: false },
								{ label: 'Расходы', data: expByDay, fill: false },
							],
						},
						options: {
							title: {
								display: true,
								text: `Доходы и расходы ${String(month).padStart(
									2,
									'0'
								)}.${year}`,
							},
						},
					}
					const url =
						'https://quickchart.io/chart?c=' +
						encodeURIComponent(JSON.stringify(chartConfig)) +
						'&w=800&h=400'
					ctx.replyWithPhoto({ url })
				}
			)
		}
	)
})

// -------------------- Button "Назад" --------------------

bot.hears('🔙 Назад', ctx => {
	ctx.session = ctx.session || {}
	const history = ctx.session.menuHistory || []
	if (history.length > 1) {
		history.pop() // текущий
		const prevMenu = history[history.length - 1]
		ctx.telegram.sendMessage(
			ctx.chat.id,
			'Вернулись в предыдущее меню:',
			prevMenu
		)
	} else {
		ctx.telegram.sendMessage(ctx.chat.id, 'Выберите действие:', getMainMenu())
	}
})
bot.hears('🔄 Сбросить меню', ctx => {
	ctx.session = {}
	ctx.reply('Меню сброшено. Используйте /start для показа кнопок.')
})

// -------------------- Остальной код бота (добавление, отчёты, редактирование) --------------------
// Здесь оставляем все существующие хэндлеры для добавления трат/доходов, отчётов и редактирования без изменений,
// но клавиатуры заменяем на showMenu там, где они меняют текущее меню.
// Т.е. везде ctx.reply(..., Markup.keyboard([...])) → showMenu(ctx, Markup.keyboard([...]), 'Текст')

// -------------------- Catch & launch --------------------

bot.catch((err, ctx) => {
	console.error('Error for', ctx.updateType, err)
})

bot
	.launch()
	.then(() => {
		console.log('✅ Бот запущен (enhanced)!')
		console.log('✅ Разрешены пользователи:', ALLOWED_USERS)
	})
	.catch(e => {
		console.error('❌ Ошибка запуска бота:', e)
	})

process.once('SIGINT', () => {
	db.close()
	bot.stop('SIGINT')
})
process.once('SIGTERM', () => {
	db.close()
	bot.stop('SIGTERM')
})
