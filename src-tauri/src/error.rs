use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    pub label: String,
    pub value: String,
}

impl ErrorDetail {
    pub fn new(label: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            value: value.into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchError {
    pub code: String,
    pub title: String,
    pub message: String,
    pub details: Vec<ErrorDetail>,
}

impl LaunchError {
    pub fn new(
        code: impl Into<String>,
        title: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            title: title.into(),
            message: message.into(),
            details: Vec::new(),
        }
    }

    pub fn detail(mut self, label: impl Into<String>, value: impl Into<String>) -> Self {
        self.details.push(ErrorDetail::new(label, value));
        self
    }

    pub fn io(code: &str, title: &str, message: &str, error: &std::io::Error) -> Self {
        Self::new(code, title, message).detail("Underlying error", error.to_string())
    }
}

impl From<serde_json::Error> for LaunchError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(
            "RUNTIME_MANIFEST_INVALID",
            "The packaged runtime manifest is invalid",
            "DSH App cannot safely start this packaged runtime.",
        )
        .detail("Underlying error", error.to_string())
    }
}
