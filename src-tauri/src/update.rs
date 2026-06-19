use std::cmp::Ordering;
use std::time::Duration;

use serde::Deserialize;

use crate::models::UpdateInfo;

#[derive(Debug, Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    prerelease: bool,
    draft: bool,
}

#[derive(Debug, Clone, Eq, PartialEq)]
struct Semver {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Option<String>,
}

pub fn check_shell_update() -> UpdateInfo {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("GSDesk/0.1 update-check")
        .build()
    {
        Ok(client) => client,
        Err(error) => return update_error(current_version, error.to_string()),
    };

    let response = client
        .get("https://api.github.com/repos/yeahhhh321/gsdesk/releases")
        .send();
    match response {
        Ok(response) if response.status().is_success() => match response
            .json::<Vec<GithubRelease>>()
        {
            Ok(releases) => build_update_info(current_version, releases),
            Err(error) => update_error(current_version, format!("解析 Release 信息失败: {error}")),
        },
        Ok(response) => update_error(
            current_version,
            format!("暂无可用 Release 或请求失败: {}", response.status()),
        ),
        Err(error) => update_error(current_version, error.to_string()),
    }
}

fn build_update_info(current_version: String, releases: Vec<GithubRelease>) -> UpdateInfo {
    let current = parse_semver(&current_version);
    let stable = newest_release(
        releases
            .iter()
            .filter(|release| !release.draft && !release.prerelease),
    );
    let prerelease = newest_release(
        releases
            .iter()
            .filter(|release| !release.draft && release.prerelease),
    );

    let stable_version = stable
        .as_ref()
        .map(|release| normalize_tag(&release.tag_name));
    let prerelease_version = prerelease
        .as_ref()
        .map(|release| normalize_tag(&release.tag_name));
    let stable_update = stable_version
        .as_ref()
        .and_then(|version| parse_semver(version).map(|latest| (version, latest)))
        .and_then(|(version, latest)| current.as_ref().map(|current| (version, latest, current)))
        .map(|(_, latest, current)| latest > *current)
        .unwrap_or_else(|| {
            stable_version
                .as_ref()
                .map(|version| version != &current_version)
                .unwrap_or(false)
        });
    let prerelease_newer = prerelease_version
        .as_ref()
        .and_then(|version| parse_semver(version).map(|latest| (version, latest)))
        .and_then(|(version, latest)| current.as_ref().map(|current| (version, latest, current)))
        .map(|(_, latest, current)| latest > *current)
        .unwrap_or(false);

    let channel = if stable_update {
        "latest"
    } else if prerelease_newer {
        "prerelease"
    } else {
        "current"
    };
    let selected = if stable_update {
        stable.as_ref()
    } else if prerelease_newer {
        prerelease.as_ref()
    } else {
        stable.as_ref()
    };

    UpdateInfo {
        current_version,
        latest_version: stable_version,
        prerelease_version,
        has_update: stable_update,
        channel: channel.to_string(),
        release_url: stable.as_ref().map(|release| release.html_url.clone()),
        prerelease_url: prerelease.as_ref().map(|release| release.html_url.clone()),
        notes: selected.and_then(|release| release.body.clone()),
        error: None,
    }
}

fn newest_release<'a>(releases: impl Iterator<Item = &'a GithubRelease>) -> Option<GithubRelease> {
    releases
        .filter_map(|release| {
            parse_semver(&normalize_tag(&release.tag_name)).map(|version| (version, release))
        })
        .max_by(|(left, _), (right, _)| left.cmp(right))
        .map(|(_, release)| release.clone())
}

fn update_error(current_version: String, error: String) -> UpdateInfo {
    UpdateInfo {
        current_version,
        latest_version: None,
        prerelease_version: None,
        has_update: false,
        channel: "error".to_string(),
        release_url: None,
        prerelease_url: None,
        notes: None,
        error: Some(error),
    }
}

fn normalize_tag(tag: &str) -> String {
    tag.trim().trim_start_matches('v').to_string()
}

fn parse_semver(value: &str) -> Option<Semver> {
    let value = value.trim().trim_start_matches('v');
    let (numbers, prerelease) = value
        .split_once('-')
        .map(|(numbers, pre)| (numbers, Some(pre.to_string())))
        .unwrap_or((value, None));
    let mut parts = numbers.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some(Semver {
        major,
        minor,
        patch,
        prerelease,
    })
}

impl Ord for Semver {
    fn cmp(&self, other: &Self) -> Ordering {
        self.major
            .cmp(&other.major)
            .then_with(|| self.minor.cmp(&other.minor))
            .then_with(|| self.patch.cmp(&other.patch))
            .then_with(|| match (&self.prerelease, &other.prerelease) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(left), Some(right)) => left.cmp(right),
            })
    }
}

impl PartialOrd for Semver {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag_name: &str, prerelease: bool) -> GithubRelease {
        GithubRelease {
            tag_name: tag_name.to_string(),
            html_url: format!("https://example.com/{tag_name}"),
            body: Some(tag_name.to_string()),
            prerelease,
            draft: false,
        }
    }

    #[test]
    fn compares_semver_numerically() {
        assert!(parse_semver("0.10.0") > parse_semver("0.2.0"));
        assert!(parse_semver("1.0.0") > parse_semver("1.0.0-beta.1"));
    }

    #[test]
    fn distinguishes_stable_prerelease_and_current() {
        let info = build_update_info(
            "0.1.0".to_string(),
            vec![release("v0.2.0-beta.1", true), release("v0.1.0", false)],
        );
        assert!(!info.has_update);
        assert_eq!(info.channel, "prerelease");
        assert_eq!(info.latest_version.as_deref(), Some("0.1.0"));
        assert_eq!(info.prerelease_version.as_deref(), Some("0.2.0-beta.1"));

        let stable = build_update_info(
            "0.1.0".to_string(),
            vec![release("v0.10.0", false), release("v0.2.0-beta.1", true)],
        );
        assert!(stable.has_update);
        assert_eq!(stable.channel, "latest");
        assert_eq!(stable.latest_version.as_deref(), Some("0.10.0"));
    }
}
