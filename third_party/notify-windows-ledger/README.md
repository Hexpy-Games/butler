# Windows directory notifications

Adapted from notify 8.2.0's `src/windows.rs` (CC0-1.0),
https://github.com/notify-rs/notify/tree/a1d7c2d8f80786679d58ec6d5986a1d4278bc8cf/notify.

Only the recursive directory backend is retained. It uses event-completed
ReadDirectoryChangesW on a dedicated thread, configurable flags and buffer size,
explicit Rescan/Lost events, and a synchronous drain barrier. Unlike upstream
8.2.0 it never silently unwatches on overflow or a handle error. Requests and
buffers remain owned until cancellation completes. Butler consumes only the
safe API; native FFI stays in this vendored dependency.
