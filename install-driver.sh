#!/bin/bash
# install-driver.sh — one-command OpenRazer driver setup for the
# Razer Battery extension. Run when the indicator shows "!" (driver missing).
# Supported: Arch (and derivatives), Fedora, Ubuntu, Debian, openSUSE.
# After install: reboot (module + group permissions need it).
set -e

say() { echo "[razer-battery] $*"; }

# --- distro detection -------------------------------------------------------
if [ -f /etc/arch-release ]; then
    DISTRO=arch
elif [ -f /etc/fedora-release ]; then
    DISTRO=fedora
elif [ -f /etc/debian_version ]; then
    DISTRO=debian   # covers Ubuntu too
elif [ -f /etc/os-release ] && grep -q openSUSE /etc/os-release; then
    DISTRO=opensuse
else
    say "Unknown distro. See https://openrazer.github.io/ for manual install."
    exit 1
fi

# --- already installed? -----------------------------------------------------
if [ -d /sys/module/razermouse ] || ls /sys/bus/hid/drivers/razermouse >/dev/null 2>&1; then
    say "Driver already loaded. If the extension still shows '!', log out and back in."
    exit 0
fi

# --- kernel headers note ----------------------------------------------------
say "The driver is built via DKMS; matching kernel headers are required."
say "You may be asked for your sudo password."

case "$DISTRO" in
arch)
    say "Detected Arch Linux."
    say "Installing: openrazer-driver-dkms (+ linux-headers if missing)."
    sudo pacman -S --needed linux-headers
    sudo pacman -S --needed openrazer-driver-dkms
    # Arch packages the udev group as 'openrazer' since Nov 2025.
    sudo gpasswd -a "$USER" openrazer || true
    ;;
fedora)
    say "Detected Fedora."
    say "Installing: openrazer-meta from the hardware:razer repo."
    sudo dnf install -y \
        "https://download.opensuse.org/repositories/hardware:/razer/Fedora_$(rpm -E %fedora)/$(rpm -E %{?repo:noarch})/hardware:razer.repo" \
        2>/dev/null \
    || sudo dnf config-manager --add-repo \
        "https://download.opensuse.org/repositories/hardware:/razer/Fedora_$(rpm -E %fedora)/hardware:razer.repo"
    sudo dnf install -y openrazer-meta
    sudo gpasswd -a "$USER" plugdev || true
    ;;
debian)
    . /etc/os-release
    if [ -n "${UBUNTU_CODENAME:-}" ]; then
        say "Detected Ubuntu ($UBUNTU_CODENAME)."
    else
        say "Detected Debian."
    fi
    say "Installing: openrazer-driver-dkms from the archive (universe on Ubuntu)."
    sudo apt-get update
    sudo apt-get install -y openrazer-driver-dkms
    sudo gpasswd -a "$USER" plugdev || true
    ;;
opensuse)
    say "Detected openSUSE."
    say "Installing: openrazer-driver-dkms from hardware:razer repo."
    sudo zypper addrepo \
        "https://download.opensuse.org/repositories/hardware:/razer/openSUSE_Tumbleweed/hardware:razer.repo"
    sudo zypper --gpg-auto-import-keys install -y openrazer-driver-dkms
    sudo gpasswd -a "$USER" plugdev || true
    ;;
esac

YELLOW="\033[1;33m"; RESET="\033[0m"
echo ""
echo -e "${YELLOW}Done. IMPORTANT: reboot now — the kernel module and the group${RESET}"
echo -e "${YELLOW}permission only take effect after a reboot.${RESET}"
echo ""
say "If Secure Boot blocks the module, see:"
say "https://github.com/openrazer/openrazer/wiki/Troubleshooting"