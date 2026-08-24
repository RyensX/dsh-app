use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::atomic::atomic_write;
use crate::error::LaunchError;
use crate::model::RuntimeLayout;
use crate::user_dirs::UserDirs;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginIndex {
    schema_version: u32,
    plugins: Vec<IndexedPlugin>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexedPlugin {
    id: String,
    entry: String,
    config: Value,
    manifest: String,
}

#[derive(Debug, Deserialize)]
struct PluginPackage {
    name: String,
}

#[derive(Debug, Serialize)]
struct PatchOperation {
    insert: Vec<PatchEntry>,
}

#[derive(Debug, Serialize)]
struct PatchEntry {
    id: String,
    name: String,
    config: Value,
}

pub fn rebuild_patch(layout: &RuntimeLayout, dirs: &UserDirs) -> Result<PathBuf, LaunchError> {
    let index_path = layout.runtime_root.join("plugins/index.json");
    let source = fs::read_to_string(&index_path)
        .map_err(|error| patch_error(&index_path, &error.to_string()))?;
    let index: PluginIndex = serde_json::from_str(&source)
        .map_err(|error| patch_error(&index_path, &error.to_string()))?;
    if index.schema_version != 1 {
        return Err(patch_error(
            &index_path,
            &format!("unsupported schemaVersion {}", index.schema_version),
        ));
    }
    let indexed_contract: Vec<(&str, &str)> = index
        .plugins
        .iter()
        .map(|plugin| (plugin.id.as_str(), plugin.entry.as_str()))
        .collect();
    let manifest_contract: Vec<(&str, &str)> = layout
        .manifest
        .plugins
        .iter()
        .map(|plugin| (plugin.id.as_str(), plugin.entry.as_str()))
        .collect();
    if indexed_contract != manifest_contract {
        return Err(patch_error(
            &index_path,
            "plugin index does not match runtime-manifest.json",
        ));
    }

    let canonical_root = fs::canonicalize(&layout.runtime_root)
        .map_err(|error| patch_error(&layout.runtime_root, &error.to_string()))?;
    let mut entries = Vec::with_capacity(index.plugins.len());
    for plugin in index.plugins {
        validate_id(&plugin.id).map_err(|cause| patch_error(&index_path, cause))?;
        let relative =
            contained_relative(&plugin.entry).map_err(|cause| patch_error(&index_path, cause))?;
        let entry = fs::canonicalize(layout.runtime_root.join(relative))
            .map_err(|error| patch_error(&index_path, &error.to_string()))?;
        if !entry.starts_with(&canonical_root) || !entry.is_file() {
            return Err(patch_error(
                &index_path,
                &format!("plugin {} resolves outside the packaged runtime", plugin.id),
            ));
        }
        let manifest = layout.runtime_root.join(
            contained_relative(&plugin.manifest)
                .map_err(|cause| patch_error(&index_path, cause))?,
        );
        if !manifest.is_file() {
            return Err(patch_error(
                &index_path,
                &format!("plugin {} manifest is missing", plugin.id),
            ));
        }
        let package_manifest = layout
            .runtime_root
            .join("node_modules")
            .join(&plugin.id)
            .join("package.json");
        let package: PluginPackage = serde_json::from_str(
            &fs::read_to_string(&package_manifest)
                .map_err(|error| patch_error(&package_manifest, &error.to_string()))?,
        )
        .map_err(|error| patch_error(&package_manifest, &error.to_string()))?;
        if package.name != plugin.id {
            return Err(patch_error(
                &package_manifest,
                &format!(
                    "plugin package name mismatch: expected {}, found {}",
                    plugin.id, package.name
                ),
            ));
        }
        entries.push(PatchEntry {
            name: plugin.id.clone(),
            id: plugin.id,
            config: plugin.config,
        });
    }

    let patch = if entries.is_empty() {
        Vec::<PatchOperation>::new()
    } else {
        vec![PatchOperation { insert: entries }]
    };
    let mut serialized =
        serde_json::to_vec_pretty(&patch).expect("plugin patch data is JSON serializable");
    serialized.push(b'\n');
    atomic_write(&dirs.patch, &serialized)
        .map_err(|error| patch_error(&dirs.patch, &error.to_string()))?;
    Ok(dirs.patch.clone())
}

fn validate_id(id: &str) -> Result<(), &str> {
    let valid = !id.is_empty()
        && id
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !id.ends_with('-')
        && !id.contains("--");
    valid.then_some(()).ok_or("plugin id is invalid")
}

fn contained_relative(value: &str) -> Result<PathBuf, &str> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("plugin path must be a contained relative path");
    }
    Ok(path.to_path_buf())
}

fn patch_error(path: &Path, cause: &str) -> LaunchError {
    LaunchError::new(
        "PLUGIN_PATCH_INVALID",
        "The packaged plugin configuration is invalid",
        "DSH App did not start dsh because its bundled plugin index could not be trusted.",
    )
    .detail("Path", path.display().to_string())
    .detail("Underlying error", cause)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_plugin_identifiers() {
        assert!(validate_id("macos-helper").is_ok());
        assert!(validate_id("Bad").is_err());
        assert!(validate_id("double--dash").is_err());
    }

    #[test]
    fn rejects_escaping_plugin_paths() {
        assert!(contained_relative("plugins/demo.mjs").is_ok());
        assert!(contained_relative("../demo.mjs").is_err());
    }
}
