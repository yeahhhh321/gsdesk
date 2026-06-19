use std::time::{Duration, Instant};

use regex::Regex;
use reqwest::blocking::{Client, ClientBuilder};
use reqwest::Proxy;

use crate::models::{MirrorCheckResult, NetworkDiagnosticResult, Settings, SourceProbeResult};
use crate::process::run_command_timeout;
use crate::settings::env_from_settings;

pub const SOURCES: &[(&str, &str, &str)] = &[
    (
        "github",
        "GitHub",
        "https://github.com/Genshin-bots/gsuid_core.git",
    ),
    (
        "cnb",
        "CNB 国内镜像",
        "https://cnb.cool/gscore-mirror/gsuid_core.git",
    ),
];

pub const MIRRORS: &[(&str, &str)] = &[
    ("官方", "https://pypi.org/simple/"),
    ("阿里", "https://mirrors.aliyun.com/pypi/simple/"),
    ("腾讯云", "https://mirrors.cloud.tencent.com/pypi/simple/"),
    ("火山引擎", "https://mirrors.volces.com/pypi/simple/"),
    (
        "华为云",
        "https://mirrors.huaweicloud.com/repository/pypi/simple/",
    ),
    ("清华大学", "https://pypi.tuna.tsinghua.edu.cn/simple/"),
    (
        "中国科学技术大学",
        "https://mirrors.ustc.edu.cn/pypi/simple/",
    ),
    (
        "北京外国语大学",
        "https://mirrors.bfsu.edu.cn/pypi/web/simple/",
    ),
    (
        "上海交通大学",
        "https://mirror.sjtu.edu.cn/pypi/web/simple/",
    ),
    ("南京大学", "https://mirror.nju.edu.cn/pypi/web/simple/"),
];

pub fn probe_sources(settings: &Settings) -> Vec<SourceProbeResult> {
    let envs = env_from_settings(settings);
    let mut results = SOURCES
        .iter()
        .map(|(id, name, url)| {
            let output = run_command_timeout(
                "git",
                &["ls-remote", "--heads", url],
                None,
                &envs,
                Duration::from_secs(12),
            );
            match output {
                Ok(output) if output.success => SourceProbeResult {
                    id: (*id).to_string(),
                    name: (*name).to_string(),
                    url: (*url).to_string(),
                    ok: true,
                    latency_ms: Some(output.elapsed_ms),
                    error: None,
                },
                Ok(output) => SourceProbeResult {
                    id: (*id).to_string(),
                    name: (*name).to_string(),
                    url: (*url).to_string(),
                    ok: false,
                    latency_ms: Some(output.elapsed_ms),
                    error: Some(first_non_empty(&output.stderr, &output.stdout)),
                },
                Err(error) => SourceProbeResult {
                    id: (*id).to_string(),
                    name: (*name).to_string(),
                    url: (*url).to_string(),
                    ok: false,
                    latency_ms: None,
                    error: Some(error),
                },
            }
        })
        .collect::<Vec<_>>();
    results.sort_by_key(|result| (!result.ok, result.latency_ms.unwrap_or(u128::MAX)));
    results
}

pub fn check_mirrors(settings: &Settings) -> Result<Vec<MirrorCheckResult>, String> {
    let client = mirror_client(settings)?;
    let mut results = MIRRORS
        .iter()
        .map(|(name, url)| check_mirror(&client, name, url))
        .collect::<Vec<_>>();
    results.sort_by(|a, b| {
        b.ok.cmp(&a.ok)
            .then_with(|| {
                b.speed_mbps
                    .partial_cmp(&a.speed_mbps)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| {
                a.latency_ms
                    .unwrap_or(u128::MAX)
                    .cmp(&b.latency_ms.unwrap_or(u128::MAX))
            })
    });
    Ok(results)
}

pub fn diagnose_targets(
    settings: &Settings,
    webconsole_url: Option<String>,
) -> Vec<NetworkDiagnosticResult> {
    let mut results = SOURCES
        .iter()
        .map(|(id, name, url)| diagnose_git_target(settings, id, name, url))
        .collect::<Vec<_>>();
    results.push(diagnose_http_target(
        settings,
        "pypi",
        "当前 PyPI 镜像",
        &format!("{}/pip/", settings.pypi_index_url.trim_end_matches('/')),
    ));
    if let Some(url) = webconsole_url {
        results.push(diagnose_webconsole_target(settings, &url));
    } else {
        results.push(NetworkDiagnosticResult {
            id: "webconsole".to_string(),
            label: "本机 WebConsole".to_string(),
            target: "Core 未启动".to_string(),
            ok: false,
            latency_ms: None,
            error: Some("Core 尚未启动，无法测试 /app".to_string()),
        });
    }
    results
}

fn diagnose_git_target(
    settings: &Settings,
    id: &str,
    label: &str,
    url: &str,
) -> NetworkDiagnosticResult {
    let output = run_command_timeout(
        "git",
        &["ls-remote", "--heads", url],
        None,
        &env_from_settings(settings),
        Duration::from_secs(12),
    );
    match output {
        Ok(output) if output.success => NetworkDiagnosticResult {
            id: id.to_string(),
            label: label.to_string(),
            target: url.to_string(),
            ok: true,
            latency_ms: Some(output.elapsed_ms),
            error: None,
        },
        Ok(output) => NetworkDiagnosticResult {
            id: id.to_string(),
            label: label.to_string(),
            target: url.to_string(),
            ok: false,
            latency_ms: Some(output.elapsed_ms),
            error: Some(first_non_empty(&output.stderr, &output.stdout)),
        },
        Err(error) => NetworkDiagnosticResult {
            id: id.to_string(),
            label: label.to_string(),
            target: url.to_string(),
            ok: false,
            latency_ms: None,
            error: Some(error),
        },
    }
}

fn diagnose_http_target(
    settings: &Settings,
    id: &str,
    label: &str,
    url: &str,
) -> NetworkDiagnosticResult {
    let client = match mirror_client(settings) {
        Ok(client) => client,
        Err(error) => {
            return NetworkDiagnosticResult {
                id: id.to_string(),
                label: label.to_string(),
                target: url.to_string(),
                ok: false,
                latency_ms: None,
                error: Some(error),
            }
        }
    };
    let started = Instant::now();
    match client.get(url).send() {
        Ok(response) if response.status().is_success() => NetworkDiagnosticResult {
            id: id.to_string(),
            label: label.to_string(),
            target: url.to_string(),
            ok: true,
            latency_ms: Some(started.elapsed().as_millis()),
            error: None,
        },
        Ok(response) => NetworkDiagnosticResult {
            id: id.to_string(),
            label: label.to_string(),
            target: url.to_string(),
            ok: false,
            latency_ms: Some(started.elapsed().as_millis()),
            error: Some(format!("HTTP {}", response.status())),
        },
        Err(error) => NetworkDiagnosticResult {
            id: id.to_string(),
            label: label.to_string(),
            target: url.to_string(),
            ok: false,
            latency_ms: None,
            error: Some(error.to_string()),
        },
    }
}

fn diagnose_webconsole_target(settings: &Settings, url: &str) -> NetworkDiagnosticResult {
    if proxy_configured(settings) && !no_proxy_covers_localhost(&settings.proxy.no_proxy) {
        return NetworkDiagnosticResult {
            id: "webconsole".to_string(),
            label: "本机 WebConsole".to_string(),
            target: url.to_string(),
            ok: false,
            latency_ms: None,
            error: Some(
                "NO_PROXY 未包含 127.0.0.1/localhost，WebConsole 可能被代理劫持".to_string(),
            ),
        };
    }
    let client = match Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent("GSDesk/0.1 webconsole-check")
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return NetworkDiagnosticResult {
                id: "webconsole".to_string(),
                label: "本机 WebConsole".to_string(),
                target: url.to_string(),
                ok: false,
                latency_ms: None,
                error: Some(error.to_string()),
            }
        }
    };
    let started = Instant::now();
    match client.get(url).send() {
        Ok(response) if response.status().is_success() => NetworkDiagnosticResult {
            id: "webconsole".to_string(),
            label: "本机 WebConsole".to_string(),
            target: url.to_string(),
            ok: true,
            latency_ms: Some(started.elapsed().as_millis()),
            error: None,
        },
        Ok(response) => NetworkDiagnosticResult {
            id: "webconsole".to_string(),
            label: "本机 WebConsole".to_string(),
            target: url.to_string(),
            ok: false,
            latency_ms: Some(started.elapsed().as_millis()),
            error: Some(format!("HTTP {}", response.status())),
        },
        Err(error) => NetworkDiagnosticResult {
            id: "webconsole".to_string(),
            label: "本机 WebConsole".to_string(),
            target: url.to_string(),
            ok: false,
            latency_ms: None,
            error: Some(error.to_string()),
        },
    }
}

fn proxy_configured(settings: &Settings) -> bool {
    !settings.proxy.http_proxy.trim().is_empty()
        || !settings.proxy.https_proxy.trim().is_empty()
        || !settings.proxy.all_proxy.trim().is_empty()
}

fn no_proxy_covers_localhost(no_proxy: &str) -> bool {
    no_proxy
        .split(',')
        .map(|item| item.trim().to_ascii_lowercase())
        .any(|item| matches!(item.as_str(), "127.0.0.1" | "localhost" | "::1"))
}

fn mirror_client(settings: &Settings) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("GSDesk/0.1 mirror-check");
    builder = add_proxy(builder, "http", &settings.proxy.http_proxy)?;
    builder = add_proxy(builder, "https", &settings.proxy.https_proxy)?;
    if !settings.proxy.all_proxy.trim().is_empty() {
        builder = builder.proxy(
            Proxy::all(settings.proxy.all_proxy.trim())
                .map_err(|error| format!("ALL_PROXY 无效: {error}"))?,
        );
    }
    builder
        .build()
        .map_err(|error| format!("创建镜像测速客户端失败: {error}"))
}

fn add_proxy(builder: ClientBuilder, scheme: &str, value: &str) -> Result<ClientBuilder, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(builder);
    }
    let proxy = match scheme {
        "http" => Proxy::http(value).map_err(|error| format!("HTTP_PROXY 无效: {error}"))?,
        "https" => Proxy::https(value).map_err(|error| format!("HTTPS_PROXY 无效: {error}"))?,
        _ => return Ok(builder),
    };
    Ok(builder.proxy(proxy))
}

fn check_mirror(client: &Client, name: &str, base_url: &str) -> MirrorCheckResult {
    let simple_url = format!("{}/pip/", base_url.trim_end_matches('/'));
    let started = Instant::now();
    let response = match client.get(&simple_url).send() {
        Ok(response) => response,
        Err(error) => {
            return MirrorCheckResult {
                name: name.to_string(),
                url: base_url.to_string(),
                ok: false,
                latency_ms: None,
                speed_mbps: None,
                error: Some(error.to_string()),
            }
        }
    };
    let latency_ms = started.elapsed().as_millis();
    let page = match response.text() {
        Ok(text) => text,
        Err(error) => {
            return MirrorCheckResult {
                name: name.to_string(),
                url: base_url.to_string(),
                ok: false,
                latency_ms: Some(latency_ms),
                speed_mbps: None,
                error: Some(format!("读取 simple 页面失败: {error}")),
            }
        }
    };
    if !page.to_lowercase().contains("pip") {
        return MirrorCheckResult {
            name: name.to_string(),
            url: base_url.to_string(),
            ok: false,
            latency_ms: Some(latency_ms),
            speed_mbps: None,
            error: Some("响应内容不是 pip 包索引".to_string()),
        };
    }
    let speed_mbps = measure_speed(client, &page, &simple_url).ok();
    MirrorCheckResult {
        name: name.to_string(),
        url: base_url.to_string(),
        ok: true,
        latency_ms: Some(latency_ms),
        speed_mbps,
        error: None,
    }
}

fn measure_speed(client: &Client, page: &str, page_url: &str) -> Result<f64, String> {
    let href_re = Regex::new(r#"href="([^"]+)""#).unwrap();
    let mut links = href_re
        .captures_iter(page)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .collect::<Vec<_>>();
    links.sort();
    let chosen = links
        .iter()
        .rev()
        .find(|link| link.contains(".whl"))
        .or_else(|| links.last())
        .ok_or_else(|| "页面中无可下载文件".to_string())?;
    let file_url = if chosen.starts_with("http") {
        chosen.to_string()
    } else {
        format!("{}{}", page_url, chosen.trim_start_matches("./"))
    };
    let started = Instant::now();
    let bytes = client
        .get(file_url)
        .send()
        .map_err(|error| error.to_string())?
        .bytes()
        .map_err(|error| error.to_string())?;
    let elapsed = started.elapsed().as_secs_f64();
    if elapsed == 0.0 {
        return Err("测速耗时为 0".to_string());
    }
    let limited = bytes.len().min(3 * 1024 * 1024);
    Ok(limited as f64 / elapsed / 1024.0 / 1024.0)
}

fn first_non_empty(a: &str, b: &str) -> String {
    let trimmed = a.trim();
    if trimmed.is_empty() {
        b.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_list_contains_required_hosts() {
        assert!(SOURCES
            .iter()
            .any(|(_, _, url)| url.contains("github.com/Genshin-bots")));
        assert!(SOURCES
            .iter()
            .any(|(_, _, url)| url.contains("cnb.cool/gscore-mirror")));
    }

    #[test]
    fn mirror_list_contains_upstream_choices() {
        assert_eq!(MIRRORS.len(), 10);
        assert!(MIRRORS.iter().any(|(name, _)| *name == "清华大学"));
    }

    #[test]
    fn no_proxy_detection_covers_local_webconsole() {
        assert!(no_proxy_covers_localhost("127.0.0.1,localhost,::1"));
        assert!(no_proxy_covers_localhost(" example.com, LOCALHOST "));
        assert!(!no_proxy_covers_localhost("example.com,10.0.0.1"));
    }
}
