#!/usr/bin/env bash
#
# Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
#
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Fail if a source file that ships to the public mirror has no SPDX identifier.
#
# A license sweep is a snapshot: it covers the files that existed the day
# someone ran it, and every file merged afterwards is uncovered. This check
# moves that assertion from something a person remembers to something the build
# enforces.
#
# The set of files checked is read from .github/sync.yml rather than repeated
# here. Two hand-maintained lists would drift, and a path published but not
# checked is exactly a file that can ship without a license header.
#
# Two additions to that set:
#
#   * Every tracked file under packages/. A workspace package that is not yet
#     in the allowlist (daa-api-client is one) will be, and its files should
#     already carry the header when it is, not be found missing in the sync
#     that publishes them.
#   * When .github/sync.yml is absent, every tracked source file. That is the
#     public repository, which does not carry the allowlist: there, everything
#     present is published.

set -euo pipefail
cd "$(dirname "$0")/.."

ALLOWLIST=.github/sync.yml

# Source extensions worth a license header. Data and config formats that cannot
# carry a comment (JSON, YAML) are deliberately absent. A shell script is source
# like any other: it ships and it runs.
is_source() {
  case "$1" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.sh) return 0 ;;
    *) return 1 ;;
  esac
}

# Portable across bash 3.2 (macOS) as well as CI's bash 5: no mapfile.
candidates=()
add_tracked() {
  # git ls-files, not find: it lists tracked files only, so gitignored build
  # output under a published directory (dist/, node_modules) can never be swept
  # in and reported as a missing header on a file that was never source.
  while IFS= read -r f; do
    if is_source "$f"; then candidates+=("$f"); fi
  done < <(git ls-files -- "$@")
}

if [ -f "$ALLOWLIST" ]; then
  published=()
  while IFS= read -r line; do
    if [ -n "$line" ]; then published+=("$line"); fi
  done < <(sed -n 's/^[[:space:]]*-[[:space:]]*source:[[:space:]]*\([^[:space:]#]*\).*/\1/p' "$ALLOWLIST")
  if [ ${#published[@]} -eq 0 ]; then
    echo "Parsed no 'source:' entries from $ALLOWLIST; the check would pass vacuously." >&2
    exit 1
  fi
  for entry in "${published[@]}"; do
    entry="${entry%\"}"; entry="${entry#\"}"
    if [ -d "${entry%/}" ]; then
      add_tracked "${entry%/}"
    elif [ -f "$entry" ]; then
      if is_source "$entry"; then candidates+=("$entry"); fi
    else
      # An entry that names nothing would otherwise drop out of the check without
      # a word, and a published path would go unchecked.
      echo "$ALLOWLIST names '$entry', which is not a file or directory here." >&2
      exit 1
    fi
  done
  add_tracked packages
else
  add_tracked .
fi

if [ ${#candidates[@]} -eq 0 ]; then
  echo "Found no source files to check; the check would pass vacuously." >&2
  exit 1
fi

# The same file can be named by an allowlist entry and by the packages/ sweep.
unique=()
while IFS= read -r f; do
  unique+=("$f")
done < <(printf '%s\n' "${candidates[@]}" | sort -u)

missing=()
for file in "${unique[@]}"; do
  # The header sits at the top, below at most a shebang; six lines covers the
  # block and line comment forms without matching an SPDX mention in the body of
  # a file.
  if ! head -6 "$file" | grep -q 'SPDX-License-Identifier'; then
    missing+=("$file")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing SPDX-License-Identifier in ${#missing[@]} published source file(s):" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo >&2
  echo "Add the Apache-2.0 header used by the rest of the repository. These files" >&2
  echo "ship to the public mirror, and every one of them carries a header." >&2
  exit 1
fi

echo "All ${#unique[@]} published source files carry an SPDX identifier."
