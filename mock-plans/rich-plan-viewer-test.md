# Rate limiting for the public API

## Context

The public API has no rate limiting today. Last month a single integration partner sent **~40k requests per minute** during a bulk sync, which saturated the Postgres connection pool and caused a 12-minute partial outage for every other client (see incident `INC-2291`). Support also reports that a handful of scrapers hit the `/v2/products` search endpoint around the clock, which keeps p95 latency high even on quiet days.

This plan adds per-client rate limiting at the API gateway layer, backed by Redis, with limits that can be tuned per plan tier without a deploy. The goal is to protect shared infrastructure first and to give well-behaved clients clear, predictable feedback (`429` responses with `Retry-After` and `RateLimit-*` headers) so they can back off on their own.

> **Non-goal:** this is not a billing or quota system. Monthly usage caps stay in the billing service and are out of scope here.

### Current request flow

```
client ──► load balancer ──► api-gateway ──► service (products, orders, …) ──► postgres
                                  │
                                  └── auth middleware (resolves API key → client_id, tier)
```

The limiter will sit in `api-gateway`, right after the auth middleware, so every request already carries a resolved `client_id` and `tier`.

## Goals

- Stop any single client from degrading the API for everyone else
- Return standard headers so SDKs can implement backoff automatically
- Let support raise or lower a client's limit in under a minute, with no deploy
- Add **less than 2 ms** to p99 gateway latency

## Limits by tier

| Tier       | Requests / minute | Burst | Concurrent searches | Notes                            |
|------------|------------------:|------:|--------------------:|----------------------------------|
| Free       |                60 |    20 |                   2 | Shared IP limit applies too      |
| Starter    |               600 |   100 |                   5 |                                  |
| Business   |             3 000 |   500 |                  20 | Default for most partners        |
| Enterprise |            12 000 | 2 000 |                  50 | Overridable per client           |
| Internal   |         unlimited |     — |                   — | Service-to-service tokens only   |

Overrides live in the `client_limits` table and take precedence over the tier defaults.

## Plan

### 1. Choose the algorithm and key layout

Status: done

We compared three approaches:

| Algorithm            | Accuracy | Redis ops / request | Burst handling | Verdict    |
|----------------------|----------|--------------------:|----------------|------------|
| Fixed window         | Low      |                   1 | Poor at edges  | Rejected   |
| Sliding window log   | Exact    |                 3–4 | Good           | Too costly |
| **Token bucket (GCRA)** | High  |                   1 | Good           | **Chosen** |

GCRA needs a single key per client and one atomic `EVAL` per request:

- Key: `rl:{client_id}:{bucket}` where `bucket` is `default` or `search`
- Value: the theoretical arrival time (TAT) as a millisecond timestamp
- TTL: set to the burst window so idle clients cost no memory

### 2. Write the Redis Lua script

Status: done

- [x] Implement GCRA in Lua so the check-and-update is atomic
- [x] Return `allowed`, `remaining`, `reset_after_ms` and `retry_after_ms`
- [x] Unit test the script against a local Redis with a fake clock

```lua
-- KEYS[1] = bucket key, ARGV = now_ms, emission_interval_ms, burst_tolerance_ms
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local tolerance = tonumber(ARGV[3])

local tat = tonumber(redis.call("GET", KEYS[1]) or now)
local new_tat = math.max(tat, now) + interval
local allow_at = new_tat - tolerance

if now < allow_at then
  return { 0, 0, tat - now, allow_at - now }
end

redis.call("SET", KEYS[1], new_tat, "PX", tolerance + interval)
return { 1, math.floor((tolerance - (new_tat - now)) / interval), new_tat - now, 0 }
```

### 3. Add the limiter middleware to the gateway

Status: in progress

The middleware runs after authentication and before routing. It looks up the client's effective limits (override → tier default), runs the script, and either forwards the request or answers `429`.

- [x] Middleware skeleton and config loading
- [x] Effective-limit resolution with a 30 s in-process cache
- [ ] Separate `search` bucket for `/v2/products/search` and `/v2/orders/search`
- [ ] Fail-open behaviour when Redis is unreachable

```ts
export function rateLimit(limits: LimitResolver, redis: RedisClient): Middleware {
  return async (req, res, next) => {
    const { clientId, tier } = req.auth
    const bucket = isSearch(req.path) ? 'search' : 'default'
    const limit = await limits.resolve(clientId, tier, bucket)

    if (limit.unlimited) return next()

    const verdict = await redis.gcra(`rl:${clientId}:${bucket}`, limit).catch(() => FAIL_OPEN)
    setRateLimitHeaders(res, limit, verdict)

    if (!verdict.allowed) {
      res.setHeader('Retry-After', Math.ceil(verdict.retryAfterMs / 1000))
      return res.status(429).json({ error: 'rate_limited', retry_after_ms: verdict.retryAfterMs })
    }
    return next()
  }
}
```

> ⚠️ Fail-open is deliberate: an outage of the limiter must never become an outage of the API. We alert on it instead (see step 6).

### 4. Response headers and error body

Every response, allowed or not, carries the IETF draft headers:

| Header                | Example | Meaning                                   |
|-----------------------|---------|-------------------------------------------|
| `RateLimit-Limit`     | `600`   | Requests allowed in the current window    |
| `RateLimit-Remaining` | `412`   | Requests left before throttling           |
| `RateLimit-Reset`     | `37`    | Seconds until the bucket is full again    |
| `Retry-After`         | `4`     | Only on `429`: seconds to wait            |

The `429` body follows our standard error shape:

```json
{
  "error": "rate_limited",
  "message": "Too many requests for this API key. Retry after 4 seconds.",
  "retry_after_ms": 3820,
  "docs": "https://docs.example.com/api/rate-limits"
}
```

### 5. Admin endpoint for per-client overrides

Support needs to change a client's limits without engineering. We add two internal endpoints behind the admin auth:

1. `GET /internal/clients/:id/limits` returns the effective limits and where each value comes from (`tier` or `override`)
2. `PUT /internal/clients/:id/limits` upserts an override row and publishes an invalidation on the `limits:changed` channel, so every gateway instance drops its cached entry within a second

Validation rules:

- `requests_per_minute` must be between **1** and **100 000**
- `burst` must not exceed `requests_per_minute`
- An override can carry an `expires_at`; expired overrides are ignored and cleaned up nightly

### 6. Metrics, dashboards and alerts

- Counter `gateway_rate_limit_decisions_total{tier, bucket, outcome}`
- Histogram `gateway_rate_limit_check_seconds` for the Redis round trip
- Gauge `gateway_rate_limit_fail_open` set to `1` while Redis is unreachable

Alerts:

| Alert                          | Condition                              | Severity |
|--------------------------------|----------------------------------------|----------|
| `RateLimiterFailOpen`          | fail-open gauge = 1 for 2 min          | page     |
| `RateLimiterSlow`              | p99 check latency > 5 ms for 10 min    | ticket   |
| `ClientThrottledHeavily`       | one client > 50 % throttled for 15 min | ticket   |

### 7. Roll out in shadow mode, then enforce

Rollout happens in three phases, each behind the `rate_limit_mode` flag:

1. **Shadow** (one week): compute decisions and emit metrics, never block
2. **Enforce for Free and Starter** (one week): real `429`s for the two lowest tiers only
3. **Enforce everywhere**: all tiers, after reviewing the shadow data with the partner team

Before phase 3, account managers email every Business and Enterprise client that the shadow data shows would have been throttled, with their numbers and a link to the docs.

### 8. ~~Per-endpoint cost weights~~

Dropped for now: weighting expensive endpoints (search = 5 tokens, export = 20) is a good idea but doubles the configuration surface. The separate `search` bucket from step 3 covers the worst case. Revisit after a month of enforcement data.

### 9. Update the public docs and SDKs

- New page *Rate limits* in the API reference, with the tier table and header descriptions
- JavaScript and Python SDKs: automatic retry on `429` honouring `Retry-After`, capped at 3 attempts with jitter
- Changelog entry and a banner in the developer dashboard two weeks before phase 3

## Risks

- **Shared NAT on Free tier:** many free clients behind one corporate IP could hit the IP-level limit together. Mitigation: the IP limit only applies to unauthenticated requests.
- **Redis as a hot path:** a slow Redis adds latency to every request. Mitigation: dedicated instance, 50 ms client timeout, fail-open.
- **Clock skew between gateway nodes:** GCRA uses the caller's clock. Mitigation: pass Redis `TIME` instead of the local clock if skew alerts fire.

## Verification

- Load test with `k6` at 2× the Enterprise limit and check that throttled requests get `429` within the burst tolerance
- Kill the Redis instance during the load test and confirm traffic keeps flowing and the fail-open alert fires
- Compare p99 gateway latency before and after on the staging dashboard

```bash
k6 run --vus 200 --duration 5m \
  -e API_KEY="$ENTERPRISE_TEST_KEY" \
  -e TARGET=https://staging-api.example.com/v2/products \
  scripts/load/rate-limit.js
```

## Open questions

- Should internal service tokens be limited at all, or only monitored?
- Do we expose a `GET /v2/rate-limit` endpoint so clients can check their status without spending a request?

---

*Owner: platform team · Last updated: 2026-11-11*
