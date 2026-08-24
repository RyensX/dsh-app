use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
pub const LOG_BACKUPS: usize = 5;
const MAX_LOG_LINE_BYTES: usize = 64 * 1024;

pub struct RotatingLog {
    path: PathBuf,
    file: Option<File>,
    bytes: u64,
    max_bytes: u64,
    backups: usize,
}

pub type SharedLog = Arc<Mutex<RotatingLog>>;

pub fn open_rotating(path: &Path) -> io::Result<SharedLog> {
    open_rotating_with_limits(path, MAX_LOG_BYTES, LOG_BACKUPS)
}

fn open_rotating_with_limits(path: &Path, max_bytes: u64, backups: usize) -> io::Result<SharedLog> {
    rotate(path, max_bytes, backups)?;
    let bytes = path.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    Ok(Arc::new(Mutex::new(RotatingLog {
        path: path.to_path_buf(),
        file: Some(file),
        bytes,
        max_bytes,
        backups,
    })))
}

pub fn rotate(path: &Path, max_bytes: u64, backups: usize) -> io::Result<()> {
    if backups == 0 || !path.exists() || path.metadata()?.len() < max_bytes {
        return Ok(());
    }
    rotate_backups(path, backups)
}

fn rotate_backups(path: &Path, backups: usize) -> io::Result<()> {
    let oldest = backup_path(path, backups);
    if oldest.exists() {
        fs::remove_file(&oldest)?;
    }
    for index in (1..backups).rev() {
        let source = backup_path(path, index);
        if source.exists() {
            fs::rename(source, backup_path(path, index + 1))?;
        }
    }
    fs::rename(path, backup_path(path, 1))
}

pub fn write_line(log: &SharedLog, stream: &str, line: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let safe = bounded(redact(line), MAX_LOG_LINE_BYTES);
    let record = format!("[{timestamp}] [{stream}] {safe}\n");
    if let Ok(mut log) = log.lock() {
        let _ = log.write(record.as_bytes());
    }
}

impl RotatingLog {
    fn write(&mut self, record: &[u8]) -> io::Result<()> {
        let incoming = u64::try_from(record.len()).unwrap_or(u64::MAX);
        if self.backups > 0
            && self.bytes > 0
            && self.bytes.saturating_add(incoming) > self.max_bytes
        {
            self.file.take();
            if let Err(error) = rotate_backups(&self.path, self.backups) {
                self.file = Some(
                    OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&self.path)?,
                );
                return Err(error);
            }
            self.file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)?,
            );
            self.bytes = 0;
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "log file is closed"))?;
        file.write_all(record)?;
        file.flush()?;
        self.bytes = self.bytes.saturating_add(incoming);
        Ok(())
    }
}

fn backup_path(path: &Path, index: usize) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("dsh.log");
    path.with_file_name(format!("{name}.{index}"))
}

fn redact(line: &str) -> &str {
    const SENSITIVE: [&str; 7] = [
        "API_KEY",
        "API-KEY",
        "AUTHORIZATION",
        "PASSWORD",
        "SECRET",
        "ACCESS_TOKEN",
        "REFRESH_TOKEN",
    ];
    let uppercase = line.to_ascii_uppercase();
    if SENSITIVE.iter().any(|marker| uppercase.contains(marker)) {
        "[redacted sensitive dsh output]"
    } else {
        line
    }
}

fn bounded(line: &str, max_bytes: usize) -> String {
    if line.len() <= max_bytes {
        return line.to_owned();
    }
    const SUFFIX: &str = " [truncated]";
    if max_bytes <= SUFFIX.len() {
        return SUFFIX[..max_bytes].to_owned();
    }
    let mut end = max_bytes.saturating_sub(SUFFIX.len());
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{SUFFIX}", &line[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_to_the_configured_depth() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("dsh.log");
        fs::write(&path, b"12345").unwrap();
        rotate(&path, 4, 2).unwrap();
        assert_eq!(fs::read(root.path().join("dsh.log.1")).unwrap(), b"12345");
        fs::write(&path, b"second").unwrap();
        rotate(&path, 4, 2).unwrap();
        assert_eq!(fs::read(root.path().join("dsh.log.2")).unwrap(), b"12345");
    }

    #[test]
    fn redacts_lines_that_can_contain_credentials() {
        assert_eq!(
            redact("DEEPSEEK_API_KEY=secret"),
            "[redacted sensitive dsh output]"
        );
        assert_eq!(redact("dsh web: ready"), "dsh web: ready");
    }

    #[test]
    fn rotates_while_a_process_is_still_writing() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("dsh.log");
        let log = open_rotating_with_limits(&path, 80, 2).unwrap();
        write_line(&log, "stdout", "first record fills part of the active log");
        write_line(&log, "stdout", "second record crosses the configured limit");
        assert!(root.path().join("dsh.log.1").is_file());
        assert!(path.is_file());
    }

    #[test]
    fn bounds_single_log_lines_without_splitting_utf8() {
        assert_eq!(bounded("short", 16), "short");
        let value = bounded("abcdefghijklmnopqrstuvwxyz", 20);
        assert!(value.ends_with("[truncated]"));
        assert!(value.len() <= 20);
        let unicode = bounded("\u{754c}".repeat(32).as_str(), 32);
        assert!(unicode.is_char_boundary(unicode.len()));
    }
}
