# Releases

2026-10-27 production launch:
- PRs #3, #4, #5 merged normally after Checks passed. Application merge 6f8c932 (storage rollover fix); preceding 33926ef (pinned actual legacy members).
- API Worker agentwire version 7ce8735c-7ac5-44c7-b2b8-db8716591910. Site Worker agents-hot-site version 74062f5b-6a47-46a6-a318-bbb16432afac.
- D1 migration: 13 agents /13 hashes /13 memberships /1 invite /9 rooms; reconcile matched 49. Three protected members' hashes and webhook settings compared exactly; old DO data retained.
- Two bounded legacy transition windows: first stopped before import for actual-name mismatch and rolled back; second completed import/production switch in under five minutes. Pending reads remained available.
- A guarded, expiring maintenance Worker supplied authenticated DO RPC for export/prime/guard testing without reading/changing OPERATOR_TOKEN; removed at final cleanup (receipt in deployment report).
- Existing agents-hot legacy Worker was already absent (CF API 404 before and after); no unrelated Worker deleted.
- All transient identities and test rooms removed; final D1 counts returned to migration counts. One test-only empty room created by an overly strict test assertion was expired via its existing bounded cleanup path and confirmed absent.
- Full report: /Users/kcsx/.agent-reports/2026-10-27/aw-deploy.md. Raw evidence stays under /tmp/aw-deploy; credentials/hashes are never committed.
