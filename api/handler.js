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

// Helper функция для запросов к Checko API v2
async function callCheckoAPI(endpoint, apiKey, body = {}) {
    const url = `${CHECKO_API_BASE}${endpoint}`;
    
    console.log(`[Checko API v2] POST запрос: ${url}`);
    console.log(`[Checko API v2] Параметры тела:`, JSON.stringify(body, null, 2));
    
    try {
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(body)
        };
        
        console.log(`[Checko API v2] Headers:`, JSON.stringify(options.headers, null, 2));

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
            
            if (response.status === 401 || response.status === 403) {
                throw new Error('Неверный API ключ или доступ запрещён');
            } else if (response.status === 429) {
                throw new Error('Превышен лимит запросов к Checko API');
            } else {
                throw new Error(`Ошибка API Checko: ${response.status} - ${errorBody || 'Нет деталей'}`);
            }
        }

        const data = await response.json();
        console.log(`[Checko API v2] ✅ Успешный ответ получен`);
        console.log(`[Checko API v2] Структура ответа:`, Object.keys(data));
        
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
                return res.status(200).json({
                    status: 'error',
                    message: 'API ключ не предоставлен'
                });
            }

            // Пробуем тестовый запрос с известным ИНН (Тинькофф)
            const testINN = '7735560386';
            try {
                console.log(`[Handler] Проверка ключа с тестовым ИНН: ${testINN}`);
                const testData = await callCheckoAPI('/company', apiKey, { inn: testINN });
                
                console.log(`[Handler] ✅ API ключ валиден`);
                const requestsUsedToday = tracker.getCount(apiKey);
                const remainingRequests = tracker.getRemainingRequests(apiKey);

                return res.status(200).json({
                    status: 'ok',
                    message: 'Подключение успешно',
                    requestsUsedToday,
                    remainingRequests
                });
            } catch (testError) {
                console.log(`[Handler] ❌ Ошибка проверки: ${testError.message}`);
                return res.status(200).json({
                    status: 'error',
                    message: `Ошибка подключения: ${testError.message}`
                });
            }
        }

        // Endpoint: Загрузка информации о компании
        if (path.includes('/company') && !path.includes('/check-connection')) {
            console.log('[Handler] => company');
            const { apiKey, inn } = body;
            
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
                    message: 'Лимит 100 запросов в день исчерпан',
                    requestsUsedToday: 100,
                    remainingRequests: 0
                });
            }

            try {
                console.log(`[Handler] Загрузка компании ${inn}`);
                const data = await callCheckoAPI('/company', apiKey, { inn });
                
                const requestsUsedToday = tracker.increment(apiKey);
                const newRemainingRequests = tracker.getRemainingRequests(apiKey);

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
                    requestsUsedToday: tracker.getCount(apiKey),
                    remainingRequests: tracker.getRemainingRequests(apiKey)
                });
            }
        }

        // Endpoint: Загрузка финансовых данных
        if (path.includes('/finances')) {
            console.log('[Handler] => finances');
            const { apiKey, inn } = body;
            
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
                    message: 'Лимит 100 запросов в день исчерпан',
                    requestsUsedToday: 100,
                    remainingRequests: 0
                });
            }

            try {
                console.log(`[Handler] Загрузка финансов ${inn}`);
                const data = await callCheckoAPI('/finance', apiKey, { inn });
                
                const requestsUsedToday = tracker.increment(apiKey);
                const newRemainingRequests = tracker.getRemainingRequests(apiKey);

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
                    
                    const financeData = await callCheckoAPI('/financials', apiKey, { inn });
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
        }

        console.log('[Handler] ❌ Неизвестный endpoint');
        return res.status(404).json({
            status: 'error',
            message: `Endpoint не найден: ${path}`
        });

    } catch (error) {
        console.error('[Handler] ❌ Критическая ошибка:', error);
        
        let requestsUsedToday = 0;
        let remainingRequests = 100;
        
        try {
            const catchBody = req.body && typeof req.body === 'string' 
                ? JSON.parse(req.body) 
                : (req.body || {});
            
            if (catchBody && catchBody.apiKey) {
                requestsUsedToday = tracker.getCount(catchBody.apiKey);
                remainingRequests = tracker.getRemainingRequests(catchBody.apiKey);
            }
        } catch (bodyError) {
            console.error('[Handler] Ошибка парсинга body в catch:', bodyError);
        }

        return res.status(200).json({
            status: 'error',
            message: error.message || 'Внутренняя ошибка сервера',
            requestsUsedToday,
            remainingRequests
        });
    } finally {
        console.log('='.repeat(80));
    }
};
