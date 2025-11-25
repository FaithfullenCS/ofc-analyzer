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

// Базовый URL API Checko
const CHECKO_API_BASE = 'https://api.checko.ru';

// Helper функция для запросов к Checko API
// Пробуем разные варианты запросов
async function callCheckoAPI(endpoint, apiKey, method = 'GET', body = null) {
    // Пробуем разные варианты URL
    const variants = [
        `${CHECKO_API_BASE}${endpoint}`,
        `${CHECKO_API_BASE}/v1${endpoint}`,
        `${CHECKO_API_BASE}/api${endpoint}`,
        `${CHECKO_API_BASE}/api/v1${endpoint}`
    ];
    
    for (const url of variants) {
        console.log(`[Checko API] Попытка запроса: ${method} ${url}`);
        
        try {
            const options = {
                method,
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            };

            if (body && method === 'POST') {
                options.body = JSON.stringify(body);
            }

            const response = await fetch(url, options);
            
            console.log(`[Checko API] Статус ответа: ${response.status}`);

            if (response.status === 404) {
                console.log(`[Checko API] 404 для URL: ${url}, пробуем следующий вариант...`);
                continue; // Пробуем следующий вариант URL
            }

            if (!response.ok) {
                let errorBody = '';
                try {
                    errorBody = await response.text();
                    console.log(`[Checko API] Тело ошибки: ${errorBody}`);
                } catch (e) {
                    console.log(`[Checko API] Не удалось прочитать тело ошибки`);
                }

                if (response.status === 401) {
                    throw new Error('Неверный API ключ');
                } else if (response.status === 429) {
                    throw new Error('Превышен лимит запросов к Checko API');
                } else if (response.status === 403) {
                    throw new Error('Доступ запрещён. Проверьте права API ключа');
                } else {
                    throw new Error(`Ошибка API Checko: ${response.status} - ${errorBody || 'Нет деталей'}`);
                }
            }

            const data = await response.json();
            console.log(`[Checko API] ✅ Успешный ответ получен с URL: ${url}`);
            console.log(`[Checko API] Структура ответа:`, Object.keys(data));
            return data;
            
        } catch (error) {
            if (error.message === 'Неверный API ключ' || 
                error.message.includes('Превышен лимит') || 
                error.message.includes('Доступ запрещён')) {
                // Критические ошибки - не пробуем другие варианты
                console.error('[Checko API] Критическая ошибка:', error.message);
                throw error;
            }
            
            console.log(`[Checko API] Ошибка для ${url}: ${error.message}`);
            // Продолжаем пробовать другие варианты
        }
    }
    
    // Если все варианты не сработали
    throw new Error('Не удалось найти рабочий endpoint Checko API. Проверьте документацию API или свяжитесь с поддержкой Checko.');
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
                
                // Пробуем оба метода: GET и POST
                let testData = null;
                try {
                    testData = await callCheckoAPI(`/company?inn=${testINN}`, apiKey, 'GET');
                } catch (getError) {
                    console.log(`[Handler] GET не сработал, пробуем POST`);
                    testData = await callCheckoAPI(`/company`, apiKey, 'POST', { inn: testINN });
                }
                
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
                
                // Пробуем оба метода
                let data = null;
                try {
                    data = await callCheckoAPI(`/company?inn=${inn}`, apiKey, 'GET');
                } catch (getError) {
                    console.log(`[Handler] GET не сработал, пробуем POST`);
                    data = await callCheckoAPI(`/company`, apiKey, 'POST', { inn });
                }

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
                
                // Пробуем оба метода
                let data = null;
                try {
                    data = await callCheckoAPI(`/finances?inn=${inn}`, apiKey, 'GET');
                } catch (getError) {
                    console.log(`[Handler] GET не сработал, пробуем POST`);
                    data = await callCheckoAPI(`/finances`, apiKey, 'POST', { inn });
                }

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
                    
                    let companyData = null;
                    try {
                        companyData = await callCheckoAPI(`/company?inn=${inn}`, apiKey, 'GET');
                    } catch (getError) {
                        companyData = await callCheckoAPI(`/company`, apiKey, 'POST', { inn });
                    }
                    tracker.increment(apiKey);

                    let financeData = null;
                    try {
                        financeData = await callCheckoAPI(`/finances?inn=${inn}`, apiKey, 'GET');
                    } catch (getError) {
                        financeData = await callCheckoAPI(`/finances`, apiKey, 'POST', { inn });
                    }
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
            const catchBody = req.body && typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
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
