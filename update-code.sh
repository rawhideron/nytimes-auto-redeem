#!/bin/bash

echo "🎫 NYTimes Gift Code Updater"
echo "=============================="
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found"
    exit 1
fi

# Show current code
CURRENT_CODE=$(grep NYTIMES_GIFT_CODE .env | cut -d '=' -f2)
echo "Current code: ${CURRENT_CODE:0:8}..."
echo ""

# Get new code
read -p "Enter new gift code: " NEW_CODE

if [ -z "$NEW_CODE" ]; then
    echo "❌ No code entered. Exiting."
    exit 1
fi

# Update .env file
sed -i.bak "s/NYTIMES_GIFT_CODE=.*/NYTIMES_GIFT_CODE=$NEW_CODE/" .env

echo "✅ Code updated successfully!"
echo "Old code: ${CURRENT_CODE:0:8}..."
echo "New code: ${NEW_CODE:0:8}..."
echo ""

# Restart container
read -p "Restart Docker container? (y/n): " RESTART

if [ "$RESTART" = "y" ]; then
    echo "🔄 Restarting container..."
    docker-compose restart nytimes-redeem
    echo "✅ Container restarted!"
    echo ""
    echo "Test the new code with:"
    echo "  docker-compose exec nytimes-redeem node redeem.js"
fi
