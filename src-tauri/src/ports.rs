use std::net::TcpListener;
use std::time::{Duration, Instant};

use crate::models::{ClearPortResult, PortOccupant};
use crate::process::run_command_timeout;

pub fn service_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub fn select_port() -> u16 {
    for port in 8765..=8865 {
        if service_port_available(port) {
            return port;
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok().map(|addr| addr.port()))
        .unwrap_or(8765)
}

fn port_occupant_summary(port: u16) -> Option<String> {
    let occupants = port_occupants(port).ok()?;
    let summary = occupants
        .iter()
        .map(|occupant| format!("{} {}", occupant.pid, occupant.name))
        .collect::<Vec<_>>()
        .join(", ");
    if summary.is_empty() {
        None
    } else {
        Some(summary)
    }
}

pub fn clear_occupied_port(port: u16) -> Result<ClearPortResult, String> {
    validate_user_port(port)?;
    let occupants = port_occupants(port)?;
    if occupants.is_empty() {
        return Ok(ClearPortResult {
            port,
            occupants,
            killed_pids: Vec::new(),
            released: true,
            message: format!("端口 {port} 当前未被占用"),
        });
    }

    let current_pid = std::process::id();
    let mut killed_pids = Vec::new();
    for occupant in &occupants {
        guard_kill_target(occupant, current_pid)?;
        force_kill_pid(occupant.pid)?;
        killed_pids.push(occupant.pid);
    }

    let released = wait_for_port_release(port, Duration::from_secs(5));
    if !released {
        let next = port_occupant_summary(port).unwrap_or_else(|| "仍无法确认占用进程".to_string());
        return Err(format!("已强杀进程 {:?}，但端口 {port} 仍未释放: {next}", killed_pids));
    }

    Ok(ClearPortResult {
        port,
        occupants,
        killed_pids: killed_pids.clone(),
        released,
        message: format!("端口 {port} 已释放，强杀进程: {:?}", killed_pids),
    })
}

fn validate_user_port(port: u16) -> Result<(), String> {
    if (1024..=65535).contains(&port) {
        Ok(())
    } else {
        Err(format!("端口 {port} 不在允许范围 1024-65535"))
    }
}

pub fn port_occupants(port: u16) -> Result<Vec<PortOccupant>, String> {
    if cfg!(windows) {
        windows_port_occupants(port)
    } else {
        unix_port_occupants(port)
    }
}

fn windows_port_occupants(port: u16) -> Result<Vec<PortOccupant>, String> {
    let script = format!(
        "$connections = Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | Select-Object -Property OwningProcess -Unique; \
         foreach ($connection in $connections) {{ \
           $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue; \
           if ($process) {{ \
             $path = $process.Path; if (-not $path) {{ $path = '' }}; \
             \"$($connection.OwningProcess)`t$($process.ProcessName)`t$path\" \
           }} else {{ \
             \"$($connection.OwningProcess)`t未知进程`t\" \
           }} \
         }}"
    );
    let output = run_command_timeout(
        "powershell",
        &["-NoProfile", "-Command", &script],
        None,
        &[],
        Duration::from_secs(5),
    )?;
    if !output.success {
        return Err(format!(
            "查询端口 {port} 占用失败: {}",
            first_non_empty(&output.stderr, &output.stdout)
        ));
    }
    Ok(parse_occupants_tsv(&output.stdout))
}

fn unix_port_occupants(port: u16) -> Result<Vec<PortOccupant>, String> {
    let command = format!("lsof -nP -iTCP:{port} -sTCP:LISTEN -Fpc 2>/dev/null || true");
    let output = run_command_timeout("sh", &["-c", &command], None, &[], Duration::from_secs(5))?;
    if !output.success {
        return Err(format!(
            "查询端口 {port} 占用失败: {}",
            first_non_empty(&output.stderr, &output.stdout)
        ));
    }
    Ok(parse_lsof_field_output(&output.stdout))
}

fn parse_occupants_tsv(output: &str) -> Vec<PortOccupant> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let pid = parts.next()?.trim().parse::<u32>().ok()?;
            let name = parts.next().unwrap_or("未知进程").trim();
            let path = parts.next().map(str::trim).filter(|value| !value.is_empty());
            Some(PortOccupant {
                pid,
                name: if name.is_empty() { "未知进程".to_string() } else { name.to_string() },
                path: path.map(str::to_string),
            })
        })
        .collect()
}

fn parse_lsof_field_output(output: &str) -> Vec<PortOccupant> {
    let mut occupants = Vec::new();
    let mut current_pid: Option<u32> = None;
    let mut current_name: Option<String> = None;
    for line in output.lines() {
        if let Some(value) = line.strip_prefix('p') {
            if let Some(pid) = current_pid.take() {
                occupants.push(PortOccupant {
                    pid,
                    name: current_name.take().unwrap_or_else(|| "未知进程".to_string()),
                    path: None,
                });
            }
            current_pid = value.trim().parse::<u32>().ok();
        } else if let Some(value) = line.strip_prefix('c') {
            current_name = Some(value.trim().to_string());
        }
    }
    if let Some(pid) = current_pid {
        occupants.push(PortOccupant {
            pid,
            name: current_name.unwrap_or_else(|| "未知进程".to_string()),
            path: None,
        });
    }
    occupants
}

fn guard_kill_target(occupant: &PortOccupant, current_pid: u32) -> Result<(), String> {
    if occupant.pid == current_pid {
        return Err(format!("拒绝强杀当前 GSDesk 进程 pid={}", occupant.pid));
    }
    if occupant.pid == 0 || (cfg!(windows) && occupant.pid == 4) {
        return Err(format!("拒绝强杀系统进程 pid={} ({})", occupant.pid, occupant.name));
    }
    Ok(())
}

fn force_kill_pid(pid: u32) -> Result<(), String> {
    let output = if cfg!(windows) {
        run_command_timeout(
            "taskkill",
            &["/PID", &pid.to_string(), "/T", "/F"],
            None,
            &[],
            Duration::from_secs(10),
        )
    } else {
        run_command_timeout(
            "kill",
            &["-KILL", &pid.to_string()],
            None,
            &[],
            Duration::from_secs(10),
        )
    }?;
    if output.success {
        Ok(())
    } else {
        Err(format!("强杀进程 pid={pid} 失败: {}", first_non_empty(&output.stderr, &output.stdout)))
    }
}

fn wait_for_port_release(port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if service_port_available(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    service_port_available(port)
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
    fn parses_windows_port_occupants() {
        let occupants =
            parse_occupants_tsv("1234\tpython\tC:\\Python\\python.exe\n5678\tuvicorn\t\n");

        assert_eq!(occupants.len(), 2);
        assert_eq!(occupants[0].pid, 1234);
        assert_eq!(occupants[0].name, "python");
        assert_eq!(occupants[0].path.as_deref(), Some("C:\\Python\\python.exe"));
        assert_eq!(occupants[1].path, None);
    }

    #[test]
    fn parses_lsof_field_output() {
        let occupants = parse_lsof_field_output("p1234\ncpython\np5678\ncuvicorn\n");

        assert_eq!(occupants.len(), 2);
        assert_eq!(occupants[0].pid, 1234);
        assert_eq!(occupants[0].name, "python");
        assert_eq!(occupants[1].pid, 5678);
    }

    #[test]
    fn refuses_to_kill_current_or_system_processes() {
        let current =
            PortOccupant { pid: std::process::id(), name: "gsdesk".to_string(), path: None };
        assert!(guard_kill_target(&current, std::process::id()).is_err());

        let system = PortOccupant { pid: 0, name: "System".to_string(), path: None };
        assert!(guard_kill_target(&system, std::process::id()).is_err());
    }
}
