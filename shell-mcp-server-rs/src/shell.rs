#[cfg(unix)]
use libc::{kill, SIGKILL, SIGTERM};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Debug, serde::Serialize)]
pub struct ShellResult {
    pub output: String,
    pub stdout: String,
    pub stderr: String,
    pub error: String,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub pid: Option<u32>,
    pub background_pids: Vec<u32>,
    pub timed_out: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct ShellExecOptions {
    pub cwd: PathBuf,
    pub timeout_ms: i64,
    pub max_output_bytes: usize,
}

enum StreamKind {
    Stdout,
    Stderr,
}

enum StreamEvent {
    Data(StreamKind, Vec<u8>),
    Done(StreamKind),
}

pub fn execute_shell(command: &str, options: ShellExecOptions) -> Result<ShellResult, String> {
    let is_windows = cfg!(windows);
    let temp_file_path = if is_windows {
        None
    } else {
        let name = format!("shell_pgrep_{}.tmp", Uuid::new_v4());
        Some(std::env::temp_dir().join(name))
    };

    let wrapped = if is_windows {
        command.trim().to_string()
    } else {
        let mut cmd = command.trim().to_string();
        if !cmd.ends_with('&') {
            cmd.push(';');
        }
        let tmp = temp_file_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        format!(
            "{{ {cmd} }}; __code=$?; pgrep -g 0 >{tmp} 2>&1; exit $__code;"
        )
    };

    let (spawn_file, spawn_args): (&str, Vec<String>) = if is_windows {
        (
            "powershell.exe",
            vec!["-NoProfile".to_string(), "-Command".to_string(), wrapped],
        )
    } else {
        ("bash", vec!["-c".to_string(), wrapped])
    };

    let mut child = Command::new(spawn_file)
        .args(&spawn_args)
        .current_dir(&options.cwd)
        .envs(std::env::vars())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| err.to_string())?;

    let pid = Some(child.id());

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let (tx, rx) = mpsc::channel();

    spawn_reader(stdout, tx.clone(), StreamKind::Stdout);
    spawn_reader(stderr, tx.clone(), StreamKind::Stderr);

    let mut output = String::new();
    let mut stdout_text = String::new();
    let mut stderr_text = String::new();
    let mut error_text = String::new();
    let mut truncated = false;
    let mut total_bytes = 0usize;
    let mut last_stream: Option<StreamKind> = None;
    let mut stdout_done = false;
    let mut stderr_done = false;
    let mut exit_status: Option<std::process::ExitStatus> = None;
    let mut timed_out = false;
    let mut kill_deadline: Option<Instant> = None;
    let mut last_activity = Instant::now();

    loop {
        if exit_status.is_none() {
            if let Ok(Some(status)) = child.try_wait() {
                exit_status = Some(status);
            }
        }

        if stdout_done && stderr_done && exit_status.is_some() {
            break;
        }

        if options.timeout_ms > 0 {
            let elapsed = last_activity.elapsed();
            if !timed_out && elapsed.as_millis() as i64 >= options.timeout_ms {
                timed_out = true;
                terminate_child(&mut child);
                kill_deadline = Some(Instant::now() + Duration::from_secs(2));
            }
        }

        if let Some(deadline) = kill_deadline {
            if Instant::now() >= deadline {
                force_kill(&mut child);
                kill_deadline = None;
            }
        }

        let wait = Duration::from_millis(100);
        match rx.recv_timeout(wait) {
            Ok(StreamEvent::Data(kind, chunk)) => {
                last_activity = Instant::now();
                if !truncated {
                    let remaining = options
                        .max_output_bytes
                        .saturating_sub(total_bytes);
                    if remaining == 0 {
                        truncated = true;
                    } else {
                        let slice = if chunk.len() > remaining {
                            truncated = true;
                            &chunk[..remaining]
                        } else {
                            &chunk[..]
                        };
                        let text = String::from_utf8_lossy(slice);
                        output.push_str(&text);
                        match kind {
                            StreamKind::Stdout => stdout_text.push_str(&text),
                            StreamKind::Stderr => stderr_text.push_str(&text),
                        }
                        total_bytes += slice.len();
                        last_stream = Some(kind);
                    }
                }
            }
            Ok(StreamEvent::Done(kind)) => match kind {
                StreamKind::Stdout => stdout_done = true,
                StreamKind::Stderr => stderr_done = true,
            },
            Err(RecvTimeoutError::Timeout) => {}
            Err(_) => break,
        }
    }

    let status = exit_status.unwrap_or_else(|| child.wait().unwrap());
    let exit_code = status.code();
    let signal = extract_signal(&status);

    if timed_out && error_text.is_empty() {
        error_text = format!(
            "Command was cancelled after {}ms of inactivity.",
            options.timeout_ms
        );
    }

    if truncated {
        output.push_str("\n[output truncated]");
        match last_stream {
            Some(StreamKind::Stderr) => stderr_text.push_str("\n[output truncated]"),
            _ => stdout_text.push_str("\n[output truncated]"),
        }
    }

    if output.is_empty() {
        output = "(empty)".to_string();
    }
    if stdout_text.is_empty() {
        stdout_text = "(empty)".to_string();
    }
    if stderr_text.is_empty() {
        stderr_text = "(empty)".to_string();
    }
    if error_text.is_empty() {
        error_text = "(none)".to_string();
    }

    let mut background_pids = Vec::new();
    if !is_windows {
        if let Some(path) = temp_file_path {
            if path.exists() {
                if let Ok(text) = fs::read_to_string(&path) {
                    for line in text.lines() {
                        if let Ok(pid_val) = line.trim().parse::<u32>() {
                            if Some(pid_val) != pid {
                                background_pids.push(pid_val);
                            }
                        }
                    }
                }
                let _ = fs::remove_file(&path);
            }
        }
    }

    Ok(ShellResult {
        output,
        stdout: stdout_text,
        stderr: stderr_text,
        error: error_text,
        exit_code,
        signal,
        pid,
        background_pids,
        timed_out,
        truncated,
    })
}

fn spawn_reader(mut reader: impl Read + Send + 'static, tx: mpsc::Sender<StreamEvent>, kind: StreamKind) {
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = tx.send(StreamEvent::Done(kind));
                    break;
                }
                Ok(n) => {
                    let _ = tx.send(StreamEvent::Data(kind, buffer[..n].to_vec()));
                }
                Err(_) => {
                    let _ = tx.send(StreamEvent::Done(kind));
                    break;
                }
            }
        }
    });
}

fn terminate_child(child: &mut Child) {
    if cfg!(windows) {
        let _ = child.kill();
        return;
    }
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            let _ = kill(pid, SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

fn force_kill(child: &mut Child) {
    if cfg!(windows) {
        let _ = child.kill();
        return;
    }
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        unsafe {
            let _ = kill(pid, SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

fn extract_signal(status: &std::process::ExitStatus) -> Option<String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|sig| sig.to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}
