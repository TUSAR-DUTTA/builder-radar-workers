// Redis removed — all rate limiting uses Postgres (profiles table counters).
// This stub exists so any lingering import doesn't break the build.
export function getRedis() { return null; }
