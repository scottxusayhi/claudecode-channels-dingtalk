#!/bin/bash
# Run the DingTalk channel broker under launchd (macOS), so it starts at login,
# restarts if it dies, and survives the terminal or Claude Code session that
# would otherwise have started it.
#
#   deploy/launchd-broker.sh install     write the LaunchAgent and start it
#   deploy/launchd-broker.sh uninstall   stop it and remove the LaunchAgent
#   deploy/launchd-broker.sh status      show what launchd thinks
#
# The broker runs from this checkout. Proxy variables set when installing are
# carried into the job — tenant sessions inherit them to reach the model API.
set -euo pipefail

LABEL=com.remote-cc.dingtalk-broker
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

case "${1:-}" in
install)
  BUN="$(find_bun)"
  mkdir -p "$(dirname "$PLIST")" "$STATE"
  ENV="<key>PATH</key><string>$(xml "$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")</string>
    <key>HOME</key><string>$(xml "$HOME")</string>
    <key>DINGTALK_BROKER_STANDBY</key><string>1</string>"
  [ -n "${DINGTALK_STATE_DIR:-}" ] && ENV="$ENV
    <key>DINGTALK_STATE_DIR</key><string>$(xml "$DINGTALK_STATE_DIR")</string>"
  for v in HTTPS_PROXY HTTP_PROXY ALL_PROXY NO_PROXY https_proxy http_proxy all_proxy no_proxy; do
    [ -n "${!v:-}" ] && ENV="$ENV
    <key>$v</key><string>$(xml "${!v}")</string>"
  done
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$(xml "$BUN")</string><string>$(xml "$REPO/broker.ts")</string></array>
  <key>WorkingDirectory</key><string>$(xml "$REPO")</string>
  <key>EnvironmentVariables</key>
  <dict>
    $ENV
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <!-- Tenant sessions are started by the broker but must outlive a broker restart. -->
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$(xml "$STATE/broker.err.log")</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "installed $PLIST (bun: $BUN, repo: $REPO)"
  ;;
uninstall)
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  ;;
status)
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code|path) =' || echo "$LABEL is not loaded"
  ;;
*)
  echo "usage: $0 install|uninstall|status" >&2; exit 2
  ;;
esac
