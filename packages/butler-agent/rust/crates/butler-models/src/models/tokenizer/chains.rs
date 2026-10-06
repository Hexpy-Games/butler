//! Ordered exact blocks avoid rehashing the entire unchanged transcript.
use std::collections::VecDeque;
use std::sync::Arc;

type Block = (Arc<str>, Arc<[u32]>);
pub(super) type Chain = Vec<Block>;

const CACHE_BYTES: usize = 32 * 1024 * 1024;
const CACHE_CHAINS: usize = 4;

#[derive(Default)]
pub(super) struct Cache {
    chains: VecDeque<Chain>,
    bytes: usize,
}

impl Cache {
    pub(super) fn take(&mut self, first: &str) -> Option<Chain> {
        let index = self.chains.iter().position(|chain| {
            chain
                .first()
                .is_some_and(|(source, _)| source.as_ref() == first)
        })?;
        let chain = self.chains.remove(index)?;
        self.bytes -= retained_bytes(&chain);
        Some(chain)
    }

    pub(super) fn insert(&mut self, chain: Chain) {
        let bytes = retained_bytes(&chain);
        if bytes > CACHE_BYTES || chain.is_empty() {
            return;
        }
        while self.bytes + bytes > CACHE_BYTES || self.chains.len() >= CACHE_CHAINS {
            if let Some(old) = self.chains.pop_front() {
                self.bytes -= retained_bytes(&old);
            } else {
                break;
            }
        }
        self.bytes += bytes;
        self.chains.push_back(chain);
    }
}

fn retained_bytes(chain: &Chain) -> usize {
    chain.capacity() * std::mem::size_of::<Block>()
        + chain
            .iter()
            .map(|(source, tokens)| {
                source.len()
                    + std::mem::size_of_val(tokens.as_ref())
                    + 4 * std::mem::size_of::<usize>() // Arc allocation headers.
            })
            .sum::<usize>()
}
