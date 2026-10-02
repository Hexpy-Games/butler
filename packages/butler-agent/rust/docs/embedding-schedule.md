# Event-driven memory embeddings

Conversation completion still runs semantic projection and the hot-cache stage
immediately. Vector units remain durable `pending` rows until batch admission.
A deferred vector backlog is normal work, not a failed projection. Recall can
still find recent facts through text/alias/lexical lanes, hot-cache context and
active explicit rules before vectors exist. No ranking weights or expansion
rules changed.

## Verified baseline facts

At baseline `09ffe9679fa5`, crate-relative source locations were:

- `butler-memory/src/cognition/completion/consumer/process.rs:114-160` ran
  semantic projection, hot cache, then vectors on each productive poll;
  `process/vector.rs:167` limited each request to four embeddings.
- `butler-agent/src/host/memory_jobs/sync.rs:170` repolled after 1,500 ms;
  `host/embedding/worker.rs:17` used a 900-second idle exit.
- `butler-agent/src/host/embedding/owner.rs:323` spawned lazily on the first
  request; initialization at `:333` already outlived a caller deadline.
- `butler-memory/src/cognition/memory_recall/service.rs:289` limited the vector
  lane to 750 ms. `generation_vectors/compatibility.rs:10-42` accepts the
  adopted JavaScript identity; that fix was present in baseline main.
- `plans/post-0.1.0/02-embedding-model.md:9` records a historical 2.4-second
  Mac load, and `:17-18` proposes reaping and warm batches with maximum delay.

The supplied +16.6 pp gold hit@5 result and 144 units/four days are owner
observations used as task inputs, not independently reproduced here.

## Admission and lifetime

- A ready embedding owner admits background quanta. Completing cold worker
  initialization signals the consumer, including when the initiating recall
  has already reached its vector-lane deadline.
- The existing daily consolidation window explicitly drains eligible work,
  yielding between quanta and using the same consumer admission, cancellation
  and consolidation leases. Unavailable embeddings do not stop text/cache
  maintenance; retry/failure state stays durable and is reported in health.
- New semantic/cache progress checks the bounded pending-state index for
  **more than 1,024 units**, or an oldest eligible pending job at least
  **48 hours old**. Once admitted, a cap/age drain continues until no eligible
  vector work remains. Age is checked on work events, never by an idle timer;
  the daily window covers otherwise-idle backlogs.

The constants are exported as `VECTOR_BACKLOG_CAP` and
`VECTOR_MAX_AGE_HOURS`. The supplied observation of 144 units over four light
usage days implies roughly 36/day. A tenfold heavy day would produce about
360 units, below the cap; that is an extrapolation, not a measured heavy-day
workload. The daily window normally drains before the two-day safeguard.
Explicit rebuild consumers retain their maintenance admission.

Each quantum still covers at most four units and yields to the existing
interactive-priority embedding queue. Empty/deferred vector work adds no idle
vector probe, lease, write, timer or fast poll. Semantic candidate lookup also
uses the embedding owner only while it is warm, so a pinned identity cannot
reload a cold worker during an ordinary turn. Warm-only requests also enforce
this inside the owner after dequeue, closing the race with worker exit. A
refused warm-only quantum returns to `pending` without an error or consumed
provider attempt.

The worker releases the model after **60 seconds without worker requests**,
instead of 15 minutes. This retains a short follow-up opportunity while freeing
resident memory between recalls. Its existing idle reaper is unchanged apart
from that default; there is no new batch timer.

Cold recall keeps its **750 ms vector-lane deadline**. Owner-managed model
initialization continues after that caller expires, then wakes the backlog
consumer. A fresh generation can warm even before its first vector identity is
bound. The first cold answer uses text lanes when loading exceeds the deadline,
without waiting for the full load; the next warm query can use vectors. A cold
load that completes inside the lane deadline may still serve vectors. Shutdown
cancels initialization and background work through their existing owners.

## Linux stub evidence

Baseline: `09ffe9679fa5`, unchanged agent with an instrumented E2E harness.
Both runs used three turns (an explicit fact followed by two ordinary messages),
synthetic/replayed model responses, real local BGE-M3 assets and isolated data.
The Linux probe includes children spawned by every parent thread, since Tokio
can spawn the private worker outside the main thread.

| Measurement | Before | After |
| --- | ---: | ---: |
| Worker processes after three turns, no recall | 1 | 0 |
| Pending vector units after text stages settle | 0 | 7 |
| Complete units before the first batch | all eligible | 0 |
| Loaded worker RSS | 1,137,053,696 B | 1,133,559,808 B |
| Daily window | per-turn embedding already ran | 7 pending -> 7 complete, one load |
| Age event | per-turn embedding already ran | 7 pending -> 9 complete, one load |

In the final run the recall load took 3,180 ms (daily: 4,292 ms; age: 2,995 ms). The first cold recall found the pending fact through text, with vector coverage
`unavailable` / `embed_request_deadline`. The complete replayed recall **turn**
took 1,445 ms (this includes provider/harness/turn overhead, not just the recall
operation). Chat B then found chat A's fact by paraphrase with a `vector` channel.
All eleven units were complete; the worker exited 60,599 ms after the
complete-projection barrier. A subsequent ordinary turn with a pinned identity
left new vectors pending and did not reload the worker.

MEM-IDLE uses 30,000 completed projection windows. Before, with no pending unit,
and after, with one deferred unit, both 60-second samples had **zero graph
commits, zero leases and zero workers**. All completed windows and the deferred
unit remain present.

| Idle I/O over 60 seconds | Before | After |
| --- | ---: | ---: |
| `rchar` (bytes returned by reads) | 69,427 | 66,602 |
| `read_bytes` (storage reads) | 12,333,056 | 0 |

Returned-read bytes decreased. Earlier after-runs returned 66,538 bytes, with
14,323,712 and 94,208 storage-read bytes respectively. Storage-read bytes varied; these measurements
establish neither their cause nor an owner-scale physical-I/O budget. There is
no claim of a physical-I/O reduction. No macOS/Windows run or owner-data quality
benchmark (including the supplied +16.6 pp result) was performed here.

## Reproduce

Run from `packages/butler-agent/rust`, preserving the real build caches before
isolating the application home. Use a fixture asset directory, never owner data.

```sh
export CARGO_HOME="$HOME/.cargo" RUSTUP_HOME="$HOME/.rustup"
export HOME="$(mktemp -d)" BUTLER_DATA="$(mktemp -d)"
cargo build -j 8 -p butler-agent
export BUTLER_E2E_TIER=stub BUTLER_E2E_BIN="$CARGO_TARGET_DIR/debug/butler-agent"
export BUTLER_E2E_EMBEDDING_ASSETS=/path/to/bge-m3-fixture
cargo test -j 8 -p butler-e2e --test memory --test memory_idle \
  --test memory_hot_cache --test migration -- --nocapture --test-threads=1
```

Functional assertions inspect unit states, process presence, content, current
projection/cache barriers and vector channels. Elapsed times are printed; the
timeouts are existing nontermination guards, not stub-tier latency budgets.
The existing vector receipt test also checks count/age boundary admission.

## Validation

Final Linux runs passed: all 117 memory library tests, three embedding-owner
library tests, three memory-job library tests, and 16 stub E2Es across `memory`
(8), `memory_hot_cache` (1), `memory_idle` (3), `migration` (2),
`queue_admission_shutdown` (1) and `queue_shutdown` (1). Queue recovery covered
both the active turn and queued follow-ups. The platform library target compiled
but selected no Linux tests; its process probe was exercised by the real-model
E2Es. An initial executable-target owner filter selected zero tests and was
corrected to the library target before claiming coverage.

`cargo fmt`, clippy with `-D warnings` on all targets of the four touched crates,
source-check, the agent build, licence generation/checks and `git diff --check`
passed. No dependency or licence fingerprint changed. All tests/checks used
isolated application homes and data, cargo used eight jobs, and E2Es used one
thread. No live model-provider calls were made.
