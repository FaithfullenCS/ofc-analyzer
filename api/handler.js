const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Класс для отслеживания запросов
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
}

// Endpoint: Проверка подключения
app.post('/api/check-connection', async (req, res) => {
  try {
    const { apiKey } = req.body;

    if (!apiKey) {
      return res.json({
        status: 'error',
        message: 'API ключ не предоставлен'
      });
    }

    // Простой запрос для проверки валидности ключа
    // Используем тестовый ИНН Яндекса
    await callCheckoAPI('/company?inn=7735560386', apiKey);

    const requestsUsedToday = tracker.getCount(apiKey);
    const remainingRequests = tracker.getRemainingRequests(apiKey);

    res.json({
      status: 'ok',
      message: 'Подключение успешно',
      requestsUsedToday,
      remainingRequests
    });

  } catch (error) {
    res.json({
      status: 'error',
      message: error.message
    });
  }
});

// Endpoint: Загрузка информации о компании
app.post('/api/company', async (req, res) => {
  try {
    const { apiKey, inn } = req.body;

    if (!apiKey || !inn) {
      return res.json({
        status: 'error',
        message: 'API ключ и ИНН обязательны'
      });
    }

    // Проверка лимита
    const remainingRequests = tracker.getRemainingRequests(apiKey);
    if (remainingRequests <= 0) {
      return res.json({
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

    res.json({
      status: 'ok',
      data,
      requestsUsedToday,
      remainingRequests: newRemainingRequests
    });

  } catch (error) {
    const requestsUsedToday = tracker.getCount(req.body.apiKey);
    const remainingRequests = tracker.getRemainingRequests(req.body.apiKey);

    res.json({
      status: 'error',
      message: error.message,
      requestsUsedToday,
      remainingRequests
    });
  }
});

// Endpoint: Загрузка финансовых данных
app.post('/api/finances', async (req, res) => {
  try {
    const { apiKey, inn } = req.body;

    if (!apiKey || !inn) {
      return res.json({
        status: 'error',
        message: 'API ключ и ИНН обязательны'
      });
    }

    // Проверка лимита
    const remainingRequests = tracker.getRemainingRequests(apiKey);
    if (remainingRequests <= 0) {
      return res.json({
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

    res.json({
      status: 'ok',
      data,
      requestsUsedToday,
      remainingRequests: newRemainingRequests
    });

  } catch (error) {
    const requestsUsedToday = tracker.getCount(req.body.apiKey);
    const remainingRequests = tracker.getRemainingRequests(req.body.apiKey);

    res.json({
      status: 'error',
      message: error.message,
      requestsUsedToday,
      remainingRequests
    });
  }
});

// Endpoint: Батч-загрузка нескольких компаний
app.post('/api/batch', async (req, res) => {
  try {
    const { apiKey, innList } = req.body;

    if (!apiKey || !Array.isArray(innList) || innList.length === 0) {
      return res.json({
        status: 'error',
        message: 'API ключ и массив ИНН обязательны'
      });
    }

    const requiredRequests = innList.length * 2; // 2 запроса на компанию
    const remainingRequests = tracker.getRemainingRequests(apiKey);

    if (remainingRequests < requiredRequests) {
      return res.json({
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
        // Загрузка информации о компании
        const companyData = await callCheckoAPI(`/company?inn=${inn}`, apiKey);
        tracker.increment(apiKey);

        // Загрузка финансовых данных
        const financeData = await callCheckoAPI(`/finances?inn=${inn}`, apiKey);
        tracker.increment(apiKey);

        results.push({
          company: companyData,
          finances: financeData
        });

      } catch (error) {
        console.error(`Ошибка загрузки данных для ИНН ${inn}:`, error.message);
        // Продолжаем загрузку остальных компаний
      }
    }

    const requestsUsedToday = tracker.getCount(apiKey);
    const newRemainingRequests = tracker.getRemainingRequests(apiKey);

    res.json({
      status: 'ok',
      data: results,
      requestsUsedToday,
      remainingRequests: newRemainingRequests
    });

  } catch (error) {
    const requestsUsedToday = tracker.getCount(req.body.apiKey);
    const remainingRequests = tracker.getRemainingRequests(req.body.apiKey);

    res.json({
      status: 'error',
      message: error.message,
      requestsUsedToday,
      remainingRequests
    });
  }
});
