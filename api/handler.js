// Встроенный crypto модуль Node.js
const crypto = require('crypto');

// Класс для отслеживания запросов (в памяти)
class RequestTracker {
    constructor() {
        this.requests = new Map();
    }

    getKey(apiKey) {
        return crypto.createHash('sha256').update(apiKey).digest('hex');
    }

    getCount(apiKey) {
        const key = this.getKey(apiKey);
        const today = new Date().toISOString().split('T')[0];
        const data = this.requests.get(key);
        if (!data || data.date !== today) {
            return 0;
        }
        return data.count;
    }

    increment(apiKey) {
        const key = this.getKey(apiKey);
        const today = new Date().toISOString().split('T')[0];
        const data = this.requests.get(key);
        if (!data || data.date !== today) {
            this.requests.set(key, { date: today, count: 1 });
            return 1;
        }
        data.count++;
        return data.count;
    }

    getRemainingRequests(apiKey) {
        const used = this.getCount(apiKey);
        return Math.max(0, 100 - used);
    }
}

const tracker = new RequestTracker();

// Базовый URL API Checko v2
const CHECKO_API_BASE = 'https://api.checko.ru/v2';

function createError(message, statusCode = 500, extra = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    Object.assign(error, extra);
    return error;
}

function jsonError(res, statusCode, message, extra = {}) {
    return res.status(statusCode).json({
        status: 'error',
        message,
        ...extra
    });
}

// Helper функция для запросов к Checko API v2
async function callCheckoAPI(endpoint, apiKey, params = {}) {
    const url = `${CHECKO_API_BASE}${endpoint}`;

    // ✅ ИСПРАВЛЕНИЕ: Добавляем extended=true для /finances
    const bodyData = {
        key: apiKey,
        ...params
    };

    // Если это запрос финансов, добавляем extended=true
    if (endpoint === '/finances' && !bodyData.extended) {
        bodyData.extended = 'true';
    }

    console.log(`[Checko API v2] POST запрос: ${url}`);
    console.log(`[Checko API v2] Отправляемое тело:`, JSON.stringify(bodyData, null, 2));

    try {
        const formData = new URLSearchParams();
        for (const [paramKey, paramValue] of Object.entries(bodyData)) {
            formData.append(paramKey, paramValue);
        }

        console.log(`[Checko API v2] URL-encoded body: ${formData.toString()}`);

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: formData.toString()
        };

        const response = await fetch(url, options);
        console.log(`[Checko API v2] Статус ответа: ${response.status}`);

        if (!response.ok) {
            let errorBody = '';
            try {
                errorBody = await response.text();
                console.log(`[Checko API v2] Тело ошибки: ${errorBody}`);
            } catch (e) {
                console.log(`[Checko API v2] Не удалось прочитать тело ошибки`);
            }

            let errorData = null;
            try {
                errorData = JSON.parse(errorBody);
            } catch (e) {
                // Игнорируем
            }

            if (response.status === 401 || response.status === 403) {
                throw createError('Неверный API ключ или доступ запрещён', 401);
            } else if (response.status === 429) {
                throw createError('Превышен лимит запросов к Checko API', 429);
            } else if (response.status === 400 && errorData?.meta?.balance === 0) {
                throw createError('Баланс API-ключа равен 0. Проверьте баланс на сайте checko.ru или используйте ключ с бесплатным тарифом.', 402);
            } else {
                throw createError(`Ошибка API Checko: ${response.status} - ${errorBody || 'Нет деталей'}`, response.status || 500);
            }
        }

        const data = await response.json();
        console.log(`[Checko API v2] ✅ Успешный ответ получен`);
        console.log(`[Checko API v2] Структура ответа:`, Object.keys(data));

        if (data.meta?.today_request_count !== undefined) {
            console.log(`[Checko API v2] Использовано запросов сегодня: ${data.meta.today_request_count}`);
        }

        return data;
    } catch (error) {
        console.error('[Checko API v2] Ошибка:', error.message);
        throw error;
    }
}

// Главный обработчик для Vercel Serverless Function
module.exports = async (req, res) => {
    console.log('='.repeat(80));
    console.log('[Handler] Новый запрос:', {
        method: req.method,
        url: req.url,
        timestamp: new Date().toISOString()
    });

    // CORS headers
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,Content-Type,Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    res.setHeader('Content-Type', 'application/json');

    try {
        let body = {};
        if (req.body) {
            if (typeof req.body === 'string') {
                try {
                    body = JSON.parse(req.body);
                } catch (e) {
                    console.error('[Handler] Ошибка парсинга body:', e);
                    body = {};
                }
            } else {
                body = req.body;
            }
        }

        console.log('[Handler] Body:', JSON.stringify(body, null, 2));
        const path = req.url || '';
        console.log('[Handler] Путь:', path);

        // Endpoint: Проверка подключения
        if (path.includes('/check-connection')) {
            console.log('[Handler] => check-connection');
            const { apiKey } = body;

            if (!apiKey) {
                return jsonError(res, 401, 'API ключ не предоставлен');
            }

            const testINN = '7735560386';
            try {
                console.log(`[Handler] Проверка ключа с тестовым ИНН: ${testINN}`);
                const testData = await callCheckoAPI('/company', apiKey, { inn: testINN });
                console.log(`[Handler] ✅ API ключ валиден`);

                const requestsUsedToday = testData.meta?.today_request_count || tracker.getCount(apiKey);
                const remainingRequests = Math.max(0, 100 - requestsUsedToday);

                return res.status(200).json({
                    status: 'ok',
                    message: 'Подключение успешно',
                    requestsUsedToday,
                    remainingRequests
                });
            } catch (testError) {
                console.log(`[Handler] ❌ Ошибка проверки: ${testError.message}`);
                return jsonError(res, testError.statusCode || 500, `Ошибка подключения: ${testError.message}`);
            }
        }

        // Endpoint: Загрузка информации о компании
        if (path.includes('/company') && !path.includes('/check-connection')) {
            console.log('[Handler] => company');
            const { apiKey, inn } = body;

            if (!apiKey || !inn) {
                return jsonError(res, 401, 'API ключ и ИНН обязательны');
            }

            const remainingRequests = tracker.getRemainingRequests(apiKey);
            if (remainingRequests <= 0) {
                return jsonError(res, 429, 'Лимит 100 запросов в день исчерпан (локальный счетчик)', {
                    requestsUsedToday: 100,
                    remainingRequests: 0
                });
            }

            try {
                console.log(`[Handler] Загрузка компании ${inn}`);
                const data = await callCheckoAPI('/company', apiKey, { inn });

                tracker.increment(apiKey);

                const requestsUsedToday = data.meta?.today_request_count || tracker.getCount(apiKey);
                const newRemainingRequests = Math.max(0, 100 - requestsUsedToday);

                const companyData = data?.data;
                const hasCompanyData = companyData && Object.keys(companyData).length > 0;

                if (!hasCompanyData) {
                    return jsonError(res, 404, 'Компания не найдена', {
                        requestsUsedToday,
                        remainingRequests: newRemainingRequests
                    });
                }

                return res.status(200).json({
                    status: 'ok',
                    data,
                    requestsUsedToday,
                    remainingRequests: newRemainingRequests
                });
            } catch (apiError) {
                console.log(`[Handler] ❌ Ошибка: ${apiError.message}`);
                return jsonError(res, apiError.statusCode || 500, apiError.message, {
                    requestsUsedToday: tracker.getCount(apiKey),
                    remainingRequests: tracker.getRemainingRequests(apiKey)
                });
            }
        }

        // Endpoint: Загрузка финансовых данных (с extended=true)
        if (path.includes('/finances')) {
            console.log('[Handler] => finances (extended mode)');
            const { apiKey, inn } = body;

            if (!apiKey || !inn) {
                return jsonError(res, 401, 'API ключ и ИНН обязательны');
            }

            const remainingRequests = tracker.getRemainingRequests(apiKey);
            if (remainingRequests <= 0) {
                return jsonError(res, 429, 'Лимит 100 запросов в день исчерпан (локальный счетчик)', {
                    requestsUsedToday: 100,
                    remainingRequests: 0
                });
            }

            try {
                console.log(`[Handler] Загрузка финансов ${inn} (extended=true)`);
                // extended=true добавляется автоматически в callCheckoAPI
                const data = await callCheckoAPI('/finances', apiKey, { inn });

                tracker.increment(apiKey);

                const requestsUsedToday = data.meta?.today_request_count || tracker.getCount(apiKey);
                const newRemainingRequests = Math.max(0, 100 - requestsUsedToday);

                const financeData = data?.data;
                const hasFinances = financeData && Object.keys(financeData).length > 0;

                if (!hasFinances) {
                    return jsonError(res, 404, 'Финансовая информация не найдена', {
                        requestsUsedToday,
                        remainingRequests: newRemainingRequests
                    });
                }

                return res.status(200).json({
                    status: 'ok',
                    data,
                    requestsUsedToday,
                    remainingRequests: newRemainingRequests
                });
            } catch (apiError) {
                console.log(`[Handler] ❌ Ошибка: ${apiError.message}`);
                return jsonError(res, apiError.statusCode || 500, apiError.message, {
                    requestsUsedToday: tracker.getCount(apiKey),
                    remainingRequests: tracker.getRemainingRequests(apiKey)
                });
            }
        }

        // Endpoint: Батч-загрузка
        if (path.includes('/batch')) {
            console.log('[Handler] => batch');
            const { apiKey, innList } = body;

            if (!apiKey || !Array.isArray(innList) || innList.length === 0) {
                return jsonError(res, 401, 'API ключ и массив ИНН обязательны');
            }

            const requiredRequests = innList.length * 2;
            const remainingRequests = tracker.getRemainingRequests(apiKey);

            if (remainingRequests < requiredRequests) {
                return jsonError(res, 429, `Недостаточно запросов. Требуется: ${requiredRequests}, осталось: ${remainingRequests}`, {
                    requestsUsedToday: tracker.getCount(apiKey),
                    remainingRequests
                });
            }

            const results = [];
            const errors = [];

            for (const inn of innList) {
                try {
                    console.log(`[Handler] Батч: загрузка ${inn}...`);
                    const companyData = await callCheckoAPI('/company', apiKey, { inn });
                    tracker.increment(apiKey);

                    const hasCompany = companyData?.data && Object.keys(companyData.data).length > 0;
                    if (!hasCompany) {
                        throw createError('Компания не найдена', 404);
                    }

                    const financeData = await callCheckoAPI('/finances', apiKey, { inn });
                    tracker.increment(apiKey);

                    const hasFinances = financeData?.data && Object.keys(financeData.data).length > 0;
                    if (!hasFinances) {
                        throw createError('Финансовая информация не найдена', 404);
                    }

                    results.push({
                        inn,
                        company: companyData,
                        finances: financeData
                    });
                } catch (error) {
                    console.error(`[Handler] ❌ Ошибка ${inn}: ${error.message}`);
                    errors.push({ inn, error: error.message, statusCode: error.statusCode || 500 });
                }
            }

            const requestsUsedToday = tracker.getCount(apiKey);
            const newRemainingRequests = tracker.getRemainingRequests(apiKey);

            if (results.length === 0) {
                const statusCode = errors[0]?.statusCode || 500;
                return jsonError(res, statusCode, 'Не удалось загрузить данные ни для одной компании', {
                    errors,
                    requestsUsedToday,
                    remainingRequests: newRemainingRequests
                });
            }

            return res.status(200).json({
                status: 'ok',
                data: results,
                errors: errors.length > 0 ? errors : undefined,
                requestsUsedToday,
                remainingRequests: newRemainingRequests
            });
        }

        console.log('[Handler] ❌ Неизвестный endpoint');
        return jsonError(res, 404, `Endpoint не найден: ${path}`);

    } catch (error) {
        console.error('[Handler] ❌ Критическая ошибка:', error);

        let requestsUsedToday = 0;
        let remainingRequests = 100;

        try {
            const catchBody = req.body && typeof req.body === 'string'
                ? JSON.parse(req.body)
                : (req.body || {});
            if (catchBody?.apiKey) {
                requestsUsedToday = tracker.getCount(catchBody.apiKey);
                remainingRequests = tracker.getRemainingRequests(catchBody.apiKey);
            }
        } catch (bodyError) {
            console.error('[Handler] Ошибка парсинга body в catch:', bodyError);
        }

        return jsonError(res, error.statusCode || 500, error.message || 'Внутренняя ошибка сервера', {
            requestsUsedToday,
            remainingRequests
        });
    } finally {
        console.log('='.repeat(80));
    }
};
