#!/bin/bash
set -e

# Detect OS
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
  darwin)
    PLATFORM="macos"
    ;;
  linux)
    PLATFORM="linux"
    ;;
  *)
    echo "Unsupported operating system: $OS"
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64)
    ARCH_NAME="x64"
    ;;
  arm64|aarch64)
    ARCH_NAME="arm64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

BINARY_NAME="undomcp-${PLATFORM}-${ARCH_NAME}"
DOWNLOAD_URL="https://github.com/LokeyDev0/UndoMCP-Tool/releases/latest/download/${BINARY_NAME}"

INSTALL_DIR="$HOME/.undomcp/bin"
mkdir -p "$INSTALL_DIR"

echo "Downloading undomcp from $DOWNLOAD_URL..."
curl -L -o "$INSTALL_DIR/undomcp" "$DOWNLOAD_URL"
chmod +x "$INSTALL_DIR/undomcp"

# Add to PATH if not present
SHELL_PROFILES=("$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile")
PATH_LINE='export PATH="$HOME/.undomcp/bin:$PATH"'

for PROFILE in "${SHELL_PROFILES[@]}"; do
  if [ -f "$PROFILE" ]; then
    if ! grep -q ".undomcp/bin" "$PROFILE"; then
      echo "" >> "$PROFILE"
      echo "# undomcp path configuration" >> "$PROFILE"
      echo "$PATH_LINE" >> "$PROFILE"
      echo "Added undomcp PATH to $PROFILE"
    fi
  fi
done

echo "Running setup command..."
"$INSTALL_DIR/undomcp" setup

echo "undomcp was successfully installed!"
echo "Please restart your shell or run: source <your-profile>"
