const { Telegraf, Markup } = require('telegraf')
const sqlite3 = require('sqlite3').verbose()
const path = require('path')
require('dotenv').config()

const bot = new Telegraf(process.env.BOT_TOKEN)
const db = new sqlite3.Database('./finance.db')

const ALLOWED_USERS = [586995184, 1319991227]

// Категории расходов (можно расширять)
const EXPENSE_CATEGORIES = [
	'🍔 Еда',
	'🚗 Транспорт',
	'🏠 Жилье',
	'🛍️ Покупки',
	'💊 Здоровье',
	'🎬 Развлечения',
	'💼 Бизнес',
	'📚 Образование',
	'📱 Техника',
	'🎁 Подарки',
	'✈️ Путешествия',
	'💵 Прочее',
]

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
				'Это приватный бот для учета финансов. ' +
				'Если вы должны иметь доступ, обратитесь к администратору.'
		)
		return
	}
	return next()
})

// Инициализация базы данных
db.serialize(() => {
	// Таблица расходов
	db.run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT NOT NULL,
      who TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

	// Таблица доходов
	db.run(`
    CREATE TABLE IF NOT EXISTS incomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      who TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `)

	// Таблица для автоудаления
	db.run(`
    CREATE TABLE IF NOT EXISTS cleanup_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cleaned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      month INTEGER,
      year INTEGER,
      expenses_count INTEGER,
      incomes_count INTEGER
    )
  `)
})

function parseAmount(amountStr) {
	const cleaned = amountStr.replace(',', '.').replace(/\s/g, '')
	return parseFloat(cleaned)
}

function formatAmount(amount) {
	return parseFloat(amount)
		.toFixed(2)
		.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function getMainMenu() {
	return Markup.keyboard([
		['📊 Статистика', '📋 Отчёт'],
		['💸 Добавить расход', '💰 Добавить доход'],
		['✏️ Мои операции', '🗑️ Удалить старые'],
		['🔄 Сбросить меню'],
	]).resize()
}

function getExpenseCategoryKeyboard() {
	const buttons = []
	for (let i = 0; i < EXPENSE_CATEGORIES.length; i += 3) {
		buttons.push(EXPENSE_CATEGORIES.slice(i, i + 3))
	}
	buttons.push(['⬅️ Назад'])
	return Markup.keyboard(buttons).resize()
}

function getExpenseEditMenu(expenseId) {
	return Markup.inlineKeyboard([
		[
			Markup.button.callback('✏️ Изменить', `edit_expense_${expenseId}`),
			Markup.button.callback('❌ Удалить', `delete_expense_${expenseId}`),
		],
		[Markup.button.callback('⬅️ Назад к списку', 'back_to_list')],
	])
}

function getIncomeEditMenu(incomeId) {
	return Markup.inlineKeyboard([
		[
			Markup.button.callback('✏️ Изменить', `edit_income_${incomeId}`),
			Markup.button.callback('❌ Удалить', `delete_income_${incomeId}`),
		],
		[Markup.button.callback('⬅️ Назад к списку', 'back_to_list')],
	])
}

// Автоудаление данных за предыдущий месяц (вызывать 5 числа каждого месяца)
async function cleanupOldData() {
	const now = new Date()
	const currentMonth = now.getMonth() + 1
	const currentYear = now.getFullYear()

	let deleteMonth = currentMonth - 1
	let deleteYear = currentYear
	if (deleteMonth === 0) {
		deleteMonth = 12
		deleteYear = currentYear - 1
	}

	db.serialize(() => {
		// Удаляем расходы
		db.run(
			`DELETE FROM expenses 
       WHERE strftime('%m', date) = ? 
       AND strftime('%Y', date) = ?`,
			[deleteMonth.toString().padStart(2, '0'), deleteYear],
			function (err) {
				const expensesDeleted = this.changes

				// Удаляем доходы
				db.run(
					`DELETE FROM incomes 
           WHERE strftime('%m', date) = ? 
           AND strftime('%Y', date) = ?`,
					[deleteMonth.toString().padStart(2, '0'), deleteYear],
					function (err) {
						const incomesDeleted = this.changes

						// Логируем удаление
						if (expensesDeleted > 0 || incomesDeleted > 0) {
							db.run(
								`INSERT INTO cleanup_log (month, year, expenses_count, incomes_count) 
                 VALUES (?, ?, ?, ?)`,
								[deleteMonth, deleteYear, expensesDeleted, incomesDeleted]
							)

							console.log(
								`🗑️ Удалены данные за ${deleteMonth}.${deleteYear}: ${expensesDeleted} расходов, ${incomesDeleted} доходов`
							)
						}
					}
				)
			}
		)
	})
}

// Проверяем нужно ли делать автоочистку
function checkAutoCleanup() {
	const now = new Date()
	if (now.getDate() === 5) {
		// 5 число месяца
		cleanupOldData()
	}
}

// Запускаем проверку каждый день в 00:01
setTimeout(() => {
	checkAutoCleanup()
	// Проверяем каждый день
	setInterval(checkAutoCleanup, 24 * 60 * 60 * 1000)
}, 60000)

bot.start(ctx => {
	const userName = ctx.from.first_name || 'Пользователь'

	ctx.reply(
		`💰 Привет, ${userName}!\n\n` +
			'Это приватный бот для учета наших финансов.\n\n' +
			'Выберите действие:',
		getMainMenu()
	)
})

bot.hears('🔄 Сбросить меню', ctx => {
	ctx.reply('Меню сброшено. Используйте /start для показа кнопок.')
})

bot.hears('💸 Добавить расход', ctx => {
	ctx.reply(
		'Введите расход в формате:\n\n' +
			'📅 <b>Дата(ДД.ММ.ГГГГ)</b> | 🛍️ <b>На что</b> | 💰 <b>Сумма</b> | 👤 <b>Кто</b>\n\n' +
			'Пример:\n' +
			'<code>25.12.2023 | Xbox | 30000.50 | Я</code>\n' +
			'<code>26.12.2023 | Продукты | 2500,75 | Девушка</code>\n\n' +
			'После ввода выберите категорию расходов.',
		{ parse_mode: 'HTML' }
	)

	ctx.session = ctx.session || {}
	ctx.session.waitingForExpense = true
})

bot.hears('💰 Добавить доход', ctx => {
	ctx.reply(
		'Введите доход в формате:\n\n' +
			'📅 <b>Дата(ДД.ММ.ГГГГ)</b> | 💼 <b>Источник</b> | 💰 <b>Сумма</b> | 👤 <b>Кто</b>\n\n' +
			'Пример:\n' +
			'<code>25.12.2023 | Зарплата | 85000 | Я</code>\n' +
			'<code>26.12.2023 | Продажа компьютера | 45000 | Девушка</code>\n\n' +
			'💡 <i>Можно использовать точки или запятые для копеек</i>',
		{ parse_mode: 'HTML' }
	)

	ctx.session = ctx.session || {}
	ctx.session.waitingForIncome = true
})

bot.hears('📊 Статистика', async ctx => {
	const chatId = ctx.chat.id

	const now = new Date()
	const currentMonth = now.getMonth() + 1
	const currentYear = now.getFullYear()

	// Получаем статистику за текущий месяц
	db.all(
		`SELECT who, SUM(amount) as total, COUNT(*) as count 
     FROM expenses 
     WHERE strftime('%m', date) = ? 
       AND strftime('%Y', date) = ?
     GROUP BY who`,
		[currentMonth.toString().padStart(2, '0'), currentYear],
		(err, expenseRows) => {
			if (err) {
				bot.telegram.sendMessage(
					chatId,
					'❌ Ошибка при получении статистики расходов'
				)
				return
			}

			db.all(
				`SELECT who, SUM(amount) as total, COUNT(*) as count 
         FROM incomes 
         WHERE strftime('%m', date) = ? 
           AND strftime('%Y', date) = ?
         GROUP BY who`,
				[currentMonth.toString().padStart(2, '0'), currentYear],
				(err, incomeRows) => {
					if (err) {
						bot.telegram.sendMessage(
							chatId,
							'❌ Ошибка при получении статистики доходов'
						)
						return
					}

					// Статистика по категориям
					db.all(
						`SELECT category, SUM(amount) as total 
             FROM expenses 
             WHERE strftime('%m', date) = ? 
               AND strftime('%Y', date) = ?
             GROUP BY category 
             ORDER BY total DESC`,
						[currentMonth.toString().padStart(2, '0'), currentYear],
						(err, categoryRows) => {
							if (err) {
								console.error('Category stat error:', err)
							}

							let response = `📊 <b>Статистика за ${currentMonth}.${currentYear}:</b>\n\n`

							// Доходы
							response += '<b>📈 Доходы:</b>\n'
							let totalIncome = 0
							if (incomeRows && incomeRows.length > 0) {
								incomeRows.forEach(row => {
									response += `${row.who}: ${formatAmount(row.total)} руб. (${
										row.count
									})\n`
									totalIncome += row.total
								})
							} else {
								response += 'Нет данных\n'
							}
							response += `Всего доходов: ${formatAmount(totalIncome)} руб.\n\n`

							// Расходы
							response += '<b>📉 Расходы:</b>\n'
							let totalExpense = 0
							if (expenseRows && expenseRows.length > 0) {
								expenseRows.forEach(row => {
									response += `${row.who}: ${formatAmount(row.total)} руб. (${
										row.count
									})\n`
									totalExpense += row.total
								})
							} else {
								response += 'Нет данных\n'
							}
							response += `Всего расходов: ${formatAmount(
								totalExpense
							)} руб.\n\n`

							// Итог
							const balance = totalIncome - totalExpense
							response += `<b>💰 Итоговый баланс:</b> ${formatAmount(
								balance
							)} руб.\n\n`

							// Категории расходов
							if (categoryRows && categoryRows.length > 0) {
								response += '<b>🏷️ Расходы по категориям:</b>\n'
								categoryRows.forEach(row => {
									const percent =
										totalExpense > 0
											? ((row.total / totalExpense) * 100).toFixed(1)
											: 0
									response += `${row.category}: ${formatAmount(
										row.total
									)} руб. (${percent}%)\n`
								})
							}

							bot.telegram.sendMessage(chatId, response, { parse_mode: 'HTML' })
						}
					)
				}
			)
		}
	)
})

bot.hears('📋 Отчёт', ctx => {
	const chatId = ctx.chat.id

	const now = new Date()
	const currentMonth = now.getMonth() + 1
	const currentYear = now.getFullYear()

	// Получаем все операции за месяц
	db.all(
		`SELECT 
        date, 
        description, 
        amount, 
        'expense' as type,
        category,
        who
     FROM expenses 
     WHERE strftime('%m', date) = ? 
       AND strftime('%Y', date) = ?
     
     UNION ALL
     
     SELECT 
        date, 
        description, 
        amount, 
        'income' as type,
        '' as category,
        who
     FROM incomes 
     WHERE strftime('%m', date) = ? 
       AND strftime('%Y', date) = ?
     
     ORDER BY date DESC, created_at DESC
     LIMIT 50`,
		[
			currentMonth.toString().padStart(2, '0'),
			currentYear,
			currentMonth.toString().padStart(2, '0'),
			currentYear,
		],
		(err, rows) => {
			if (err) {
				bot.telegram.sendMessage(chatId, '❌ Ошибка при получении отчёта')
				return
			}

			if (!rows || rows.length === 0) {
				bot.telegram.sendMessage(chatId, '📋 Пока нет операций для отчёта')
				return
			}

			let response = `📋 <b>Операции за ${currentMonth}.${currentYear}:</b>\n\n`
			let totalIncome = 0
			let totalExpense = 0

			rows.forEach(row => {
				const typeIcon = row.type === 'income' ? '📈' : '📉'
				const category = row.category ? `[${row.category}] ` : ''
				response += `${typeIcon} <b>${row.date}</b> | ${category}${
					row.description
				} | ${formatAmount(row.amount)} руб. | ${row.who}\n`

				if (row.type === 'income') {
					totalIncome += row.amount
				} else {
					totalExpense += row.amount
				}
			})

			response += `\n📈 <b>Итого доходов:</b> ${formatAmount(totalIncome)} руб.`
			response += `\n📉 <b>Итого расходов:</b> ${formatAmount(
				totalExpense
			)} руб.`
			response += `\n💰 <b>Баланс:</b> ${formatAmount(
				totalIncome - totalExpense
			)} руб.`

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

bot.hears('✏️ Мои операции', ctx => {
	ctx.reply(
		'Выберите тип операций для просмотра:',
		Markup.inlineKeyboard([
			[
				Markup.button.callback('📈 Доходы', 'view_incomes'),
				Markup.button.callback('📉 Расходы', 'view_expenses'),
			],
			[Markup.button.callback('📋 Все операции', 'view_all')],
		])
	)
})

bot.hears('🗑️ Удалить старые', ctx => {
	ctx.reply(
		'⚠️ <b>Внимание!</b>\n\n' +
			'Эта операция удалит все данные за предыдущий месяц.\n' +
			'Автоматическое удаление происходит 5 числа каждого месяца.\n\n' +
			'Вы уверены, что хотите удалить данные за предыдущий месяц?',
		{
			parse_mode: 'HTML',
			...Markup.inlineKeyboard([
				[
					Markup.button.callback('✅ Да, удалить', 'force_cleanup'),
					Markup.button.callback('❌ Нет, отмена', 'cancel_cleanup'),
				],
			]),
		}
	)
})

bot.action('view_incomes', ctx => {
	ctx.answerCbQuery()
	showIncomesList(ctx)
})

bot.action('view_expenses', ctx => {
	ctx.answerCbQuery()
	showExpensesList(ctx)
})

bot.action('view_all', ctx => {
	ctx.answerCbQuery()
	showAllOperations(ctx)
})

function showIncomesList(ctx) {
	db.all(
		`SELECT id, date, description, amount, who 
     FROM incomes 
     ORDER BY date DESC, id DESC
     LIMIT 20`,
		(err, rows) => {
			if (err || !rows || rows.length === 0) {
				ctx.editMessageText('📈 Пока нет доходов для редактирования', {
					...Markup.inlineKeyboard([
						[Markup.button.callback('⬅️ Назад', 'back_to_operations')],
					]),
				})
				return
			}

			let response = '📈 <b>Последние доходы:</b>\n\n'
			rows.forEach((row, index) => {
				response += `${index + 1}. <b>${row.date}</b> | ${
					row.description
				} | ${formatAmount(row.amount)} руб. | ${row.who}\n`
			})

			const keyboard = rows.map(row => [
				Markup.button.callback(
					`${row.date} - ${row.description} - ${formatAmount(row.amount)} руб.`,
					`select_income_${row.id}`
				),
			])

			keyboard.push([Markup.button.callback('⬅️ Назад', 'back_to_operations')])

			ctx.editMessageText(response, {
				parse_mode: 'HTML',
				...Markup.inlineKeyboard(keyboard),
			})
		}
	)
}

function showExpensesList(ctx) {
	db.all(
		`SELECT id, date, description, amount, category, who 
     FROM expenses 
     ORDER BY date DESC, id DESC
     LIMIT 20`,
		(err, rows) => {
			if (err || !rows || rows.length === 0) {
				ctx.editMessageText('📉 Пока нет расходов для редактирования', {
					...Markup.inlineKeyboard([
						[Markup.button.callback('⬅️ Назад', 'back_to_operations')],
					]),
				})
				return
			}

			let response = '📉 <b>Последние расходы:</b>\n\n'
			rows.forEach((row, index) => {
				const category = row.category ? `[${row.category}] ` : ''
				response += `${index + 1}. <b>${row.date}</b> | ${category}${
					row.description
				} | ${formatAmount(row.amount)} руб. | ${row.who}\n`
			})

			const keyboard = rows.map(row => [
				Markup.button.callback(
					`${row.date} - ${row.description} - ${formatAmount(row.amount)} руб.`,
					`select_expense_${row.id}`
				),
			])

			keyboard.push([Markup.button.callback('⬅️ Назад', 'back_to_operations')])

			ctx.editMessageText(response, {
				parse_mode: 'HTML',
				...Markup.inlineKeyboard(keyboard),
			})
		}
	)
}

function showAllOperations(ctx) {
	db.all(
		`SELECT 
        id, date, description, amount, 'income' as type, '' as category, who 
     FROM incomes 
     
     UNION ALL
     
     SELECT 
        id, date, description, amount, 'expense' as type, category, who 
     FROM expenses 
     
     ORDER BY date DESC, created_at DESC
     LIMIT 20`,
		(err, rows) => {
			if (err || !rows || rows.length === 0) {
				ctx.editMessageText('📋 Пока нет операций для редактирования', {
					...Markup.inlineKeyboard([
						[Markup.button.callback('⬅️ Назад', 'back_to_operations')],
					]),
				})
				return
			}

			let response = '📋 <b>Последние операции:</b>\n\n'
			rows.forEach((row, index) => {
				const typeIcon = row.type === 'income' ? '📈' : '📉'
				const category = row.category ? `[${row.category}] ` : ''
				response += `${index + 1}. ${typeIcon} <b>${
					row.date
				}</b> | ${category}${row.description} | ${formatAmount(
					row.amount
				)} руб. | ${row.who}\n`
			})

			const keyboard = rows.map(row => {
				const action =
					row.type === 'income' ? 'select_income' : 'select_expense'
				return [
					Markup.button.callback(
						`${row.type === 'income' ? '📈' : '📉'} ${row.date} - ${
							row.description
						}`,
						`${action}_${row.id}`
					),
				]
			})

			keyboard.push([Markup.button.callback('⬅️ Назад', 'back_to_operations')])

			ctx.editMessageText(response, {
				parse_mode: 'HTML',
				...Markup.inlineKeyboard(keyboard),
			})
		}
	)
}

// Обработчики для выбора операций
bot.action(/select_expense_(\d+)/, ctx => {
	const expenseId = ctx.match[1]

	db.get('SELECT * FROM expenses WHERE id = ?', [expenseId], (err, row) => {
		if (err || !row) {
			ctx.answerCbQuery('Расход не найден')
			return
		}

		const response =
			`✏️ <b>Редактирование расхода:</b>\n\n` +
			`📅 <b>Дата:</b> ${row.date}\n` +
			`🛍️ <b>Описание:</b> ${row.description}\n` +
			`💰 <b>Сумма:</b> ${formatAmount(row.amount)} руб.\n` +
			`🏷️ <b>Категория:</b> ${row.category}\n` +
			`👤 <b>Кто:</b> ${row.who}\n\n` +
			`Выберите действие:`

		ctx.editMessageText(response, {
			parse_mode: 'HTML',
			...getExpenseEditMenu(expenseId),
		})
	})
})

bot.action(/select_income_(\d+)/, ctx => {
	const incomeId = ctx.match[1]

	db.get('SELECT * FROM incomes WHERE id = ?', [incomeId], (err, row) => {
		if (err || !row) {
			ctx.answerCbQuery('Доход не найден')
			return
		}

		const response =
			`✏️ <b>Редактирование дохода:</b>\n\n` +
			`📅 <b>Дата:</b> ${row.date}\n` +
			`💼 <b>Источник:</b> ${row.description}\n` +
			`💰 <b>Сумма:</b> ${formatAmount(row.amount)} руб.\n` +
			`👤 <b>Кто:</b> ${row.who}\n\n` +
			`Выберите действие:`

		ctx.editMessageText(response, {
			parse_mode: 'HTML',
			...getIncomeEditMenu(incomeId),
		})
	})
})

// Редактирование расходов
bot.action(/edit_expense_(\d+)/, ctx => {
	const expenseId = ctx.match[1]
	ctx.answerCbQuery()

	ctx.reply(
		`Введите новые данные в формате:\n\n` +
			`<code>Дата | На что | Сумма | Кто</code>\n\n` +
			`Пример:\n` +
			`<code>27.12.2023 | Xbox Series X | 35000,50 | Я</code>\n\n` +
			`После ввода выберите категорию расходов.`,
		{
			parse_mode: 'HTML',
			...Markup.removeKeyboard(),
		}
	)

	ctx.session = ctx.session || {}
	ctx.session.editingExpenseId = expenseId
})

// Редактирование доходов
bot.action(/edit_income_(\d+)/, ctx => {
	const incomeId = ctx.match[1]
	ctx.answerCbQuery()

	ctx.reply(
		`Введите новые данные в формате:\n\n` +
			`<code>Дата | Источник | Сумма | Кто</code>\n\n` +
			`Пример:\n` +
			`<code>27.12.2023 | Зарплата | 85000 | Я</code>`,
		{
			parse_mode: 'HTML',
			...Markup.removeKeyboard(),
		}
	)

	ctx.session = ctx.session || {}
	ctx.session.editingIncomeId = incomeId
})

// Удаление расходов
bot.action(/delete_expense_(\d+)/, async ctx => {
	const expenseId = ctx.match[1]

	db.run('DELETE FROM expenses WHERE id = ?', [expenseId], function (err) {
		if (err) {
			ctx.answerCbQuery('Ошибка при удалении')
			return
		}

		if (this.changes > 0) {
			ctx.answerCbQuery('✅ Расход удален')
			ctx.editMessageText('✅ Расход успешно удален!', {
				...Markup.inlineKeyboard([
					[Markup.button.callback('⬅️ Назад к списку', 'back_to_list')],
				]),
			})
		} else {
			ctx.answerCbQuery('Расход не найден')
		}
	})
})

// Удаление доходов
bot.action(/delete_income_(\d+)/, async ctx => {
	const incomeId = ctx.match[1]

	db.run('DELETE FROM incomes WHERE id = ?', [incomeId], function (err) {
		if (err) {
			ctx.answerCbQuery('Ошибка при удалении')
			return
		}

		if (this.changes > 0) {
			ctx.answerCbQuery('✅ Доход удален')
			ctx.editMessageText('✅ Доход успешно удален!', {
				...Markup.inlineKeyboard([
					[Markup.button.callback('⬅️ Назад к списку', 'back_to_list')],
				]),
			})
		} else {
			ctx.answerCbQuery('Доход не найден')
		}
	})
})

bot.action('force_cleanup', ctx => {
	ctx.answerCbQuery()
	cleanupOldData()
	ctx.editMessageText(
		'✅ Данные за предыдущий месяц будут удалены в ближайшее время!'
	)
})

bot.action('cancel_cleanup', ctx => {
	ctx.answerCbQuery()
	ctx.deleteMessage()
})

bot.action('back_to_list', ctx => {
	ctx.answerCbQuery()
	const message = {
		text: '✏️ Мои операции',
		chat: ctx.chat,
		from: ctx.from,
	}
	const update = { message }
	bot.handleUpdate(update)
})

bot.action('back_to_operations', ctx => {
	ctx.answerCbQuery()
	const message = {
		text: '✏️ Мои операции',
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

// Обработка выбора категории
EXPENSE_CATEGORIES.forEach(category => {
	bot.hears(category, ctx => {
		if (ctx.session && ctx.session.pendingExpense) {
			const { date, desc, amount, who } = ctx.session.pendingExpense

			db.run(
				'INSERT INTO expenses (date, description, amount, category, who) VALUES (?, ?, ?, ?, ?)',
				[date, desc, amount, category, who],
				err => {
					if (err) {
						ctx.reply('❌ Ошибка сохранения: ' + err.message)
					} else {
						ctx.reply(
							`✅ Расход добавлен!\n${date} | ${desc} | ${formatAmount(
								amount
							)} | ${category} | ${who}`
						)
					}
					delete ctx.session.pendingExpense
				}
			)
		} else if (
			ctx.session &&
			ctx.session.editingExpenseId &&
			ctx.session.pendingEditExpense
		) {
			const expenseId = ctx.session.editingExpenseId
			const { date, desc, amount, who } = ctx.session.pendingEditExpense

			db.run(
				'UPDATE expenses SET date = ?, description = ?, amount = ?, category = ?, who = ? WHERE id = ?',
				[date, desc, amount, category, who, expenseId],
				err => {
					if (err) {
						ctx.reply('❌ Ошибка обновления: ' + err.message)
					} else {
						ctx.reply(
							`✅ Расход обновлен!\n${date} | ${desc} | ${formatAmount(
								amount
							)} | ${category} | ${who}`
						)
					}
					delete ctx.session.editingExpenseId
					delete ctx.session.pendingEditExpense
				}
			)
		}
	})
})

bot.hears('⬅️ Назад', ctx => {
	ctx.reply('Выберите действие:', getMainMenu())
})

// Основной обработчик текста
bot.on('text', ctx => {
	const text = ctx.message.text

	// Пропускаем команды меню
	if (
		[
			'📊 Статистика',
			'📋 Отчёт',
			'💸 Добавить расход',
			'💰 Добавить доход',
			'✏️ Мои операции',
			'🗑️ Удалить старые',
			'🔄 Сбросить меню',
			'⬅️ Назад',
			...EXPENSE_CATEGORIES,
		].includes(text)
	) {
		return
	}

	// Редактирование расхода
	if (ctx.session && ctx.session.editingExpenseId) {
		if (text.includes('|')) {
			const parts = text.split('|').map(p => p.trim())
			if (parts.length === 4) {
				const [date, desc, amount, who] = parts
				const amountNum = parseAmount(amount)

				if (!isNaN(amountNum) && amountNum > 0) {
					ctx.session.pendingEditExpense = {
						date,
						desc,
						amount: amountNum,
						who,
					}
					ctx.reply('Выберите категорию расхода:', getExpenseCategoryKeyboard())
					return
				} else {
					ctx.reply('❌ Сумма должна быть положительным числом')
				}
			}
		}
		ctx.reply('❌ Неверный формат. Используйте: Дата | На что | Сумма | Кто')
		return
	}

	// Редактирование дохода
	if (ctx.session && ctx.session.editingIncomeId) {
		const expenseId = ctx.session.editingIncomeId

		if (text.includes('|')) {
			const parts = text.split('|').map(p => p.trim())
			if (parts.length === 4) {
				const [date, desc, amount, who] = parts
				const amountNum = parseAmount(amount)

				if (!isNaN(amountNum) && amountNum > 0) {
					db.run(
						'UPDATE incomes SET date = ?, description = ?, amount = ?, who = ? WHERE id = ?',
						[date, desc, amountNum, who, expenseId],
						err => {
							if (err) {
								ctx.reply('❌ Ошибка обновления: ' + err.message)
							} else {
								ctx.reply(
									`✅ Доход обновлен!\n${date} | ${desc} | ${formatAmount(
										amountNum
									)} | ${who}`
								)
								delete ctx.session.editingIncomeId
							}
						}
					)
					return
				} else {
					ctx.reply('❌ Сумма должна быть положительным числом')
				}
			}
		}
		ctx.reply('❌ Неверный формат. Используйте: Дата | Источник | Сумма | Кто')
		return
	}

	// Добавление расхода
	if (ctx.session && ctx.session.waitingForExpense) {
		if (text.includes('|')) {
			const parts = text.split('|').map(p => p.trim())
			if (parts.length === 4) {
				const [date, desc, amount, who] = parts
				const amountNum = parseAmount(amount)

				if (!isNaN(amountNum) && amountNum > 0) {
					ctx.session.pendingExpense = { date, desc, amount: amountNum, who }
					delete ctx.session.waitingForExpense
					ctx.reply('Выберите категорию расхода:', getExpenseCategoryKeyboard())
					return
				} else {
					ctx.reply('❌ Сумма должна быть положительным числом')
				}
			}
		}
		ctx.reply('❌ Неверный формат. Используйте: Дата | На что | Сумма | Кто')
		return
	}

	// Добавление дохода
	if (ctx.session && ctx.session.waitingForIncome) {
		if (text.includes('|')) {
			const parts = text.split('|').map(p => p.trim())
			if (parts.length === 4) {
				const [date, desc, amount, who] = parts
				const amountNum = parseAmount(amount)

				if (!isNaN(amountNum) && amountNum > 0) {
					db.run(
						'INSERT INTO incomes (date, description, amount, who) VALUES (?, ?, ?, ?)',
						[date, desc, amountNum, who],
						err => {
							if (err) {
								ctx.reply('❌ Ошибка сохранения: ' + err.message)
							} else {
								ctx.reply(
									`✅ Доход добавлен!\n${date} | ${desc} | ${formatAmount(
										amountNum
									)} | ${who}`
								)
							}
						}
					)
					delete ctx.session.waitingForIncome
					return
				} else {
					ctx.reply('❌ Сумма должна быть положительным числом')
				}
			}
		}
		ctx.reply('❌ Неверный формат. Используйте: Дата | Источник | Сумма | Кто')
		return
	}

	// Обработка в свободной форме (для обратной совместимости)
	if (text.includes('|')) {
		const parts = text.split('|').map(p => p.trim())
		if (parts.length === 4) {
			const [date, desc, amount, who] = parts
			const amountNum = parseAmount(amount)

			if (!isNaN(amountNum) && amountNum > 0) {
				// Спрашиваем пользователя - это доход или расход?
				ctx.reply(
					`Это доход или расход?\n\n` +
						`📅 ${date} | ${desc} | ${formatAmount(amountNum)} | ${who}`,
					Markup.inlineKeyboard([
						[
							Markup.button.callback(
								'📈 Доход',
								`add_income_${date}_${desc.replace(
									/\|/g,
									''
								)}_${amountNum}_${who}`
							),
							Markup.button.callback(
								'📉 Расход',
								`add_expense_${date}_${desc.replace(
									/\|/g,
									''
								)}_${amountNum}_${who}`
							),
						],
					])
				)
				return
			}
		}
	}
})

// Обработчики для инлайн-кнопок определения типа операции
bot.action(/add_income_(.+)_(.+)_(.+)_(.+)/, ctx => {
	const [date, desc, amount, who] = [
		ctx.match[1],
		ctx.match[2],
		parseFloat(ctx.match[3]),
		ctx.match[4],
	]

	db.run(
		'INSERT INTO incomes (date, description, amount, who) VALUES (?, ?, ?, ?)',
		[date, desc, amount, who],
		err => {
			if (err) {
				ctx.answerCbQuery('❌ Ошибка сохранения')
				ctx.editMessageText('❌ Ошибка при сохранении дохода')
			} else {
				ctx.answerCbQuery('✅ Доход добавлен')
				ctx.editMessageText(
					`✅ Доход добавлен!\n${date} | ${desc} | ${formatAmount(
						amount
					)} | ${who}`
				)
			}
		}
	)
})

bot.action(/add_expense_(.+)_(.+)_(.+)_(.+)/, ctx => {
	const [date, desc, amount, who] = [
		ctx.match[1],
		ctx.match[2],
		parseFloat(ctx.match[3]),
		ctx.match[4],
	]

	ctx.session = ctx.session || {}
	ctx.session.pendingExpense = { date, desc, amount, who }

	ctx.answerCbQuery()
	ctx.editMessageText('Выберите категорию расхода:')

	// Немного хак для отправки нового сообщения с клавиатурой
	setTimeout(() => {
		bot.telegram.sendMessage(
			ctx.chat.id,
			'Выберите категорию расхода:',
			getExpenseCategoryKeyboard()
		)
	}, 100)
})

bot.catch((err, ctx) => {
	console.error('Error for', ctx.updateType, err)
})

bot.launch()
console.log('✅ Бот запущен с новыми функциями!')
console.log('✅ Разрешены пользователи:', ALLOWED_USERS)

process.once('SIGINT', () => {
	db.close()
	bot.stop('SIGINT')
})
process.once('SIGTERM', () => {
	db.close()
	bot.stop('SIGTERM')
})
