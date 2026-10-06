#!/bin/bash
# Run the question log (monitor.ts) under launchd (macOS): it starts at login,
# restarts if it dies, and needs nothing from the broker — installing,
# restarting or removing it never touches the broker or any session.
#
#   deploy/launchd-monitor.sh install     write the LaunchAgent and start it
#   deploy/launchd-monitor.sh uninstall   stop it and remove the LaunchAgent
#   deploy/launchd-monitor.sh status      show what launchd thinks
#
# What it records lands in the state dir: questions.log (readable, tail -f it)
# and questions.jsonl. `bun monitor.ts report` prints it grouped by person.
set -euo pipefail

LABEL=com.remote-cc.dingtalk-monitor
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="${DINGTALK_STATE_DIR:-$HOME/.claude/channels/dingtalk}"
DOMAIN="gui/$(id -u)"

find_bun() {
  for b in "$(command -v bun || true)" "$HOME/.local/bin/bun" "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    [ -n "$b" ] && [ -x "$b" ] && { echo "$b"; return; }
  done
  echo "bun not found" >&2; exit 1
}

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

# bootout returns before the job is gone; bootstrapping over it then fails
# with "5: Input/output error". Wait until launchd has really let go.
unload() {
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  for _ in $(seq 1 50); do launchctl print "$DOMAIN/$1" >/dev/null 2>&1 || return 0; sleep 0.2; done
}

case "${1:-}" in
install)
  BUN="$(find_bun)"
  mkdir -p "$(dirname "$PLIST")" "$STATE"
  ENV="<key>PATH</key><string>$(xml "$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")</string>
    <key>HOME</key><string>$(xml "$HOME")</string>"
  [ -n "${DINGTALK_STATE_DIR:-}" ] && ENV="$ENV
    <key>DINGTALK_STATE_DIR</key><string>$(xml "$DINGTALK_STATE_DIR")</string>"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(xml "$BUN")</string><string>$(xml "$REPO/monitor.ts")</string></array>
  <key>WorkingDirectory</key><string>$(xml "$REPO")</string>
  <key>EnvironmentVariables</key>
  <dict>
    $ENV
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$(xml "$STATE/monitor.err.log")</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
  unload "$LABEL"
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "installed $PLIST (bun: $BUN, repo: $REPO) — questions go to $STATE/questions.log"
  ;;
uninstall)
  unload "$LABEL"
  rm -f "$PLIST"
  echo "removed $LABEL (recorded questions are kept)"
  ;;
status)
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code|path) =' || echo "$LABEL is not loaded"
  ;;
*)
  echo "usage: $0 install|uninstall|status" >&2; exit 2
  ;;
esac
