//! 전원 버튼: 종료·다시 시작·절전·로그아웃.
//!
//! 셸 명령(shutdown.exe)을 띄우면 콘솔 창이 깜빡이고 권한에 따라 동작이 달라진다.
//! 여기서는 Win32 API를 직접 부른다. 종료 계열은 SE_SHUTDOWN_NAME 권한을 먼저 켠다.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{
    AdjustTokenPrivileges, LookupPrivilegeValueW, LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED,
    SE_SHUTDOWN_NAME, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY,
};
use windows::Win32::System::Power::SetSuspendState;
use windows::Win32::System::Shutdown::{
    ExitWindowsEx, EXIT_WINDOWS_FLAGS, EWX_FORCEIFHUNG, EWX_LOGOFF, EWX_POWEROFF, EWX_REBOOT,
    EWX_SHUTDOWN, SHTDN_REASON_MAJOR_OTHER,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// 프로세스 토큰에서 종료 권한을 켠다. 일반 사용자도 부여받지만 기본은 비활성이다.
fn enable_shutdown_privilege() -> Result<(), String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
        .map_err(|e| format!("권한 토큰을 열 수 없습니다: {e}"))?;

        let mut luid = windows::Win32::Foundation::LUID::default();
        let result = (|| -> windows::core::Result<()> {
            LookupPrivilegeValueW(PCWSTR::null(), SE_SHUTDOWN_NAME, &mut luid)?;
            let privileges = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                Privileges: [LUID_AND_ATTRIBUTES {
                    Luid: luid,
                    Attributes: SE_PRIVILEGE_ENABLED,
                }],
            };
            AdjustTokenPrivileges(token, false, Some(&privileges), 0, None, None)?;
            Ok(())
        })();

        let _ = CloseHandle(token);
        result.map_err(|e| format!("종료 권한을 켤 수 없습니다: {e}"))
    }
}

fn exit_windows(flags: EXIT_WINDOWS_FLAGS) -> Result<(), String> {
    enable_shutdown_privilege()?;
    // 응답이 없는 앱은 윈도우 기본 종료 절차처럼 기다리지 않고 넘긴다.
    unsafe { ExitWindowsEx(flags | EWX_FORCEIFHUNG, SHTDN_REASON_MAJOR_OTHER) }
        .map_err(|e| format!("전원 동작을 실행하지 못했습니다: {e}"))
}

/// 프런트엔드가 보낸 동작만 허용한다. 임의 문자열은 API로 전달되지 않는다.
#[tauri::command]
pub fn power_action(action: String) -> Result<(), String> {
    match action.as_str() {
        "shutdown" => exit_windows(EWX_SHUTDOWN | EWX_POWEROFF),
        "restart" => exit_windows(EWX_REBOOT),
        "logoff" => exit_windows(EWX_LOGOFF),
        // 최대 절전이 아니라 일반 절전. 앱이 거부해도 사용자가 누른 전원 버튼이므로 강제한다.
        "sleep" => {
            if unsafe { SetSuspendState(false, true, false) } {
                Ok(())
            } else {
                Err("절전 모드로 전환하지 못했습니다".into())
            }
        }
        other => Err(format!("알 수 없는 전원 동작입니다: {other}")),
    }
}
