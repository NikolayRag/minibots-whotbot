# Process Tracker Worker

TypeScript-библиотека учёта процессов с Cloudflare Workers + D1 и Telegram-адаптером.

## Команды

- `/go "Название" описание` — создать процесс; текущий процесс ставится на паузу.
- `/stop` — завершить текущий процесс и возобновить последний приостановленный (LIFO).
- `/what` — отчёт по всей истории.

Команды обрабатываются в личном контексте пользователя Telegram (`from.id`), независимо от чата, в котором они вызваны. Это соответствует одному пользовательскому пространству при использовании inline-вызовов. Telegram inline query сам по себе не принимает `/go` как обычное сообщение; команды следует отправлять боту/в чате. Для настоящего inline-интерфейса потребуется отдельный `inline_query` адаптер, который возвращает варианты действий, а подтверждение действия обрабатывается через callback/message.

## Модель данных

- `processes`: неизменяемая идентичность процесса и текущее состояние.
- `intervals`: каждый интервал выполнения. При паузе интервал закрывается; при возобновлении открывается новый.
- `user_state`: активный процесс, LIFO-стек и счётчик последовательности.

Все времена — Unix timestamp в миллисекундах UTC. Интервалы сохраняются в базе; runtime Worker не используется для измерения времени.

## Развёртывание

Требуются Node.js 20+ и аккаунт Cloudflare.

1. Распакуйте проект и в каталоге проекта выполните:

   ```bash
   npm install
   npx wrangler login
   ```

2. Создайте D1:

   ```bash
   npm run db:create
   ```

   Скопируйте `database_id` из вывода в `wrangler.toml`, заменив `REPLACE_WITH_DATABASE_ID`.

3. Примените схему:

   ```bash
   npm run db:migrate:remote
   ```

   Для локальной разработки: `npm run db:migrate:local`.

4. Задайте секрет токена:

   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   ```

   Вставьте токен от BotFather. Не помещайте токен в `wrangler.toml` и репозиторий.

5. (Рекомендуется) задайте секрет вебхука — произвольную длинную случайную строку:

   ```bash
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

   Сохраните то же значение для шага 7.

6. Разверните Worker:

   ```bash
   npm run deploy
   ```

   Запишите выданный URL, например `https://process-tracker-worker.<subdomain>.workers.dev`.

7. Установите Telegram webhook, подставив токен, URL и то же значение `SECRET` (если задавали):

   ```bash
   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" ^
     -H "Content-Type: application/json" ^
     -d "{\"url\":\"https://YOUR-WORKER-URL/telegram\",\"secret_token\":\"YOUR_SECRET\"}"
   ```

   В PowerShell можно выполнить команду одной строкой; в bash замените `^` на `\`. Если секрет вебхука не задавали, уберите поле `secret_token`.

8. Напишите боту `/go "Тест" описание`, затем `/what` и `/stop`.

## Библиотека отдельно от Telegram

```ts
import { createProcessLibrary } from "./library";
import { D1ProcessStorage } from "./d1-storage";

const processes = createProcessLibrary(new D1ProcessStorage(env.DB));

await processes.start({
  userId: "telegram-user-id",
  title: "Работа",
  description: "Короткое описание",
  metadata: { project: "alpha" }
});

await processes.stop("telegram-user-id");
const report = await processes.report("telegram-user-id", {
  from: Date.parse("2026-10-01T00:00:00Z"),
  to: Date.now()
});
```

Интерфейс `ProcessLibrary` в `src/types.ts` — контракт для любого интерпретатора. `StorageAdapter` в `src/library.ts` позволяет заменить D1 другим хранилищем.

## Семантика отчёта по периоду

Активная длительность считается только по пересечению интервалов с `[from, to]`. Если `from` не задан — от начала истории; если `to` не задан — до момента отчёта. Начальное время процесса остаётся исходным временем создания/первого старта. Состояние и список «последний процесс» отражают текущее состояние, даже если выбранный отчётный период исторический.

## Примечания

- В этой минимальной версии метаданные принимаются библиотекой и хранятся как JSON, но Telegram-команда `/go` задаёт только название и описание.
- Транзакционная последовательность реализована через `D1Database.batch`. При высокой конкуренции команд одного пользователя стоит добавить Durable Object на пользователя либо транзакционную сериализацию, поскольку чтение стека перед `batch` не блокирует параллельное чтение.
- Время в отчёте форматируется UTC. Библиотечные timestamp-значения — миллисекунды.
