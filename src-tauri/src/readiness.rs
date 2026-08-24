use tauri::Url;

pub const READY_PREFIX: &str = "dsh web: ";

pub fn parse_readiness_line(line: &str) -> Option<Result<Url, String>> {
    let value = line.trim().strip_prefix(READY_PREFIX)?;
    let parsed = match Url::parse(value) {
        Ok(url) => url,
        Err(error) => return Some(Err(format!("invalid readiness URL: {error}"))),
    };
    let valid = parsed.scheme() == "http"
        && parsed.host_str() == Some("127.0.0.1")
        && parsed.port().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none();
    if valid {
        Some(Ok(parsed))
    } else {
        Some(Err(format!(
            "readiness URL is not an isolated IPv4 loopback origin: {value}"
        )))
    }
}

pub fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_ipv4_loopback_readiness_urls() {
        let url = parse_readiness_line("dsh web: http://127.0.0.1:43123")
            .unwrap()
            .unwrap();
        assert_eq!(url.port(), Some(43123));
        assert!(parse_readiness_line("dsh web: http://localhost:43123")
            .unwrap()
            .is_err());
        assert!(parse_readiness_line("dsh web: https://127.0.0.1:43123")
            .unwrap()
            .is_err());
        assert!(parse_readiness_line("ordinary log output").is_none());
    }
}
