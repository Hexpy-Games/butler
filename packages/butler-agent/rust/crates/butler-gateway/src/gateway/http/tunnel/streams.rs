use std::{collections::HashMap, io, sync::Arc};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, header},
    response::Response,
};
use bytes::{Buf, Bytes};
use futures_util::{FutureExt as _, StreamExt as _, stream};
use tokio::sync::{Semaphore, mpsc};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use zeroize::Zeroizing;

use super::{
    HttpState,
    frames::{self, Frame},
    noise::{self, BodyChunks, Opened, RecordReader, Target},
};
use crate::gateway::{
    crypto::constant_time_eq,
    http::{
        content,
        listeners::{self, TunnelPeer},
        security::DEVICE_PAIR_PATH,
    },
};

const CREDIT: usize = 1_048_576;
const MAX_REQUEST: usize = 67_108_864;

pub(super) struct Streams {
    context: Arc<Context>,
    active: HashMap<u32, Incoming>,
    last_opened: u32,
}

struct Context {
    state: Arc<HttpState>,
    api: Router,
    content: Router,
    id: String,
    key: Arc<Zeroizing<[u8; 32]>>,
    closed: CancellationToken,
    outgoing: mpsc::Sender<Message>,
}

struct Incoming {
    data: Option<mpsc::UnboundedSender<Bytes>>,
    closed: CancellationToken,
    credit: Arc<Semaphore>,
    received: usize,
}

struct Outgoing {
    id: u32,
    credit: Arc<Semaphore>,
    sender: mpsc::Sender<Message>,
}

impl Streams {
    pub(super) fn new(
        state: &Arc<HttpState>,
        closed: CancellationToken,
        id: &str,
        key: Arc<Zeroizing<[u8; 32]>>,
        outgoing: mpsc::Sender<Message>,
    ) -> Self {
        Self {
            context: Arc::new(Context {
                api: listeners::api_router(state.clone(), closed.clone()),
                content: content::router(state.clone()),
                state: state.clone(),
                id: id.to_owned(),
                key,
                closed,
                outgoing,
            }),
            active: HashMap::new(),
            last_opened: 0,
        }
    }

    fn open(&mut self, id: u32) {
        if id <= self.last_opened {
            return;
        }
        self.last_opened = id;
        let (data, input) = mpsc::unbounded_channel();
        let closed = self.context.closed.child_token();
        let credit = Arc::new(Semaphore::new(CREDIT));
        self.active.insert(
            id,
            Incoming {
                data: Some(data),
                closed: closed.clone(),
                credit: credit.clone(),
                received: 0,
            },
        );
        let context = self.context.clone();
        tokio::spawn(async move {
            let out = Outgoing {
                id,
                credit,
                sender: context.outgoing.clone(),
            };
            tokio::select! {
                biased;
                () = closed.cancelled() => (),
                () = async {
                    if let Err(reason) = context.request(input, &out).await {
                        let _ = out.send(frames::RESET, &[reason]).await;
                    }
                } => (),
            }
        });
    }

    pub(super) fn receive(&mut self, frame: Frame) -> Option<Message> {
        let Frame {
            kind,
            id,
            mut payload,
        } = frame;
        if kind == frames::OPEN {
            self.open(id);
            return None;
        }
        let entry = self.active.get_mut(&id)?;
        match kind {
            frames::DATA => {
                if let Some(data) = &entry.data {
                    entry.received += payload.len();
                    if entry.received > MAX_REQUEST {
                        self.remove(id);
                        return Some(frames::message(frames::RESET, id, &[frames::TOO_LARGE]));
                    }
                    let _ = data.send(payload);
                }
            }
            frames::END => {
                entry.data.take();
            }
            frames::RESET => self.remove(id),
            frames::WINDOW => {
                let credit = payload.get_u32() as usize;
                entry.credit.add_permits(credit);
            }
            _ => (),
        }
        None
    }

    pub(super) fn outgoing(&mut self, message: &Message) -> bool {
        let Message::Binary(bytes) = message else {
            return false;
        };
        let Some(frame) = Frame::parse(bytes.clone()) else {
            return false;
        };
        if matches!(frame.kind, frames::END | frames::RESET) {
            let active = self.active.contains_key(&frame.id);
            self.remove(frame.id);
            active
        } else {
            self.active.contains_key(&frame.id)
        }
    }

    fn remove(&mut self, id: u32) {
        if let Some(stream) = self.active.remove(&id) {
            stream.closed.cancel();
        }
    }
}

impl Drop for Streams {
    fn drop(&mut self) {
        self.context.closed.cancel();
    }
}

impl Outgoing {
    async fn send(&self, kind: u8, payload: &[u8]) -> Result<(), u8> {
        self.sender
            .send(frames::message(kind, self.id, payload))
            .await
            .map_err(|_| frames::DESKTOP_ERROR)
    }

    async fn record(&self, ciphertext: &[u8]) -> Result<(), u8> {
        let record = noise::frame_record(ciphertext);
        for payload in record.chunks(frames::MAX_PAYLOAD) {
            let count = u32::try_from(payload.len()).map_err(|_| frames::DESKTOP_ERROR)?;
            let permit = self
                .credit
                .acquire_many(count)
                .await
                .map_err(|_| frames::DESKTOP_ERROR)?;
            self.send(frames::DATA, payload).await?;
            permit.forget();
        }
        Ok(())
    }
}

impl Context {
    async fn request(
        &self,
        mut input: mpsc::UnboundedReceiver<Bytes>,
        out: &Outgoing,
    ) -> Result<(), u8> {
        let tunnel = self.state.tunnel.as_ref().ok_or(frames::DESKTOP_ERROR)?;
        let mut reader = RecordReader::default();
        let first = next_record(&mut reader, &mut input)
            .await?
            .ok_or(frames::PROTOCOL)?;
        let handshake =
            noise::responder(&self.key, &self.id, None).map_err(|_| frames::DESKTOP_ERROR)?;
        let opened = noise::open(handshake, &first, &tunnel.replay, noise::now_ms())
            .map_err(|_| frames::PROTOCOL)?;
        if !self.admits(&opened) {
            return Err(frames::PROTOCOL);
        }
        let Opened {
            body,
            target,
            handshake,
            method,
            uri,
            headers,
            remote_static,
            ..
        } = opened;
        let (chunks, incoming) = mpsc::channel(1);
        let router = match target {
            Target::Api => &self.api,
            Target::Content => &self.content,
        };
        let body_stream = if body.is_some() {
            Body::from_stream(stream::unfold(incoming, |mut incoming| async {
                incoming.recv().await.map(|chunk| (chunk, incoming))
            }))
        } else {
            Body::empty()
        };
        let mut request = Request::new(body_stream);
        *request.method_mut() = method;
        *request.uri_mut() = uri;
        *request.headers_mut() = headers;
        request
            .extensions_mut()
            .insert(TunnelPeer { remote_static });

        let has_body = body.is_some();
        let upload = upload(reader, input, body, chunks);
        let download = async {
            let Ok(response) = router.clone().oneshot(request).await;
            respond(response, handshake, out).await
        };
        if has_body {
            tokio::try_join!(biased; upload, download)?;
        } else {
            upload.await?;
            download.await?;
        }
        out.send(frames::END, &[]).await
    }

    fn admits(&self, request: &Opened) -> bool {
        let devices = &self.state.devices;
        if request.headers.contains_key(header::AUTHORIZATION) {
            return devices
                .token_noise_static(&request.headers)
                .is_some_and(|key| constant_time_eq(&key, &request.remote_static));
        }
        (matches!(request.target, Target::Api)
            && request.method == Method::POST
            && request.uri.path() == DEVICE_PAIR_PATH)
            || devices.knows_noise_static(&request.remote_static)
    }
}

async fn next_record(
    reader: &mut RecordReader,
    input: &mut mpsc::UnboundedReceiver<Bytes>,
) -> Result<Option<Bytes>, u8> {
    loop {
        if let Some(record) = reader.next().map_err(|_| frames::PROTOCOL)? {
            return Ok(Some(record));
        }
        let Some(bytes) = input.recv().await else {
            reader.finish().map_err(|_| frames::PROTOCOL)?;
            return Ok(None);
        };
        reader.push(&bytes);
    }
}

async fn upload(
    mut reader: RecordReader,
    mut input: mpsc::UnboundedReceiver<Bytes>,
    mut body: Option<BodyChunks>,
    chunks: mpsc::Sender<Result<Bytes, io::Error>>,
) -> Result<(), u8> {
    let result = async {
        while let Some(record) = next_record(&mut reader, &mut input).await? {
            let body = body.as_mut().ok_or(frames::PROTOCOL)?;
            let plaintext = body.decrypt(&record).map_err(|_| frames::PROTOCOL)?;
            let _ = chunks.send(Ok(plaintext)).await;
        }
        if let Some(body) = body {
            body.finish().map_err(|_| frames::PROTOCOL)?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = chunks.try_send(Err(io::Error::other("invalid tunnel request body")));
    }
    result
}

async fn respond(
    response: Response,
    handshake: snow::HandshakeState,
    out: &Outgoing,
) -> Result<(), u8> {
    let (head, body) = response.into_parts();
    let payload = noise::response_head(head.status.as_u16(), &head.headers)
        .map_err(|_| frames::DESKTOP_ERROR)?;
    let mut body = body.into_data_stream();
    let first = body.next().now_or_never();
    if matches!(first, Some(Some(Err(_)))) {
        return Err(frames::DESKTOP_ERROR);
    }
    let (message2, mut transport) =
        noise::response(handshake, &payload).map_err(|_| frames::DESKTOP_ERROR)?;
    out.record(&message2).await?;
    let mut next = match first {
        Some(item) => item,
        None => body.next().await,
    };
    while let Some(chunk) = next {
        for part in chunk
            .map_err(|_| frames::DESKTOP_ERROR)?
            .chunks(noise::RESPONSE_CHUNK)
        {
            let record =
                noise::transport_record(&mut transport, part).map_err(|_| frames::DESKTOP_ERROR)?;
            out.record(&record).await?;
        }
        next = body.next().await;
    }
    let record = noise::transport_record(&mut transport, &[]).map_err(|_| frames::DESKTOP_ERROR)?;
    out.record(&record).await
}
