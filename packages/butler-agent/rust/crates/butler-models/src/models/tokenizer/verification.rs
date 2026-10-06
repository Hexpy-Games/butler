//! Extends the admission test's exact token-count contract across cached blocks.
use super::*;

pub(crate) fn exact_encoding() {
    let owner = TokenizerOwner::default();
    let reference = o200k_base().unwrap();
    let samples = [
        "prose with spaces and digits99, JSON: {\"text\":\"latest\"}\n",
        "I'm I'LL aren't wasn't we've she'd they'll won't it's can't\r\n",
        "한글 English 中文 e\u{301} A\u{301} \u{200d}💻🧑\u{200d}🚀 ١٢٣ ９９\n",
        "\\\"slashes/[]{}!??,  \t\r\n\n <|endoftext|> <|fim_prefix|>\n",
        "UPPER lower Title 1234567890 foo_bar foo42 /n'RE\n",
    ];
    // Shift every interesting boundary across the block cut, then append and
    // edit old bytes. Compare token IDs as well as counts to the uncached BPE.
    let prefix = "ordinary prose context ".repeat(400);
    for sample in samples {
        for offset in 0..64 {
            let mut text = format!("{}{sample}", &prefix[..8192 - offset]);
            text.push_str(&sample.repeat(180));
            assert_exact(&owner, &reference, &text);
            text.push_str(" edited latest state99");
            assert_exact(&owner, &reference, &text);
            text.replace_range(30..31, "한");
            assert_exact(&owner, &reference, &text);
        }
    }
    // Unsplittable text must fall back to exact full encoding. Empty input and
    // input exceeding the cache's entry count must also retain every token.
    for text in [String::new(), "🧑\u{200d}🚀".repeat(3000), " ".repeat(9000)] {
        assert_exact(&owner, &reference, &text);
    }
    let mut cache = blocks::BlockCache::default();
    for index in 0..4100 {
        cache.insert(&format!("block {index}"), Arc::from([index]));
    }
    assert!(cache.get("block 0").is_none());
    assert_eq!(cache.get("block 4099").unwrap().as_ref(), &[4099]);
    cache.insert("block 4099", Arc::from([0]));
    assert_eq!(cache.get("block 4099").unwrap().as_ref(), &[4099]);
}

fn assert_exact(owner: &TokenizerOwner, reference: &CoreBPE, text: &str) {
    let expected = reference.encode_ordinary(text);
    assert_eq!(owner.encode_ordinary(text).unwrap(), expected);
    assert_eq!(owner.count_ordinary(text).unwrap(), expected.len());
}
