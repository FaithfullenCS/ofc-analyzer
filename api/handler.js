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
async function callCheckoAPI(endpoint, apiKey) {
    const url = `${CHECKO_API_BASE}${endpoint}`;
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            if (response.status === 401) {
                throw new Error('Неверный API ключ');
            } else if (response.status === 404) {
                throw new Error('Компания не найдена');
            } else if (response.status === 429) {
                throw new Error('Превышен лимит запросов к Checko API');
            } else {
                throw new Error(`Ошибка API: ${response.status}`);
            }
        }

        return await response.json();
    } catch (error) {
        console.error('Checko API Error:', error);
        throw error;
    }
}

// Главный обработчик для Vercel Serverless Function
module.exports = async (req, res) => {
    // Логирование для отладки
    console.log('Request received:', {
        method: req.method,
        url: req.url,
        headers: req.headers
    });

    // CORS headers - ВСЕГДА устанавливаем первым делом
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,Content-Type,Authorization');

    // Обработка preflight запросов
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Устанавливаем Content-Type для JSON
    res.setHeader('Content-Type', 'application/json');

    try {
        // Парсинг body
        let body = {};
        if (req.body) {
            if (typeof req.body === 'string') {
                try {
                    body = JSON.parse(req.body);
                } catch (e) {
                    console.error('Body parsing error:', e);
                    body = {};
                }
            } else {
                body = req.body;
            }
        }

        console.log('Parsed body:', body);

        // Маршрутизация по URL
        const path = req.url || '';

        // Endpoint: Проверка подключения
        if (path.includes('/check-connection') || path.includes('/api/check-connection')) {
            console.log('Check connection endpoint');
            const { apiKey } = body;

            if (!apiKey) {
                return res.status(200).json({
                    status: 'error',
                    message: 'API ключ не предоставлен'
                });
            }

            // Простой запрос для проверки валидности ключа
            await callCheckoAPI('/company?inn=7735560386', apiKey);
            
            const requestsUsedToday = tracker.getCount(apiKey);
            const remainingRequests = tracker.getRemainingRequests(apiKey);

            return res.status(200).json({
                status: 'ok',
                message: 'Подключение успешно',
                requestsUsedToday,
                remainingRequests
            });
        }

        // Endpoint: Загрузка информации о компании
        if (path.includes('/company') && !path.includes('/check-connection')) {
            console.log('Company endpoint');
            const { apiKey, inn } = body;

            if (!apiKey || !inn) {
                return res.status(200).json({
                    status: 'error',
                    message: 'API ключ и ИНН обязательны'
                });
            }

            // Проверка лимита
            const remainingRequests = tracker.getRemainingRequests(apiKey);
            if (remainingRequests <= 0) {
                return res.status(200).json({
                    status: 'error',
                    message: 'Лимит 100 запросов в день исчерпан',
                    requestsUsedToday: 100,
                    remainingRequests: 0
                });
            }

            // Запрос к Checko API
            const data = await callCheckoAPI(`/company?inn=${inn}`, apiKey);

            // Инкрементируем счетчик
            const requestsUsedToday = tracker.increment(apiKey);
            const newRemainingRequests = tracker.getRemainingRequests(apiKey);

            return res.status(200).json({
                status: 'ok',
                data,
                requestsUsedToday,
                remainingRequests: newRemainingRequests
            });
        }

        // Endpoint: Загрузка финансовых данных
        if (path.includes('/finances')) {
            console.log('Finances endpoint');
            const { apiKey, inn } = body;

            if (!apiKey || !inn) {
                return res.status(200).json({
                    status: 'error',
                    message: 'API ключ и ИНН обязательны'
                });
            }

            // Проверка лимита
            const remainingRequests = tracker.getRemainingRequests(apiKey);
            if (remainingRequests <= 0) {
                return res.status(200).json({
                    status: 'error',
                    message: 'Лимит 100 запросов в день исчерпан',
                    requestsUsedToday: 100,
                    remainingRequests: 0
                });
            }

            // Запрос к Checko API
            const data = await callCheckoAPI(`/finances?inn=${inn}`, apiKey);

            // Инкрементируем счетчик
            const requestsUsedToday = tracker.increment(apiKey);
            const newRemainingRequests = tracker.getRemainingRequests(apiKey);

            return res.status(200).json({
                status: 'ok',
                data,
                requestsUsedToday,
                remainingRequests: newRemainingRequests
            });
        }

        // Endpoint: Батч-загрузка нескольких компаний
        if (path.includes('/batch')) {
            console.log('Batch endpoint');
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

            // Загрузка данных для всех компаний
            const results = [];
            for (const inn of innList) {
                try {
                    const companyData = await callCheckoAPI(`/company?inn=${inn}`, apiKey);
                    tracker.increment(apiKey);

                    const financeData = await callCheckoAPI(`/finances?inn=${inn}`, apiKey);
                    tracker.increment(apiKey);

                    results.push({
                        company: companyData,
                        finances: financeData
                    });
                } catch (error) {
                    console.error(`Ошибка загрузки данных для ИНН ${inn}:`, error.message);
                }
            }

            const requestsUsedToday = tracker.getCount(apiKey);
            const newRemainingRequests = tracker.getRemainingRequests(apiKey);

            return res.status(200).json({
                status: 'ok',
                data: results,
                requestsUsedToday,
                remainingRequests: newRemainingRequests
            });
        }

        // Неизвестный endpoint
        console.log('Unknown endpoint:', path);
        return res.status(404).json({
            status: 'error',
            message: `Endpoint не найден: ${path}`
        });

    } catch (error) {
        console.error('Handler error:', error);
        const requestsUsedToday = body && body.apiKey ? tracker.getCount(body.apiKey) : 0;
        const remainingRequests = body && body.apiKey ? tracker.getRemainingRequests(body.apiKey) : 100;

        return res.status(200).json({
            status: 'error',
            message: error.message || 'Внутренняя ошибка сервера',
            requestsUsedToday,
            remainingRequests
        });
    }
};
