use std::env;
use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptBackend {
    Auto,
    Tty,
}

pub struct TtyPrompt {
    input: std::fs::File,
    output: std::fs::File,
    buffer: Vec<u8>,
    backend: PromptBackend,
}

pub fn create_tty_prompt() -> Option<TtyPrompt> {
    if env::var("MODEL_CLI_DISABLE_TTY_PROMPTS").ok().as_deref() == Some("1") {
        return None;
    }
    let backend = resolve_prompt_backend();
    if backend.is_none() {
        return None;
    }
    let backend = backend.unwrap();
    let (input_path, output_path) = default_tty_paths();
    let input = OpenOptions::new().read(true).open(input_path).ok()?;
    let output = OpenOptions::new().write(true).open(output_path).ok()?;
    Some(TtyPrompt {
        input,
        output,
        buffer: Vec::new(),
        backend,
    })
}

impl TtyPrompt {
    pub fn backend(&self) -> PromptBackend {
        self.backend
    }

    pub fn writeln(&mut self, text: &str) -> io::Result<()> {
        self.write(text)?;
        self.write("\n")
    }

    pub fn write(&mut self, text: &str) -> io::Result<()> {
        self.output.write_all(text.as_bytes())?;
        self.output.flush()
    }

    pub fn ask(&mut self, prompt: &str, cancel: &AtomicBool) -> io::Result<Option<String>> {
        self.write(prompt)?;
        self.read_line_with_cancel(cancel)
    }

    fn read_line_with_cancel(&mut self, cancel: &AtomicBool) -> io::Result<Option<String>> {
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Ok(None);
            }
            if let Some(line) = self.consume_buffered_line() {
                return Ok(Some(line));
            }
            #[cfg(unix)]
            {
                use std::os::unix::io::AsRawFd;
                if !poll_readable(self.input.as_raw_fd(), 200)? {
                    continue;
                }
            }
            let mut buf = [0u8; 1024];
            let read = self.input.read(&mut buf)?;
            if read == 0 {
                return Ok(None);
            }
            self.buffer.extend_from_slice(&buf[..read]);
        }
    }

    fn consume_buffered_line(&mut self) -> Option<String> {
        if let Some(pos) = self.buffer.iter().position(|b| *b == b'\n') {
            let line_bytes: Vec<u8> = self.buffer.drain(..=pos).collect();
            let mut line = String::from_utf8_lossy(&line_bytes).to_string();
            line = line.trim_end_matches(['\r', '\n']).to_string();
            return Some(line);
        }
        None
    }
}

fn resolve_prompt_backend() -> Option<PromptBackend> {
    let candidates = [
        env::var("MODEL_CLI_UI_PROMPT_BACKEND").ok(),
        env::var("MODEL_CLI_PROMPT_BACKEND").ok(),
        env::var("MODEL_CLI_UI_PROMPTS_BACKEND").ok(),
        env::var("MODEL_CLI_PROMPTS_BACKEND").ok(),
    ];
    for candidate in candidates.iter().flatten() {
        if candidate.trim().is_empty() {
            continue;
        }
        return normalize_backend(candidate);
    }
    Some(PromptBackend::Auto)
}

fn normalize_backend(value: &str) -> Option<PromptBackend> {
    let raw = value.trim().to_lowercase();
    if raw.is_empty() || raw == "auto" {
        return Some(PromptBackend::Auto);
    }
    if matches!(raw.as_str(), "tty" | "terminal" | "console" | "cli") {
        return Some(PromptBackend::Tty);
    }
    if matches!(raw.as_str(), "ui" | "file" | "jsonl" | "log") {
        return None;
    }
    Some(PromptBackend::Auto)
}

fn default_tty_paths() -> (&'static str, &'static str) {
    if cfg!(windows) {
        ("\\\\.\\CONIN$", "\\\\.\\CONOUT$")
    } else {
        ("/dev/tty", "/dev/tty")
    }
}

#[cfg(unix)]
fn poll_readable(fd: i32, timeout_ms: i32) -> io::Result<bool> {
    let mut fds = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let res = unsafe { libc::poll(&mut fds, 1, timeout_ms) };
    if res < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(res > 0 && (fds.revents & libc::POLLIN) != 0)
}
