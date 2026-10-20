//! 접힌 레일이 보여 주는 기본 정보: 시스템 볼륨과 배터리.
//!
//! CPU·메모리 같은 시스템 모니터 값은 넣지 않는다. 이 독은 앱을 여는 도구이고,
//! 레일에 필요한 건 "지금 소리가 어느 정도인지", "전원이 얼마나 남았는지" 정도다.
//!
//! 볼륨은 슬라이더를 끄는 동안에도 따라와야 해서 프런트가 묻는 방식이 아니라
//! 워커 스레드가 100ms마다 읽어 바뀐 값만 이벤트로 보낸다. 오디오 장치는 한 번
//! 잡아 두고 재사용한다(매번 열거하면 100ms 주기로는 비싸다).

use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

/// 값이 바뀔 때마다 이 이벤트로 전체 상태를 보낸다.
pub const STATUS_EVENT: &str = "system:status";

/// 지금 재생 중인 미디어. SMTC(시스템 미디어 컨트롤)를 그대로 쓴다.
#[derive(Serialize, Clone, PartialEq)]
pub struct MediaInfo {
    pub title: String,
    pub artist: String,
    pub playing: bool,
    /// 재생 위치 0~1. 길이를 모르는 스트림은 None.
    pub progress: Option<f32>,
}

/// 접힌 레일이 그리는 값. 모르는 값은 None으로 두고 프런트엔드가 그 막대만 숨긴다.
#[derive(Serialize, Clone, PartialEq)]
pub struct SystemStatus {
    /// 마스터 볼륨 0~100. 오디오 장치가 없으면 None.
    pub volume: Option<f32>,
    pub muted: bool,
    /// 배터리 잔량 0~100. 배터리가 없는 데스크톱은 None.
    pub battery: Option<f32>,
    /// 전원이 꽂혀 있는지. 배터리가 없어도 케이블 상태는 알 수 있다.
    pub charging: bool,
    /// 재생 중인 곡. 재생 중인 세션이 없으면 None.
    pub media: Option<MediaInfo>,
}

/// 기본 출력 장치의 볼륨 인터페이스. 장치가 바뀌면 다시 잡아야 한다.
fn acquire_audio() -> Option<IAudioEndpointVolume> {
    unsafe {
        // 이미 다른 모드로 초기화된 스레드일 수 있다. 그 경우에도 COM 호출은 그대로 된다.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        device.Activate(CLSCTX_ALL, None).ok()
    }
}

fn read_audio(endpoint: &IAudioEndpointVolume) -> Option<(f32, bool)> {
    unsafe {
        let level = endpoint.GetMasterVolumeLevelScalar().ok()?;
        let muted = endpoint.GetMute().ok()?.as_bool();
        Some(((level * 100.0).clamp(0.0, 100.0), muted))
    }
}

/// SMTC 세션에서 지금 곡과 재생 위치를 읽는다. 세션이 없거나 앱이 정보를 감추면 None.
fn media(manager: &GlobalSystemMediaTransportControlsSessionManager) -> Option<MediaInfo> {
    let session = manager.GetCurrentSession().ok()?;
    let props = session.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
    let title = props.Title().map(|t| t.to_string()).unwrap_or_default();
    if title.is_empty() {
        return None;
    }
    let artist = props.Artist().map(|a| a.to_string()).unwrap_or_default();
    let playing = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .map(|state| state == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
        .unwrap_or(false);
    let progress = session.GetTimelineProperties().ok().and_then(|timeline| {
        let start = timeline.StartTime().ok()?.Duration;
        let end = timeline.EndTime().ok()?.Duration;
        let position = timeline.Position().ok()?.Duration;
        let total = end.saturating_sub(start);
        if total <= 0 {
            return None;
        }
        Some(((position - start) as f64 / total as f64).clamp(0.0, 1.0) as f32)
    });
    Some(MediaInfo { title, artist, playing, progress })
}

fn battery() -> (Option<f32>, bool) {
    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
        return (None, false);
    }
    // 255는 "알 수 없음"이다. 배터리가 없는 데스크톱도 255로 온다.
    let level = (status.BatteryLifePercent != 255).then_some(status.BatteryLifePercent as f32);
    // ACLineStatus: 0 오프라인, 1 온라인, 255 알 수 없음.
    (level, status.ACLineStatus == 1)
}

#[tauri::command]
pub fn system_status() -> SystemStatus {
    let (battery, charging) = battery();
    let sound = acquire_audio().as_ref().and_then(read_audio);
    let session = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
        .ok()
        .and_then(|op| op.join().ok());
    SystemStatus {
        volume: sound.map(|(level, _)| level),
        muted: sound.is_some_and(|(_, muted)| muted),
        battery,
        charging,
        media: session.as_ref().and_then(media),
    }
}

/// 볼륨·배터리 감시 스레드. 바뀐 값만 보내므로 100ms 주기여도 이벤트가 쏟아지지 않는다.
pub fn start_watch(app: AppHandle) {
    thread::spawn(move || {
        let mut endpoint = acquire_audio();
        let mut acquired = Instant::now();
        let mut sent: Option<SystemStatus> = None;
        // 세션 관리자는 한 번 잡으면 재생 앱이 바뀌어도 현재 세션을 계속 돌려준다.
        let mut manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .ok()
            .and_then(|op| op.join().ok());

        loop {
            // 기본 장치가 바뀌었을 수 있다. 몇 초마다 다시 잡아 따라간다.
            if acquired.elapsed() >= Duration::from_secs(5) {
                if let Some(fresh) = acquire_audio() {
                    endpoint = Some(fresh);
                }
                acquired = Instant::now();
            }

            let (battery, charging) = battery();
            let sound = endpoint.as_ref().and_then(read_audio);
            // 관리자를 못 잡았으면(세션 서비스가 늦게 뜨는 경우) 이따금 다시 시도한다.
            if manager.is_none() && acquired.elapsed() >= Duration::from_secs(1) {
                manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
                    .ok()
                    .and_then(|op| op.join().ok());
            }
            let status = SystemStatus {
                volume: sound.map(|(level, _)| level),
                muted: sound.is_some_and(|(_, muted)| muted),
                battery,
                charging,
                media: manager.as_ref().and_then(media),
            };

            if sent.as_ref() != Some(&status) {
                let _ = app.emit(STATUS_EVENT, status.clone());
                sent = Some(status);
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::system_status;

    // 실제 장치 값은 환경을 따라가므로 "범위 안이거나 없음"만 확인한다.
    // 오디오 장치가 없는 CI에서도 통과해야 한다.
    #[test]
    fn status_stays_in_range() {
        let status = system_status();
        // --nocapture로 실행하면 이 PC의 실제 값을 볼 수 있다.
        println!(
            "volume={:?} muted={} battery={:?} charging={}",
            status.volume, status.muted, status.battery, status.charging
        );
        assert!(status.volume.map_or(true, |v| (0.0..=100.0).contains(&v)));
        assert!(status.battery.map_or(true, |v| (0.0..=100.0).contains(&v)));
    }
}
