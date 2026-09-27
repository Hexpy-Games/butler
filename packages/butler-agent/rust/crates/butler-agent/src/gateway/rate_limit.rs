use parking_lot::Mutex;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub(super) struct FixedWindowRateLimiter {
    max: u64,
    window: Duration,
    buckets: Mutex<HashMap<String, RateBucket>>,
}

struct RateBucket {
    count: u64,
    reset_at: Instant,
}

impl FixedWindowRateLimiter {
    pub(super) fn new(max: u64, window: Duration) -> Self {
        Self {
            max: if max > 0 { max } else { 60 },
            window: if window.is_zero() {
                Duration::from_secs(60)
            } else {
                window
            },
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn consume(&self, key: String) -> bool {
        let now = Instant::now();
        let mut buckets = self.buckets.lock();
        buckets.retain(|_, bucket| bucket.reset_at > now);
        match buckets.get_mut(&key) {
            Some(bucket) if bucket.count >= self.max => false,
            Some(bucket) => {
                bucket.count += 1;
                true
            }
            None => {
                buckets.insert(
                    key,
                    RateBucket {
                        count: 1,
                        reset_at: now + self.window,
                    },
                );
                true
            }
        }
    }
}
