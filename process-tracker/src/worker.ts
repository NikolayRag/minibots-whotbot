import { D1ProcessStorage } from "./d1-storage";
import { createProcessLibrary } from "./library";
import type { Report } from "./types";

interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  APP_MODE?: string;
}
interface TelegramUpdate {
  message?: {
    from?: { id: number; is_bot?: boolean };
    chat?: { id: number; type?: string };
    text?: string;
    date?: number;
  };
}
interface TelegramResponse { ok: boolean; result?: unknown; description?: string }

const html = (s: string) => s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const duration = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [d ? `${d}д` : "", h ? `${h}ч` : "", m ? `${m}м` : "", `${s}с`].filter(Boolean).join(" ");
};
const date = (ms: number | null) => ms === null ? "—" : new Date(ms).toISOString().replace("T"," ").replace(".000Z"," UTC");
function parseGo(text: string): { title: string; description: string } {
  const rest = text.replace(/^\/go(?:@\w+)?\s*/i, "");
  const match = rest.match(/^"([^"]+)"(?:\s+([\s\S]*))?$/);
  if (match) return { title: match[1].trim(), description: (match[2] ?? "").trim() };
  const fallback = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!fallback) throw new Error('Формат: /go "название" описание');
  return { title: fallback[1], description: (fallback[2] ?? "").trim() };
}
function formatReport(r: Report): string {
  const lines = [
    "<b>Завершённые</b>",
    `Количество: ${r.completed.count}`,
    `Суммарное активное время: ${duration(r.completed.totalActiveDurationMs)}`,
    "",
    `<b>Приостановленные: ${r.paused.count}</b>`
  ];
  if (!r.paused.processes.length) lines.push("Нет");
  for (const p of r.paused.processes) {
    lines.push(`• <b>${html(p.title)}</b> — ${duration(p.activeDurationMs)}; первый старт: ${date(p.startedAt)}`);
  }
  if (r.paused.oldestFirstStartAt !== null) {
    lines.push(`Самый ранний старт в списке: ${date(r.paused.oldestFirstStartAt)}`);
    lines.push(`С того момента: ${duration(r.paused.oldestElapsedSinceStartMs ?? 0)}`);
  }
  lines.push("", "<b>Последний процесс</b>");
  if (!r.latest) lines.push("Нет процессов");
  else {
    lines.push(`Название: <b>${html(r.latest.title)}</b>`);
    lines.push(`Начало: ${date(r.latest.startedAt)}`);
    lines.push(`Активное время: ${duration(r.latest.activeDurationMs)}`);
    lines.push(`Окончание: ${r.latest.state === "stopped" ? date(r.latest.endedAt) : "running"}`);
    lines.push(`Состояние: ${r.latest.state}`);
  }
  return lines.join("\n");
}
async function telegram(env: Env, method: string, body: unknown): Promise<TelegramResponse> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  return await response.json() as TelegramResponse;
}
async function send(env: Env, chatId: number, text: string): Promise<void> {
  await telegram(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (request.method !== "POST" || url.pathname !== "/telegram") return new Response("Not found", { status: 404 });
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (supplied !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
    }
    let update: TelegramUpdate;
    try { update = await request.json() as TelegramUpdate; }
    catch { return new Response("Bad Request", { status: 400 }); }
    const msg = update.message;
    if (!msg?.text || !msg.from || msg.from.is_bot || !msg.chat) return new Response("ok");
    const userId = String(msg.from.id);
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const lib = createProcessLibrary(new D1ProcessStorage(env.DB));

    try {
      if (/^\/go(?:@\w+)?(?:\s|$)/i.test(text)) {
        const parsed = parseGo(text);
        const process = await lib.start({ userId, ...parsed });
        await send(env, chatId, `Запущен: <b>${html(process.title)}</b>`);
      } else if (/^\/stop(?:@\w+)?(?:\s|$)/i.test(text)) {
        const stopped = await lib.stop(userId);
        if (!stopped) await send(env, chatId, "Нет активного процесса.");
        else {
          const report = await lib.report(userId);
          const resumed = report.latest?.state === "running" && report.latest.id !== stopped.id
            ? report.latest
            : null;
          await send(env, chatId, `Остановлен: <b>${html(stopped.title)}</b>${resumed ? `\nВозобновлён: <b>${html(resumed.title)}</b>` : ""}`);
        }
      } else if (/^\/what(?:@\w+)?(?:\s|$)/i.test(text)) {
        await send(env, chatId, formatReport(await lib.report(userId)));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Неизвестная ошибка";
      await send(env, chatId, `Ошибка: ${html(message)}`);
    }
    return new Response("ok");
  }
};
