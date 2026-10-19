#!/bin/sh
# Installs the mouse icon into the user's hicolor icon theme so GNOME
# applies symbolic recoloring (the silhouette follows the panel text
# color). Run once after cloning the extension, then reload GNOME Shell.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/status"
mkdir -p "$DEST"
cp "$DIR/icon-mouse.svg" "$DEST/battery-razer-mouse-symbolic.svg"
gtk-update-icon-cache "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" 2>/dev/null || true
echo "Icon installed. Log out and back in (or restart GNOME Shell)."
