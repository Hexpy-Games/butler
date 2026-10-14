//! How much concurrent browsing this machine takes. Agent tabs are bounded by
//! installed memory (a page's renderer commonly holds a few hundred MB), and
//! calls in flight by CPU. A call beyond the call limit waits for a slot; none
//! is refused for it. The App's executor (`browser/capacity.mjs`) applies the
//! same tab formula.

/// Tabs the user keeps on their own, beside the agent tabs.
pub const USER_TABS: usize = 30;
/// Agent tabs on the smallest machine.
pub const MIN_AGENT_TABS: usize = 6;
/// Agent tabs on the largest machine.
pub const MAX_AGENT_TABS: usize = 24;
/// The most tabs one browser holds at once: the user's and the agents'.
pub const MAX_TABS: usize = USER_TABS + MAX_AGENT_TABS;

const GIB: u64 = 1 << 30;

/// Agent tabs open at once across conversations: one per GiB of memory,
/// within [`MIN_AGENT_TABS`]..=[`MAX_AGENT_TABS`].
pub fn agent_tabs() -> usize {
    let gib = butler_platform::memory::total_bytes() / GIB;
    usize::try_from(gib)
        .unwrap_or(MAX_AGENT_TABS)
        .clamp(MIN_AGENT_TABS, MAX_AGENT_TABS)
}

/// Browser calls executing at once: two per core (most of a call waits on
/// the network or the page), at least 8, at most 32.
pub fn call_slots() -> usize {
    let cores = std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
    (cores * 2).clamp(8, 32)
}
