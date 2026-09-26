//! Manual end-to-end playout probe. See docs/VOLUME.md; uses an isolated room.
//! Publish two distinct tones, then measure the receiving device's monitor.
#[allow(dead_code)]
#[path = "../src/token.rs"]
mod token;

use livekit::webrtc::{
    audio_frame::AudioFrame,
    audio_source::{native::NativeAudioSource, AudioSourceOptions, RtcAudioSource},
};
use livekit::{options::TrackPublishOptions, prelude::*, Room, RoomOptions};
use std::{
    collections::HashMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

type Error = Box<dyn std::error::Error>;

async fn connect(identity: &str, room_name: &str) -> Result<Room, Error> {
    let file = std::env::var("MINVOICE_TEST_CREDENTIALS")?;
    let env: HashMap<String, String> = std::fs::read_to_string(file)?
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| {
            (
                key.trim().to_owned(),
                value.trim().trim_matches('"').to_owned(),
            )
        })
        .collect();
    let token = token::mint(&token::MintRequest {
        api_key: env.get("LIVEKIT_API_KEY").ok_or("missing API key")?.clone(),
        api_secret: env
            .get("LIVEKIT_API_SECRET")
            .ok_or("missing API secret")?
            .clone(),
        identity: identity.into(),
        display_name: None,
        room: room_name.into(),
        ttl_seconds: 300,
    })?;
    let mut options = RoomOptions::default();
    options.auto_subscribe = identity == "volume-receiver";
    let (room, mut events) = Room::connect(
        env.get("LIVEKIT_URL").ok_or("missing URL")?,
        &token,
        options,
    )
    .await?;
    tokio::spawn(async move { while events.recv().await.is_some() {} });
    Ok(room)
}

async fn publish(room_name: &str) -> Result<(), Error> {
    let mut rooms = Vec::new();
    let mut sources = Vec::new();
    for (identity, frequency) in [("volume-a", 440.0), ("volume-b", 880.0)] {
        let room = connect(identity, room_name).await?;
        let source = NativeAudioSource::new(AudioSourceOptions::default(), 48000, 1, 100);
        let track =
            LocalAudioTrack::create_audio_track("tone", RtcAudioSource::Native(source.clone()));
        room.local_participant()
            .publish_track(
                LocalTrack::Audio(track),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    dtx: false,
                    ..Default::default()
                },
            )
            .await?;
        sources.push((source, frequency));
        rooms.push(room);
    }
    println!("Two publishers ready (440 Hz, 880 Hz)");
    let mut interval = tokio::time::interval(Duration::from_millis(10));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    for frame_index in 0..9000 {
        interval.tick().await;
        for (source, frequency) in &sources {
            let data: Vec<i16> = (0..480)
                .map(|i| {
                    let t = f64::from(frame_index * 480 + i) / 48000.0;
                    (1000.0 * (t * frequency * std::f64::consts::TAU).sin()) as i16
                })
                .collect();
            source
                .capture_frame(&AudioFrame {
                    data: data.into(),
                    sample_rate: 48000,
                    num_channels: 1,
                    samples_per_channel: 480,
                })
                .await?;
        }
    }
    for room in rooms {
        room.close().await?;
    }
    Ok(())
}

async fn receive(room_name: &str, device_name: &str) -> Result<(), Error> {
    let audio = PlatformAudio::new()?;
    let device = audio
        .playout_devices()
        .find(|d| d.name.contains(device_name))
        .ok_or("test output device not found")?;
    audio.set_playout_device(&device.id)?;
    let room = connect("volume-receiver", room_name).await?;
    let tracks = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let mut tracks = HashMap::new();
            for p in room.remote_participants().values() {
                for publication in p.track_publications().values() {
                    if let Some(RemoteTrack::Audio(track)) = publication.track() {
                        tracks.insert(p.identity().to_string(), track);
                    }
                }
            }
            if tracks.len() == 2 {
                break tracks;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await?;
    audio.switch_playout_device(&device.id)?;
    for (a, b) in [
        (100, 100),
        (50, 100),
        (0, 100),
        (200, 100),
        (100, 0),
        (100, 100),
    ] {
        assert!(tracks["volume-a"]
            .rtc_track()
            .set_playout_volume(f64::from(a) / 100.0));
        assert!(tracks["volume-b"]
            .rtc_track()
            .set_playout_volume(f64::from(b) / 100.0));
        println!(
            "{}",
            serde_json::json!({"a":a,"b":b,"atMs":SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()})
        );
        tokio::time::sleep(Duration::from_secs(4)).await;
        for (identity, track) in &tracks {
            for stat in track.get_stats().await? {
                if let livekit::webrtc::stats::RtcStats::InboundRtp(stat) = stat {
                    eprintln!(
                        "{identity}: bytes={} energy={}",
                        stat.inbound.bytes_received, stat.inbound.total_audio_energy
                    );
                }
            }
        }
    }
    room.close().await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let args: Vec<String> = std::env::args().collect();
    let room = args
        .get(2)
        .ok_or("usage: volume_probe publish|receive room [output-device-name]")?;
    match args.get(1).map(String::as_str) {
        Some("publish") => publish(room).await,
        Some("receive") => receive(room, args.get(3).ok_or("specify test output device")?).await,
        _ => Err("expected publish or receive".into()),
    }
}
