use command_group::{CommandGroup, GroupChild};
use std::io;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

pub fn spawn_group(command: &mut Command) -> io::Result<GroupChild> {
    #[cfg(windows)]
    {
        command.group().kill_on_drop(true).spawn()
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
