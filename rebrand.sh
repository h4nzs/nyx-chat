#!/bin/bash

echo "--- STARTING REBRANDING: Chat Lite -> NYX ---"

# Correctly find all files while excluding specified directories at any depth.
# The -path '*/node_modules' pattern is the key fix.
find . -type d \( -path '*/node_modules' -o -path '*/dist' -o -path '*/dev-dist' -o -path './.git' \) -prune -o -type f -print0 | while IFS= read -r -d $'\0' file; do
  
  # Skip this script itself
  if [ "$file" == "./rebrand.sh" ]; then
    continue
  fi

  echo "Scanning: $file"
  
  # Use a temporary file to avoid issues with sed -i on some systems
  TMP_FILE=$(mktemp)

  # Perform all replacements on a temporary file
  sed -e 's/Chat-Lite/NYX/ig' \
      -e 's/ChatLite/NYX/ig' \
      -e 's/chat-lite-db/nyx-db/g' \
      -e 's/chat-lite-redis/nyx-redis/g' \
      -e 's/chat-lite-api/nyx-api/g' \
      -e 's/chat-lite-web/nyx-web/g' \
      -e 's/chat-lite-backend/nyx-backend/g' \
      -e 's/chat-lite/nyx/g' \
      -e 's/chatlite_user/nyx_user/g' \
      -e 's/chatlite/nyxdb/g' \
      "$file" > "$TMP_FILE" && mv "$TMP_FILE" "$file"

done

# Manual fix for the HTML title
HTML_FILE="./web/index.html"
if [ -f "$HTML_FILE" ]; then
    echo "Fixing HTML title in: $HTML_FILE"
    sed -i 's|<title>.*</title>|<title>NYX</title>|' "$HTML_FILE"
fi

# Manual fix for package.json names
echo "Fixing package.json names..."
if [ -f "./web/package.json" ]; then
  sed -i 's/"name": "chat-lite-web"/"name": "nyx-web"/' "./web/package.json"
fi
if [ -f "./server/package.json" ]; then
  sed -i 's/"name": "chat-lite-server"/"name": "nyx-server"/' "./server/package.json"
fi

echo "--- REBRANDING COMPLETE ---"
echo "Please review the changes with 'git diff' before committing."
echo "To run this script, use: bash rebrand.sh"
