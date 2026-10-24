#!/bin/bash
# install-driver.sh — one-command OpenRazer driver setup for the
# Razer Battery extension. Run when the indicator shows "!" (driver missing).
# Supported: Arch, Manjaro/EndeavourOS, Fedora, Ubuntu, Debian, openSUSE.
# After install: reboot (module + group permissions need it).

# Pause on ANY exit (success handled at the end) so the terminal window the
# extension opened never flashes closed on error — the user must see why.
trap 'rc=$?; if [ $rc -ne 0 ]; then
    echo ""
    echo "Install FAILED (see the messages above)."
    read -rp "Press Enter to close this window..." _ < /dev/tty || true
fi' EXIT
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

add_group() {
    # Add the user to the driver group and VERIFY — a failed group add must
    # not be silently swallowed, the extension depends on it after reboot.
    local grp="$1"
    # Verify against /etc/group, NOT `id -nG`: the current session does not
    # include the new group until the reboot the script asks for anyway.
    sudo gpasswd -a "$USER" "$grp"
    if ! getent group "$grp" | grep -qw "$USER"; then
        say "WARNING: could not add $USER to group '$grp'."
        say "Run manually:  sudo gpasswd -a $USER $grp"
        exit 1
    fi
}

case "$DISTRO" in
arch)
    . /etc/os-release
    say "Detected ${PRETTY_NAME:-Arch Linux}."
    # Kernel headers must match the RUNNING kernel: plain Arch uses
    # linux/linux-headers, Manjaro and other derivatives name them
    # linux61/linux61-headers etc.
    KVER="$(uname -r)"
    if [[ "$KVER" == *arch1-1 || "$KVER" == *arch*-1 ]]; then
        HDRS="linux-headers"
    else
        # e.g. 6.6.14-2-MANJARO -> linux66-headers
        HDRS="linux$(echo "$KVER" | sed -E 's/^([0-9]+)\.([0-9]+).*/\1\2/')-headers"
    fi
    say "Installing: openrazer-driver-dkms (+ $HDRS if missing)."
    # stdin is the curl pipe: pacman's interactive [Y/n] prompt would eat
    # the undelivered rest of the script. Point it at the real terminal.
    sudo pacman -S --needed "$HDRS" < /dev/tty
    sudo pacman -S --needed openrazer-driver-dkms < /dev/tty
    # Arch packages the udev group as 'openrazer' since Nov 2025.
    add_group openrazer
    ;;
fedora)
    say "Detected Fedora."
    say "Installing: openrazer-meta from the hardware:razer repo."
    REPO_URL="https://download.opensuse.org/repositories/hardware:/razer/Fedora_$(rpm -E %fedora)/hardware:razer.repo"
    # Fedora 41+ ships dnf5: config-manager subcommand is 'addrepo'.
    if sudo dnf config-manager addrepo --from-repofile="$REPO_URL" 2>/dev/null; then
        :
    else
        sudo dnf config-manager --add-repo "$REPO_URL"
    fi
    sudo dnf install -y openrazer-meta
    add_group plugdev
    ;;
debian)
    . /etc/os-release
    if [ "${ID:-}" = ubuntu ]; then
        say "Detected Ubuntu ($VERSION_CODENAME)."
        say "Installing: openrazer-driver-dkms from the archive (universe)."
        sudo add-apt-repository -y universe 2>/dev/null || true
    else
        say "Detected Debian."
        say "Installing: openrazer-driver-dkms from the archive."
    fi
    sudo apt-get update
    sudo apt-get install -y openrazer-driver-dkms "linux-headers-$(uname -r)" 2>/dev/null \
        || sudo apt-get install -y openrazer-driver-dkms
    add_group plugdev
    ;;
opensuse)
    . /etc/os-release
    say "Detected ${PRETTY_NAME:-openSUSE}."
    say "Installing: openrazer-driver-dkms from hardware:razer repo."
    # Leap keeps its own repo path; everything else is Tumbleweed.
    if [ "${ID:-}" = opensuse-leap ]; then
        SUSE_VER="openSUSE_Leap_${VERSION_ID}"
    else
        SUSE_VER="openSUSE_Tumbleweed"
    fi
    sudo zypper addrepo \
        "https://download.opensuse.org/repositories/hardware:/razer/${SUSE_VER}/hardware:razer.repo"
    sudo zypper --gpg-auto-import-keys install -y openrazer-driver-dkms
    add_group plugdev
    ;;
esac

say ""
say "If Secure Boot blocks the module, see:"
say "https://github.com/openrazer/openrazer/wiki/Troubleshooting"
YELLOW="\033[1;33m"; RESET="\033[0m"; BOLD="\033[1m"
echo ""
echo -e "${YELLOW}Done. To finish setup, ${BOLD}reboot your PC${RESET}${YELLOW}.${RESET}"
echo ""
# stdin is the curl pipe — read the keyboard from the terminal directly.
read -rp "Press Enter to close this window..." _ < /dev/tty || true
exit 0