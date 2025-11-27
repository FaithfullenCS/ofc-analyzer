const express = require('express');
const cors = require('cors');
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

// Helper функция для запросов к Checko API v2
async function callCheckoAPI(endpoint, apiKey, params = {}) {
    const url = `${CHECKO_API_BASE}${endpoint}`;

    const bodyData = {
        key: apiKey,
        ...params
    };

    if (endpoint === '/finances' && !bodyData.extended) {
        bodyData.extended = 'true';
    }

    console.log(`[Checko API v2] POST запрос: ${url}`);
    console.log(`[Checko API v2] Отправляемое тело:`, JSON.stringify(bodyData, null, 2));

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
            console.log('[Checko API v2] Не удалось прочитать тело ошибки');
        }

        let errorData = null;
        try {
            errorData = JSON.parse(errorBody);
        } catch (e) {
            // Игнорируем
        }

        if (response.status === 401 || response.status === 403) {
            throw new Error('Неверный API ключ или доступ запрещён');
        } else if (response.status === 429) {
            throw new Error('Превышен лимит запросов к Checko API');
        } else if (response.status === 400 && errorData?.meta?.balance === 0) {
            throw new Error('Баланс API-ключа равен 0. Проверьте баланс на сайте checko.ru или используйте ключ с бесплатным тарифом.');
        } else {
            throw new Error(`Ошибка API Checko: ${response.status} - ${errorBody || 'Нет деталей'}`);
        }
    }

    const data = await response.json();
    console.log('[Checko API v2] ✅ Успешный ответ получен');
    console.log('[Checko API v2] Структура ответа:', Object.keys(data));

    if (data.meta?.today_request_count !== undefined) {
        console.log(`[Checko API v2] Использовано запросов сегодня: ${data.meta.today_request_count}`);
    }

    return data;
}

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Простейший логгер для входящих запросов
app.use((req, res, next) => {
    console.log('='.repeat(80));
    console.log('[Handler] Новый запрос:', {
        method: req.method,
        url: req.url,
        timestamp: new Date().toISOString()
    });
    next();
});

app.post('/api/check-connection', async (req, res, next) => {
    try {
        const { apiKey } = req.body || {};

        if (!apiKey) {
            return res.status(200).json({
                status: 'error',
                message: 'API ключ не предоставлен'
            });
        }

        const testINN = '7735560386';
        console.log(`[Handler] Проверка ключа с тестовым ИНН: ${testINN}`);

        const testData = await callCheckoAPI('/company', apiKey, { inn: testINN });
        console.log('[Handler] ✅ API ключ валиден');

        const requestsUsedToday = testData.meta?.today_request_count || tracker.getCount(apiKey);
        const remainingRequests = Math.max(0, 100 - requestsUsedToday);

        return res.status(200).json({
            status: 'ok',
            message: 'Подключение успешно',
            requestsUsedToday,
            remainingRequests
        });
    } catch (error) {
        console.log(`[Handler] ❌ Ошибка проверки: ${error.message}`);
        return res.status(200).json({
            status: 'error',
            message: `Ошибка подключения: ${error.message}`
        });
    } finally {
        console.log('='.repeat(80));
    }
});

app.post('/api/company', async (req, res, next) => {
    try {
        const { apiKey, inn } = req.body || {};

        if (!apiKey || !inn) {
            return res.status(200).json({
                status: 'error',
                message: 'API ключ и ИНН обязательны'
            });
        }

        const remainingRequests = tracker.getRemainingRequests(apiKey);
        if (remainingRequests <= 0) {
            return res.status(200).json({
                status: 'error',
                message: 'Лимит 100 запросов в день исчерпан (локальный счетчик)',
                requestsUsedToday: 100,
                remainingRequests: 0
            });
        }

        console.log(`[Handler] Загрузка компании ${inn}`);
        const data = await callCheckoAPI('/company', apiKey, { inn });

        tracker.increment(apiKey);

        const requestsUsedToday = data.meta?.today_request_count || tracker.getCount(apiKey);
        const newRemainingRequests = Math.max(0, 100 - requestsUsedToday);

        return res.status(200).json({
            status: 'ok',
            data,
            requestsUsedToday,
            remainingRequests: newRemainingRequests
        });
    } catch (apiError) {
        console.log(`[Handler] ❌ Ошибка: ${apiError.message}`);
        return res.status(200).json({
            status: 'error',
            message: apiError.message,
            requestsUsedToday: tracker.getCount(req.body?.apiKey),
            remainingRequests: tracker.getRemainingRequests(req.body?.apiKey)
        });
    } finally {
        console.log('='.repeat(80));
    }
});

app.post('/api/finances', async (req, res, next) => {
    try {
        const { apiKey, inn } = req.body || {};

        if (!apiKey || !inn) {
            return res.status(200).json({
                status: 'error',
                message: 'API ключ и ИНН обязательны'
            });
        }

        const remainingRequests = tracker.getRemainingRequests(apiKey);
        if (remainingRequests <= 0) {
            return res.status(200).json({
                status: 'error',
                message: 'Лимит 100 запросов в день исчерпан (локальный счетчик)',
                requestsUsedToday: 100,
                remainingRequests: 0
            });
        }

        console.log(`[Handler] Загрузка финансов ${inn} (extended=true)`);
        const data = await callCheckoAPI('/finances', apiKey, { inn });

        tracker.increment(apiKey);

        const requestsUsedToday = data.meta?.today_request_count || tracker.getCount(apiKey);
        const newRemainingRequests = Math.max(0, 100 - requestsUsedToday);

        return res.status(200).json({
            status: 'ok',
            data,
            requestsUsedToday,
            remainingRequests: newRemainingRequests
        });
    } catch (apiError) {
        console.log(`[Handler] ❌ Ошибка: ${apiError.message}`);
        return res.status(200).json({
            status: 'error',
            message: apiError.message,
            requestsUsedToday: tracker.getCount(req.body?.apiKey),
            remainingRequests: tracker.getRemainingRequests(req.body?.apiKey)
        });
    } finally {
        console.log('='.repeat(80));
    }
});

app.post('/api/batch', async (req, res, next) => {
    try {
        const { apiKey, innList } = req.body || {};

        if (!apiKey || !Array.isArray(innList) || innList.length === 0) {
            return res.status(200).json({
                status: 'error',
                message: 'API ключ и массив ИНН обязательны'
            });
        }

        const requiredRequests = innList.length * 2;
        const remainingRequests = tracker.getRemainingRequests(apiKey);

        if (remainingRequests < requiredRequests) {
            return res.status(200).json({
                status: 'error',
                message: `Недостаточно запросов. Требуется: ${requiredRequests}, осталось: ${remainingRequests}`,
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

                const financeData = await callCheckoAPI('/finances', apiKey, { inn });
                tracker.increment(apiKey);

                results.push({
                    inn,
                    company: companyData,
                    finances: financeData
                });
            } catch (error) {
                console.error(`[Handler] ❌ Ошибка ${inn}: ${error.message}`);
                errors.push({ inn, error: error.message });
            }
        }

        const requestsUsedToday = tracker.getCount(apiKey);
        const newRemainingRequests = tracker.getRemainingRequests(apiKey);

        return res.status(200).json({
            status: 'ok',
            data: results,
            errors: errors.length > 0 ? errors : undefined,
            requestsUsedToday,
            remainingRequests: newRemainingRequests
        });
    } catch (apiError) {
        console.log('[Handler] ❌ Ошибка batch', apiError);
        return res.status(200).json({
            status: 'error',
            message: apiError.message || 'Внутренняя ошибка сервера',
            requestsUsedToday: tracker.getCount(req.body?.apiKey),
            remainingRequests: tracker.getRemainingRequests(req.body?.apiKey)
        });
    } finally {
        console.log('='.repeat(80));
    }
});

// Обработка неизвестных маршрутов
app.use((req, res) => {
    return res.status(404).json({
        status: 'error',
        message: `Endpoint не найден: ${req.path}`
    });
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
    console.error('[Handler] ❌ Критическая ошибка:', err);

    const apiKey = req.body?.apiKey;
    const requestsUsedToday = apiKey ? tracker.getCount(apiKey) : 0;
    const remainingRequests = apiKey ? tracker.getRemainingRequests(apiKey) : 100;

    return res.status(200).json({
        status: 'error',
        message: err.message || 'Внутренняя ошибка сервера',
        requestsUsedToday,
        remainingRequests
    });
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
}

module.exports = app;
