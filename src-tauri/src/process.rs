use command_group::{CommandGroup, GroupChild};
use std::io;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 后台进程在 Windows 上不得创建或继承可见的控制台窗口。
pub fn configure_background_process(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

pub fn spawn_group(command: &mut Command) -> io::Result<GroupChild> {
    #[cfg(windows)]
    {
        command
            .group()
            .kill_on_drop(true)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    }
    #[cfg(not(windows))]
    {
        command.group_spawn()
    }
}

pub fn graceful_stop(child: &mut GroupChild, grace: Duration) {
    #[cfg(unix)]
    {
        use command_group::{Signal, UnixChildExt};
        let _ = child.signal(Signal::SIGTERM);
    }
    #[cfg(windows)]
    {
        // A GUI process has no reliable console control channel. The Job Object
        // is kill-on-close and is terminated as one unit.
        let _ = child.kill();
    }

    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}
