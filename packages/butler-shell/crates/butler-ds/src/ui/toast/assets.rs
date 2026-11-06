//! The icons sonner draws in its toasts (see THIRD-PARTY-NOTICES, section 5), served by
//! `assets::Assets` next to the DS icons.
pub(crate) const FILES: &[(&str, &[u8])] = &[
    (
        "toast/success.svg",
        include_bytes!("../../../assets/toast/success.svg").as_slice(),
    ),
    (
        "toast/info.svg",
        include_bytes!("../../../assets/toast/info.svg").as_slice(),
    ),
    (
        "toast/warning.svg",
        include_bytes!("../../../assets/toast/warning.svg").as_slice(),
    ),
    (
        "toast/error.svg",
        include_bytes!("../../../assets/toast/error.svg").as_slice(),
    ),
    (
        "toast/close.svg",
        include_bytes!("../../../assets/toast/close.svg").as_slice(),
    ),
];
