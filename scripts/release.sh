#!/bin/bash
set -e

# Stage all changes first so npm version includes them in its commit
git add -A

# Bump version first — without --git-tag-version we let our own commit handle git
npm version patch --no-git-tag-version

# Now read the new version and commit everything together
NEW_VERSION=$(node -p "require('./package.json').version")
COMMIT_MSG="${1:-v$NEW_VERSION}"
# If a message was passed, prepend the version to it for clarity
if [ -n "$1" ]; then
  COMMIT_MSG="v$NEW_VERSION: $1"
fi

git commit -m "$COMMIT_MSG"
git tag "v$NEW_VERSION"
git push
git push --tags

npm run build
npx cap sync android
scp -r -i ~/.ssh/.id_satoshi_market dist/* satoshi@satoshimarket.app:~/chama-dist/
echo "Deployed $NEW_VERSION"
