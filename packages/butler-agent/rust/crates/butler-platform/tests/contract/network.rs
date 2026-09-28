//! The machine's interface addresses.

use butler_platform::network::{INTERFACE_ADDRESSES, external_addresses};

#[test]
fn external_addresses_are_listed_without_loopback_where_supported() {
    let listed = external_addresses();
    assert_eq!(
        listed.is_some(),
        INTERFACE_ADDRESSES,
        "a supported host lists its addresses; another reports none"
    );
    let addresses = listed.unwrap_or_default();
    assert!(
        addresses.iter().all(|ip| !ip.is_loopback()),
        "{addresses:?}"
    );
    assert!(
        addresses.windows(2).all(|pair| pair[0] < pair[1]),
        "not sorted and unique: {addresses:?}"
    );
}
