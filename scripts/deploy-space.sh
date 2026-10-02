#!/bin/sh
# Deploy the space/ subtree to the osolmaz/redtap-space Hugging Face Space.
# The redtap source lives in this one git repo; the Space is a deployment
# target that receives the space/ directory as its own git tree.
set -eu

OWNER=${OWNER:-osolmaz}
SPACE=${SPACE:-redtap-space}
SRC=$(dirname "$0")/../space

REMOTE="https://huggingface.co/spaces/$OWNER/$SPACE"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --depth 1 "$REMOTE" "$WORK/space-git" 2>/dev/null \
  || (git init "$WORK/space-git" && git -C "$WORK/space-git" remote add origin "$REMOTE")
rsync -a --delete --exclude .git "$SRC/" "$WORK/space-git/"
git -C "$WORK/space-git" add -A
git -C "$WORK/space-git" -c user.name=redtap-deploy -c user.email=redtap@local \
  commit -m "deploy: sync space source from redtap repo" || echo "space already up to date"
TOKEN=$(cat "${HF_TOKEN_PATH:-$HOME/.cache/huggingface/token}" 2>/dev/null || true)
if [ -n "$TOKEN" ]; then
  git -C "$WORK/space-git" push "https://osolmaz:$TOKEN@huggingface.co/spaces/$OWNER/$SPACE" HEAD:main
else
  git -C "$WORK/space-git" push "$REMOTE" HEAD:main
fi
echo "deployed $SRC -> $REMOTE"
