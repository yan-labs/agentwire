# Infrastructure

Verified 2026-10-27. Account f796e83dc0009a24dadf3f5016b8a1ff; zone ed0e1bedf6cb69fd4190fe8ff26fa739 active; NS albert/kay.ns.cloudflare.com.

- Site: agents-hot-site; agents.hot and www custom domains. API: agentwire; api custom domain and root API routes; workers.dev enabled, preview URLs disabled.
- Original Room and Directory namespaces retained. Directory D1: 74066439-a6d6-44f2-a3ac-8f1fc972fdfd; migrations 0001/0002 applied. Pending KV a626151091ac4531b580dcc8d9ad864e. R2 agents-hot-unread: custom pending domain, r2.dev off, GET/HEAD CORS, edge and browser TTL 60 seconds.
- SSL strict, HTTPS redirect, TLS>=1.2, HSTS one day without includeSubDomains/preload. AI bot blocking / Bot Fight / managed robots disabled; real crawler probes pass.
- WAF gate: ruleset 2d00ebee93904df495cc59e117599361 / rule d3445f9482194c708e830bc70c014ee3. Existing rules preserved; only specific rules appended/updated.
- Budget account period starts day 9; 80/85/90/95% thresholds; CPU control cap 40M ms includes up to $0.20 beyond the paid-plan 30M allowance. All other caps remain included amounts. Account-wide usage and lagged alerts are not a hard spending cap.
- $0.10 budget email; $1 budget email plus native Webhook → /internal/billing-alert. Forged payload rejected; valid/replayed alerts latch L4, WAF readback on, Cron cannot unlock; three pinned protected pending paths remain 200 at workers.dev. Explicit restore completed and gate read back off.
- OPERATOR_TOKEN retained, never read or replaced. New secrets stored only on Worker; names TURNSTILE_SECRET, CF_ANALYTICS_TOKEN, CF_GUARD_TOKEN, BILLING_ALERT_SECRET. Analytics/WAF API tokens have account/zone scoped permissions.
- Rollback: 889019cf-c9ef-456d-a192-c124a64aa4b2 is the old pre-migration source. It was used before import for preflight recovery. After new D1 writes, do not restore the old directory implementation blindly: retain new data and forward-fix or reconcile first. For application-only rollback after launch, use the previous compatible scale version through wrangler rollback. WAF changes roll back by single rule ID; never replace a zone ruleset wholesale.
