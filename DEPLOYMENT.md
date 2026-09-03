# Развёртывание Papakha Exchange

Frontend публикуется GitHub Actions из ветки `main`. Cloudflare Workers разворачиваются вручную после подтверждения владельца.

## Production-ресурсы Cloudflare

- Worker: `papakha-rates`;
- KV: `papakha-rates-cache`;
- D1: `papakha-deals`;
- Queue: `papakha-notifications`;
- Worker админ-панели: `papakha-admin`.

Реальные идентификаторы KV и D1 уже записаны в `worker/wrangler.jsonc`. Владелец с Telegram ID `8321831931` добавлен в D1 с ролью `owner`.

## Секреты Worker

- `TELEGRAM_BOT_TOKEN` — токен существующего бота;
- `RATE_PROVIDER_API_URL` — серверный адрес поставщика котировок;
- будущие ключи внешнего исполнения — только после отдельного согласования.
- `SUMSUB_APP_TOKEN`, `SUMSUB_SECRET_KEY`, `SUMSUB_WEBHOOK_SECRET` — только Sandbox до отдельного юридического допуска.

Секреты задаются через Workers Secrets и не записываются в файлы проекта.

## Повторная публикация

1. Запустить тесты Worker и админ-панели.
2. Применить новые D1-миграции, если они появились.
3. Развернуть `papakha-rates` и проверить `/health` и `/rates`.
4. Развернуть `papakha-admin` после backend, поскольку он использует Service Binding.
5. Отправить проверенный коммит в `main` и дождаться GitHub Pages workflow.
6. Пройти тестовую сделку без реального перевода в Telegram Desktop и мобильной версии.
7. Убедиться, что frontend использует новый API и не обращается к резервному Worker.

KYC разворачивается сначала с `KYC_ENFORCEMENT=off`. После применения миграции, сохранения Sandbox-секретов и настройки подписанного webhook допускается `owner_only` для Telegram ID `8321831931`. Глобальный режим `all` кодом заблокирован.

Старые Worker и KV не удаляются и не переименовываются. Их удаление возможно только после отдельного подтверждения владельца и проверки новой production-версии.
