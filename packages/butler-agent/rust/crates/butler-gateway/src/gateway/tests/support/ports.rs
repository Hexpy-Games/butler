//! Test gateways on a free loopback pair: port P and content port P+1.
use std::{io::ErrorKind, sync::Arc};

use tokio::net::TcpListener;

use crate::gateway::{GatewayApplication, GatewayConfig, GatewayServer, serve_gateway};

const PAIR_ATTEMPTS: usize = 64;

/// Starts the gateway on an ephemeral port P; `serve_gateway` binds the
/// content port P+1 itself, which a parallel test may already hold. P is
/// bound before the call, so `AddrInUse` can only come from that P+1 bind:
/// then P is released and a fresh ephemeral P is drawn. Any other error
/// fails at once.
pub(in crate::gateway::tests) async fn serve_on_free_pair(
    application: Arc<dyn GatewayApplication>,
    config: impl Fn() -> GatewayConfig,
) -> GatewayServer {
    for _ in 0..PAIR_ATTEMPTS {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        // P+1 does not exist for the last port.
        if listener.local_addr().unwrap().port() == u16::MAX {
            continue;
        }
        match serve_gateway(listener, application.clone(), config()).await {
            Ok(server) => return server,
            Err(error) if error.kind() == ErrorKind::AddrInUse => continue,
            Err(error) => panic!("test gateway failed to start: {error}"),
        }
    }
    panic!(
        "no free loopback port pair: content port P+1 was in use \
         for {PAIR_ATTEMPTS} ephemeral ports P"
    );
}
