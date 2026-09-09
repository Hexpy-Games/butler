# Board lane filtering — production correction

## Cause

The UI requested each lane independently, but the production App gateway still ran code loaded on September 9 at 17:52 KST, before lane filtering was implemented. Main/embed supervisor rollout did not restart this separately managed gateway. A health-only check missed that mismatch.

Observed on the live records endpoint before correction: `lane=done&limit=10` returned mixed active/blocked/done/other cards, and an invalid lane returned a ready page rather than HTTP 400. The current-source HTTP regression already passed. Browser and Electron bridge both preserve the query; no client filtering workaround is needed.

## Plan and action

1. Trace the public UI/bridge/HTTP/store path and compare the current-source test to production.
2. Use `butler gateway restart app` to replace only the registered App gateway, preserving main/embed runtime work and project records.
3. Verify the changed endpoint, not only health: all six lanes across Work/Plan/Task, disjoint item IDs, at most ten initial cards, same-lane subsequent pages, invalid-lane rejection.
4. Extend the existing HTTP regression for the three kinds and six lanes; retain independent server-owned pagination.

## Results

- Gateway replaced through the operator CLI: old PID 11896, new PID 67963, online at September 10 approximately 07:27 KST.
- Live production checks pass for all 18 kind/lane combinations, including empty lanes. All available second pages remain within their lane without repeating the first page's IDs. Invalid lane returns HTTP 400.
- Focused dashboard integration suite: 8 tests passed, 0 failed, 142 assertions.
- No production filtering code change was required; the existing correction is now loaded by the actual API process.
- Acceptance review: the reported duplicate-across-columns behavior is closed at the public endpoint. An already-open board may retain its fetched page until refreshed. Project or conversation data was not rewritten.

For future dashboard rollout, a main/embed restart plus health response is insufficient: check the independent App gateway lifecycle and exercise the changed dashboard endpoint after deployment.
