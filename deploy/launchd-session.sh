#!/bin/bash
# Keep one long-lived Claude Code session running under launchd (macOS) — for
# a single-tenant channel bot that used to live in a terminal tab. The job is a
# small supervisor: every 30s it checks that the conversation is running as a
# background session (`claude agents`) and resumes it with
# `claude --bg --resume` when it isn't — after a reboot, a crash, or the
# session exiting on its own. The conversation keeps its id across restarts.
#
#   deploy/launchd-session.sh install <name> <dir> <session-id> [claude flags...]
#   deploy/launchd-session.sh uninstall <name>     stop the supervisor and the session
#   deploy/launchd-session.sh status <name>
#
# <dir> is the session's working directory (its project settings apply);
# <session-id> is the conversation to keep resuming. Flags after it go to every
# launch, e.g.  --channels plugin:dingtalk@remote-cc --effort xhigh
# A background session can't answer the development-channel prompt, so use
# --channels and put the plugin on the managed allowlist (allowedChannelPlugins).
#
# While the same conversation is open in a terminal, the supervisor waits
# instead of starting a copy next to it.
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
DOMAIN="gui/$(id -u)"
CHECK_EVERY=30

label() { echo "com.remote-cc.session.$1"; }
plist() { echo "$HOME/Library/LaunchAgents/$(label "$1").plist"; }
logfile() { echo "$HOME/Library/Logs/claude-session-$1.log"; }

find_bin() {
  for b in "$(command -v "$1" || true)" "$HOME/.local/bin/$1" "$HOME/.bun/bin/$1" "/opt/homebrew/bin/$1" "/usr/local/bin/$1"; do
    [ -n "$b" ] && [ -x "$b" ] && { echo "$b"; return; }
  done
  echo "$1 not found" >&2; exit 1
}

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

check_name() {
  [[ "${1:-}" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "name must be [A-Za-z0-9._-]+" >&2; exit 2; }
}

# The conversation an installed job supervises (argument 5 of its plist), or nothing.
sid_of() {
  local s
  s="$(plutil -extract ProgramArguments.5 raw -o - "$(plist "$1")" 2>/dev/null || true)"
  if [[ "$s" =~ ^[0-9a-f-]{36}$ ]]; then echo "$s"; fi
}

# Where the conversation is running now: "background <pid>", "interactive <pid>", or "none".
where_running() {
  "$CLAUDE" agents --json </dev/null 2>/dev/null | SID="$1" "$BUN" -e '
    const rows = await Bun.stdin.json().catch(() => [])
    const list = Array.isArray(rows) ? rows : rows.sessions ?? []
    const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
    const hit = list.filter(r => r.sessionId === process.env.SID && r.pid && alive(r.pid))
    const r = hit.find(r => r.kind === "interactive") ?? hit[0]
    console.log(r ? `${r.kind} ${r.pid}` : "none")'
}

# bootout returns before the job is gone; bootstrapping over it then fails
# with "5: Input/output error". Wait until launchd has really let go.
unload() {
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  for _ in $(seq 1 50); do launchctl print "$DOMAIN/$1" >/dev/null 2>&1 || return 0; sleep 0.2; done
}

case "${1:-}" in
install)
  NAME="${2:-}"; DIR="${3:-}"; SID="${4:-}"
  check_name "$NAME"
  [ -d "$DIR" ] || { echo "no such directory: $DIR" >&2; exit 2; }
  [[ "$SID" =~ ^[0-9a-f-]{36}$ ]] || { echo "session id must be a full UUID" >&2; exit 2; }
  shift 4
  find_bin claude >/dev/null; find_bin bun >/dev/null
  P="$(plist "$NAME")"
  mkdir -p "$(dirname "$P")" "$HOME/Library/Logs"
  ARGS=""
  for a in /bin/bash "$SELF" run "$NAME" "$DIR" "$SID" ${@+"$@"}; do ARGS="$ARGS<string>$(xml "$a")</string>"; done
  cat > "$P" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(label "$NAME")</string>
  <key>ProgramArguments</key>
  <array>$ARGS</array>
  <key>WorkingDirectory</key><string>$(xml "$DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")</string>
    <key>HOME</key><string>$(xml "$HOME")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <!-- The session lives in Claude Code's background daemon, which other jobs share; never take it down with this one. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>$(xml "$(logfile "$NAME")")</string>
  <key>StandardErrorPath</key><string>$(xml "$(logfile "$NAME")")</string>
</dict>
</plist>
EOF
  plutil -lint "$P" >/dev/null
  unload "$(label "$NAME")"
  launchctl bootstrap "$DOMAIN" "$P"
  echo "installed $P — log: $(logfile "$NAME")"
  ;;
run)
  # What launchd runs. Not meant to be called by hand.
  NAME="$2"; DIR="$3"; SID="$4"; shift 4
  CLAUDE="$(find_bin claude)"; BUN="$(find_bin bun)"
  cd "$DIR"
  log() { echo "$(date -u +%FT%TZ) $*"; }
  log "supervising ${SID:0:8} in $DIR"
  wait_s=$CHECK_EVERY; waiting=""
  while :; do
    read -r kind pid <<<"$(where_running "$SID")"
    case "$kind" in
    background) wait_s=$CHECK_EVERY; waiting="" ;;
    interactive)
      [ -z "$waiting" ] && log "open in a terminal (pid $pid) — waiting for it to close before resuming in the background"
      waiting=1 ;;
    *)
      waiting=""
      # A background session that stopped or exited is still on record, and
      # resuming it then starts a copy under a new id. Respawn keeps the id
      # (and the flags it was started with); resume only when there's no record.
      if out="$("$CLAUDE" respawn "${SID:0:8}" </dev/null 2>&1)"; then
        log "not running — $out"
      else
        log "not running — resuming in the background"
        out="$("$CLAUDE" --bg --resume "$SID" --name "$NAME" ${@+"$@"} </dev/null 2>&1)" || log "launch failed"
        echo "$out" | sed 's/^/  /'
        copy="$(grep -oE 'backgrounded · [0-9a-f]{8}' <<<"$out" | awk '{print $3}' || true)"
        if [ -n "$copy" ] && [ "$copy" != "${SID:0:8}" ]; then
          log "that started a copy ($copy) instead of ${SID:0:8} — removing it"
          "$CLAUDE" stop "$copy" </dev/null >/dev/null 2>&1 || true
          "$CLAUDE" rm "$copy" </dev/null >/dev/null 2>&1 || true
        fi
      fi
      sleep 15
      read -r kind pid <<<"$(where_running "$SID")"
      if [ "$kind" = background ]; then log "running (pid $pid)"; wait_s=$CHECK_EVERY
      else wait_s=$(( wait_s * 2 > 600 ? 600 : wait_s * 2 )); log "did not stay up — next try in ${wait_s}s"
      fi ;;
    esac
    sleep "$wait_s"
  done
  ;;
uninstall)
  NAME="${2:-}"; check_name "$NAME"
  P="$(plist "$NAME")"
  SID="$(sid_of "$NAME")"
  unload "$(label "$NAME")"
  rm -f "$P"
  if [ -n "$SID" ]; then
    "$(find_bin claude)" stop "${SID:0:8}" </dev/null 2>&1 | sed 's/^/  /' || true
  fi
  echo "removed $(label "$NAME")"
  ;;
status)
  NAME="${2:-}"; check_name "$NAME"
  launchctl print "$DOMAIN/$(label "$NAME")" 2>/dev/null | grep -E '^\s*(state|pid|last exit code|path) =' || echo "$(label "$NAME") is not loaded"
  SID="$(sid_of "$NAME")"
  if [ -n "$SID" ]; then
    CLAUDE="$(find_bin claude)"; BUN="$(find_bin bun)"
    echo "	session ${SID:0:8}: $(where_running "$SID")"
  fi
  tail -n 5 "$(logfile "$NAME")" 2>/dev/null | sed 's/^/	| /' || true
  ;;
*)
  echo "usage: $0 install <name> <dir> <session-id> [claude flags...] | uninstall <name> | status <name>" >&2; exit 2
  ;;
esac
