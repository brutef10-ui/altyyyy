#!/bin/bash
# Copies the SmartCross sources (no node_modules / previews) into the repo and commits + pushes
# them every 5 minutes when anything changed.
SRC=/tmp/claude-0/-home-user-altyyyy/900f4e9b-ba67-5aa9-8f8a-5d67b1bb68c5/scratchpad/smartcross
REPO=/home/user/altyyyy
DST=$REPO/smartcross
BR=ccr-ac8b50b2-7i5zd6
save() {
  rm -rf "$DST" && mkdir -p "$DST"
  tar -C "$SRC" --exclude=./node_modules --exclude=./previews -cf - . | tar -C "$DST" -xf -
  printf 'node_modules/\npreviews/\n' > "$DST/.gitignore"
  cd "$REPO" || return
  git add smartcross
  if git diff --cached --quiet; then echo "$(date -u +%H:%M:%S) no changes"; return; fi
  git commit -q -m "SmartCross: autosave $(date -u +%H:%M) UTC" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01KeymztEYB9LbiJpNBDSHQb"
  for d in 2 4 8 16 0; do
    if git push -q -u origin "$BR" 2>/tmp/autosave-push.err; then echo "$(date -u +%H:%M:%S) saved $(git rev-parse --short HEAD) $(git show --stat --oneline HEAD | tail -1)"; return; fi
    [ "$d" = 0 ] && { echo "$(date -u +%H:%M:%S) push failed: $(tail -1 /tmp/autosave-push.err)"; return; }
    sleep "$d"
  done
}
while true; do save; sleep 300; done
