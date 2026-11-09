'use strict';
/** 进程内固定窗口限流。单机够用；多实例部署时应换成 Redis（见 docs/DEPLOY.md）。 */
class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    if (this.timer.unref) this.timer.unref();
  }
  /**
   * @returns {{ok: boolean, remaining: number, retryAfter: number}}
   */
  hit(key, limit, windowMs) {
    const nowMs = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || nowMs >= bucket.resetAt) {
      bucket = { count: 0, resetAt: nowMs + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const ok = bucket.count <= limit;
    return {
      ok,
      remaining: Math.max(0, limit - bucket.count),
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - nowMs) / 1000))
    };
  }
  sweep() {
    const nowMs = Date.now();
    for (const [key, bucket] of this.buckets) if (nowMs >= bucket.resetAt) this.buckets.delete(key);
  }
  reset() { this.buckets.clear(); }
}

module.exports = { RateLimiter };
