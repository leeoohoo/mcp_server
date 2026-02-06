use std::fs;

fn to_positive_int(value: i64, fallback: i64) -> i64 {
    if value >= 0 {
        value
    } else {
        fallback
    }
}

pub fn cap_jsonl_file(file_path: &str, max_bytes: i64, max_lines: i64) {
    let target = file_path.trim();
    if target.is_empty() {
        return;
    }
    let max_bytes = to_positive_int(max_bytes, 0) as usize;
    let max_lines = to_positive_int(max_lines, 0) as usize;
    if max_bytes == 0 && max_lines == 0 {
        return;
    }

    let stat = match fs::metadata(target) {
        Ok(stat) => stat,
        Err(_) => return,
    };

    if max_bytes > 0 && stat.len() <= max_bytes as u64 && max_lines == 0 {
        return;
    }
    if max_bytes > 0 && stat.len() <= max_bytes as u64 && max_lines > 0 {
        return;
    }

    let content = match fs::read_to_string(target) {
        Ok(content) => content,
        Err(_) => return,
    };
    let mut lines: Vec<&str> = content
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .collect();
    if lines.is_empty() {
        return;
    }

    if max_lines > 0 && lines.len() > max_lines {
        lines = lines.split_off(lines.len() - max_lines);
    }

    if max_bytes > 0 {
        loop {
            let combined = lines.join("\n");
            if combined.len() <= max_bytes || lines.len() <= 1 {
                break;
            }
            lines.remove(0);
        }
    }

    let output = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    let _ = fs::write(target, output);
}
