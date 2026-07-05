import ctypes
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent
EXPORT_FILE = ROOT / "supjav-export.txt"
LIBRARY_FILE = ROOT / "supjav-potplayer-library.json"
STATE_DIR = ROOT / "supjav-potplayer-states"


def main():
    if "--continue" in sys.argv[1:] or "--resume" in sys.argv[1:]:
        return continue_menu()
    return play_export()


def play_export():
    text = read_export_text()
    if not text.strip():
        return continue_menu()

    lines = text.splitlines()
    command = find_command(lines)
    if not command:
        return continue_menu()

    try:
        argv = split_windows_command(command)
    except Exception as error:
        print(f"Failed to parse exported command: {error}")
        return continue_menu()
    if not is_proxy_command(argv):
        return continue_menu()

    record = record_from_export(lines, argv, command)
    argv = prepare_proxy_args(record, argv, record["start"])
    save_record(record, argv)
    return run_proxy(argv, record)


def continue_menu():
    records = sorted(load_library().values(), key=record_sort_key, reverse=True)
    if not records:
        pause("No saved Supjav videos yet. Click Export Link on a video once, then run this again.")
        return 1

    print("Saved Supjav videos:")
    for index, record in enumerate(records, 1):
        print(f"{index}. {record_line(record)}")

    choice = input("Select number, or press Enter to close: ").strip()
    if not choice:
        return 0
    if not choice.isdigit() or not (1 <= int(choice) <= len(records)):
        pause("Invalid selection.")
        return 1

    record = records[int(choice) - 1]
    argv = list(record.get("argv") or [])
    if not argv:
        pause("Saved record has no playable command. Export this video again.")
        return 1

    seconds = resume_seconds(record)
    argv = prepare_proxy_args(record, argv, seconds)
    record["lastOpenedAt"] = now_iso()
    save_record(record, argv)
    return run_proxy(argv, record)


def read_export_text():
    if EXPORT_FILE.exists():
        text = EXPORT_FILE.read_text(encoding="utf-8-sig", errors="replace")
        if text.strip():
            return text

    try:
        return subprocess.check_output(
            ["powershell", "-NoProfile", "-Command", "Get-Clipboard -Raw"],
            text=True,
            encoding="utf-8",
            errors="replace",
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return ""


def record_from_export(lines, argv, command):
    title = export_value(lines, "Title")
    page = export_value(lines, "Page")
    server = export_value(lines, "Server")
    player = export_value(lines, "Player")
    filename = export_filename(lines) or safe_name(title) or "video"
    stream_url = arg_value(argv, "--url") or block_value(lines, "Stream URL:")
    duration = parse_export_seconds(export_value(lines, "Duration"))
    start = parse_export_seconds(export_value(lines, "Start"))
    resolution = export_value(lines, "Resolution")
    record_id = short_hash(f"{filename}\n{stream_url}")
    state_file = str(STATE_DIR / f"{record_id}.json")
    now = now_iso()

    existing = load_library().get(record_id, {})
    return {
        **existing,
        "id": record_id,
        "title": title,
        "page": page,
        "server": server,
        "player": player,
        "filename": filename,
        "streamUrl": stream_url,
        "duration": duration,
        "start": start,
        "resolution": resolution,
        "command": command,
        "stateFile": state_file,
        "createdAt": existing.get("createdAt") or now,
        "updatedAt": now,
        "lastOpenedAt": now,
    }


def prepare_proxy_args(record, argv, seconds):
    result = list(argv)
    state_file = record.get("stateFile") or str(STATE_DIR / f"{record['id']}.json")
    result = set_arg(result, "--resume-state", state_file)
    result = set_arg(result, "--seek", f"{max(0, float(seconds or 0)):.2f}")
    if record.get("duration"):
        result = set_arg(result, "--duration", f"{float(record['duration']):.2f}")
    return result


def run_proxy(argv, record):
    env = os.environ.copy()
    env["SUPJAV_TITLE"] = record.get("title") or ""
    env["SUPJAV_PAGE"] = record.get("page") or ""
    env["SUPJAV_FILENAME"] = record.get("filename") or ""
    if record.get("duration"):
        env["SUPJAV_DURATION"] = str(record["duration"])

    print("Running:")
    print(subprocess.list2cmdline(argv))
    print()

    code = subprocess.call(argv, env=env, cwd=str(ROOT))
    if code and code != 0xC000013A:
        pause(f"Process exited with code {code}.")
    return code


def load_library():
    try:
        data = json.loads(LIBRARY_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("items"), dict):
            return data["items"]
    except Exception:
        pass
    return {}


def save_record(record, argv):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    record = {**record, "argv": argv, "updatedAt": now_iso()}
    items = load_library()
    items[record["id"]] = record
    data = {"version": 1, "items": items}
    tmp = LIBRARY_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(LIBRARY_FILE)


def resume_seconds(record):
    state_file = record.get("stateFile")
    if state_file:
        try:
            data = json.loads(Path(state_file).read_text(encoding="utf-8"))
            value = float(data.get("seconds", 0))
            if value >= 0:
                return value
        except Exception:
            pass
    return float(record.get("start") or 0)


def record_line(record):
    position = format_clock(resume_seconds(record))
    duration = format_clock(record.get("duration")) if record.get("duration") else "unknown"
    server = record.get("server") or "?"
    resolution = record.get("resolution") or "unknown"
    last = last_played_label(record)
    name = record.get("filename") or record.get("title") or record.get("streamUrl") or record.get("id")
    return f"{trim(name, 46)}  {position} / {duration}  {server}  {resolution}  上次 {last}"


def record_sort_key(record):
    return record.get("lastOpenedAt") or record.get("updatedAt") or record.get("createdAt") or ""


def last_played_label(record):
    value = ""
    state_file = record.get("stateFile")
    if state_file:
        try:
            data = json.loads(Path(state_file).read_text(encoding="utf-8"))
            value = str(data.get("updatedAt") or "")
        except Exception:
            value = ""
    value = value or record.get("lastOpenedAt") or record.get("updatedAt") or record.get("createdAt") or "unknown"
    return format_datetime_label(value)


def is_proxy_command(argv):
    return len(argv) >= 2 and Path(argv[1]).name.lower() == "supjav-potplayer-proxy.js"


def export_value(lines, name):
    prefix = f"{name}:"
    for line in lines:
        if line.startswith(prefix):
            return line[len(prefix):].strip()
    return ""


def block_value(lines, heading):
    for index, line in enumerate(lines):
        if line.strip() != heading:
            continue
        for candidate in lines[index + 1:]:
            candidate = candidate.strip()
            if candidate:
                return candidate
    return ""


def export_filename(lines):
    player = export_value(lines, "Player")
    match = re.search(r"#supjav\.com@([^#?&/\\]+)", player)
    return match.group(1).strip() if match else ""


def find_command(lines):
    return command_after_heading(lines, "PotPlayer local proxy:") or command_after_heading(lines, "PotPlayer:")


def command_after_heading(lines, heading):
    for index, line in enumerate(lines):
        if line.strip() != heading:
            continue
        for candidate in lines[index + 1:]:
            candidate = candidate.strip()
            if candidate:
                return candidate
    return ""


def split_windows_command(command):
    argc = ctypes.c_int()
    ctypes.windll.shell32.CommandLineToArgvW.restype = ctypes.POINTER(ctypes.c_wchar_p)
    argv = ctypes.windll.shell32.CommandLineToArgvW(str(command), ctypes.byref(argc))
    if not argv:
        raise OSError("CommandLineToArgvW failed")
    try:
        return [argv[index] for index in range(argc.value)]
    finally:
        ctypes.windll.kernel32.LocalFree(argv)


def arg_value(argv, name):
    for index, value in enumerate(argv):
        if value == name and index + 1 < len(argv):
            return argv[index + 1]
        if value.startswith(f"{name}="):
            return value.split("=", 1)[1]
    return ""


def set_arg(argv, name, value):
    result = []
    index = 0
    replaced = False
    while index < len(argv):
        item = argv[index]
        if item == name:
            result.extend([name, str(value)])
            index += 2
            replaced = True
            continue
        if item.startswith(f"{name}="):
            result.append(f"{name}={value}")
            index += 1
            replaced = True
            continue
        result.append(item)
        index += 1
    if not replaced:
        result.extend([name, str(value)])
    return result


def parse_export_seconds(value):
    text = str(value or "").strip()
    match = re.search(r"\(([\d.]+)s\)", text)
    if match:
        return float(match.group(1))
    match = re.search(r"(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if match:
        return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))
    return 0.0


def format_clock(value):
    seconds = max(0, int(float(value or 0)))
    hh, rem = divmod(seconds, 3600)
    mm, ss = divmod(rem, 60)
    return f"{hh:02d}:{mm:02d}:{ss:02d}"


def format_datetime_label(value):
    text = str(value or "").strip()
    if not text or text == "unknown":
        return "unknown"
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
        return parsed.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return text[:16].replace("T", " ")


def short_hash(value):
    return hashlib.sha1(str(value).encode("utf-8", "ignore")).hexdigest()[:16]


def safe_name(value):
    return re.sub(r"\s+", " ", re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", str(value or ""))).strip(" .")


def trim(value, limit):
    text = str(value or "")
    return text if len(text) <= limit else text[: limit - 3] + "..."


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def pause(message):
    print(message)
    input("Press Enter to close")


if __name__ == "__main__":
    sys.exit(main())
