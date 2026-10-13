/**
 * Фоновая загрузка без открытой админки: каждый шаг (до ~45 с) в конце сам запускает следующий,
 * пока в задачах есть работа. Защита: шаги идут только при активных задачах, номер шага ограничен,
 * одновременно задачу обрабатывает только один шаг (блокировка в worker.tick).
 */
export const CHAIN_MAX = 400; // ~5 часов непрерывной загрузки — с запасом на самый большой магазин

export async function kickWorker(base, step = 1) {
  if (!process.env.CRON_SECRET || !base || step > CHAIN_MAX) return false;
  try {
    // ждём только, чтобы запрос ушёл; сам шаг работает на сервере независимо от нас
    await fetch(`${base}/api/cron?chain=${step}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(2500) });
  } catch { /* таймаут ожидания — нормально: следующий шаг уже запущен */ }
  return true;
}
