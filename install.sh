#!/bin/sh
# Installs the milhouse binary of the latest release: no Bun needed.
#   curl -fsSL https://raw.githubusercontent.com/eizorerad/milhouse/main/install.sh | sh
# It goes to ~/.local/bin, or to $MILHOUSE_INSTALL_DIR. `milhouse upgrade` updates it later.
set -eu

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
	x86_64 | amd64) arch=x64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) arch=$(uname -m) ;;
esac
case "$os-$arch" in
	linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64) ;;
	*)
		echo "milhouse: there is no binary for $os-$arch. Install from source: see the README." >&2
		exit 1
		;;
esac

releases=${MILHOUSE_RELEASES:-https://github.com/eizorerad/milhouse/releases}
dir=${MILHOUSE_INSTALL_DIR:-$HOME/.local/bin}
mkdir -p "$dir"
url=$releases/latest/download/milhouse-$os-$arch
# Under another name first: a download that breaks off must not leave half a milhouse behind.
# The gzipped file is about half of the download; the plain one beside it is all that releases up to 0.5.4 have.
if ! { curl -fsSL "$url.gz" | gunzip >"$dir/milhouse.new"; } 2>/dev/null; then
	curl -fsSL "$url" -o "$dir/milhouse.new" || {
		rm -f "$dir/milhouse.new"
		echo "milhouse: the latest release has no binary for $os-$arch to fetch. Install from source: see the README." >&2
		exit 1
	}
fi
chmod +x "$dir/milhouse.new"
version=$("$dir/milhouse.new" --version)
mv "$dir/milhouse.new" "$dir/milhouse"
echo "Installed milhouse $version in $dir"
case ":$PATH:" in
	*":$dir:"*) ;;
	*) echo "$dir is not on your PATH: add it, or run $dir/milhouse" ;;
esac
