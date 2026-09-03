# Papakha Exchange Mini App

Telegram Mini App с актуальными предварительными курсами, четырёхшаговой заявкой и закрытой панелью управления сделками.

## Состав

- `index.html`, `styles.css`, `app.js` — клиентское Mini App;
- `rates-core.js` — предварительный расчёт в интерфейсе;
- `admin/` — закрытая панель владельца и менеджеров;
- `worker/` — Cloudflare Worker, D1, KV, Queue и Telegram-уведомления.

## Что реализовано

- актуальные значения USDT/RUB, BTC/USDT и ETH/USDT с обновлением раз в 30 секунд;
- предварительный курс Papakha: продажа USDT клиенту `ask + процент`, покупка у клиента `bid − процент`;
- серверный пересчёт суммы без доверия к расчёту браузера;
- создание заявки с защитой от дублей, фиксацией курса и неизменяемой историей;
- статусы от новой заявки до завершения или проверки;
- принятие курса и отметка об оплате в Mini App;
- роли `owner`, `manager`, `viewer`, защищённая сессия и CSRF;
- настройки процента для новых сделок без пересчёта ранее зафиксированных;
- надёжная очередь Telegram-уведомлений с повторными попытками;
- нейтральный публичный API без сведений о поставщике котировок;
- только ручное исполнение сделки: автоматическая отправка активов отключена.
- подготовленная KYC-интеграция Sumsub Sandbox: документы и биометрия не сохраняются в Papakha, а обязательная проверка по умолчанию выключена.

## Публичный API

- `GET /health` → `{ "ok": true, "service": "papakha-rates" }`;
- `GET /rates` → `{ "ok": true, "updatedAt": "…", "stale": false, "rates": {} }`.

Публичные ошибки возвращают нейтральные коды. Адрес поставщика курса хранится только в серверной переменной `RATE_PROVIDER_API_URL`.

## Локальный запуск

1. Скопировать `worker/.dev.vars.example` в `worker/.dev.vars` и заполнить локальные секреты.
2. В папке `worker` применить локальные миграции и тестового администратора командами `pnpm db:migrate:local` и `pnpm db:seed:local`.
3. Запустить Worker: `pnpm dev`.
4. Раздать папку `telegram-mini-app` локальным HTTP-сервером на `http://127.0.0.1:8080`.
5. Mini App открыть по `/`, админ-панель — по `/admin/`.

Тестовый заголовок пользователя разрешён только в явной локальной среде `dev`. Production-конфигурация его блокирует.

## Production

- Mini App: `https://jsmzj6dd9v-bit.github.io/papakha-telegram-mini-app/`;
- API: `https://papakha-rates.jsmzj6dd9v.workers.dev`;
- админ-панель: `https://papakha-admin.jsmzj6dd9v.workers.dev`.

Worker `papakha-rates` подключён к отдельным KV `papakha-rates-cache`, D1 `papakha-deals` и Queue `papakha-notifications`. Реальные идентификаторы ресурсов записаны в production-конфигурации, а секреты находятся только в Cloudflare Workers Secrets. Предыдущие Worker и KV сохранены как аварийный резерв и не удаляются без отдельного подтверждения владельца.

Финальный курс всегда подтверждает менеджер. KZT, AED и USD автоматически не рассчитываются.

## KYC Sandbox

После применения миграции `0003_identity_verifications.sql` задайте `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY` и `SUMSUB_WEBHOOK_SECRET` как Workers Secrets. В кабинете Sumsub создайте Sandbox-уровень `papakha-sandbox` с документом, selfie/liveness и AML и направьте подписанный `HMAC_SHA256_HEX` webhook на `/api/verification/webhook`.

Первое развёртывание использует `KYC_ENFORCEMENT=off`. Для тестирования только владельцем переключите значение на `owner_only`; список тестовых ID находится в `KYC_TEST_TELEGRAM_IDS`. Значение `all` намеренно блокируется кодом до юридической готовности production-проверки. В Sandbox нельзя загружать реальные документы.
