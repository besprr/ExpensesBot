const { Telegraf, Markup } = require('telegraf')
const sqlite3 = require('sqlite3').verbose()
const path = require('path')
require('dotenv').config()

const bot = new Telegraf(process.env.BOT_TOKEN)
const db = new sqlite3.Database('./finance.db')

const ALLOWED_USERS = [586995184, 1319991227]

function isUserAllowed(ctx) {
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
})

function parseAmount(amountStr) {
	const cleaned = amountStr.replace(',', '.').replace(/\s/g, '')
	return parseFloat(cleaned)
}

function formatAmount(amount) {
	return parseFloat(amount).toFixed(2)
}

function getMainMenu() {
	return Markup.keyboard([
		['📊 Статистика', '📋 Отчёт'],
		['💸 Добавить трату', '✏️ Мои траты'],
		['🔄 Сбросить меню'],
	]).resize()
}

function getEditMenu(expenseId) {
	return Markup.inlineKeyboard([
		[
			Markup.button.callback('✏️ Изменить', `edit_${expenseId}`),
			Markup.button.callback('❌ Удалить', `delete_${expenseId}`),
		],
		[Markup.button.callback('⬅️ Назад к списку', 'back_to_list')],
	])
}

bot.start(ctx => {
	const userName = ctx.from.first_name || 'Пользователь'

	ctx.reply(
		`💰 Привет, ${userName}!\n\n` +
			'Это приватный бот для учета наших расходов.\n\n' +
			'Выберите действие:',
		getMainMenu()
	)
})

bot.hears('🔄 Сбросить меню', ctx => {
	ctx.reply('Меню сброшено. Используйте /start для показа кнопок.')
})

bot.hears('💸 Добавить трату', ctx => {
	ctx.reply(
		'Введите трату в формате:\n\n' +
			'📅 <b>Дата(ДД.ММ.ГГГГ)</b> | 🛍️ <b>На что</b> | 💰 <b>Сумма</b> | 👤 <b>Кто</b>\n\n' +
			'Пример:\n' +
			'<code>25.12.2023 | Xbox | 30000.50 | Я</code>\n' +
			'<code>26.12.2023 | Продукты | 2500,75 | Девушка</code>\n\n' +
			'💡 <i>Можно использовать точки или запятые для копеек</i>',
		{ parse_mode: 'HTML' }
	)
})

bot.hears('📊 Статистика', ctx => {
	const chatId = ctx.chat.id

	db.all(
		`
    SELECT who, SUM(amount) as total, COUNT(*) as count 
    FROM expenses 
    GROUP BY who
  `,
		(err, rows) => {
			if (err) {
				bot.telegram.sendMessage(chatId, '❌ Ошибка при получении статистики')
				return
			}

			if (!rows || rows.length === 0) {
				bot.telegram.sendMessage(chatId, '📊 Пока нет данных о тратах')
				return
			}

			let totalAll = 0
			let countAll = 0
			let response = '📊 <b>Общая статистика:</b>\n\n'

			rows.forEach(row => {
				response += `<b>${row.who}:</b> ${formatAmount(row.total)} руб. (${
					row.count
				} трат)\n`
				totalAll += row.total
				countAll += row.count
			})

			response += `\n💵 <b>Всего:</b> ${formatAmount(
				totalAll
			)} руб. (${countAll} трат)`
			bot.telegram.sendMessage(chatId, response, { parse_mode: 'HTML' })
		}
	)
})

bot.hears('📋 Отчёт', ctx => {
	const chatId = ctx.chat.id

	db.all(
		`
    SELECT id, date, description, amount, who 
    FROM expenses 
    ORDER BY date DESC, id DESC
    LIMIT 30
  `,
		(err, rows) => {
			if (err) {
				bot.telegram.sendMessage(chatId, '❌ Ошибка при получении отчёта')
				return
			}

			if (!rows || rows.length === 0) {
				bot.telegram.sendMessage(chatId, '📋 Пока нет трат для отчёта')
				return
			}

			let response = '📋 <b>Последние траты:</b>\n\n'
			let total = 0

			rows.forEach(row => {
				response += `<b>${row.date}</b> | ${row.description} | ${formatAmount(
					row.amount
				)} руб. | ${row.who}\n`
				total += row.amount
			})

			response += `\n💵 <b>Итого:</b> ${formatAmount(total)} руб.`

			if (response.length > 4000) {
				const parts = response.match(/[\s\S]{1,4000}/g)
				parts.forEach(part =>
					bot.telegram.sendMessage(chatId, part, { parse_mode: 'HTML' })
				)
			} else {
				bot.telegram.sendMessage(chatId, response, { parse_mode: 'HTML' })
			}
		}
	)
})

bot.hears('✏️ Мои траты', ctx => {
	const chatId = ctx.chat.id

	db.all(
		`
    SELECT id, date, description, amount, who 
    FROM expenses 
    ORDER BY date DESC, id DESC
    LIMIT 10
  `,
		(err, rows) => {
			if (err) {
				bot.telegram.sendMessage(chatId, '❌ Ошибка при получении списка трат')
				return
			}

			if (!rows || rows.length === 0) {
				bot.telegram.sendMessage(chatId, '✏️ Пока нет трат для редактирования')
				return
			}

			let response = '✏️ <b>Последние траты (для редактирования):</b>\n\n'

			rows.forEach((row, index) => {
				response += `${index + 1}. <b>${row.date}</b> | ${
					row.description
				} | ${formatAmount(row.amount)} руб. | ${row.who}\n`
			})

			response += '\nНажмите на кнопки ниже для редактирования:'

			const keyboard = rows.map(row => [
				Markup.button.callback(
					`${row.date} - ${row.description} - ${formatAmount(row.amount)} руб.`,
					`select_${row.id}`
				),
			])

			keyboard.push([Markup.button.callback('⬅️ Назад', 'back_to_main')])

			bot.telegram.sendMessage(chatId, response, {
				parse_mode: 'HTML',
				...Markup.inlineKeyboard(keyboard),
			})
		}
	)
})

bot.action(/select_(\d+)/, ctx => {
	const expenseId = ctx.match[1]

	db.get('SELECT * FROM expenses WHERE id = ?', [expenseId], (err, row) => {
		if (err || !row) {
			ctx.answerCbQuery('Трата не найдена')
			return
		}

		const response =
			`✏️ <b>Редактирование траты:</b>\n\n` +
			`<b>Дата:</b> ${row.date}\n` +
			`<b>Описание:</b> ${row.description}\n` +
			`<b>Сумма:</b> ${formatAmount(row.amount)} руб.\n` +
			`<b>Кто:</b> ${row.who}\n\n` +
			`Выберите действие:`

		ctx.editMessageText(response, {
			parse_mode: 'HTML',
			...getEditMenu(expenseId),
		})
	})
})

bot.action(/edit_(\d+)/, ctx => {
	const expenseId = ctx.match[1]
	ctx.answerCbQuery()

	ctx.reply(
		`Введите новые данные в формате:\n\n` +
			`<code>Дата | На что | Сумма | Кто</code>\n\n` +
			`Пример:\n` +
			`<code>27.12.2023 | Xbox Series X | 35000,50 | Я</code>\n\n` +
			`💡 <i>Текущая трата будет заменена</i>`,
		{
			parse_mode: 'HTML',
			...Markup.removeKeyboard(),
		}
	)

	ctx.session = ctx.session || {}
	ctx.session.editingExpenseId = expenseId
})

bot.action(/delete_(\d+)/, async ctx => {
	const expenseId = ctx.match[1]

	db.run('DELETE FROM expenses WHERE id = ?', [expenseId], function (err) {
		if (err) {
			ctx.answerCbQuery('Ошибка при удалении')
			return
		}

		if (this.changes > 0) {
			ctx.answerCbQuery('✅ Трата удалена')
			ctx.editMessageText('✅ Трата успешно удалена!', {
				...Markup.inlineKeyboard([
					[Markup.button.callback('⬅️ Назад к списку', 'back_to_list')],
				]),
			})
		} else {
			ctx.answerCbQuery('Трата не найдена')
		}
	})
})

bot.action('back_to_list', ctx => {
	ctx.answerCbQuery()
	const message = {
		text: '✏️ Мои траты',
		chat: ctx.chat,
		from: ctx.from,
	}
	const update = { message }
	bot.handleUpdate(update)
})

bot.action('back_to_main', ctx => {
	ctx.answerCbQuery()
	ctx.deleteMessage()
	bot.telegram.sendMessage(ctx.chat.id, 'Выберите действие:', getMainMenu())
})

bot.on('text', ctx => {
	const text = ctx.message.text

	if (
		[
			'📊 Статистика',
			'📋 Отчёт',
			'💸 Добавить трату',
			'✏️ Мои траты',
			'🔄 Сбросить меню',
		].includes(text)
	) {
		return
	}

	if (ctx.session && ctx.session.editingExpenseId) {
		const expenseId = ctx.session.editingExpenseId

		if (text.includes('|')) {
			const parts = text.split('|').map(p => p.trim())
			if (parts.length === 4) {
				const [date, desc, amount, who] = parts
				const amountNum = parseAmount(amount)

				if (!isNaN(amountNum) && amountNum > 0) {
					db.run(
						'UPDATE expenses SET date = ?, description = ?, amount = ?, who = ? WHERE id = ?',
						[date, desc, amountNum, who, expenseId],
						err => {
							if (err) {
								ctx.reply('❌ Ошибка обновления: ' + err.message)
							} else {
								ctx.reply(
									`✅ Трата обновлена!\n${date} | ${desc} | ${formatAmount(
										amountNum
									)} | ${who}`
								)
								delete ctx.session.editingExpenseId
							}
						}
					)
					return
				} else {
					ctx.reply('❌ Сумма должна быть положительным числом')
				}
			}
		}

		ctx.reply('❌ Неверный формат. Используйте: Дата | На что | Сумма | Кто')
		return
	}

	if (text.includes('|')) {
		const parts = text.split('|').map(p => p.trim())
		if (parts.length === 4) {
			const [date, desc, amount, who] = parts
			const amountNum = parseAmount(amount)

			if (!isNaN(amountNum) && amountNum > 0) {
				db.run(
					'INSERT INTO expenses (date, description, amount, who) VALUES (?, ?, ?, ?)',
					[date, desc, amountNum, who],
					err => {
						if (err) {
							ctx.reply('❌ Ошибка сохранения: ' + err.message)
						} else {
							ctx.reply(
								`✅ Трата добавлена!\n${date} | ${desc} | ${formatAmount(
									amountNum
								)} | ${who}`
							)
						}
					}
				)
			} else {
				ctx.reply(
					'❌ Сумма должна быть положительным числом (можно использовать запятые или точки для копеек)'
				)
			}
		} else {
			ctx.reply('❌ Неверный формат. Используйте: Дата | На что | Сумма | Кто')
		}
	}
})

bot.catch((err, ctx) => {
	console.error('Error for', ctx.updateType, err)
})

bot.launch()
console.log('✅ Бот запущен с приватностью!')
console.log('✅ Разрешены пользователи:', ALLOWED_USERS)

process.once('SIGINT', () => {
	db.close()
	bot.stop('SIGINT')
})
process.once('SIGTERM', () => {
	db.close()
	bot.stop('SIGTERM')
})
