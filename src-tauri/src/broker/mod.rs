//! Broker module — message-queue operations. Pulsar is the first and only
//! adapter; the module's own names stay vendor-neutral (see spec D1).
pub mod adapters;
pub mod cache;
pub mod capability;
pub mod commands;
pub mod envelope;
pub mod ports;
pub mod security;
pub mod store;
pub mod topic_folding;
