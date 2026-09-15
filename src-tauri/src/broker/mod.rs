//! Broker module — message-queue operations. Pulsar is the first and only
//! adapter; the module's own names stay vendor-neutral (see spec D1).
pub mod adapters;
pub mod envelope;
pub mod ports;
