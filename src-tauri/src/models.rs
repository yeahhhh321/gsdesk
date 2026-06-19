use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    pub http_proxy: String,
    pub https_proxy: String,
    pub all_proxy: String,
    pub no_proxy: String,
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            http_proxy: String::new(),
            https_proxy: String::new(),
            all_proxy: String::new(),
            no_proxy: "127.0.0.1,localhost,::1".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub source_mode: String,
    pub selected_source: String,
    pub pypi_index_mode: String,
    pub pypi_index_url: String,
    pub preferred_core_port: Option<u16>,
    pub last_source_probe_at: Option<String>,
    pub last_mirror_check_at: Option<String>,
    pub proxy: ProxySettings,
    pub close_core_on_exit: bool,
    pub auto_check_update: bool,
    pub install_guide_completed: bool,
    pub language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            source_mode: "auto".to_string(),
            selected_source: "https://github.com/Genshin-bots/gsuid_core.git".to_string(),
            pypi_index_mode: "auto".to_string(),
            pypi_index_url: "https://pypi.org/simple/".to_string(),
            preferred_core_port: None,
            last_source_probe_at: None,
            last_mirror_check_at: None,
            proxy: ProxySettings::default(),
            close_core_on_exit: true,
            auto_check_update: true,
            install_guide_completed: false,
            language: "zh-CN".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    pub app_data: String,
    pub runtime: String,
    pub tools_dir: String,
    pub core_dir: String,
    pub venv_dir: String,
    pub uv_cache_dir: String,
    pub uv_python_dir: String,
    pub uv_executable: String,
    pub logs_dir: String,
    pub diagnostics_dir: String,
    pub backups_dir: String,
    pub settings_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainInfo {
    pub uv_detected: bool,
    pub uv_path: Option<String>,
    pub uv_source: String,
    pub uv_version: Option<String>,
    pub uv_bootstrap_supported: bool,
    pub uv_bootstrap_target: String,
    pub uv_bootstrap_url: Option<String>,
    pub uv_error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ServiceStatus {
    Uninitialized,
    Checking,
    Initializing,
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed,
    Crashed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSnapshot {
    pub service_id: String,
    pub name: String,
    pub status: ServiceStatus,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub url: Option<String>,
    pub started_at: Option<String>,
    pub current_commit: Option<String>,
    pub current_tag: Option<String>,
    pub recent_error: Option<String>,
    pub health_ok: bool,
    pub webconsole_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: u64,
    pub service_id: String,
    pub stream: String,
    pub level: String,
    pub line: String,
    pub message: String,
    pub module: Option<String>,
    pub raw: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateResponse {
    pub version: String,
    pub settings: Settings,
    pub paths: AppPaths,
    pub services: Vec<ServiceSnapshot>,
    pub recent_logs: Vec<LogEntry>,
    pub preflight_checks: Vec<PreflightCheck>,
    pub task_history: Vec<TaskRecord>,
    pub toolchain: ToolchainInfo,
    pub uv_detected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightCheck {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub stage: String,
    pub message: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub elapsed_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProbeResult {
    pub id: String,
    pub name: String,
    pub url: String,
    pub ok: bool,
    pub latency_ms: Option<u128>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorCheckResult {
    pub name: String,
    pub url: String,
    pub ok: bool,
    pub latency_ms: Option<u128>,
    pub speed_mbps: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnosticResult {
    pub id: String,
    pub label: String,
    pub target: String,
    pub ok: bool,
    pub latency_ms: Option<u128>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartServiceRequest {
    pub service_id: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairRuntimeRequest {
    pub action: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreUpdateRequest {
    pub action: String,
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreUpdateResult {
    pub action: String,
    pub channel: String,
    pub current_commit: Option<String>,
    pub target_commit: Option<String>,
    pub rollback_commit: Option<String>,
    pub changed: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeBackupResult {
    pub path: String,
    pub included: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRestoreRequest {
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRestoreResult {
    pub path: String,
    pub safety_backup: Option<String>,
    pub restored: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTransferRequest {
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTransferResult {
    pub path: String,
    pub fields: Vec<String>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreConfigFileSummary {
    pub relative_path: String,
    pub label: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub entry_count: usize,
    pub secret_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreConfigReadRequest {
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreConfigEntry {
    pub key: String,
    pub title: String,
    pub description: String,
    pub value: Value,
    pub value_type: String,
    pub options: Vec<Value>,
    pub secret: bool,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreConfigFileContent {
    pub relative_path: String,
    pub path: String,
    pub schema: String,
    pub entries: Vec<CoreConfigEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreConfigSaveRequest {
    pub relative_path: String,
    pub entries: Vec<CoreConfigSaveEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreConfigSaveEntry {
    pub key: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreConfigSaveResult {
    pub relative_path: String,
    pub path: String,
    pub backup_path: Option<String>,
    pub saved: Vec<String>,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebConsoleInfo {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub prerelease_version: Option<String>,
    pub has_update: bool,
    pub channel: String,
    pub release_url: Option<String>,
    pub prerelease_url: Option<String>,
    pub notes: Option<String>,
    pub error: Option<String>,
}
