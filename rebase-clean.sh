#!/bin/bash

# This script will help clean sensitive data from git history

echo "Starting interactive rebase to clean sensitive data..."
echo "When the editor opens:"
echo "1. Change 'pick' to 'edit' for commit 41c183f"
echo "2. Save and close the editor"
echo "3. The script will then help you edit the problematic commit"

# Set up sequence editor to automatically mark the commit for editing
export GIT_SEQUENCE_EDITOR="sed -i '' 's/pick 41c183f/edit 41c183f/'"

# Start the rebase
git rebase -i 41c183f^

echo ""
echo "Now at commit 41c183f. Let's clean the sensitive data..."
echo "Editing truffle-config.js to remove sensitive information..."

# The rebase should now be paused at commit 41c183f
# We can edit the file and amend the commit