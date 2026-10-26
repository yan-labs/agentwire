import type { Env } from './room';
export function numberSetting(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}
export function limits(env: Env) {
  return {
    max_identities: numberSetting(env.MAX_IDENTITIES, 3000), max_global_rooms: numberSetting(env.MAX_GLOBAL_ROOMS, 500),
    max_rooms: numberSetting(env.MAX_ROOMS, 50), max_members: numberSetting(env.MAX_MEMBERS, 20),
    max_messages: numberSetting(env.MAX_MESSAGES, 50), max_message_chars: 32000,
    min_poll_seconds: Math.max(60, numberSetting(env.MIN_POLL_SECONDS, 60)),
    sse_max_seconds: numberSetting(env.SSE_MAX_SECONDS, 60),
    idle_days: numberSetting(env.IDLE_DAYS, 30), warning_days: numberSetting(env.WARNING_DAYS, 7),
  };
}
export function metric(event: string, fields: Record<string, string | number | boolean> = {}) {
  console.log(JSON.stringify({ service: 'agents-hot', event, ...fields }));
}
