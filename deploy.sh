#!/usr/bin/env bash

# Build the plugin and copy it into the local SiYuan plugins directory.
#
# The SiYuan workspace is auto-detected. Override when needed:
#   SIYUAN_PLUGIN_DIR=/abs/path/to/data/plugins/siyuan-agent ./deploy.sh
#   SIYUAN_WORKSPACE=/abs/path/to/SiYuan ./deploy.sh
#
# Print the resolved target without building:  ./deploy.sh --print-dir

set -euo pipefail

PLUGIN_NAME="siyuan-agent"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# A SiYuan workspace holds both conf/ and data/ subdirectories.
is_workspace() {
	[ -d "$1/data" ] && [ -d "$1/conf" ]
}

resolve_plugin_dir() {
	# 1. Explicit overrides win.
	if [ -n "${SIYUAN_PLUGIN_DIR:-}" ]; then
		printf '%s\n' "$SIYUAN_PLUGIN_DIR"
		return 0
	fi
	if [ -n "${SIYUAN_WORKSPACE:-}" ] && [ -d "${SIYUAN_WORKSPACE}/data" ]; then
		printf '%s\n' "${SIYUAN_WORKSPACE}/data/plugins/${PLUGIN_NAME}"
		return 0
	fi

	# 2. Candidate workspaces — native home first.
	local candidates=("$HOME/SiYuan" "$HOME/Documents/SiYuan")

	# 3. Under WSL, also probe Windows user profiles on /mnt/c.
	if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null; then
		local winuser=""
		if command -v cmd.exe >/dev/null 2>&1; then
			winuser="$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r\n')" || winuser=""
		fi
		local base
		for base in "/mnt/c/Users/$winuser" /mnt/c/Users/*; do
			[ -d "$base" ] || continue
			case "${base##*/}" in
				Public|Default|"Default User"|"All Users") continue ;;
			esac
			candidates+=("$base/SiYuan" "$base/Documents/SiYuan" "$base/OneDrive/Documents/SiYuan")
		done
	fi

	# 4. First conventional candidate that is a real workspace wins.
	local ws
	for ws in "${candidates[@]}"; do
		if is_workspace "$ws"; then
			printf '%s\n' "$ws/data/plugins/${PLUGIN_NAME}"
			return 0
		fi
	done

	# 5. Fallback: the workspace may sit at a custom path (e.g. moved to D:).
	#    Scan mounted drives for the workspace signature (conf/conf.json next to
	#    data/), pruning big system trees. Prefer the active one (has .lock).
	if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null && [ -d /mnt ]; then
		local root cj found="" first=""
		for root in /mnt/*; do
			[ -d "$root" ] || continue
			case "${root##*/}" in wslg) continue ;; esac
			while IFS= read -r cj; do
				ws="${cj%/conf/conf.json}"
				is_workspace "$ws" || continue
				[ -n "$first" ] || first="$ws"
				if [ -f "$ws/.lock" ]; then found="$ws"; break; fi
			done < <(find "$root" -maxdepth 6 \
				\( -name 'Windows' -o -name 'Program Files' -o -name 'Program Files (x86)' \
				   -o -name 'ProgramData' -o -name 'AppData' -o -name 'node_modules' \
				   -o -name '$Recycle.Bin' -o -name 'System Volume Information' \
				   -o -name 'Windows.old' \) -prune \
				-o -type f -name conf.json -path '*/conf/conf.json' -print 2>/dev/null)
			[ -n "$found" ] && break
		done
		ws="${found:-$first}"
		if [ -n "$ws" ]; then
			printf '%s\n' "$ws/data/plugins/${PLUGIN_NAME}"
			return 0
		fi
	fi

	return 1
}

if ! PLUGIN_DIR="$(resolve_plugin_dir)"; then
	echo "Error: could not locate a SiYuan workspace." >&2
	echo "Set one explicitly, e.g.:" >&2
	echo "  SIYUAN_WORKSPACE=/path/to/SiYuan ./deploy.sh" >&2
	echo "  SIYUAN_PLUGIN_DIR=/path/to/SiYuan/data/plugins/${PLUGIN_NAME} ./deploy.sh" >&2
	exit 1
fi

if [ "${1:-}" = "--print-dir" ]; then
	printf '%s\n' "$PLUGIN_DIR"
	exit 0
fi

echo "Target: ${PLUGIN_DIR}"

cp assets/logos/icon.png ./icon.png
cp assets/logos/preview.png ./preview.png

npm run build

mkdir -p "${PLUGIN_DIR}/i18n"

cp dist/index.js   "${PLUGIN_DIR}/"
cp dist/index.css  "${PLUGIN_DIR}/"
cp dist/plugin.json "${PLUGIN_DIR}/"
cp dist/icon.png   "${PLUGIN_DIR}/"
cp dist/preview.png "${PLUGIN_DIR}/"
cp dist/README*.md "${PLUGIN_DIR}/"
cp dist/i18n/*     "${PLUGIN_DIR}/i18n/"

echo "Deployed ${PLUGIN_NAME} to ${PLUGIN_DIR}"
