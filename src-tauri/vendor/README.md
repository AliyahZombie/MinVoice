# Local LiveKit bindings

`libwebrtc-0.3.49` and `webrtc-sys-0.3.46` are vendored from the corresponding
crates.io releases of <https://github.com/livekit/rust-sdks> (Apache-2.0).
Original copyright notices and license files are retained. The application's
MIT license does not replace these upstream licenses.

The only source changes add `RtcAudioTrack::set_playout_volume` through the
native Rust and CXX bindings to `AudioSourceInterface::SetVolume`. The C++ call
runs on the WebRTC signaling thread, rejects invalid gains and local sources,
and changes only this client's remote audio playout. The ADM, mixer and echo
cancellation path remain in use. No LiveKit server changes are required.

Modified upstream files:

- `libwebrtc-0.3.49/src/audio_track.rs`
- `libwebrtc-0.3.49/src/native/audio_track.rs`
- `webrtc-sys-0.3.46/src/audio_track.rs`
- `webrtc-sys-0.3.46/src/audio_track.cpp`
- `webrtc-sys-0.3.46/include/livekit/audio_track.h`

When upgrading, preserve/review these bindings or remove the patches if upstream
provides an equivalent native per-track playout-volume API. Keep both package
versions aligned with Cargo.lock; libwebrtc itself still uses the official
prebuilt archive downloaded by webrtc-sys-build.
