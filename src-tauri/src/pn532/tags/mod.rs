//! Tag-family protocol logic (NTAG21x/Ultralight, MIFARE Classic) — deliberately kept separate
//! from `pn532::session`, which only handles the PN532-specific transport (connection lifecycle,
//! generic ISO14443-3A target selection, retry). These protocols belong to the *tags*, not the
//! reader chip: the same command bytes would apply through any reader capable of relaying raw
//! bytes to a selected ISO14443-3A target, not just a PN532. If a second reader chip is ever
//! supported, this is the layer that gets reused as-is — only `pn532::session`'s equivalent for
//! that chip would need to be written.
pub mod mifare_classic;
pub mod ntag21x;
